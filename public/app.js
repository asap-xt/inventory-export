function toISOFromLocal(dtLocal) {
// dtLocal is e.g. "2025-10-01T00:00" from <input type="datetime-local">
if (!dtLocal) return null;
const d = new Date(dtLocal);
return d.toISOString();
}

async function createSnapshot() {
const label = document.getElementById('snapshot-date').value || new Date().toISOString().slice(0,10);
const res = await fetch('/snapshot', { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify({ label }) });
const data = await res.json();
alert(data.ok ? `Snapshot saved for ${label}` : `Error: ${data.error}`);
}

document.getElementById('btn-snapshot').addEventListener('click', createSnapshot);

document.getElementById('btn-report').addEventListener('click', async () => {
const since = toISOFromLocal(document.getElementById('since').value);
const until = toISOFromLocal(document.getElementById('until').value);
const startSnapshotLabel = document.getElementById('start-snap').value || undefined;
const columns = Array.from(document.querySelectorAll('input.col:checked')).map(i => i.value);

const status = document.getElementById('status');
status.textContent = 'Working…';

const res = await fetch('/report', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ since, until, startSnapshotLabel, columns })
});
const data = await res.json();
if (!data.ok) {
status.textContent = 'Error';
alert(data.error || 'Error');
return;
}

status.textContent = `Rows: ${data.rows}`;
const downloads = document.getElementById('downloads');
downloads.innerHTML = '';
const a1 = document.createElement('a'); a1.href = data.csv; a1.textContent = 'Download CSV'; a1.target = '_blank';
const a2 = document.createElement('a'); a2.href = data.xml; a2.textContent = 'Download XML'; a2.target = '_blank';
downloads.appendChild(a1); downloads.appendChild(a2);

// Render preview table
const table = document.getElementById('table');
const cols = columns && columns.length ? columns : ['vendor','vendor_invoice_date','vendor_invoice_number','product_title','product_variant_sku','unit_cost','unit_cost_currency','starting_inventory_qty','ending_inventory_qty','units_sold'];
const sample = data.sample || [];

const thead = `<thead><tr>${cols.map(c => `<th>${c}</th>`).join('')}</tr></thead>`;
const tbody = `<tbody>${sample.map(r => `<tr>${cols.map(c => `<td>${r[c] ?? ''}</td>`).join('')}</tr>`).join('')}</tbody>`;
table.innerHTML = thead + tbody;
});