import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import { Parser as Json2CsvParser } from 'json2csv';
import { create } from 'xmlbuilder2';
import iconv from 'iconv-lite';
import { MongoClient } from 'mongodb';
import crypto from 'crypto';

// fetch polyfill
(async () => {
  if (typeof fetch === 'undefined') {
    const mod = await import('node-fetch');
    globalThis.fetch = mod.default;
  }
})();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===== ENV =====
const {
  SHOPIFY_SHOP,
  SHOPIFY_ADMIN_TOKEN,
  SHOPIFY_API_VERSION = '2024-10',
  TIMEZONE = 'Europe/Sofia',
  APP_URL = '',
  SNAPSHOT_DIR: SNAPSHOT_DIR_ENV,
  MONGODB_URI,
  MONGODB_DB = 'inventory_export',
  APP_SHARED_PASSWORD
} = process.env;

const PORT = process.env.PORT || 3000;

console.log('[BOOT] Starting Inventory Export app');
console.log('[BOOT] Config:', {
  SHOPIFY_SHOP,
  SHOPIFY_API_VERSION,
  TIMEZONE,
  APP_URL,
  SNAPSHOT_DIR: SNAPSHOT_DIR_ENV || '(default ./data/snapshots)',
  MONGODB_DB: MONGODB_URI ? MONGODB_DB : '(no Mongo)',
  AUTH: APP_SHARED_PASSWORD ? 'ENABLED' : 'DISABLED'
});

if (!SHOPIFY_SHOP || !SHOPIFY_ADMIN_TOKEN) {
  console.error('[BOOT] Missing SHOPIFY_SHOP or SHOPIFY_ADMIN_TOKEN — API calls will fail!');
}

// ===== APP =====
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));

// Basic request logger for our endpoints
app.use((req, _res, next) => {
  if (['/health','/login','/logout','/snapshot','/report','/download','/exports'].some(p => req.path.startsWith(p))) {
    console.log(`[REQ] ${req.method} ${req.path}`);
  }
  next();
});

// Health (keep public)
app.get('/health', (_req, res) => res.json({ ok: true }));

// CSP (allow embed in Shopify admin)
app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', "frame-ancestors https://admin.shopify.com https://*.myshopify.com");
  next();
});

// ===== SIMPLE PASSWORD GATE (shared password via ENV) =====
const COOKIE_NAME = 'invexp_auth';
const COOKIE_MAX_AGE_S = 12 * 60 * 60; // 12h
const EXPECTED_TOKEN = APP_SHARED_PASSWORD
  ? crypto.createHash('sha256').update(String(APP_SHARED_PASSWORD)).digest('hex')
  : null;

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach(c => {
    const i = c.indexOf('=');
    if (i > -1) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}

if (APP_SHARED_PASSWORD) {
  console.log('[AUTH] Password protection ENABLED');

  // Login page (GET)
  app.get('/login', (req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'unsafe-inline' 'self'");
    res.send(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Inventory Report — Login</title>
<style>
  body{font:16px/1.45 system-ui,-apple-system,Segoe UI,Roboto,Arial;background:#f6f7f8;margin:0;display:grid;place-items:center;height:100vh;color:#0f172a}
  .card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:22px 20px;box-shadow:0 1px 0 rgba(15,23,42,.02);width:360px;max-width:94vw}
  h1{font-size:20px;margin:0 0 6px 0}
  p{color:#6b7280;margin:0 0 14px 0}
  label{display:block;font-size:13px;color:#6b7280;margin-bottom:6px}
  input[type=password]{width:100%;height:38px;border:1px solid #e5e7eb;border-radius:8px;padding:0 10px}
  .row{display:flex;justify-content:flex-end;margin-top:12px}
  button{height:38px;padding:0 14px;border-radius:8px;border:1px solid #2563eb;background:#2563eb;color:#fff;cursor:pointer}
  button:hover{background:#1d4ed8;border-color:#1d4ed8}
  .err{color:#ef4444;margin-top:8px;font-size:13px}
</style></head>
<body>
  <form class="card" method="post" action="/login">
    <h1>Inventory Report</h1>
    <p>Моля въведи парола за достъп.</p>
    <label for="pw">Парола</label>
    <input id="pw" name="password" type="password" autofocus required>
    <div class="row"><button type="submit">Вход</button></div>
    ${req.query.err ? '<div class="err">Грешна парола. Опитай отново.</div>' : ''}
  </form>
</body></html>`);
  });

  // Login submit (POST)
  app.post('/login', (req, res) => {
    const password = req.body?.password || '';
    const token = crypto.createHash('sha256').update(String(password)).digest('hex');
    if (token === EXPECTED_TOKEN) {
      const secure = req.headers['x-forwarded-proto'] === 'https' || process.env.NODE_ENV !== 'development';
      res.setHeader('Set-Cookie', `${COOKIE_NAME}=${EXPECTED_TOKEN}; HttpOnly; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; SameSite=Lax; ${secure?'Secure;':''}`);
      res.writeHead(302, { Location: '/' });
      res.end();
    } else {
      res.writeHead(302, { Location: '/login?err=1' });
      res.end();
    }
  });

  // Logout (optional; you said you'll add a link yourself)
  app.post('/logout', (_req, res) => {
    const secure = process.env.NODE_ENV !== 'development';
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax; ${secure?'Secure;':''}`);
    res.json({ ok: true });
  });

  // Gate (protect everything except /health and /login)
  app.use((req, res, next) => {
    if (req.path === '/health' || req.path.startsWith('/login')) return next();
    const cookies = parseCookies(req);
    if (cookies[COOKIE_NAME] && cookies[COOKIE_NAME] === EXPECTED_TOKEN) return next();
    if (req.method === 'GET') {
      res.writeHead(302, { Location: '/login' });
      return res.end();
    }
    res.status(401).json({ ok:false, error:'Unauthorized' });
  });
} else {
  console.log('[AUTH] Password protection DISABLED');
}

// ===== STATIC =====
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

// ===== DIRS =====
const EXPORT_DIR = path.join(__dirname, 'exports');
const SNAPSHOT_DIR = SNAPSHOT_DIR_ENV || path.join(__dirname, 'data', 'snapshots');
fs.mkdirSync(EXPORT_DIR, { recursive: true });
fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
console.log('[BOOT] EXPORT_DIR:', EXPORT_DIR);
console.log('[BOOT] SNAPSHOT_DIR:', SNAPSHOT_DIR);

// ===== TIME HELPERS =====
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

// ===== SHOPIFY GRAPHQL =====
const GQL_URL = `https://${SHOPIFY_SHOP}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
function truncate(s, n){ return s && s.length > n ? s.slice(0,n)+'…(truncated)' : s; }
function sanitizeVars(v){ try{ return JSON.parse(JSON.stringify(v)); }catch{ return v; } }

async function shopifyGraphQL(query, variables = {}) {
  const opName = (() => {
    const m = query.match(/\b(query|mutation)\s+([A-Za-z0-9_]+)/);
    return m ? m[2] : 'UnknownOp';
  })();

  console.log(`[GQL→] ${opName} vars=`, sanitizeVars(variables));
  const started = Date.now();

  const res = await fetch(GQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN
    },
    body: JSON.stringify({ query, variables })
  });

  let outText = '';
  try { outText = await res.text(); } catch {}
  let out = {};
  try { out = JSON.parse(outText); } catch {}

  const ms = Date.now() - started;
  if (!res.ok) {
    console.error(`[GQL✗] ${opName} HTTP ${res.status} in ${ms}ms body=`, truncate(outText, 1000));
    throw new Error(`GraphQL HTTP ${res.status}: ${outText}`);
  }
  if (out.errors) {
    console.error(`[GQL✗] ${opName} errors=`, out.errors);
    throw new Error(`GraphQL errors: ${JSON.stringify(out.errors)}`);
  }
  if (out.extensions?.cost) console.log(`[GQL$] ${opName} cost=`, out.extensions.cost);
  console.log(`[GQL✓] ${opName} in ${ms}ms`);
  return out.data;
}

// ===== QUERIES =====
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

// ===== MONGO =====
let mongoClient = null;
let mongoDb = null;

async function getDb() {
  if (mongoDb) return mongoDb;
  if (!MONGODB_URI) {
    console.warn('[MONGO] No MONGODB_URI configured — using files only.');
    return null;
  }
  mongoClient = new MongoClient(MONGODB_URI, { maxPoolSize: 5 });
  await mongoClient.connect();
  mongoDb = mongoClient.db(MONGODB_DB);
  console.log('[MONGO] Connected to', MONGODB_DB);

  // index for label (we use _id = `${label}|${variantId}` for uniqueness)
  await mongoDb.collection('snapshots_inventory').createIndex({ label: 1 });

  return mongoDb;
}

// ===== FETCHERS =====
async function fetchAllProductsAndInventory() {
  console.log('[INV] Fetching products & inventory…');
  let cursor = null, hasNext = true;
  const rows = [];
  let page = 0, totalVariants = 0;

  while (hasNext) {
    page++;
    const data = await shopifyGraphQL(PRODUCTS_PAGE_QUERY, {
      cursor,
      qtyNames: ['available']
    });

    const { edges, pageInfo } = data.products;
    console.log(`[INV] Page ${page} products=${edges.length} hasNext=${pageInfo.hasNextPage}`);

    for (const { node: p } of edges) {
      for (const vEdge of p.variants.edges) {
        const v = vEdge.node;

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
          vendorInvoiceDate: p.vendorInvoiceDate?.value || null,
          vendorInvoiceNumber: p.vendorInvoiceNumber?.value || null,
          variantId: v.id,
          variantSku: v.sku,
          unitCost: v.inventoryItem?.unitCost?.amount ?? null,
          unitCostCurrency: v.inventoryItem?.unitCost?.currencyCode ?? null,
          endingQty
        });
        totalVariants++;
      }
    }

    hasNext = pageInfo.hasNextPage;
    cursor = pageInfo.endCursor;
  }
  console.log('[INV] Done. variants(tracked)=', totalVariants, 'rows=', rows.length);
  return rows;
}

async function fetchUnitsSold(sinceISO, untilISO) {
  const toDateOnly = (s) => (s || '').split('T')[0];
  const sinceDate = toDateOnly(sinceISO);
  const untilDate = toDateOnly(untilISO);

  const q = `created_at:${sinceDate}..${untilDate} financial_status:paid -status:cancelled`;
  console.log('[ORDERS SEARCH]', q);

  let cursor = null, hasNext = true;
  const byVariant = new Map();
  let page = 0, totalOrders = 0, totalLines = 0;

  while (hasNext) {
    page++;
    const data = await shopifyGraphQL(ORDERS_PAGE_QUERY, { cursor, query: q });
    const { edges, pageInfo } = data.orders;
    console.log(`[ORD] Page ${page} orders=${edges.length} hasNext=${pageInfo.hasNextPage}`);

    for (const { node: o } of edges) {
      totalOrders++;
      for (const liEdge of o.lineItems.edges) {
        const li = liEdge.node;
        totalLines++;
        const vId = li.variant?.id || (li.sku ? `SKU:${li.sku}` : null);
        if (!vId) continue;
        byVariant.set(vId, (byVariant.get(vId) || 0) + (li.quantity || 0));
      }
    }
    hasNext = pageInfo.hasNextPage;
    cursor = pageInfo.endCursor;
  }

  console.log('[ORD] Done. orders=', totalOrders, 'lines=', totalLines, 'variantsWithSales=', byVariant.size);
  return byVariant;
}

// ===== SNAPSHOTS =====
function snapshotPath(label){ return path.join(SNAPSHOT_DIR, `${label}.json`); }

async function createSnapshot(label){
  console.log('[SNAPSHOT] Creating snapshot:', label);
  const rows = await fetchAllProductsAndInventory();

  const snapMap = new Map();
  for (const r of rows) {
    const prev = snapMap.get(r.variantId) || 0;
    snapMap.set(r.variantId, prev + (r.endingQty || 0));
  }
  const count = snapMap.size;

  // file backup
  const file = snapshotPath(label);
  const asObj = Object.fromEntries(snapMap.entries());
  fs.writeFileSync(file, JSON.stringify(asObj, null, 2));
  console.log('[SNAPSHOT] File saved:', file, 'variants=', count);

  // mongo
  const db = await getDb();
  if (db) {
    const invCol = db.collection('snapshots_inventory');
    const metaCol = db.collection('snapshots_meta');

    const ops = [];
    for (const [variantId, qty] of snapMap.entries()) {
      const _id = `${label}|${variantId}`;
      ops.push({
        updateOne: {
          filter: { _id },
          update: { $set: { _id, label, variantId, qty } },
          upsert: true
        }
      });
    }
    if (ops.length) {
      console.log('[SNAPSHOT] Mongo bulkWrite start, ops=', ops.length);
      const res = await invCol.bulkWrite(ops, { ordered: false });
      console.log('[SNAPSHOT] Mongo bulkWrite ok:', {
        upserted: res.upsertedCount,
        modified: res.modifiedCount,
        matched: res.matchedCount
      });
    }
    await metaCol.updateOne(
      { _id: label },
      { $set: { _id: label, createdAt: new Date(), count } },
      { upsert: true }
    );
    console.log('[SNAPSHOT] Mongo meta upsert ok:', { label, count });
  } else {
    console.log('[SNAPSHOT] Mongo not configured — file-only snapshot done.');
  }

  return { count, file: file.replace(__dirname, ''), absPath: file };
}

// ===== BUILD/EXPORT =====
function buildReportRows(productRows, unitsSoldMap, startSnapshot=null){
  const out = productRows.map(r=>{
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
  console.log('[BUILD] Rows built:', out.length);
  return out;
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
  console.log('[WRITE] CSV:', file, 'bytes=', fs.statSync(file).size);
  return path.basename(file, '.csv');
}

function writeXML(rows, base, columns){
  const mapped = (Array.isArray(columns) && columns.length)
    ? rows.map(r => { const o = {}; for (const c of columns) o[c] = r[c]; return o; })
    : rows;
  const xml = create({ version: '1.0' }).ele({ report: { row: mapped }}).end({ prettyPrint: true });
  const file = path.join(EXPORT_DIR, `${base}.xml`);
  fs.writeFileSync(file, xml, 'utf8');
  console.log('[WRITE] XML:', file, 'bytes=', fs.statSync(file).size);
  return path.basename(file, '.xml');
}

// ===== DOWNLOADS =====
function safeBase(name) { return String(name).replace(/[^a-zA-Z0-9._-]/g, ''); }

app.get('/download/csv/:base', (req, res) => {
  const base = safeBase(req.params.base);
  const enc = (req.query.enc || 'utf8').toLowerCase();
  const filePath = path.join(EXPORT_DIR, `${base}.csv`);
  if (!fs.existsSync(filePath)) return res.status(404).send('File not found');

  console.log('[DL] CSV', { base, enc });
  let csv = fs.readFileSync(filePath, 'utf8');
  let buf;
  if (enc === 'win1251' || enc === 'windows-1251') {
    buf = iconv.encode(csv, 'windows-1251');
    res.setHeader('Content-Type', 'text/csv; charset=windows-1251');
  } else {
    csv = '\uFEFF' + csv; // BOM for Excel
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

  console.log('[DL] XML', { base, enc });
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

// ===== ENDPOINTS =====
app.post('/snapshot', async (req, res)=>{
  try {
    console.log('[EP/snapshot] body=', req.body);
    const label = (req.body?.label) || labelForTodayTZ(TIMEZONE);
    const out = await createSnapshot(label);
    res.json({ ok:true, label, ...out, path:`/data/snapshots/${label}.json` });
  } catch(e){
    console.error('[SNAPSHOT✗]', e?.stack || String(e));
    res.status(500).json({ ok:false, error:String(e) });
  }
});

app.post('/report', async (req,res)=>{
  try{
    console.log('[EP/report] body=', req.body);
    const { since, until, startSnapshotLabel, columns } = req.body||{};
    if(!since||!until) {
      return res.status(400).json({ ok:false, error:'Missing since/until (ISO)' });
    }

    const [products, soldMap] = await Promise.all([
      fetchAllProductsAndInventory(),
      fetchUnitsSold(since, until)
    ]);
    console.log('[REPORT] products rows=', products.length, 'sold variants=', soldMap.size);

    // Load start snapshot: Mongo first, fall back to file
    let startSnapshot=null;
    if(startSnapshotLabel){
      const db = await getDb();
      if (db) {
        console.log('[REPORT] Loading snapshot from Mongo for', startSnapshotLabel);
        const invCol = db.collection('snapshots_inventory');
        const cursor = invCol.find(
          { label: startSnapshotLabel },
          { projection: { variantId: 1, qty: 1 } }
        );
        startSnapshot = {};
        let cnt = 0;
        for await (const doc of cursor) {
          startSnapshot[doc.variantId] = doc.qty;
          cnt++;
        }
        console.log('[REPORT] Mongo snapshot loaded. entries=', cnt);
        if (cnt === 0) {
          console.warn('[REPORT] Mongo snapshot empty for label, will try file:', startSnapshotLabel);
          startSnapshot = null;
        }
      } else {
        console.log('[REPORT] Mongo not configured — will try file snapshot.');
      }

      if (!startSnapshot) {
        const p = snapshotPath(startSnapshotLabel);
        if (fs.existsSync(p)) {
          const raw = fs.readFileSync(p,'utf8');
          startSnapshot = JSON.parse(raw);
          console.log('[REPORT] Loaded snapshot FILE', p, 'keys=', Object.keys(startSnapshot).length);
        } else {
          console.warn('[REPORT] Snapshot not found (Mongo+file):', startSnapshotLabel);
        }
      }
    } else {
      console.log('[REPORT] No startSnapshotLabel provided');
    }

    const rows = buildReportRows(products, soldMap, startSnapshot);
    const stamp = new Date().toISOString().replace(/[:.]/g,'-');
    const base = `inventory-report_${stamp}`;

    const csvBase = writeCSV(rows, base, columns);
    const xmlBase = writeXML(rows, base, columns);

    const payload = {
      ok: true,
      rows: rows.length,
      csv: `/download/csv/${csvBase}?enc=utf8`,
      xml: `/download/xml/${xmlBase}?enc=utf8`,
      csv_win1251: `/download/csv/${csvBase}?enc=win1251`,
      xml_win1251: `/download/xml/${xmlBase}?enc=win1251`,
      columns: columns && columns.length ? columns : undefined,
      sample: rows.slice(0, 50)
    };
    console.log('[REPORT] Done. files=', { csv: payload.csv, xml: payload.xml });
    res.json(payload);
  } catch(e){
    console.error('[REPORT✗]', e?.stack || String(e));
    res.status(500).json({ ok:false, error:String(e) });
  }
});

// ===== CRON: 11:59:59 локално време (1-во, 10-то, 20-то, последен ден) =====
cron.schedule('59 59 11 1 * *', async () => {
  try { const label = labelForTodayTZ(TIMEZONE); console.log('[CRON] (1st)', label); await createSnapshot(label); }
  catch (e) { console.error('[CRON 1st✗]', e?.stack || String(e)); }
}, { timezone: TIMEZONE });

cron.schedule('59 59 11 10 * *', async () => {
  try { const label = labelForTodayTZ(TIMEZONE); console.log('[CRON] (10th)', label); await createSnapshot(label); }
  catch (e) { console.error('[CRON 10th✗]', e?.stack || String(e)); }
}, { timezone: TIMEZONE });

cron.schedule('59 59 11 20 * *', async () => {
  try { const label = labelForTodayTZ(TIMEZONE); console.log('[CRON] (20th)', label); await createSnapshot(label); }
  catch (e) { console.error('[CRON 20th✗]', e?.stack || String(e)); }
}, { timezone: TIMEZONE });

cron.schedule('59 59 11 28-31 * *', async () => {
  try {
    const label = labelForTodayTZ(TIMEZONE);
    if (!isLastDayOfMonthTZ(TIMEZONE)) { console.log('[CRON] skipped (not last day)'); return; }
    console.log('[CRON] (last-of-month)', label);
    await createSnapshot(label);
  } catch (e) { console.error('[CRON last✗]', e?.stack || String(e)); }
}, { timezone: TIMEZONE });

// ===== START =====
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on :${PORT}`);
  if (APP_URL) console.log(`App URL: ${APP_URL}`);
});
