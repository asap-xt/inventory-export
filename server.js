// server.js — hardened for Railway (Node >= 18), with polyfills & error handlers
import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import { Parser as Json2CsvParser } from 'json2csv';
import { create } from 'xmlbuilder2';

// ---- fetch polyfill for Node < 18 (safety) ----
if (typeof fetch === 'undefined') {
  // eslint-disable-next-line no-undef
  const { default: nodeFetch } = await import('node-fetch');
  // eslint-disable-next-line no-global-assign
  globalThis.fetch = nodeFetch;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- ENV ----
const {
  SHOPIFY_SHOP,
  SHOPIFY_ADMIN_TOKEN,
  SHOPIFY_API_VERSION = '2024-10',
  TIMEZONE = 'UTC',
  APP_URL = ''
} = process.env;
const PORT = process.env.PORT || 3000;

// Global error handlers so the process doesn't die silently
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

console.log('[BOOT] Node', process.version, 'ENV:', process.env.NODE_ENV || 'development');

if (!SHOPIFY_SHOP || !SHOPIFY_ADMIN_TOKEN) {
  console.error('Missing SHOPIFY_SHOP or SHOPIFY_ADMIN_TOKEN env vars.');
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '2mb' }));

// Quick ping as early as possible
app.get('/health', (_req, res) => res.json({ ok: true }));

// Embed in Shopify Admin via CSP
app.use((_req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    'frame-ancestors https://admin.shopify.com https://*.myshopify.com'
  );
  next();
});

// ---- Static UI ----
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

// ---- Export & snapshot dirs ----
const EXPORT_DIR = path.join(__dirname, 'exports');
const SNAPSHOT_DIR = path.join(__dirname, 'data', 'snapshots');
fs.mkdirSync(EXPORT_DIR, { recursive: true });
fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
app.use('/exports', express.static(EXPORT_DIR));

// ---- Shopify GraphQL helper ----
const GQL_URL = `https://${SHOPIFY_SHOP}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

async function shopifyGraphQL(query, variables = {}) {
  const res = await fetch(GQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN
    },
    body: JSON.stringify({ query, variables })
  }).catch((e) => {
    console.error('[GraphQL fetch error]', e);
    throw e;
  });

  let out = {};
  try {
    out = await res.json();
  } catch (e) {
    console.error('[GraphQL parse error]', e);
  }

  if (!res.ok) {
    throw new Error(`GraphQL HTTP ${res.status} ${res.statusText}: ${JSON.stringify(out)}`);
  }
  if (out.errors) throw new Error(`GraphQL errors: ${JSON.stringify(out.errors)}`);
  return out.data;
}

// ---- GQL queries ----
const PRODUCTS_PAGE_QUERY = `
  query ProductsPage($cursor: String) {
    products(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          title
          vendor
          vendorInvoiceDate: metafield(namespace: "custom", key: "vendor_invoice_date") { value }
          vendorInvoiceNumber: metafield(namespace: "custom", key: "vendor_invoice_number") { value }
          variants(first: 100) {
            edges {
              node {
                id
                sku
                inventoryItem {
                  unitCost { amount currencyCode }
                  inventoryLevels(first: 100) {
                    edges {
                      node {
                        available
                        location { id name }
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

// ---- Fetchers ----
async function fetchAllProductsAndInventory() {
  let cursor = null;
  let hasNext = true;
  const rows = [];

  while (hasNext) {
    const data = await shopifyGraphQL(PRODUCTS_PAGE_QUERY, { cursor });
    const { edges, pageInfo } = data.products;

    for (const { node: p } of edges) {
      const vendorInvoiceDate = p.vendorInvoiceDate?.value || null;
      const vendorInvoiceNumber = p.vendorInvoiceNumber?.value || null;

      for (const vEdge of p.variants.edges) {
        const v = vEdge.node;
        const levels = v.inventoryItem?.inventoryLevels?.edges || [];
        theLoop: {
          // Sum all locations for endingQty
        }
        const endingQty = levels.reduce((sum, lev) => sum + (lev.node.available ?? 0), 0);
        const unitCost = v.inventoryItem?.unitCost?.amount ?? null;
        const unitCostCurrency = v.inventoryItem?.unitCost?.currencyCode ?? null;

        rows.push({
          productId: p.id,
          productTitle: p.title,
          productVendor: p.vendor,
          vendorInvoiceDate,
          vendorInvoiceNumber,
          variantId: v.id,
          variantSku: v.sku,
          unitCost,
          unitCostCurrency,
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
  let cursor = null;
  let hasNext = true;
  const byVariant = new Map();

  while (hasNext) {
    const data = await shopifyGraphQL(ORDERS_PAGE_QUERY, { cursor, query: q });
    const { edges, pageInfo } = data.orders;

    for (const { node: o } of edges) {
      for (const liEdge of o.lineItems.edges) {
        const li = liEdge.node;
        const vId = li.variant?.id || (li.sku ? `SKU:${li.sku}` : null);
        if (!vId) continue;
        const prev = byVariant.get(vId) || 0;
        byVariant.set(vId, prev + (li.quantity || 0));
      }
    }

    hasNext = pageInfo.hasNextPage;
    cursor = pageInfo.endCursor;
  }
  return byVariant;
}

// ---- Snapshots ----
function snapshotPath(label) {
  return path.join(SNAPSHOT_DIR, `${label}.json`);
}

async function createSnapshot(label) {
  const rows = await fetchAllProductsAndInventory();
  const snap = {};
  for (const r of rows) {
    snap[r.variantId] = (snap[r.variantId] || 0) + (r.endingQty || 0);
  }
  fs.writeFileSync(snapshotPath(label), JSON.stringify(snap, null, 2));
  return { count: Object.keys(snap).length, file: `/data/snapshots/${label}.json` };
}

// ---- Report builder ----
function buildReportRows(productRows, unitsSoldMap, startSnapshot = null) {
  return productRows.map(r => {
    const vKey = r.variantId || (r.variantSku ? `SKU:${r.variantSku}` : null);
    const sold = vKey ? (unitsSoldMap.get(vKey) || 0) : 0;

    let startingQty = null;
    if (startSnapshot && r.variantId && Object.prototype.hasOwnProperty.call(startSnapshot, r.variantId)) {
      startingQty = startSnapshot[r.variantId];
    }

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

// ---- Writers ----
function writeCSV(rows, filenameBase, columns) {
  const defaultFields = [
    'vendor',
    'vendor_invoice_date',
    'vendor_invoice_number',
    'product_title',
    'product_variant_sku',
    'unit_cost',
    'unit_cost_currency',
    'starting_inventory_qty',
    'ending_inventory_qty',
    'units_sold'
  ];
  const fields = Array.isArray(columns) && columns.length ? columns : defaultFields;
  const parser = new Json2CsvParser({ fields });
  const csv = parser.parse(rows);
  const file = path.join(EXPORT_DIR, `${filenameBase}.csv`);
  fs.writeFileSync(file, csv, 'utf8');
  return `/exports/${path.basename(file)}`;
}

function writeXML(rows, filenameBase, columns) {
  const mappedRows = Array.isArray(columns) && columns.length
    ? rows.map(r => {
        const o = {};
        for (const c of columns) o[c] = r[c];
        return o;
      })
    : rows;
  const xml = create({ version: '1.0' })
    .ele({ report: { row: mappedRows } })
    .end({ prettyPrint: true });
  const file = path.join(EXPORT_DIR, `${filenameBase}.xml`);
  fs.writeFileSync(file, xml, 'utf8');
  return `/exports/${path.basename(file)}`;
}

// ---- Routes ----
// (health е горе, за да отговаря дори при частични проблеми)

// POST /snapshot  { "label": "YYYY-MM-DD" }
app.post('/snapshot', async (req, res) => {
  try {
    const label = (req.body?.label) || new Date().toISOString().slice(0, 10);
    const out = await createSnapshot(label);
    res.json({ ok: true, label, ...out, path: `/data/snapshots/${label}.json` });
  } catch (e) {
    console.error('[SNAPSHOT] Error', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// POST /report { since, until, startSnapshotLabel?, columns? }
app.post('/report', async (req, res) => {
  try {
    const { since, until, startSnapshotLabel, columns } = req.body || {};
    if (!since || !until) return res.status(400).json({ ok: false, error: 'Missing since/until (ISO)' });

    const [products, soldMap] = await Promise.all([
      fetchAllProductsAndInventory(),
      fetchUnitsSold(since, until)
    ]);

    let startSnapshot = null;
    if (startSnapshotLabel) {
      const p = snapshotPath(startSnapshotLabel);
      if (fs.existsSync(p)) startSnapshot = JSON.parse(fs.readFileSync(p, 'utf8'));
    }

    const rows = buildReportRows(products, soldMap, startSnapshot);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = `inventory-report_${stamp}`;

    const csvUrl = writeCSV(rows, base, columns);
    const xmlUrl = writeXML(rows, base, columns);

    res.json({
      ok: true,
      rows: rows.length,
      csv: csvUrl,
      xml: xmlUrl,
      columns: columns && columns.length ? columns : undefined,
      sample: rows.slice(0, 20)
    });
  } catch (e) {
    console.error('[REPORT] Error', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ---- Cron (daily 00:05 local) ----
cron.schedule('5 0 * * *', async () => {
  try {
    const label = new Date().toISOString().slice(0, 10);
    await createSnapshot(label);
    console.log(`[CRON] Snapshot saved for ${label}`);
  } catch (e) {
    console.error('[CRON] Snapshot error', e);
  }
}, { timezone: TIMEZONE });

// ---- Start ----
app.listen(PORT, () => {
  console.log(`Server running on :${PORT}`);
  if (APP_URL) console.log(`App URL: ${APP_URL}`);
});
