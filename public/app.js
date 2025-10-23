// === Columns (all pre-selected) ===
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
const tzEl = document.getElementById("tz");
if (tzEl) tzEl.textContent = Intl.DateTimeFormat().resolvedOptions().timeZone;

// --- Toast helper ---
function showToast(title, message = "", type = "success", timeoutMs = 3500) {
  const root = document.getElementById("toast-root");
  if (!root) return;
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

// Глобален error catcher (за по-лесен дебъг в бъдеще)
window.addEventListener("error", (e) => {
  showToast("UI error", String(e.message || e.error || e), "error", 6000);
});

// Build column chips
const colBar = document.getElementById("columnsBar");
if (colBar) {
  COLUMNS.forEach((c) => {
    const id = `col_${c}`;
    const wrap = document.createElement("label");
    wrap.className = "chip";
    wrap.innerHTML = `
      <input type="checkbox" id="${id}" checked />
      <span>${c}</span>
    `;
    colBar.appendChild(wrap);
  });
}

// === Dates helpers ===
function toYMD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
// start: 00:00:01 local
function isoStartOfDayPlusOne(dateYMD) {
  const [y, m, d] = dateYMD.split("-").map(n => parseInt(n, 10));
  const dt = new Date(y, m - 1, d, 0, 0, 1);
  return new Date(dt.getTime() - dt.getTimezoneOffset() * 60000)
    .toISOString()
    .replace(/\.\d+Z$/, "Z");
}
// end: 23:59:59 local, or now if today
function isoEndOfDayOrNow(dateYMD) {
  const [y, m, d] = dateYMD.split("-").map(n => parseInt(n, 10));
  const today = toYMD(new Date());
  if (dateYMD === today) {
    return new Date().toISOString().replace(/\.\d+Z$/, "Z");
  }
  const dt = new Date(y, m - 1, d, 23, 59, 59);
  return new Date(dt.getTime() - dt.getTimezoneOffset() * 60000)
    .toISOString()
    .replace(/\.\d+Z$/, "Z");
}

// ===== SNAPSHOT (optional manual) =====
const snapshotForm = document.getElementById("snapshotForm");
const snapshotDate = document.getElementById("snapshotDate");
const snapshotResult = document.getElementById("snapshotResult");

const todayBtn = document.getElementById("snapshotToday");
if (todayBtn) {
  todayBtn.onclick = () => { snapshotDate.value = toYMD(new Date()); };
}
const somBtn = document.getElementById("snapshotStartOfMonth");
if (somBtn) {
  somBtn.onclick = () => {
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    snapshotDate.value = toYMD(first);
  };
}

if (snapshotForm) {
  snapshotForm.onsubmit = async (e) => {
    e.preventDefault();
    if (snapshotResult) snapshotResult.textContent = "Working…";
    const label = snapshotDate?.value || toYMD(new Date());
    try {
      const res = await fetch("/snapshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      });
      const json = await res.json();
      if (json.ok) {
        if (snapshotResult)
          snapshotResult.innerHTML = `✅ Snapshot <code>${json.label}</code> saved (${json.count} variants).`;
        showToast("Snapshot created", `Label: ${json.label} · Variants: ${json.count}`, "success");
      } else {
        if (snapshotResult) snapshotResult.innerHTML = `❌ ${json.error || "Error"}`;
        showToast("Snapshot failed", json.error || "Error", "error", 6000);
      }
    } catch (err) {
      if (snapshotResult) snapshotResult.innerHTML = `❌ ${err.message || err}`;
      showToast("Snapshot failed", String(err.message || err), "error", 6000);
    }
  };
}

// ===== REPORT =====
const reportForm = document.getElementById("reportForm");
const sinceDateEl = document.getElementById("sinceDate");
const untilDateEl = document.getElementById("untilDate");
const startLabelDateEl = document.getElementById("startLabelDate");
const encSel = document.getElementById("encoding");
const linksEl = document.getElementById("reportLinks");
const previewEl = document.getElementById("reportPreview");

// Presets
const presetLast = document.getElementById("presetLastMonth");
if (presetLast) {
  presetLast.onclick = () => {
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const last = new Date(now.getFullYear(), now.getMonth(), 0);
    sinceDateEl.value = toYMD(first);
    untilDateEl.value = toYMD(last);
    startLabelDateEl.value = toYMD(first);
  };
}
const presetThis = document.getElementById("presetThisMonth");
if (presetThis) {
  presetThis.onclick = () => {
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    sinceDateEl.value = toYMD(first);
    untilDateEl.value = toYMD(now);
    startLabelDateEl.value = toYMD(first);
  };
}

if (reportForm) {
  reportForm.onsubmit = async (e) => {
    e.preventDefault();
    if (linksEl) linksEl.textContent = "Working…";
    if (previewEl) previewEl.innerHTML = "";

    const sinceYMD = sinceDateEl.value;
    const untilYMD = untilDateEl.value;
    if (!sinceYMD || !untilYMD) {
      if (linksEl) linksEl.textContent = "Please choose both dates.";
      showToast("Missing dates", "Please choose both since and until.", "error");
      return;
    }

    const sinceISO = isoStartOfDayPlusOne(sinceYMD);
    const untilISO = isoEndOfDayOrNow(untilYMD);
    const startLabel = startLabelDateEl.value || "";

    const selected = COLUMNS.filter(c => {
      const el = document.getElementById(`col_${c}`);
      return el && el.checked;
    });

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
        if (linksEl) linksEl.innerHTML = `❌ ${json.error || "Error"}`;
        showToast("Report failed", json.error || "Error", "error", 6000);
        return;
      }

      const enc = encSel?.value || "utf8";
      const csvUrl = enc === "win1251" && json.csv_win1251 ? json.csv_win1251 : json.csv;
      const xmlUrl = enc === "win1251" && json.xml_win1251 ? json.xml_win1251 : json.xml;

      if (linksEl) {
        linksEl.innerHTML = `
          ✅ Rows: <strong>${json.rows}</strong> &nbsp;—&nbsp;
          <a href="${csvUrl}" download>Download CSV</a> &nbsp;|&nbsp;
          <a href="${xmlUrl}" download>Download XML</a>
        `;
      }

      // preview table (first 50 rows)
      const rows = json.sample && json.sample.length ? json.sample : [];
      if (rows.length && previewEl) {
        const cols = body.columns && body.columns.length ? body.columns : COLUMNS;
        const thead = `<thead><tr>${cols.map(c=>`<th>${c}</th>`).join("")}</tr></thead>`;
        const tbody = `<tbody>${rows.slice(0,50).map(r=>{
          return `<tr>${cols.map(c=>`<td>${(r[c] ?? "")}</td>`).join("")}</tr>`;
        }).join("")}</tbody>`;
        previewEl.innerHTML = `<div class="table-wrap"><table>${thead}${tbody}</table></div>`;
      }

      showToast("Report ready", `Rows: ${json.rows}. Pick CSV/XML to download.`, "success");
    } catch (err) {
      if (linksEl) linksEl.innerHTML = `❌ ${err.message || err}`;
      showToast("Report failed", String(err.message || err), "error", 6000);
    }
  };
}
