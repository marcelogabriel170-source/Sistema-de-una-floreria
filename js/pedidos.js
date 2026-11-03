document.addEventListener("DOMContentLoaded", () => {
  const $ = id => document.getElementById(id);
  const panel = $("order-form-panel"), form = $("order-form"), table = $("orders-table");
  const STATUS = { pendiente: ["Pendiente", "low"], preparacion: ["En preparación", ""], entregado: ["Entregado", "inactive"], cancelado: ["Cancelado", "danger"] };
  const NEXT = { pendiente: ["preparacion", "▶ Preparar"], preparacion: ["entregado", "✓ Entregado"] };
  const today = () => new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10); // fecha de Lima
  let orders = [], people = [], productos = [];

  // ---------- Productos del pedido ----------
  const itemsBox = $("order-items");
  function addItemRow(it = {}) {
    const row = document.createElement("div");
    row.className = "recipe-row";
    row.style.gridTemplateColumns = "minmax(0,1fr) 90px auto";
    row.innerHTML = `<select class="it-product" aria-label="Producto"><option value="">Producto…</option>${productos.map(p =>
        `<option value="${p.id}">${escapeHtml(p.name)} · ${p.recipe && p.recipe.length ? `receta (alcanza ${p.available ?? 0})` : `${p.stock} paq.`}</option>`).join("")}</select>
      <input class="it-qty" type="number" min="1" step="1" value="${it.quantity || 1}" aria-label="Cantidad">
      <button type="button" class="btn btn-secondary btn-small it-del" aria-label="Quitar producto">✕</button>`;
    itemsBox.appendChild(row);
    if (it.productId) row.querySelector(".it-product").value = it.productId;
  }
  itemsBox.addEventListener("click", e => { if (e.target.closest(".it-del")) e.target.closest(".recipe-row").remove(); });
  $("order-item-add").addEventListener("click", () => addItemRow());
  const readItems = () => [...itemsBox.querySelectorAll(".recipe-row")].map(r => ({ productId: r.querySelector(".it-product").value, quantity: Number(r.querySelector(".it-qty").value) }));

  // ---------- Generar la boleta o factura de un pedido entregado ----------
  async function generarVenta(o) {
    const doc = prompt(`Venta del pedido ${o.number} por ${euro(o.total)}.\nDNI (8 dígitos → boleta) o RUC (11 dígitos → factura) de ${o.customerName}:`, o.customerDoc || "");
    if (doc === null) return;
    const numero = doc.trim();
    const esFactura = /^\d{11}$/.test(numero);
    if (!esFactura && !/^\d{8}$/.test(numero)) return showMessage("order-message", "Escribe un DNI de 8 dígitos o un RUC de 11 dígitos.", "error");
    let address = "";
    if (esFactura) {
      const dir = prompt("Dirección fiscal del cliente (obligatoria para factura):", "");
      if (dir === null) return;
      address = dir;
    }
    const nombre = prompt(esFactura ? "Razón social del cliente:" : "Nombre del cliente:", o.customerName);
    if (nombre === null) return;
    try {
      const r = await api(`/orders/${o.id}/sale`, { method: "POST", body: JSON.stringify({
        documentType: esFactura ? "factura" : "boleta",
        customer: { docNumber: numero, name: nombre, address }
      }) });
      showMessage("order-message", `Venta ${r.sale.ticketNumber} generada por ${euro(r.sale.total)}. El stock se descontó. Puedes verla en Comprobantes.`);
      load();
    } catch (err) { showMessage("order-message", err.message, "error"); }
  }

  const close = () => { form.reset(); $("order-id").value = ""; panel.classList.add("hidden"); };
  function open(o) {
    form.reset();
    $("order-id").value = o ? o.id : "";
    $("order-form-title").textContent = o ? `Editar pedido ${o.number}` : "Nuevo pedido";
    $("order-customer").value = o?.customerName || "";
    $("order-phone").value = o?.phone || "";
    $("order-channel").value = o?.channel || "";
    $("order-responsible").value = o?.responsible?.id || window.USER?.id || "";
    $("order-date").value = o?.deliveryDate || today();
    $("order-time").value = o?.deliveryTime || "";
    $("order-total").value = o?.total ?? "";
    $("order-advance").value = o?.advance || "";
    $("order-description").value = o?.description || "";
    $("order-doc").value = o?.customerDoc || "";
    itemsBox.innerHTML = ""; (o?.items || []).forEach(addItemRow);
    $("order-status").value = o?.status || "pendiente";
    $("order-status-field").classList.toggle("hidden", !o);
    panel.classList.remove("hidden");
    $("order-customer").focus();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  $("new-order-btn").addEventListener("click", () => open(null));
  ["close-order-form", "cancel-order"].forEach(id => $(id).addEventListener("click", close));
  ["order-filter-status", "order-filter-channel"].forEach(id => $(id).addEventListener("change", render));

  function render() {
    const st = $("order-filter-status").value, ch = $("order-filter-channel").value;
    const list = orders
      .filter(o => st === "activos" ? ["pendiente", "preparacion"].includes(o.status) : !st || o.status === st)
      .filter(o => !ch || o.channel === ch)
      .sort((a, b) => (a.deliveryDate + (a.deliveryTime || "")).localeCompare(b.deliveryDate + (b.deliveryTime || "")));
    $("order-count").textContent = `${list.length} pedido${list.length === 1 ? "" : "s"} con este filtro`;
    const t = today();
    table.innerHTML = list.length ? list.map(o => {
      const late = ["pendiente", "preparacion"].includes(o.status) && o.deliveryDate < t;
      const isToday = o.deliveryDate === t;
      const saldo = o.total === null || o.total === undefined ? null : o.total - (o.advance || 0);
      const next = NEXT[o.status];
      return `<tr>
        <td><strong>${escapeHtml(o.number)}</strong></td>
        <td>${dateOnly(o.deliveryDate + "T12:00:00")}${o.deliveryTime ? ` · ${escapeHtml(o.deliveryTime)}` : ""}
          ${late ? '<div><span class="badge danger">Atrasado</span></div>' : isToday ? '<div><span class="badge low">Hoy</span></div>' : ""}</td>
        <td><strong>${escapeHtml(o.customerName)}</strong>${o.phone ? `<div class="muted">${escapeHtml(o.phone)}</div>` : ""}</td>
        <td style="white-space:normal;min-width:220px">${escapeHtml(o.description)}${(o.items || []).length ? `<div class="muted">Usa: ${o.items.map(i => `${i.quantity} × ${escapeHtml(i.name)}`).join(", ")}</div>` : ""}</td>
        <td>${escapeHtml(o.channelLabel)}</td>
        <td>${escapeHtml(o.responsible?.name || "—")}</td>
        <td>${saldo === null ? '<span class="muted">Sin precio</span>' : `${euro(o.total)}<div class="muted">${o.saleId ? "Cobrado en la venta" : saldo > 0 ? "Saldo " + euro(saldo) : "Pagado"}</div>`}</td>
        <td><span class="badge ${STATUS[o.status][1]}">${STATUS[o.status][0]}</span>${o.saleNumber ? `<div class="muted">Venta ${escapeHtml(o.saleNumber)}</div>` : ""}</td>
        <td><div class="row-actions">
          ${next ? `<button class="btn btn-primary btn-small" data-next="${o.id}" data-status="${next[0]}">${next[1]}</button>` : ""}
          ${o.status === "entregado" && !o.saleId ? `<button class="btn btn-primary btn-small" data-sale="${o.id}">🧾 Generar boleta</button>` : ""}
          ${o.saleId ? "" : `<button class="btn btn-secondary btn-small" data-edit="${o.id}">Editar</button>`}
        </div></td>
      </tr>`;
    }).join("") : emptyRow(9, "No hay pedidos con este filtro.");
  }

  function stats() {
    const t = today(), active = orders.filter(o => ["pendiente", "preparacion"].includes(o.status));
    const cards = [
      ["Pendientes", "○", orders.filter(o => o.status === "pendiente").length, "Por empezar"],
      ["En preparación", "✿", orders.filter(o => o.status === "preparacion").length, "Armándose"],
      ["Para hoy", "◷", active.filter(o => o.deliveryDate === t).length, "Entregas de hoy"],
      ["Atrasados", "!", active.filter(o => o.deliveryDate < t).length, "Fecha de entrega vencida"]
    ];
    $("order-stats").innerHTML = cards.map(([l, i, v, n]) => `<div class="stat-card"><div class="stat-top">${l} <span class="stat-icon">${i}</span></div><div class="stat-value">${v}</div><div class="stat-note">${n}</div></div>`).join("");
  }

  async function load() {
    try {
      [orders, people, productos] = await Promise.all([api("/orders"), people.length ? people : api("/users/basic"), api("/products?active=true")]);
      $("order-responsible").innerHTML = `<option value="">Elige al responsable</option>` + people.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
      stats(); render();
    } catch (e) { table.innerHTML = emptyRow(9, e.message); }
  }

  table.addEventListener("click", async e => {
    const edit = e.target.closest("[data-edit]"), next = e.target.closest("[data-next]"), sale = e.target.closest("[data-sale]");
    if (sale) return generarVenta(orders.find(o => o.id === sale.dataset.sale));
    if (edit) open(orders.find(o => o.id === edit.dataset.edit));
    if (next) {
      try {
        const o = await api(`/orders/${next.dataset.next}`, { method: "PUT", body: JSON.stringify({ status: next.dataset.status }) });
        showMessage("order-message", `Pedido ${o.number}: ${o.statusLabel}.`); load();
      } catch (err) { showMessage("order-message", err.message, "error"); }
    }
  });

  form.addEventListener("submit", async e => {
    e.preventDefault();
    const id = $("order-id").value;
    const body = {
      customerName: $("order-customer").value, phone: $("order-phone").value, channel: $("order-channel").value,
      responsibleId: $("order-responsible").value, deliveryDate: $("order-date").value, deliveryTime: $("order-time").value,
      total: $("order-total").value, advance: $("order-advance").value, description: $("order-description").value,
      customerDoc: $("order-doc").value, items: readItems()
    };
    if (body.items.some(i => !i.productId)) return showMessage("order-message", "Elige el producto de cada fila (o quita la fila vacía).", "error");
    if (id) body.status = $("order-status").value;
    try {
      const o = await api(id ? `/orders/${id}` : "/orders", { method: id ? "PUT" : "POST", body: JSON.stringify(body) });
      close(); showMessage("order-message", id ? `Pedido ${o.number} actualizado.` : `Pedido ${o.number} registrado.`); load();
    } catch (err) { showMessage("order-message", err.message, "error"); }
  });

  load();
});
