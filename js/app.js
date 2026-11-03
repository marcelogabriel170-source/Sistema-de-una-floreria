const API = "/api";
// Moneda: Soles (PEN). Se mantiene el nombre "euro" para no romper las páginas que ya lo usan.
const euro = value => "S/ " + new Intl.NumberFormat("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value || 0));
const dateTime = value => value ? new Intl.DateTimeFormat("es-ES", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—";
const dateOnly = value => value ? new Intl.DateTimeFormat("es-ES", { dateStyle: "medium" }).format(new Date(value)) : "—";
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[ch]));
async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || "No se pudo completar la operación.");
  return payload;
}
function showMessage(target, message, type = "success") {
  const el = typeof target === "string" ? document.getElementById(target) : target;
  if (!el) return;
  el.innerHTML = `<div class="notice ${type}" role="status">${escapeHtml(message)}</div>`;
  if (type === "success") setTimeout(() => { if (el.isConnected) el.innerHTML = ""; }, 4500);
}
function setActiveNav() {
  const current = window.PAGE_NAME || location.pathname.split("/").pop();
  document.querySelectorAll(".nav a").forEach(a => a.classList.toggle("active", a.dataset.page === current));
  const active = document.querySelector(".nav a.active");
  const crumb = document.getElementById("breadcrumb");
  if (crumb && active) crumb.textContent = active.textContent.trim();
}
function emptyRow(colspan, message) { return `<tr><td colspan="${colspan}" class="empty">${escapeHtml(message)}</td></tr>`; }
function productIcon(category) {
  return ({ "Ramos":"💐", "Flores":"🌹", "Plantas":"🪴", "Accesorios":"🏺", "Decoración":"🎀" })[category] || "🌷";
}
document.addEventListener("DOMContentLoaded", setActiveNav);

// ---------- Stock mínimo y alerta de rosas ----------
// Stock mínimo general: 5. Las rosas avisan antes: con 10 o menos hay que pedir más.
const STOCK_MINIMO = 5, STOCK_MINIMO_ROSAS = 10;
const esRosa = p => p.code === "ROS-001" || /^rosas?\b/.test(String(p.name || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim());
const stockMinimo = p => esRosa(p) ? STOCK_MINIMO_ROSAS : STOCK_MINIMO;

// Ventana de alerta: dice cuántas rosas quedan y a qué proveedor pedir (nombre y teléfono)
async function mostrarAlertasStock() {
  let alerts;
  try { alerts = await api("/alerts/stock"); } catch { return; }
  if (!Array.isArray(alerts) || !alerts.length) return;

  // Se vuelve a mostrar cuando cambia el stock (por ejemplo, después de otra venta)
  const key = "alertaStock:" + alerts.map(a => `${a.productId}:${a.stock}`).join("|");
  try { if (sessionStorage.getItem(key)) return; } catch { /* sin sessionStorage: se muestra siempre */ }

  const overlay = document.createElement("div");
  overlay.className = "stock-alert-overlay";
  overlay.setAttribute("role", "alertdialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "stock-alert-title");
  overlay.innerHTML = `<div class="stock-alert">
    <div class="stock-alert-icon">⚠️</div>
    <h2 id="stock-alert-title">Stock bajo de rosas</h2>
    ${alerts.map(a => {
      const s = a.supplier;
      const tel = s ? String(s.phone || "").replace(/[^\d+]/g, "") : "";
      return `<p>Quedan <strong>${a.stock}</strong> unidades de <strong>${escapeHtml(a.name)}</strong> (mínimo ${a.minStock}). Hay que pedir más al último proveedor que las trajo:</p>
      ${s ? `<div class="stock-alert-supplier">
        <div><span>Proveedor</span><strong>${escapeHtml(s.name)}</strong></div>
        ${s.contact ? `<div><span>Contacto</span><strong>${escapeHtml(s.contact)}</strong></div>` : ""}
        <div><span>Teléfono</span><strong>${tel ? `<a href="tel:${escapeHtml(tel)}">${escapeHtml(s.phone)}</a>` : escapeHtml(s.phone || "—")}</strong></div>
      </div>` : `<div class="stock-alert-supplier"><div>No hay proveedor registrado para este producto. Regístralo en <a href="/paginas/proveedores.html" style="text-decoration:underline">Proveedores</a> con el código ROS-001.</div></div>`}`;
    }).join("")}
    <div class="stock-alert-actions"><button type="button" class="btn btn-primary" id="stock-alert-close">Entendido</button></div>
  </div>`;
  const close = () => {
    try { sessionStorage.setItem(key, "1"); } catch { /* ignorar */ }
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = e => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
  overlay.querySelector("#stock-alert-close").addEventListener("click", close);
  overlay.querySelector("#stock-alert-close").focus();
}
document.addEventListener("DOMContentLoaded", mostrarAlertasStock);
