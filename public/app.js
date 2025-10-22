const COLUMNS = [
  "vendor",
  "vendor_invoice_date",
  "vendor_invoice_number",
  "product_title",
  "product_variant_sku",
  "unit_cost",
  "unit_cost_currency",
  "starting_inventory_qty",
  "ending_inventory_qty",
  "units_sold",
];

// footer timezone
document.getElementById("tz").textContent =
  Intl.DateTimeFormat().resolvedOptions().timeZone;

// --- Toast helper ---
function showToast(title, message = "", type = "success", timeoutMs = 3500) {
  const root = document.getElementById("toast-root");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = `
    <div>
      <h4>${title}</h4>
      ${message ? `<p>${message}</p>` : ""}
    </div>
    <button class="close" aria-label="Close">&times;</button>
  `;
  el.querySelector(".close").onclick = () => root.removeChild(el);
  root.appendChild(el);
  if (timeoutMs) setTimeout(() => {
    if (root.contains(el)) root.removeChild(el);
  }, timeoutMs);
}

// Build column chips
const colBar = document.getElementById("columnsBar");
COLUMNS.forEach((c, i) => {
  const id = `col_${c}`;
  const wrap = document.createElement("label");
  wrap.className = "chip";
  wrap.innerHTML = `
    <input type="checkbox" id="${id}" ${i !== 6 ? "checked" : ""}/>
    <span>${c}</span>
  `;
  colBar.appendChild(wrap);
});

// Helpers
function toISODate(d) {
  if (!d) return "";
  const s = d.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;        // YYYY-MM-DD
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {               // DD/MM/YYYY
    const [dd, mm, yy] = s.split("/");
    return `${yy}-${mm}-${dd}`;
  }
  return s;
}
function toISODateTime(s) {
  if (!s) return "";
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4}),?\s+(\d{2}):(\d{2})$/);
  if (m) {
    const [_, dd, mm, yyyy, HH, MM] = m;
    const dt = new Date(`${yyyy}-${mm}-${dd}T${HH}:${MM}:00`);
    return new Date(dt.getTime() - dt.getTimezoneOffset() * 60000)
      .toISOString()
      .replace(/\.\d+Z$/, "Z");
  }
  return s;
}

// SNAPSHOT
const snapshotForm = document.getElementById("snapshotForm");
const snapshotLabel = document.getElementById("snapshotLabel");
const snapshotResult = document.getElementById("snapshotResult");

document.getElementById("snapshotToday").onclick = () => {
  const now = new Date();
  snapshotLabel.value = now.toISOString().slice(0, 10);
};
document.getElementById("snapshotStartOfMonth").onclick = () => {
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  snapshotLabel.value = first.toISOString().slice(0, 10);
};

snapshotForm.onsubmit = async (e) => {
  e.preventDefault();
  snapshotResult.textContent = "Working…";
  const label = toISODate(snapshotLabel.value);
  const body = label ? { label } : {};
  try {
    const res = await fetch("/snapshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (json.ok) {
      snapshotResult.innerHTML = `✅ Snapshot <code>${json.label}</code> saved (${json.count} variants).`;
      showToast("Snapshot created", `Label: ${json.label} · Variants: ${json.count}`, "success");
    } else {
      snapshotResult.innerHTML = `❌ ${json.error || "Error"}`;
      showToast("Snapshot failed", json.error || "Error", "error", 6000);
    }
  } catch (err) {
    snapshotResult.innerHTML = `❌ ${err.message || err}`;
    showToast("Snapshot failed", String(err.message || err), "error", 6000);
  }
};

// REPORT
const reportForm = document.getElementById("reportForm");
const sinceEl = document.getElementById("since");
const untilEl = document.getElementById("until");
const startLabelEl = document.getElementById("startLabel");
const encSel = document.getElementById("encoding");
const linksEl = document.getElementById("reportLinks");
const previewEl = document.getElementById("reportPreview");

// Presets
document.getElementById("presetLastMonth").onclick = () => {
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0, 23, 59, 59));
  sinceEl.value = `${first.toISOString().slice(0,10)}T00:00:00Z`;
  untilEl.value = `${last.toISOString().slice(0,19)}Z`;
  startLabelEl.value = first.toISOString().slice(0,10);
};
document.getElementById("presetThisMonth").onclick = () => {
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  sinceEl.value = `${first.toISOString().slice(0,10)}T00:00:00Z`;
  untilEl.value = new Date().toISOString().slice(0,19) + "Z";
  startLabelEl.value = first.toISOString().slice(0,10);
};

reportForm.onsubmit = async (e) => {
  e.preventDefault();
  linksEl.textContent = "Working…";
  previewEl.innerHTML = "";

  const selected = COLUMNS.filter(c => document.getElementById(`col_${c}`).checked);
  const body = {
    since: toISODateTime(sinceEl.value),
    until: toISODateTime(untilEl.value),
    startSnapshotLabel: toISODate(startLabelEl.value),
    columns: selected
  };

  try {
    const res = await fetch("/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();

    if (!json.ok) {
      linksEl.innerHTML = `❌ ${json.error || "Error"}`;
      showToast("Report failed", json.error || "Error", "error", 6000);
      return;
    }

    const enc = encSel.value || "utf8";
    const csvUrl = enc === "win1251" && json.csv_win1251 ? json.csv_win1251 : json.csv;
    const xmlUrl = enc === "win1251" && json.xml_win1251 ? json.xml_win1251 : json.xml;

    linksEl.innerHTML = `
      ✅ Rows: <strong>${json.rows}</strong> &nbsp;—&nbsp;
      <a href="${csvUrl}" download>Download CSV</a> &nbsp;|&nbsp;
      <a href="${xmlUrl}" download>Download XML</a>
    `;

    // preview table (first 50 rows)
    const rows = json.sample && json.sample.length ? json.sample : [];
    if (rows.length) {
      const cols = body.columns && body.columns.length ? body.columns : COLUMNS;
      const thead = `<thead><tr>${cols.map(c=>`<th>${c}</th>`).join("")}</tr></thead>`;
      const tbody = `<tbody>${rows.slice(0,50).map(r=>{
        return `<tr>${cols.map(c=>`<td>${(r[c] ?? "")}</td>`).join("")}</tr>`;
      }).join("")}</tbody>`;
      previewEl.innerHTML = `<div class="table-wrap"><table>${thead}${tbody}</table></div>`;
    } else {
      previewEl.innerHTML = "";
    }

    showToast("Report ready", `Rows: ${json.rows}. Pick CSV/XML to download.`, "success");
  } catch (err) {
    linksEl.innerHTML = `❌ ${err.message || err}`;
    showToast("Report failed", String(err.message || err), "error", 6000);
  }
};
