import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import { Parser as Json2CsvParser } from 'json2csv';
import { create } from 'xmlbuilder2';

// fetch polyfill (без top-level await)
(async () => {
  if (typeof fetch === 'undefined') {
    const mod = await import('node-fetch');
    globalThis.fetch = mod.default;
  }
})();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const {
  SHOPIFY_SHOP,
  SHOPIFY_ADMIN_TOKEN,
  SHOPIFY_API_VERSION = '2024-10',
  TIMEZONE = 'UTC',
  APP_URL = ''
} = process.env;

const PORT = process.env.PORT || 3000;

process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

const app = express();
app.use(express.json({ limit: '2mb' }));

// earliest health
app.get('/health', (_req, res) => res.json({ ok: true }));

// CSP за вграждане
app.use((_req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    'frame-ancestors https://admin.shopify.com https://*.myshopify.com'
  );
  next();
});

// статични файлове
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

// директории за експорти/снимки
const EXPORT_DIR = path.join(__dirname, 'exports');
const SNAPSHOT_DIR = path.join(__dirname, 'data', 'snapshots');
fs.mkdirSync(EXPORT_DIR, { recursive: true });
fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
app.use('/exports', express.static(EXPORT_DIR));

if (!SHOPIFY_SHOP || !SHOPIFY_ADMIN_TOKEN) {
  console.error('Missing SHOPIFY_SHOP or SHOPIFY_ADMIN_TOKEN');
}

// --- Shopify GraphQL helper ---
const GQL_URL = `https://${SHOPIFY_SHOP}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
async function shopifyGraphQL(query, variables = {}) {
  const res = await fetch(GQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN },
    body: JSON.stringify({ query, variables })
  });
  let out = {};
  try { out = await res.json(); } catch {}
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}: ${JSON.stringify(out)}`);
  if (out.errors) throw new Error(`GraphQL errors: ${JSON.stringify(out.errors)}`);
  return out.data;
}

// --- Queries (UPDATED: InventoryLevel.quantities(names:["available"])) ---
const PRODUCTS_PAGE_QUERY = `
  query ProductsPage($cursor: String, $qtyNames: [String!]!) {
    products(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          title
          vendor
          vendorInvoiceDate: metafield(namespace: "custom", key: "vendor_invoice_date") { value }
          vendorInvoiceNumber: metafield(namespace: "custom", key: "vendor_invoice_number") { value }
          variants(first: 50) {
            edges {
              node {
                id
                sku
                inventoryItem {
                  unitCost { amount currencyCode }
                  inventoryLevels(first: 50) {
                    edges {
                      node {
                        quantities(names: $qtyNames) {
                          name
                          quantity
                        }
                        # location { id name }  // държим го махнат за по-нисък query cost
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const ORDERS_PAGE_QUERY = `
  query OrdersPage($cursor: String, $query: String!) {
    orders(first: 100, after: $cursor, query: $query) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          createdAt
          canceledAt
          financialStatus
          lineItems(first: 250) {
            edges {
              node {
                quantity
                sku
                variant { id sku }
                product { id title vendor }
              }
            }
          }
        }
      }
    }
  }
`;

// --- Fetchers ---
async function fetchAllProductsAndInventory() {
  let cursor = null, hasNext = true;
  const rows = [];

  while (hasNext) {
    const data = await shopifyGraphQL(PRODUCTS_PAGE_QUERY, { cursor, qtyNames: ["available"] });
    const { edges, pageInfo } = data.products;

    for (const { node: p } of edges) {
      const vendorInvoiceDate = p.vendorInvoiceDate?.value || null;
      const vendorInvoiceNumber = p.vendorInvoiceNumber?.value || null;

      for (const vEdge of p.variants.edges) {
        const v = vEdge.node;
        const levels = v.inventoryItem?.inventoryLevels?.edges || [];

        // UPDATED aggregation using quantities(names:[AVAILABLE])
        const endingQty = levels.reduce((sum, lev) => {
          const qList = lev.node.quantities || [];
          const avail = qList.find(q => q.name === 'available');
          return sum + (avail?.quantity ?? 0);
        }, 0);

        rows.push({
          productId: p.id,
          productTitle: p.title,
          productVendor: p.vendor,
          vendorInvoiceDate,
          vendorInvoiceNumber,
          variantId: v.id,
          variantSku: v.sku,
          unitCost: v.inventoryItem?.unitCost?.amount ?? null,
          unitCostCurrency: v.inventoryItem?.unitCost?.currencyCode ?? null,
          endingQty
        });
      }
    }

    hasNext = pageInfo.hasNextPage;
    cursor = pageInfo.endCursor;
  }
  return rows;
}

async function fetchUnitsSold(sinceISO, untilISO) {
  const q = `created_at:>=${sinceISO} created_at:<=${untilISO} financial_status:paid -cancelled_at:*`;
  let cursor = null, hasNext = true;
  const byVariant = new Map();

  while (hasNext) {
    const data = await shopifyGraphQL(ORDERS_PAGE_QUERY, { cursor, query: q });
    const { edges, pageInfo } = data.orders;

    for (const { node: o } of edges) {
      for (const liEdge of o.lineItems.edges) {
        const li = liEdge.node;
        const vId = li.variant?.id || (li.sku ? `SKU:${li.sku}` : null);
        if (!vId) continue;
        byVariant.set(vId, (byVariant.get(vId) || 0) + (li.quantity || 0));
      }
    }

    hasNext = pageInfo.hasNextPage;
    cursor = pageInfo.endCursor;
  }
  return byVariant;
}

// --- Snapshots / build / writers ---
function snapshotPath(label){ return path.join(SNAPSHOT_DIR, `${label}.json`); }
async function createSnapshot(label){
  const rows = await fetchAllProductsAndInventory();
  const snap = {};
  for (const r of rows) snap[r.variantId] = (snap[r.variantId] || 0) + (r.endingQty || 0);
  fs.writeFileSync(snapshotPath(label), JSON.stringify(snap, null, 2));
  return { count: Object.keys(snap).length, file: `/data/snapshots/${label}.json` };
}
function buildReportRows(productRows, unitsSoldMap, startSnapshot=null){
  return productRows.map(r=>{
    const vKey = r.variantId || (r.variantSku ? `SKU:${r.variantSku}` : null);
    const sold = vKey ? (unitsSoldMap.get(vKey) || 0) : 0;
    const startingQty = (startSnapshot && r.variantId && startSnapshot[r.variantId] !== undefined)
      ? startSnapshot[r.variantId] : null;
    return {
      vendor: r.productVendor,
      vendor_invoice_date: r.vendorInvoiceDate,
      vendor_invoice_number: r.vendorInvoiceNumber,
      product_title: r.productTitle,
      product_variant_sku: r.variantSku,
      unit_cost: r.unitCost,
      unit_cost_currency: r.unitCostCurrency,
      starting_inventory_qty: startingQty,
      ending_inventory_qty: r.endingQty,
      units_sold: sold
    };
  });
}
function writeCSV(rows, base, columns){
  const defaultFields=['vendor','vendor_invoice_date','vendor_invoice_number','product_title','product_variant_sku','unit_cost','unit_cost_currency','starting_inventory_qty','ending_inventory_qty','units_sold'];
  const fields=(Array.isArray(columns)&&columns.length)?columns:defaultFields;
  const csv=new Json2CsvParser({fields}).parse(rows);
  const file=path.join(EXPORT_DIR, `${base}.csv`); fs.writeFileSync(file,csv,'utf8'); return `/exports/${path.basename(file)}`;
}
function writeXML(rows, base, columns){
  const mapped=(Array.isArray(columns)&&columns.length)?rows.map(r=>{const o={}; for(const c of columns) o[c]=r[c]; return o;}):rows;
  const xml=create({version:'1.0'}).ele({report:{row:mapped}}).end({prettyPrint:true});
  const file=path.join(EXPORT_DIR, `${base}.xml`); fs.writeFileSync(file,xml,'utf8'); return `/exports/${path.basename(file)}`;
}

// --- Routes ---
app.post('/snapshot', async (req,res)=>{
  try {
    const label=(req.body?.label)||new Date().toISOString().slice(0,10);
    const out=await createSnapshot(label);
    res.json({ok:true,label,...out,path:`/data/snapshots/${label}.json`});
  } catch(e){
    console.error('[SNAPSHOT]',e);
    res.status(500).json({ok:false,error:String(e)});
  }
});
app.post('/report', async (req,res)=>{
  try{
    const { since, until, startSnapshotLabel, columns } = req.body||{};
    if(!since||!until) return res.status(400).json({ok:false,error:'Missing since/until (ISO)'});
    const [products, soldMap] = await Promise.all([ fetchAllProductsAndInventory(), fetchUnitsSold(since, until) ]);
    let startSnapshot=null; if(startSnapshotLabel){ const p=snapshotPath(startSnapshotLabel); if(fs.existsSync(p)) startSnapshot=JSON.parse(fs.readFileSync(p,'utf8')); }
    const rows=buildReportRows(products, soldMap, startSnapshot);
    const stamp=new Date().toISOString().replace(/[:.]/g,'-'); const base=`inventory-report_${stamp}`;
    res.json({ ok:true, rows:rows.length, csv:writeCSV(rows,base,columns), xml:writeXML(rows,base,columns), columns:columns&&columns.length?columns:undefined, sample:rows.slice(0,20) });
  } catch(e){
    console.error('[REPORT]',e);
    res.status(500).json({ok:false,error:String(e)});
  }
});

// --- Cron ---
cron.schedule('5 0 * * *', async ()=>{
  try{ const label=new Date().toISOString().slice(0,10); await createSnapshot(label); console.log('[CRON] Snapshot',label); }
  catch(e){ console.error('[CRON]',e); }
},{ timezone: TIMEZONE });

// --- Start (host 0.0.0.0 за хостинг платформи) ---
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on :${PORT}`);
  if (APP_URL) console.log(`App URL: ${APP_URL}`);
});
