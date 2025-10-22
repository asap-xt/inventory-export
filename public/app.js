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

const tzEl = document.getElementById("tz");
tzEl.textContent = Intl.DateTimeFormat().resolvedOptions().timeZone;

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
  // accept 01/10/2025, 2025-10-01, etc.
  const s = d.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;        // YYYY-MM-DD
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {               // DD/MM/YYYY
    const [dd, mm, yy] = s.split("/");
    return `${yy}-${mm}-${dd}`;
  }
  return s;
}
function toISODateTime(s) {
  // allow "YYYY-MM-DDTHH:mm:ssZ" or "DD/MM/YYYY, HH:mm"
  if (!s) return "";
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4}),?\s+(\d{2}):(\d{2})$/);
  if (m) {
    const [_, dd, mm, yyyy, HH, MM] = m;
    // assume local tz → convert to UTC Z
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
  const res = await fetch("/snapshot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (json.ok) {
    snapshotResult.innerHTML = `✅ Snapshot <code>${json.label}</code> saved (${json.count} variants).`;
  } else {
    snapshotResult.innerHTML = `❌ ${json.error || "Error"}`;
  }
};

// REPORT
const reportForm = document.getElementById("reportForm");
const sinceEl = document.getElementById("since");
const untilEl = document.getElementById("until");
const startLabelEl = document.getElementById("startLabel");
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

  const res = await fetch("/report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();

  if (!json.ok) {
    linksEl.innerHTML = `❌ ${json.error || "Error"}`;
    return;
  }

  // links
  linksEl.innerHTML = `
    ✅ Rows: <strong>${json.rows}</strong> &nbsp;—&nbsp;
    <a href="${json.csv}" target="_blank">Download CSV</a> &nbsp;|&nbsp;
    <a href="${json.xml}" target="_blank">Download XML</a>
  `;

  // preview table (first 50 rows for speed)
  const rows = json.sample && json.sample.length ? json.sample : [];
  if (!rows.length) return;

  const cols = body.columns && body.columns.length ? body.columns : COLUMNS;
  const thead = `<thead><tr>${cols.map(c=>`<th>${c}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${rows.slice(0,50).map(r=>{
    return `<tr>${cols.map(c=>`<td>${(r[c] ?? "")}</td>`).join("")}</tr>`;
  }).join("")}</tbody>`;
  previewEl.innerHTML = `<div class="table-wrap"><table>${thead}${tbody}</table></div>`;
};
