import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import { Parser as Json2CsvParser } from 'json2csv';
import { create } from 'xmlbuilder2';
import iconv from 'iconv-lite';

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
  TIMEZONE = 'Europe/Sofia',
  APP_URL = ''
} = process.env;

const PORT = process.env.PORT || 3000;

process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

const app = express();
app.use(express.json({ limit: '2mb' }));

// Health
app.get('/health', (_req, res) => res.json({ ok: true }));

// CSP за вграждане в Shopify Admin
app.use((_req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    'frame-ancestors https://admin.shopify.com https://*.myshopify.com'
  );
  next();
});

// Статика
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

// Директории за експорти/снимки
const EXPORT_DIR = path.join(__dirname, 'exports');
const SNAPSHOT_DIR = process.env.SNAPSHOT_DIR || path.join(__dirname, 'data', 'snapshots');
fs.mkdirSync(EXPORT_DIR, { recursive: true });
fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

// Помощни функции за време/етикети
function labelForTodayTZ(tz = 'UTC') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const Y = parts.find(p => p.type === 'year').value;
  const M = parts.find(p => p.type === 'month').value;
  const D = parts.find(p => p.type === 'day').value;
  return `${Y}-${M}-${D}`; // YYYY-MM-DD
}
function isLastDayOfMonthTZ(tz = 'UTC') {
  const todayLabel = labelForTodayTZ(tz);
  const [y, m, d] = todayLabel.split('-').map(n => parseInt(n, 10));
  const todayLocal = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const tomorrow = new Date(todayLocal.getTime() + 24 * 60 * 60 * 1000);
  const mNow = new Intl.DateTimeFormat('en-CA', { timeZone: tz, month: '2-digit' }).format(todayLocal);
  const mTom = new Intl.DateTimeFormat('en-CA', { timeZone: tz, month: '2-digit' }).format(tomorrow);
  return mNow !== mTom;
}

// Shopify GraphQL helper
if (!SHOPIFY_SHOP || !SHOPIFY_ADMIN_TOKEN) {
  console.error('Missing SHOPIFY_SHOP or SHOPIFY_ADMIN_TOKEN');
}
const GQL_URL = `https://${SHOPIFY_SHOP}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
async function shopifyGraphQL(query, variables = {}) {
  const res = await fetch(GQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN
    },
    body: JSON.stringify({ query, variables })
  });
  let out = {};
  try { out = await res.json(); } catch {}
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}: ${JSON.stringify(out)}`);
  if (out.errors) throw new Error(`GraphQL errors: ${JSON.stringify(out.errors)}`);
  return out.data;
}

// GraphQL заявки (съобразени с новия Inventory API)
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
                  tracked
                  unitCost { amount currencyCode }
                  inventoryLevels(first: 50) {
                    edges {
                      node {
                        quantities(names: $qtyNames) {
                          name
                          quantity
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

// Изтегляне на продукти/варианти и текуща наличност
async function fetchAllProductsAndInventory() {
  let cursor = null, hasNext = true;
  const rows = [];

  while (hasNext) {
    const data = await shopifyGraphQL(PRODUCTS_PAGE_QUERY, {
      cursor,
      qtyNames: ['available']
    });
    const { edges, pageInfo } = data.products;

    for (const { node: p } of edges) {
      const vendorInvoiceDate = p.vendorInvoiceDate?.value || null;
      const vendorInvoiceNumber = p.vendorInvoiceNumber?.value || null;

      for (const vEdge of p.variants.edges) {
        const v = vEdge.node;

        // само tracked
        if (v.inventoryItem?.tracked !== true) continue;

        const levels = v.inventoryItem?.inventoryLevels?.edges || [];
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

// Units sold (по поръчки в периода)
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

// Snapshot-и
function snapshotPath(label){ return path.join(SNAPSHOT_DIR, `${label}.json`); }
async function createSnapshot(label){
  const rows = await fetchAllProductsAndInventory();
  const snap = {};
  for (const r of rows) snap[r.variantId] = (snap[r.variantId] || 0) + (r.endingQty || 0);
  fs.writeFileSync(snapshotPath(label), JSON.stringify(snap, null, 2));
  return { count: Object.keys(snap).length, file: `/data/snapshots/${label}.json` };
}

// Build/Export
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
  const defaultFields = [
    'vendor','vendor_invoice_date','vendor_invoice_number',
    'product_title','product_variant_sku',
    'unit_cost','unit_cost_currency',
    'starting_inventory_qty','ending_inventory_qty','units_sold'
  ];
  const fields = (Array.isArray(columns) && columns.length) ? columns : defaultFields;
  const csv = new Json2CsvParser({ fields }).parse(rows);
  const file = path.join(EXPORT_DIR, `${base}.csv`);
  fs.writeFileSync(file, csv, 'utf8');
  return path.basename(file, '.csv'); // връщаме base name
}
function writeXML(rows, base, columns){
  const mapped = (Array.isArray(columns) && columns.length)
    ? rows.map(r => { const o = {}; for (const c of columns) o[c] = r[c]; return o; })
    : rows;
  const xml = create({ version: '1.0' }).ele({ report: { row: mapped }}).end({ prettyPrint: true });
  const file = path.join(EXPORT_DIR, `${base}.xml`);
  fs.writeFileSync(file, xml, 'utf8');
  return path.basename(file, '.xml'); // връщаме base name
}

// Download маршрути (с encoding)
function safeBase(name) {
  return String(name).replace(/[^a-zA-Z0-9._-]/g, '');
}
app.get('/download/csv/:base', (req, res) => {
  const base = safeBase(req.params.base);
  const enc = (req.query.enc || 'utf8').toLowerCase();
  const filePath = path.join(EXPORT_DIR, `${base}.csv`);
  if (!fs.existsSync(filePath)) return res.status(404).send('File not found');

  let csv = fs.readFileSync(filePath, 'utf8');
  let buf;
  if (enc === 'win1251' || enc === 'windows-1251') {
    buf = iconv.encode(csv, 'windows-1251');
    res.setHeader('Content-Type', 'text/csv; charset=windows-1251');
  } else {
    csv = '\uFEFF' + csv; // BOM за Excel
    buf = Buffer.from(csv, 'utf8');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  }
  res.setHeader('Content-Disposition', `attachment; filename="${base}.csv"`);
  res.send(buf);
});
app.get('/download/xml/:base', (req, res) => {
  const base = safeBase(req.params.base);
  const enc = (req.query.enc || 'utf8').toLowerCase();
  const filePath = path.join(EXPORT_DIR, `${base}.xml`);
  if (!fs.existsSync(filePath)) return res.status(404).send('File not found');

  let xml = fs.readFileSync(filePath, 'utf8');
  let buf;
  if (enc === 'win1251' || enc === 'windows-1251') {
    buf = iconv.encode(xml, 'windows-1251');
    res.setHeader('Content-Type', 'application/xml; charset=windows-1251');
  } else {
    buf = Buffer.from(xml, 'utf8');
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  }
  res.setHeader('Content-Disposition', `attachment; filename="${base}.xml"`);
  res.send(buf);
});

// Endpoints
app.post('/snapshot', async (req, res)=>{
  try {
    const label = (req.body?.label) || labelForTodayTZ(TIMEZONE);
    const out = await createSnapshot(label);
    res.json({ ok:true, label, ...out, path:`/data/snapshots/${label}.json` });
  } catch(e){
    console.error('[SNAPSHOT]', e);
    res.status(500).json({ ok:false, error:String(e) });
  }
});

app.post('/report', async (req,res)=>{
  try{
    const { since, until, startSnapshotLabel, columns } = req.body||{};
    if(!since||!until) return res.status(400).json({ ok:false, error:'Missing since/until (ISO)' });

    const [products, soldMap] = await Promise.all([
      fetchAllProductsAndInventory(),
      fetchUnitsSold(since, until)
    ]);

    let startSnapshot=null;
    if(startSnapshotLabel){
      const p = snapshotPath(startSnapshotLabel);
      if(fs.existsSync(p)) startSnapshot = JSON.parse(fs.readFileSync(p,'utf8'));
    }

    const rows = buildReportRows(products, soldMap, startSnapshot);
    const stamp = new Date().toISOString().replace(/[:.]/g,'-');
    const base = `inventory-report_${stamp}`;

    const csvBase = writeCSV(rows, base, columns);
    const xmlBase = writeXML(rows, base, columns);

    res.json({
      ok: true,
      rows: rows.length,
      csv: `/download/csv/${csvBase}?enc=utf8`,
      xml: `/download/xml/${xmlBase}?enc=utf8`,
      csv_win1251: `/download/csv/${csvBase}?enc=win1251`,
      xml_win1251: `/download/xml/${xmlBase}?enc=win1251`,
      columns: columns && columns.length ? columns : undefined,
      sample: rows.slice(0, 20)
    });
  } catch(e){
    console.error('[REPORT]', e);
    res.status(500).json({ ok:false, error:String(e) });
  }
});

// ---- CRON: 11:59:59 в TIMEZONE (1-во, 10-то, 20-то и последен ден) ----
cron.schedule('59 59 11 1 * *', async () => {
  try {
    const label = labelForTodayTZ(TIMEZONE);
    await createSnapshot(label);
    console.log(`[CRON] Snapshot (1st) ${label}`);
  } catch (e) { console.error('[CRON 1st]', e); }
}, { timezone: TIMEZONE });

cron.schedule('59 59 11 10 * *', async () => {
  try {
    const label = labelForTodayTZ(TIMEZONE);
    await createSnapshot(label);
    console.log(`[CRON] Snapshot (10th) ${label}`);
  } catch (e) { console.error('[CRON 10th]', e); }
}, { timezone: TIMEZONE });

cron.schedule('59 59 11 20 * *', async () => {
  try {
    const label = labelForTodayTZ(TIMEZONE);
    await createSnapshot(label);
    console.log(`[CRON] Snapshot (20th) ${label}`);
  } catch (e) { console.error('[CRON 20th]', e); }
}, { timezone: TIMEZONE });

cron.schedule('59 59 11 28-31 * *', async () => {
  try {
    if (!isLastDayOfMonthTZ(TIMEZONE)) return;
    const label = labelForTodayTZ(TIMEZONE);
    await createSnapshot(label);
    console.log(`[CRON] Snapshot (last-of-month) ${label}`);
  } catch (e) { console.error('[CRON last-of-month]', e); }
}, { timezone: TIMEZONE });

// --- Start (host 0.0.0.0 за хостинг платформи) ---
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on :${PORT}`);
  if (APP_URL) console.log(`App URL: ${APP_URL}`);
});
