document.addEventListener("DOMContentLoaded", () => {
  const $ = id => document.getElementById(id);
  const fields = { ruc: "cfg-ruc", razonSocial: "cfg-razon", nombreComercial: "cfg-nombre", direccion: "cfg-direccion", telefono: "cfg-telefono" };

  function preview() {
    const e = Object.fromEntries(Object.entries(fields).map(([k, id]) => [k, $(id).value.trim()]));
    $("config-preview").innerHTML = `<div class="cpe"><div class="cpe-header">
      <div class="cpe-emisor"><div class="cpe-logo">✿</div>
        <div class="cpe-razon">${escapeHtml(e.razonSocial.toUpperCase() || "RAZÓN SOCIAL")}</div>
        <div>${escapeHtml(e.nombreComercial)}</div><div>${escapeHtml(e.direccion)}</div>
        ${e.telefono ? `<div>Telf.: ${escapeHtml(e.telefono)}</div>` : ""}</div>
      <div class="cpe-box"><div>R.U.C. ${escapeHtml(e.ruc || "—")}</div><div class="cpe-tipo">BOLETA DE VENTA ELECTRÓNICA</div><div class="cpe-numero">B001-00000000</div></div>
    </div></div>`;
  }

  async function load() {
    try {
      const e = await api("/config/emisor");
      Object.entries(fields).forEach(([k, id]) => { $(id).value = e[k] || ""; });
      if (!e.ruc) showMessage("config-message", "Falta el RUC del negocio: los comprobantes muestran «R.U.C. — (configurar)» hasta que lo guardes.", "info");
      preview();
    } catch (err) { showMessage("config-message", err.message, "error"); }
  }

  Object.values(fields).forEach(id => $(id).addEventListener("input", preview));
  $("config-form").addEventListener("submit", async ev => {
    ev.preventDefault();
    const body = Object.fromEntries(Object.entries(fields).map(([k, id]) => [k, $(id).value]));
    try {
      await api("/config/emisor", { method: "PUT", body: JSON.stringify(body) });
      showMessage("config-message", "Datos guardados. Las próximas boletas y facturas ya los usan.");
      load();
    } catch (err) { showMessage("config-message", err.message, "error"); }
  });
  load();
});
