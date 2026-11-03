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

// ---------- Stock mínimo y avisos al entrar ----------
// Cada producto tiene su stock mínimo (Productos). Si no se definió: 10 para rosas y 5 para el resto.
const STOCK_MINIMO = 5, STOCK_MINIMO_ROSAS = 10;
const esRosa = p => p.code === "ROS-001" || /^rosas?\b/.test(String(p.name || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim());
const stockMinimo = p => Number.isInteger(p.minStockEfectivo) ? p.minStockEfectivo
  : Number.isInteger(p.minStock) ? p.minStock : esRosa(p) ? STOCK_MINIMO_ROSAS : STOCK_MINIMO;
const fechaLimaHoy = () => new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10);

// Ventana de avisos: productos en su stock mínimo (con el proveedor a llamar) y pedidos para hoy o atrasados
async function mostrarAvisos() {
  if (location.pathname.endsWith("/login.html")) return;
  const [alerts, orders] = await Promise.all([api("/alerts/stock").catch(() => []), api("/orders").catch(() => [])]);
  const hoy = fechaLimaHoy();
  const activos = (orders || []).filter(o => ["pendiente", "preparacion"].includes(o.status) && o.deliveryDate <= hoy)
    .sort((a, b) => (a.deliveryDate + (a.deliveryTime || "")).localeCompare(b.deliveryDate + (b.deliveryTime || "")));
  if (!alerts.length && !activos.length) return;

  // Se vuelve a mostrar cuando cambia algo (otra venta, otro pedido) o al día siguiente
  const key = "avisos:" + hoy + ":" + alerts.map(a => `${a.productId}:${a.stock}`).join("|") + ":" + activos.map(o => o.id + o.status).join("|");
  try { if (sessionStorage.getItem(key)) return; } catch { /* sin sessionStorage: se muestra siempre */ }

  const tel = s => String(s?.phone || "").replace(/[^\d+]/g, "");
  const stockHtml = alerts.length ? `<h3>Stock bajo (${alerts.length})</h3>
    <div class="aviso-lista">${alerts.map(a => `<div class="aviso-item">
      <div><strong>${escapeHtml(a.name)}</strong>${a.code ? ` <span class="muted">${escapeHtml(a.code)}</span>` : ""}
        <div class="muted">${a.stock === 0 ? "Agotado" : `Quedan ${a.stock} paquete${a.stock === 1 ? "" : "s"}`} · mínimo ${a.minStock}</div></div>
      <div class="aviso-prov">${a.supplier
        ? `Pedir a <strong>${escapeHtml(a.supplier.name)}</strong>${a.supplier.contact ? ` (${escapeHtml(a.supplier.contact)})` : ""}<br>${tel(a.supplier) ? `<a href="tel:${escapeHtml(tel(a.supplier))}">${escapeHtml(a.supplier.phone)}</a>` : escapeHtml(a.supplier.phone || "")}`
        : `<span class="muted">Sin proveedor registrado</span>`}</div></div>`).join("")}</div>` : "";
  const pedidosHtml = activos.length ? `<h3>Pedidos para hoy${activos.some(o => o.deliveryDate < hoy) ? " y atrasados" : ""} (${activos.length})</h3>
    <div class="aviso-lista">${activos.map(o => `<div class="aviso-item">
      <div><strong>${escapeHtml(o.number)} · ${escapeHtml(o.customerName)}</strong>
        <div class="muted">${escapeHtml(o.description.length > 70 ? o.description.slice(0, 67) + "…" : o.description)}</div></div>
      <div class="aviso-prov">${o.deliveryDate < hoy ? '<span class="badge danger">Atrasado</span>' : `<span class="badge low">Hoy${o.deliveryTime ? " " + escapeHtml(o.deliveryTime) : ""}</span>`}
        <div class="muted">${escapeHtml(o.statusLabel)} · ${escapeHtml(o.responsible?.name || "")}</div></div></div>`).join("")}</div>` : "";

  const overlay = document.createElement("div");
  overlay.className = "stock-alert-overlay";
  overlay.setAttribute("role", "alertdialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "stock-alert-title");
  overlay.innerHTML = `<div class="stock-alert aviso">
    <div class="stock-alert-icon">${alerts.length ? "⚠️" : "📦"}</div>
    <h2 id="stock-alert-title">Avisos del día</h2>
    ${pedidosHtml}${stockHtml}
    <div class="stock-alert-actions">
      ${activos.length && !location.pathname.endsWith("/pedidos.html") ? '<a class="btn btn-secondary" href="/paginas/pedidos.html">Ver pedidos</a>' : ""}
      <button type="button" class="btn btn-primary" id="stock-alert-close">Entendido</button></div>
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

// ---------- Cambiar mi contraseña ----------
function abrirCambioClave() {
  const overlay = document.createElement("div");
  overlay.className = "stock-alert-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "pass-title");
  overlay.innerHTML = `<form class="stock-alert" id="pass-form" style="text-align:left">
    <h2 id="pass-title" style="text-align:center">Cambiar mi contraseña</h2>
    <div id="pass-message"></div>
    <div class="field"><label for="pass-current">Contraseña actual</label><input id="pass-current" type="password" autocomplete="current-password" required></div>
    <div class="field"><label for="pass-new">Nueva contraseña</label><input id="pass-new" type="password" minlength="6" autocomplete="new-password" required></div>
    <div class="field"><label for="pass-repeat">Repite la nueva contraseña</label><input id="pass-repeat" type="password" minlength="6" autocomplete="new-password" required></div>
    <div class="stock-alert-actions"><button type="button" class="btn btn-secondary" id="pass-cancel">Cancelar</button><button class="btn btn-primary" type="submit">Guardar</button></div>
  </form>`;
  const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = e => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
  overlay.querySelector("#pass-cancel").addEventListener("click", close);
  overlay.querySelector("#pass-current").focus();
  overlay.querySelector("#pass-form").addEventListener("submit", async e => {
    e.preventDefault();
    const nueva = overlay.querySelector("#pass-new").value;
    if (nueva !== overlay.querySelector("#pass-repeat").value) return showMessage(overlay.querySelector("#pass-message"), "Las contraseñas nuevas no coinciden.", "error");
    try {
      await api("/me/password", { method: "POST", body: JSON.stringify({ current: overlay.querySelector("#pass-current").value, password: nueva }) });
      close();
      const content = document.querySelector(".content");
      if (content) { content.insertAdjacentHTML("afterbegin", '<div id="pass-ok"></div>'); showMessage("pass-ok", "Contraseña actualizada."); }
    } catch (err) { showMessage(overlay.querySelector("#pass-message"), err.message, "error"); }
  });
}

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
      <button type="button" class="btn btn-secondary btn-small" id="password-btn" title="Cambiar mi contraseña">🔑<span class="hide-mobile"> Contraseña</span></button>
      <button type="button" class="btn btn-secondary btn-small" id="logout-btn">Salir</button>`;
    document.getElementById("password-btn").addEventListener("click", abrirCambioClave);
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
    mostrarAvisos();
  } catch { /* api() ya redirige al inicio de sesión */ }
  return window.USER;
})();
