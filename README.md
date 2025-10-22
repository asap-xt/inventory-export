# Inventory Report (Custom Shopify App)

Custom single‑store app that builds an inventory sales report with **Vendor**, **custom product metafields** (invoice date/number), **title**, **SKU**, **unit cost**, **starting/ending qty** and **units sold** — with CSV/XML export and a simple UI.

## 1) Create a Custom App in your store
1. In your store: **Settings → Apps and sales channels → Develop apps** → **Create an app**.
2. **Configure Admin API scopes:** `read_products`, `read_inventory`, `read_orders`, `read_locations`.
3. **Install app** and copy the **Admin API access token** (starts with `shpat_`).
4. In the app’s **App setup** section:
- **App URL** = `https://YOUR-RAILWAY-URL/`
- **Embedded in Shopify admin** = Enabled (the server sends `frame-ancestors` CSP).

> No OAuth needed (single store). We call Admin GraphQL from the server using the token.

## 2) Configure environment
Create `.env` from `.env.example` and fill:
