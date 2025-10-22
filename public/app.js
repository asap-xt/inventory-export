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

// === Dates helpers ===
// return "YYYY-MM-DD"
function toYMD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Build ISO from local date boundaries:
// start: 00:00:01 local; end: 23:59:59 local (or now if until=today)
function isoStartOfDayPlusOne(dateYMD) {
  const [y, m, d] = dateYMD.split("-").map(n => parseInt(n, 10));
  const dt = new Date(y, m - 1, d, 0, 0, 1); // local 00:00:01
  return new Date(dt.getTime() - dt.getTimezoneOffset() * 60000)
    .toISOString()
    .replace(/\.\d+Z$/, "Z");
}
function isoEndOfDayOrNow(dateYMD) {
  const [y, m, d] = dateYMD.split("-").map(n => parseInt(n, 10));
  const today = toYMD(new Date());
  if (dateYMD === today) {
    // now (UTC)
    return new Date().toISOString().replace(/\.\d+Z$/, "Z");
  }
  const dt = new Date(y, m - 1, d, 23, 59, 59); // local 23:59:59
  return new Date(dt.getTime() - dt.getTimezoneOffset() * 60000)
    .toISOString()
    .replace(/\.\d+Z$/, "Z");
}

// ===== SNAPSHOT (optional) =====
const snapshotForm = document.getElementById("snapshotForm");
const snapshotDate = document.getElementById("snapshotDate");
const snapshotResult = document.getElementById("snapshotResult");

document.getElementById("snapshotToday").onclick = () => {
  snapshotDate.value = toYMD(new Date());
};
document.getElementById("snapshotStartOfMonth").onclick = () => {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  snapshotDate.value = toYMD(first);
};

snapshotForm.onsubmit = async (e) => {
  e.preventDefault();
  snapshotResult.textContent = "Working…";
  const label = snapshotDate.value || toYMD(new Date());
  try {
    const res = await fetch("/snapshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label }),
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

// ===== REPORT =====
const reportForm = document.getElementById("reportForm");
const sinceDateEl = document.getElementById("sinceDate");
const untilDateEl = document.getElementById("untilDate");
const startLabelDateEl = document.getElementById("startLabelDate");
const encSel = document.getElementById("encoding");
const linksEl = document.getElementById("reportLinks");
const previewEl = document.getElementById("reportPreview");

// Presets
document.getElementById("presetLastMonth").onclick = () => {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const last = new Date(now.getFullYear(), now.getMonth(), 0);
  sinceDateEl.value = toYMD(first);
  untilDateEl.value = toYMD(last);
  startLabelDateEl.value = toYMD(first);
};
document.getElementById("presetThisMonth").onclick = () => {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  sinceDateEl.value = toYMD(first);
  untilDateEl.value = toYMD(now);
  startLabelDateEl.value = toYMD(first);
};

reportForm.onsubmit = async (e) => {
  e.preventDefault();
  linksEl.textContent = "Working…";
  previewEl.innerHTML = "";

  const sinceYMD = sinceDateEl.value;
  const untilYMD = untilDateEl.value;
  if (!sinceYMD || !untilYMD) {
    linksEl.textContent = "Please choose both dates.";
    showToast("Missing dates", "Please choose both since and until.", "error");
    return;
  }

  const sinceISO = isoStartOfDayPlusOne(sinceYMD);
  const untilISO = isoEndOfDayOrNow(untilYMD);
  const startLabel = startLabelDateEl.value || "";

  const selected = COLUMNS.filter(c => document.getElementById(`col_${c}`).checked);
  const body = {
    since: sinceISO,
    until: untilISO,
    startSnapshotLabel: startLabel || undefined,
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
