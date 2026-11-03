// ==========================================
// SPRINT 3: MERMA, ANULACIÓN DE VENTAS, DATOS DEL EMISOR, PEDIDOS Y REPORTES
// ==========================================
// Los permisos (qué puede hacer el administrador y qué el vendedor) se validan en backend/auth.js.

const MOTIVOS_MERMA = { marchita: "Marchita", danada: "Dañada", sobrante: "Sobrante de paquete abierto", otro: "Otro" };
const CANALES = { whatsapp: "WhatsApp", instagram: "Instagram", tiktok: "TikTok", presencial: "Presencial" };
const ESTADOS_PEDIDO = { pendiente: "Pendiente", preparacion: "En preparación", entregado: "Entregado", cancelado: "Cancelado" };

// Datos del negocio por defecto. El RUC queda vacío hasta que el administrador lo configure.
const EMISOR_INICIAL = {
  ruc: "",
  razonSocial: "STUDIO FLORAL",
  nombreComercial: "Studio Floral",
  direccion: "Mercado de Flores Piedra Liza, Av. 9 de Octubre s/n, Stand 14, Rímac - Lima",
  telefono: ""
};

// Fecha (AAAA-MM-DD) en hora de Lima (UTC-5), para que una venta de las 9 p. m. cuente en su día
const fechaLima = iso => new Date(Date.parse(iso) - 5 * 3600 * 1000).toISOString().slice(0, 10);
const esFecha = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) && !Number.isNaN(Date.parse(v));

module.exports = function setupGestion(app, deps) {
  const { readData, writeData, id, text, addMovement, quien, nextCode, stockMinimo, enviarAlertaStockBajo, validRuc, round2, motor, ventas } = deps;

  const emisorActual = data => ({ ...EMISOR_INICIAL, ...(data.config && data.config.emisor) });

  // Costo por paquete vigente en una fecha: el último registrado hasta ese día (o el primero si no hay anterior)
  function costoEn(data, productId, iso) {
    const list = (data.costHistory || []).filter(c => c.productId === productId && Number(c.cost) > 0);
    if (!list.length) return null;
    const t = Date.parse(iso);
    const previos = list.filter(c => Date.parse(c.date) <= t).sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
    if (previos.length) return Number(previos[0].cost);
    return Number(list.sort((a, b) => Date.parse(a.date) - Date.parse(b.date))[0].cost);
  }

  // ---------- 1. Merma (cierra HU-08) ----------
  app.get("/api/inventory/waste", (_req, res) => res.json(readData().waste || []));

  app.post("/api/inventory/waste", (req, res) => {
    const data = readData();
    const product = (data.products || []).find(p => p.id === req.body.productId && p.active);
    if (!product) return res.status(400).json({ error: "Elige un producto activo." });
    if (motor.tieneReceta(product)) return res.status(400).json({ error: `${product.name} es un arreglo con receta: registra la merma de sus insumos.` });
    const unit = req.body.unit === "tallo" ? "tallo" : "paquete";
    const quantity = Number(req.body.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) return res.status(400).json({ error: `La cantidad de merma debe ser un número entero mayor que cero (en ${unit}s).` });
    const spp = Number(product.stemsPerPackage) || 0;
    if (unit === "tallo" && !spp) return res.status(400).json({ error: `${product.name} no maneja tallos sueltos. Configura «tallos por paquete» en Productos.` });
    const disponible = unit === "tallo" ? (Number(product.looseStems) || 0) : product.stock;
    if (quantity > disponible) {
      return res.status(400).json({ error: unit === "tallo"
        ? `Solo hay ${disponible} tallos sueltos de ${product.name}. Si la merma es de un paquete cerrado, regístrala en paquetes.`
        : `No puedes registrar más merma que el stock. Disponible: ${disponible} paquetes.` });
    }
    const reason = req.body.reason;
    if (!MOTIVOS_MERMA[reason]) return res.status(400).json({ error: "Elige el motivo de la merma." });
    const note = text(req.body.note);
    if (reason === "otro" && !note) return res.status(400).json({ error: "Describe el motivo en el detalle." });

    const stockBefore = unit === "tallo" ? (Number(product.looseStems) || 0) : product.stock;
    if (unit === "tallo") product.looseStems = stockBefore - quantity; else product.stock -= quantity;
    const stockAfter = unit === "tallo" ? product.looseStems : product.stock;
    const number = nextCode(data, "wasteCorrelativo", "MR");
    const costoPaquete = costoEn(data, product.id, new Date().toISOString());
    const unitCost = costoPaquete === null ? null : (unit === "tallo" ? costoPaquete / spp : costoPaquete);
    const record = {
      id: id("mr"), number, date: new Date().toISOString(), user: quien(),
      productId: product.id, productName: product.name, quantity, unit, reason, reasonLabel: MOTIVOS_MERMA[reason], note,
      unitCost: unitCost === null ? null : round2(unitCost), value: unitCost === null ? null : round2(unitCost * quantity), stockBefore, stockAfter
    };
    if (!Array.isArray(data.waste)) data.waste = [];
    data.waste.unshift(record);
    addMovement(data, {
      type: "merma", unit, productId: product.id, productName: product.name, quantity,
      stockBefore, stockAfter, reference: number, note: `Merma: ${MOTIVOS_MERMA[reason]}${note ? " · " + note : ""}`
    });
    writeData(data);
    if (unit === "paquete" && product.stock <= stockMinimo(product)) enviarAlertaStockBajo(product, data);
    res.status(201).json(record);
  });

  // ---------- 2. Anular ventas (HU-17, solo administrador) ----------
  app.post("/api/sales/:id/void", (req, res) => {
    const data = readData();
    const sale = (data.sales || []).find(s => s.id === req.params.id);
    if (!sale) return res.status(404).json({ error: "Venta no encontrada." });
    if (sale.status === "anulada") return res.status(400).json({ error: "Esta venta ya está anulada." });
    const reason = text(req.body.reason);
    if (reason.length < 3) return res.status(400).json({ error: "Escribe el motivo de la anulación." });

    // Devuelve al stock lo que salió con la venta (insumos de recetas y tallos incluidos)
    if (Array.isArray(sale.consumption)) {
      motor.devolver(data, sale.consumption, sale.ticketNumber, `Anulación: ${reason}`);
    } else {
      // Ventas anteriores al motor de stock: se devuelve por producto vendido
      for (const item of sale.items || []) {
        if (item.type !== "product") continue;
        const product = data.products.find(p => p.id === item.productId);
        if (!product) continue;
        const stockBefore = product.stock;
        product.stock += item.quantity;
        addMovement(data, {
          type: "devolucion", productId: product.id, productName: product.name, quantity: item.quantity,
          stockBefore, stockAfter: product.stock, reference: sale.ticketNumber, note: `Anulación: ${reason}`
        });
      }
    }
    // Si venía de un pedido, el pedido queda otra vez sin venta
    const order = (data.orders || []).find(o => o.saleId === sale.id);
    if (order) { order.saleId = null; order.saleNumber = null; }
    sale.status = "anulada";
    sale.voided = { date: new Date().toISOString(), reason, user: quien() };
    if (data.lastTicket && data.lastTicket.id === sale.id) data.lastTicket = sale;
    writeData(data);
    res.json(sale);
  });

  // ---------- 3. Datos del emisor para boletas y facturas ----------
  app.get("/api/config/emisor", (_req, res) => res.json(emisorActual(readData())));

  app.put("/api/config/emisor", (req, res) => {
    const ruc = validRuc(req.body.ruc);
    if (!ruc) return res.status(400).json({ error: "Ingresa un RUC válido de 11 dígitos (se revisa el dígito verificador)." });
    const emisor = {
      ruc,
      razonSocial: text(req.body.razonSocial).toUpperCase(),
      nombreComercial: text(req.body.nombreComercial),
      direccion: text(req.body.direccion),
      telefono: text(req.body.telefono)
    };
    if (!emisor.razonSocial) return res.status(400).json({ error: "Ingresa la razón social." });
    if (!emisor.direccion) return res.status(400).json({ error: "Ingresa la dirección fiscal." });
    const data = readData();
    data.config = { ...(data.config || {}), emisor };
    writeData(data);
    res.json(emisor);
  });

  // ---------- 4. Pedidos personalizados (objetivo 7) ----------
  // Lista de personas para elegir el responsable (cualquier usuario con sesión)
  app.get("/api/users/basic", (_req, res) =>
    res.json((readData().users || []).filter(u => u.active).map(u => ({ id: u.id, name: u.name }))));

  function datosPedido(body, data, actual) {
    const o = { ...(actual || {}) };
    if (!actual || body.customerName !== undefined) o.customerName = text(body.customerName);
    if (!actual || body.phone !== undefined) o.phone = text(body.phone);
    if (!actual || body.channel !== undefined) o.channel = body.channel;
    if (!actual || body.description !== undefined) o.description = text(body.description);
    if (!actual || body.deliveryDate !== undefined) o.deliveryDate = body.deliveryDate;
    if (!actual || body.deliveryTime !== undefined) o.deliveryTime = text(body.deliveryTime);
    if (!actual || body.total !== undefined) o.total = body.total === "" || body.total === null || body.total === undefined ? null : Number(body.total);
    if (!actual || body.advance !== undefined) o.advance = body.advance === "" || body.advance === null || body.advance === undefined ? 0 : Number(body.advance);
    if (!actual || body.items !== undefined) {
      o.items = [];
      for (const raw of Array.isArray(body.items) ? body.items : []) {
        const p = (data.products || []).find(x => x.id === raw.productId && x.active);
        const quantity = Number(raw.quantity);
        if (!p) return { error: "Hay productos del pedido que no existen o están inactivos." };
        if (!Number.isInteger(quantity) || quantity < 1) return { error: `Indica una cantidad entera mayor que cero para ${p.name}.` };
        const prev = o.items.find(i => i.productId === p.id);
        if (prev) prev.quantity += quantity; else o.items.push({ productId: p.id, name: p.name, quantity });
      }
    }
    if (!actual || body.customerDoc !== undefined) o.customerDoc = text(body.customerDoc);
    if (!actual || body.responsibleId !== undefined) {
      const u = (data.users || []).find(x => x.id === body.responsibleId && x.active);
      o.responsible = u ? { id: u.id, name: u.name } : null;
    }
    if (!o.customerName) return { error: "Escribe el nombre del cliente." };
    if (!CANALES[o.channel]) return { error: "Elige el canal por donde llegó el pedido." };
    if (!o.description) return { error: "Describe el pedido (arreglo, flores, colores, dedicatoria…)." };
    if (!esFecha(o.deliveryDate)) return { error: "Elige la fecha de entrega." };
    if (o.total !== null && (!Number.isFinite(o.total) || o.total < 0)) return { error: "El precio debe ser un número mayor o igual a cero." };
    if (!Number.isFinite(o.advance) || o.advance < 0) return { error: "El adelanto debe ser un número mayor o igual a cero." };
    if (o.total !== null && o.advance > o.total) return { error: "El adelanto no puede ser mayor que el precio." };
    if (!o.responsible) return { error: "Elige quién es responsable del pedido." };
    o.channelLabel = CANALES[o.channel];
    return { order: o };
  }

  app.get("/api/orders", (_req, res) => res.json(readData().orders || []));

  app.post("/api/orders", (req, res) => {
    const data = readData();
    const r = datosPedido(req.body || {}, data, null);
    if (r.error) return res.status(400).json({ error: r.error });
    const now = new Date().toISOString();
    const order = {
      id: id("pd"), number: nextCode(data, "orderCorrelativo", "P"), createdAt: now, createdBy: quien(),
      ...r.order, status: "pendiente", statusLabel: ESTADOS_PEDIDO.pendiente,
      history: [{ date: now, status: "pendiente", user: quien() }]
    };
    if (!Array.isArray(data.orders)) data.orders = [];
    data.orders.unshift(order);
    writeData(data);
    res.status(201).json(order);
  });

  app.put("/api/orders/:id", (req, res) => {
    const data = readData();
    const order = (data.orders || []).find(o => o.id === req.params.id);
    if (!order) return res.status(404).json({ error: "Pedido no encontrado." });
    const r = datosPedido(req.body || {}, data, order);
    if (r.error) return res.status(400).json({ error: r.error });
    const status = req.body.status;
    if (status !== undefined && !ESTADOS_PEDIDO[status]) return res.status(400).json({ error: "Estado no válido." });
    if (order.saleId && (req.body.items !== undefined || req.body.total !== undefined || (status && status !== "entregado"))) {
      return res.status(400).json({ error: `El pedido ya tiene la venta ${order.saleNumber}. Anúlala primero si necesitas cambiar productos, precio o estado.` });
    }
    Object.assign(order, r.order);
    if (status && status !== order.status) {
      order.status = status;
      order.statusLabel = ESTADOS_PEDIDO[status];
      order.history = [...(order.history || []), { date: new Date().toISOString(), status, user: quien() }];
    }
    order.updatedAt = new Date().toISOString();
    writeData(data);
    res.json(order);
  });

  // Convertir un pedido entregado en venta: genera la boleta o factura y descuenta del stock los productos del pedido
  app.post("/api/orders/:id/sale", (req, res) => {
    const data = readData();
    const order = (data.orders || []).find(o => o.id === req.params.id);
    if (!order) return res.status(404).json({ error: "Pedido no encontrado." });
    if (order.status !== "entregado") return res.status(400).json({ error: "Primero marca el pedido como entregado." });
    if (order.saleId) return res.status(400).json({ error: `Este pedido ya tiene la venta ${order.saleNumber}.` });
    if (!(Number(order.total) > 0)) return res.status(400).json({ error: "El pedido no tiene precio acordado. Edítalo y escribe el precio antes de generar la venta." });
    const detalle = order.description.length > 70 ? order.description.slice(0, 67) + "…" : order.description;
    const cargo = { type: "order", orderId: order.id, name: `Pedido ${order.number}: ${detalle}`, quantity: 1, unitPrice: round2(order.total), subtotal: round2(order.total) };
    const r = ventas.crearVenta(data, req.body || {}, {
      cargo, consumir: (order.items || []).map(i => ({ productId: i.productId, quantity: i.quantity })),
      motivo: `Pedido ${order.number}`, extra: { orderId: order.id, orderNumber: order.number }
    });
    if (r.error) return res.status(400).json({ error: r.error });
    order.saleId = r.sale.id;
    order.saleNumber = r.sale.ticketNumber;
    order.updatedAt = new Date().toISOString();
    writeData(data);
    res.status(201).json({ order, sale: r.sale });
  });

  // ---------- 5. Reportes con filtro de fechas (objetivo 8, solo administrador) ----------
  app.get("/api/reports", (req, res) => {
    const data = readData();
    const hoy = fechaLima(new Date().toISOString());
    const from = esFecha(req.query.from) ? req.query.from : hoy.slice(0, 8) + "01";
    const to = esFecha(req.query.to) ? req.query.to : hoy;
    if (from > to) return res.status(400).json({ error: "La fecha inicial no puede ser posterior a la final." });
    const enRango = iso => { const d = fechaLima(iso); return d >= from && d <= to; };

    // Ventas válidas y anuladas del periodo
    const ventas = (data.sales || []).filter(s => enRango(s.date));
    const validas = ventas.filter(s => s.status !== "anulada");
    const anuladas = ventas.filter(s => s.status === "anulada");

    // Productos vendidos: cantidad, ingresos, costo y ganancia
    const costoDe = (iso) => pid => costoEn(data, pid, iso);
    const costoConsumo = (s) => {          // costo de lo que salió del stock en una venta (para pedidos)
      let total = 0;
      for (const c of s.consumption || []) {
        const unit = costoEn(data, c.productId, s.date);
        if (unit === null) return null;
        const spp = (data.products.find(p => p.id === c.productId) || {}).stemsPerPackage || 0;
        total += unit * c.packages + (c.stems ? (spp ? unit / spp * c.stems : NaN) : 0);
      }
      return Number.isNaN(total) ? null : total;
    };
    const porProducto = new Map();
    for (const s of validas) {
      for (const i of s.items || []) {
        const key = i.type === "product" ? i.productId : i.type === "order" ? "pedidos" : "acc:" + i.name;
        const nombre = i.type === "order" ? "Pedidos personalizados" : i.name;
        const tipo = i.type === "product" ? (i.recipe ? "Arreglo (receta)" : "Producto") : i.type === "order" ? "Pedido" : "Accesorio";
        const row = porProducto.get(key) || { name: nombre, type: tipo, quantity: 0, revenue: 0, cost: 0, sinCosto: 0 };
        row.quantity += i.quantity;
        row.revenue += i.subtotal;
        let c = null;
        if (i.type === "product") c = i.recipe ? motor.costoReceta(data, i.recipe, costoDe(s.date)) : costoEn(data, i.productId, s.date);
        if (i.type === "order") { const t = costoConsumo(s); c = t === null || !(s.consumption || []).length ? null : t; }
        if (c === null) row.sinCosto += i.quantity; else row.cost += c * i.quantity;
        porProducto.set(key, row);
      }
    }
    const productos = [...porProducto.values()].map(r => ({
      ...r, revenue: round2(r.revenue), cost: round2(r.cost),
      profit: r.sinCosto === r.quantity ? null : round2(r.revenue - r.cost),
      margin: r.sinCosto === r.quantity || !r.revenue ? null : round2((r.revenue - r.cost) / r.revenue * 100)
    })).sort((a, b) => b.quantity - a.quantity || b.revenue - a.revenue);

    // Merma del periodo (en paquetes o en tallos sueltos)
    const mermas = (data.waste || []).filter(w => enRango(w.date));
    const mermaPorProducto = new Map();
    for (const w of mermas) {
      const row = mermaPorProducto.get(w.productId) || { name: w.productName, quantity: 0, stems: 0, value: 0, sinCosto: 0, motivos: {} };
      if (w.unit === "tallo") row.stems += w.quantity; else row.quantity += w.quantity;
      if (w.value === null) row.sinCosto += w.quantity; else row.value += w.value;
      row.motivos[w.reasonLabel] = (row.motivos[w.reasonLabel] || 0) + 1;
      mermaPorProducto.set(w.productId, row);
    }
    const mermaPorMotivo = {};
    for (const w of mermas) mermaPorMotivo[w.reasonLabel] = (mermaPorMotivo[w.reasonLabel] || 0) + 1;

    // Compras por proveedor (entradas de mercadería con su costo)
    const compras = new Map();
    for (const e of (data.entries || []).filter(e => enRango(e.date))) {
      const row = compras.get(e.supplierId) || { name: e.supplierName, entries: 0, packages: 0, amount: 0, sinCosto: 0 };
      row.entries += 1;
      for (const it of e.items || []) {
        row.packages += it.quantity;
        if (it.unitCost) row.amount += it.unitCost * it.quantity; else row.sinCosto += it.quantity;
      }
      compras.set(e.supplierId, row);
    }

    // Pedidos con entrega en el periodo
    const pedidos = (data.orders || []).filter(o => o.deliveryDate >= from && o.deliveryDate <= to);
    const contar = (list, key) => list.reduce((acc, o) => { acc[o[key]] = (acc[o[key]] || 0) + 1; return acc; }, {});

    const ingresos = round2(validas.reduce((a, s) => a + s.total, 0));
    const costoVendido = round2(productos.reduce((a, p) => a + p.cost, 0));
    res.json({
      from, to,
      resumen: {
        ventas: validas.length, ingresos, igv: round2(validas.reduce((a, s) => a + (s.igv || 0), 0)),
        costoVendido, ganancia: round2(ingresos - costoVendido),
        anuladas: anuladas.length, montoAnulado: round2(anuladas.reduce((a, s) => a + s.total, 0)),
        mermaPaquetes: mermas.filter(w => w.unit !== "tallo").reduce((a, w) => a + w.quantity, 0),
        mermaTallos: mermas.filter(w => w.unit === "tallo").reduce((a, w) => a + w.quantity, 0),
        mermaValor: round2(mermas.reduce((a, w) => a + (w.value || 0), 0)),
        compras: round2([...compras.values()].reduce((a, c) => a + c.amount, 0)),
        pedidos: pedidos.length
      },
      productos,
      merma: { porProducto: [...mermaPorProducto.values()].map(r => ({ ...r, value: round2(r.value) })).sort((a, b) => b.value - a.value), porMotivo: mermaPorMotivo, registros: mermas },
      compras: [...compras.values()].map(r => ({ ...r, amount: round2(r.amount) })).sort((a, b) => b.amount - a.amount),
      pedidos: { porEstado: contar(pedidos.map(o => ({ s: ESTADOS_PEDIDO[o.status] })), "s"), porCanal: contar(pedidos, "channelLabel") },
      ventasDetalle: ventas.map(s => ({ ticketNumber: s.ticketNumber, date: s.date, customer: s.customer?.name || "", seller: s.seller?.name || "", total: s.total, status: s.status === "anulada" ? "Anulada" : "Válida", voidReason: s.voided?.reason || "" }))
    });
  });

  return { emisorActual };
};
