import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import { Parser as Json2CsvParser } from 'json2csv';
import { create } from 'xmlbuilder2';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const {
SHOPIFY_SHOP,
SHOPIFY_ADMIN_TOKEN,
SHOPIFY_API_VERSION = '2024-10',
PORT = 3000,
TIMEZONE = 'UTC',
APP_URL = ''
} = process.env;

if (!SHOPIFY_SHOP || !SHOPIFY_ADMIN_TOKEN) {
console.error('Missing SHOPIFY_SHOP or SHOPIFY_ADMIN_TOKEN in .env');
process.exit(1);
}

const app = express();
app.use(express.json({ limit: '2mb' }));

// ——— Embed in Shopify Admin ———
app.use((req, res, next) => {
res.setHeader('Content-Security-Policy', "frame-ancestors https://admin.shopify.com https://*.myshopify.com");
// Shopify often loads with ?shop & host params; we don’t strictly need to validate them for this internal app
next();
});

// Optional: simple basic auth gate for the whole app (uncomment to enable)
// const { BASIC_AUTH_USER, BASIC_AUTH_PASS } = process.env;
// if (BASIC_AUTH_USER && BASIC_AUTH_PASS) {
// app.use((req, res, next) => {
// const auth = req.headers.authorization || '';
// if (!auth.startsWith('Basic ')) {
// res.setHeader('WWW-Authenticate', 'Basic realm="Restricted"');
// return res.status(401).end('Auth required');
// }
// const [user, pass] = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
// if (user === BASIC_AUTH_USER && pass === BASIC_AUTH_PASS) return next();
// res.setHeader('WWW-Authenticate', 'Basic realm="Restricted"');
// return res.status(401).end('Unauthorized');
// });
// }

// ——— Static files (UI) ———
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

// Serve generated files
const EXPORT_DIR = path.join(__dirname, 'exports');
const SNAPSHOT_DIR = path.join(__dirname, 'data', 'snapshots');
fs.mkdirSync(EXPORT_DIR, { recursive: true });
fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
app.use('/exports', express.static(EXPORT_DIR));

/* ---------------- Shopify GraphQL helper ---------------- */
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
const out = await res.json();
if (out.errors) throw new Error(JSON.stringify(out.errors));
return out.data;
}
});