const DB_NAME = "captura-gastos";
const DB_VERSION = 1;
const STORE = "movimientos";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
        store.createIndex("fecha", "fecha", { unique: false });
        store.createIndex("exportado", "exportado", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    const result = fn(store);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
  });
}

function addMovimiento(data) {
  return withStore("readwrite", (store) => store.add(data));
}

function deleteMovimiento(id) {
  return withStore("readwrite", (store) => store.delete(id));
}

async function getAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function markExportados(ids) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    ids.forEach((id) => {
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const record = getReq.result;
        if (record) {
          record.exportado = true;
          store.put(record);
        }
      };
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function todayISO() {
  const d = new Date();
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d - tz).toISOString().slice(0, 10);
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function buildCSV(rows) {
  const header = ["Date", "Payee", "Category", "Notes", "Amount"];
  const lines = [header.join(",")];
  for (const r of rows) {
    const signedAmount = (r.tipo === "gasto" ? -1 : 1) * Number(r.monto);
    lines.push(
      [
        csvEscape(r.fecha),
        csvEscape(r.comercio),
        csvEscape(r.categoria),
        csvEscape(r.nota),
        csvEscape(signedAmount.toFixed(2)),
      ].join(",")
    );
  }
  return lines.join("\n") + "\n";
}

async function exportRows(rows, filename, statusEl) {
  if (rows.length === 0) {
    statusEl.textContent = "Nada que exportar.";
    return;
  }
  const csv = buildCSV(rows);
  const blob = new Blob([csv], { type: "text/csv" });
  const file = new File([blob], filename, { type: "text/csv" });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      // OJO: no agregar "text" aquí. Al compartir files+text juntos, WhatsApp
      // se queda solo con el texto y descarta el archivo (bug reproducido).
      await navigator.share({ files: [file] });
      await markExportados(rows.map((r) => r.id));
      statusEl.textContent = `Compartido: ${filename} (${rows.length} movimientos).`;
      return;
    } catch (err) {
      if (err && err.name === "AbortError") {
        statusEl.textContent = "Compartir cancelado, el archivo no se marcó como exportado.";
        return;
      }
      // fall through to download fallback
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  await markExportados(rows.map((r) => r.id));
  statusEl.textContent = `Descargado: ${filename} (${rows.length} movimientos).`;
}

function render(rows, listEl, totalEl, fecha, cuenta) {
  listEl.innerHTML = "";
  let total = 0;
  const filtered = rows
    .filter((r) => r.fecha === fecha && r.cuenta === cuenta)
    .sort((a, b) => b.id - a.id);

  for (const r of filtered) {
    const signed = (r.tipo === "gasto" ? -1 : 1) * Number(r.monto);
    total += signed;

    const li = document.createElement("li");
    li.className = "row" + (r.exportado ? " exportado" : "");

    const info = document.createElement("div");
    info.className = "row-info";
    info.innerHTML = `
      <div class="row-main">
        <span class="monto ${r.tipo}">${signed < 0 ? "-" : "+"}$${Math.abs(signed).toFixed(2)}</span>
        <span class="categoria">${r.categoria || "Sin categoría"}</span>
      </div>
      <div class="row-sub">${r.comercio || ""}${r.nota ? " · " + r.nota : ""}${r.exportado ? " · exportado" : ""}</div>
    `;

    const del = document.createElement("button");
    del.className = "btn-del";
    del.textContent = "✕";
    del.onclick = async () => {
      await deleteMovimiento(r.id);
      refresh();
    };

    li.appendChild(info);
    li.appendChild(del);
    listEl.appendChild(li);
  }

  totalEl.textContent = `Total del día: ${total < 0 ? "-" : ""}$${Math.abs(total).toFixed(2)}`;
}

let cachedRows = [];

async function refresh() {
  cachedRows = await getAll();
  const fecha = document.getElementById("filtro-fecha").value || todayISO();
  const cuenta = document.getElementById("filtro-cuenta").value;
  render(cachedRows, document.getElementById("lista"), document.getElementById("total"), fecha, cuenta);
}

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

window.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("form-captura");
  const fechaInput = document.getElementById("fecha");
  const cuentaInput = document.getElementById("cuenta");
  const filtroFecha = document.getElementById("filtro-fecha");
  const filtroCuenta = document.getElementById("filtro-cuenta");
  const statusEl = document.getElementById("status");

  fechaInput.value = todayISO();
  filtroFecha.value = todayISO();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const monto = parseFloat(document.getElementById("monto").value);
    if (!monto || monto <= 0) {
      statusEl.textContent = "Ingresa un monto válido.";
      return;
    }
    const data = {
      fecha: fechaInput.value || todayISO(),
      cuenta: cuentaInput.value,
      tipo: document.querySelector('input[name="tipo"]:checked').value,
      monto,
      categoria: document.getElementById("categoria").value,
      comercio: document.getElementById("comercio").value.trim(),
      nota: document.getElementById("nota").value.trim(),
      exportado: false,
      creadoEn: new Date().toISOString(),
    };
    await addMovimiento(data);
    document.getElementById("monto").value = "";
    document.getElementById("comercio").value = "";
    document.getElementById("nota").value = "";
    statusEl.textContent = "Guardado.";
    filtroFecha.value = data.fecha;
    filtroCuenta.value = data.cuenta;
    await refresh();
  });

  filtroFecha.addEventListener("change", refresh);
  filtroCuenta.addEventListener("change", refresh);

  document.getElementById("btn-exportar-dia").addEventListener("click", async () => {
    const fecha = filtroFecha.value || todayISO();
    const cuenta = filtroCuenta.value;
    const rows = cachedRows.filter((r) => r.fecha === fecha && r.cuenta === cuenta);
    await exportRows(rows, `gastos_${slug(cuenta)}_${fecha}.csv`, statusEl);
    await refresh();
  });

  document.getElementById("btn-exportar-pendientes").addEventListener("click", async () => {
    const cuenta = filtroCuenta.value;
    const rows = cachedRows.filter((r) => !r.exportado && r.cuenta === cuenta);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    await exportRows(rows, `gastos_${slug(cuenta)}_pendientes_${stamp}.csv`, statusEl);
    await refresh();
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./service-worker.js");
  }

  refresh();
});
