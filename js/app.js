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
  // Sesión vencida o cerrada: volver al inicio de sesión
  if (response.status === 401 && !location.pathname.endsWith("/login.html")) {
    location.href = "/paginas/login.html";
    throw new Error(payload?.error || "Inicia sesión para continuar.");
  }
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

// ---------- Sesión y perfiles (administrador y vendedor) ----------
// El servidor es quien valida los permisos; aquí solo se ocultan las opciones que el perfil no puede usar.
const ADMIN_ONLY_PAGES = ["proveedores.html", "reportes.html", "usuarios.html", "configuracion.html"];
const isAdmin = () => window.USER?.role === "admin";

function marcarSoloAdmin() {
  const hide = el => el && el.classList.add("solo-admin");
  ["new-product-btn", "product-form-panel", "tab-diferencias"].forEach(id => hide(document.getElementById(id)));
  ["cost-form", "form-flores", "form-ramo", "form-plantas", "form-decoracion", "form-accesorio"]
    .forEach(id => hide(document.getElementById(id)?.closest(".panel")));
  hide(document.querySelector('[data-tab="diferencias"]'));
  hide(document.getElementById("count-adjust")?.closest("label"));
  // Columna de acciones de las tablas de productos y existencias
  ["products-table", "inventory-table"].forEach(id => {
    const table = document.getElementById(id)?.closest("table");
    if (table) { table.classList.add("acciones-admin"); hide(table.querySelector("thead th:last-child")); }
  });
  document.querySelectorAll(".nav a").forEach(a => { if (ADMIN_ONLY_PAGES.includes(a.dataset.page)) hide(a); });
}

function pintarUsuario(user) {
  document.body.classList.add(user.role === "admin" ? "rol-admin" : "rol-vendedor");
  // Enlaces nuevos del menú: Pedidos e Historial (todos), Usuarios y Configuración (solo administrador)
  const nav = document.querySelector(".nav");
  if (nav && !nav.querySelector('[data-page="usuarios.html"]')) {
    const venta = nav.querySelector('[data-page="nueva-venta.html"]');
    if (!nav.querySelector('[data-page="historial-ventas.html"]')) {
      (venta || nav.lastElementChild).insertAdjacentHTML("afterend", `<a data-page="historial-ventas.html" href="/paginas/historial-ventas.html"><span class="nav-icon">📋</span> Historial de ventas</a>`);
    }
    (venta || nav.lastElementChild).insertAdjacentHTML("afterend", `<a data-page="pedidos.html" href="/paginas/pedidos.html"><span class="nav-icon">📦</span> Pedidos</a>`);
    nav.insertAdjacentHTML("beforeend", `<a data-page="usuarios.html" href="/paginas/usuarios.html" class="solo-admin"><span class="nav-icon">👤</span> Usuarios</a>
      <a data-page="configuracion.html" href="/paginas/configuracion.html" class="solo-admin"><span class="nav-icon">⚙</span> Configuración</a>`);
    setActiveNav();
  }
  // Nombre, perfil y botón para salir en la barra superior
  const right = document.querySelector(".top-right");
  if (right) {
    const initials = user.name.split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase();
    right.innerHTML = `<div class="user-box hide-mobile"><strong>${escapeHtml(user.name)}</strong><span>${escapeHtml(user.roleLabel)}</span></div>
      <div class="avatar" title="${escapeHtml(user.name)}">${escapeHtml(initials)}</div>
      <button type="button" class="btn btn-secondary btn-small" id="logout-btn">Salir</button>`;
    document.getElementById("logout-btn").addEventListener("click", async () => {
      try { await api("/logout", { method: "POST" }); } catch { /* igual se sale */ }
      location.href = "/paginas/login.html";
    });
  }
  // El responsable del conteo es quien inició sesión
  const responsible = document.getElementById("count-responsible");
  if (responsible && !responsible.value) responsible.value = user.name;
  if (new URLSearchParams(location.search).get("sinPermiso")) {
    const content = document.querySelector(".content");
    if (content) content.insertAdjacentHTML("afterbegin", `<div class="notice error" role="status">Esa página solo la puede abrir un administrador.</div>`);
  }
}

window.sessionReady = (async () => {
  marcarSoloAdmin();
  try {
    window.USER = await api("/me");
    pintarUsuario(window.USER);
  } catch { /* api() ya redirige al inicio de sesión */ }
  return window.USER;
})();
