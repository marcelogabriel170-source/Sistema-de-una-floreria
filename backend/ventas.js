// ==========================================
// CREACIÓN DE VENTAS (BOLETA / FACTURA)
// ==========================================
// Se usa desde Nueva venta y desde Pedidos (convertir un pedido entregado en venta).
// El stock se descuenta con el motor de stock, que entiende recetas de arreglos y tallos sueltos.

module.exports = function crearVentas(d) {
  const { validateCustomer, nextDocumentNumber, DOCUMENT_TYPES, IGV_RATE, round2, positiveNumber, text, id, quien,
    stockMinimo, enviarAlertaStockBajo, emisorActual, motor } = d;

  // body: { documentType, customer, items }
  // opciones.cargo: línea única que se cobra (pedido con precio acordado); opciones.consumir: lo que se descuenta del stock
  function crearVenta(data, body, opciones = {}) {
    // El comprobante no se emite sin datos válidos del cliente: se valida ANTES de tocar el inventario
    const documentType = text(body.documentType) || "boleta";
    const checked = validateCustomer(documentType, body.customer);
    if (checked.error) return { error: checked.error };

    let lines = [];
    let consumir = [];

    if (opciones.cargo) {
      lines = [opciones.cargo];
      consumir = opciones.consumir || [];
    } else {
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) return { error: "Añade al menos un producto o accesorio a la venta." };
      for (const item of items) {
        const qty = Number(item.quantity);
        if (!Number.isInteger(qty) || qty < 1) return { error: "Hay cantidades no válidas." };
        if (item.type !== "accessory") {
          const product = data.products.find(p => p.id === item.productId && p.active);
          if (!product) return { error: "Hay productos no válidos." };
          consumir.push({ productId: product.id, quantity: qty });
          const line = { type: "product", productId: product.id, name: product.name, quantity: qty, unitPrice: product.price, subtotal: round2(product.price * qty) };
          // Se guarda la receta usada, para calcular el costo real en los reportes
          if (motor.tieneReceta(product)) {
            line.recipe = product.recipe.map(i => ({ ...i, stemsPerPackage: (data.products.find(x => x.id === i.productId) || {}).stemsPerPackage || null }));
          }
          lines.push(line);
          continue;
        }
        const name = text(item.name);
        const price = positiveNumber(item.price);
        if (!name || price === null) return { error: "Hay accesorios o precios no válidos." };
        lines.push({ type: "accessory", accessoryId: text(item.accessoryId), name, quantity: qty, unitPrice: price, subtotal: round2(price * qty) });
      }
    }

    // ¿Alcanza el stock (incluidos los insumos de las recetas)?
    const plan = motor.planificar(data, consumir);
    if (plan.error) return { error: plan.error };

    // Detalle tributario por línea: valor unitario = precio sin IGV; importe = precio con IGV × cantidad
    const detail = lines.map(line => {
      const valorVenta = round2(line.subtotal / (1 + IGV_RATE));
      return { ...line, unit: line.unit || "UND", valorUnitario: round2(line.unitPrice / (1 + IGV_RATE)), valorVenta, igv: round2(line.subtotal - valorVenta) };
    });
    const total = round2(detail.reduce((sum, line) => sum + line.subtotal, 0));
    const opGravada = round2(total / (1 + IGV_RATE));
    const igv = round2(total - opGravada);
    const doc = nextDocumentNumber(data, documentType);

    const consumo = motor.aplicar(data, plan.plan, doc.numero, opciones.motivo || "Venta");

    const sale = {
      id: id("v"),
      seller: quien(),
      documentType,
      documentLabel: DOCUMENT_TYPES[documentType].label,
      serie: doc.serie,
      correlativo: doc.correlativo,
      ticketNumber: doc.numero, // se mantiene para que dashboard, reportes e historial sigan funcionando
      emisor: emisorActual(data),
      customer: checked.customer,
      currency: "PEN",
      paymentCondition: "CONTADO",
      items: detail,
      consumption: consumo, // lo que salió del stock: sirve para devolverlo si se anula la venta
      opGravada, opExonerada: 0, opInafecta: 0, igvRate: IGV_RATE, igv, total,
      date: new Date().toISOString(),
      ...(opciones.extra || {})
    };
    if (!Array.isArray(data.sales)) data.sales = [];
    data.sales.unshift(sale);
    data.lastTicket = sale;

    // Aviso de stock bajo (en pantalla y por WhatsApp) para los productos que quedaron en su mínimo
    for (const c of consumo) {
      const p = data.products.find(x => x.id === c.productId);
      if (p && !motor.tieneReceta(p) && p.stock <= stockMinimo(p)) enviarAlertaStockBajo(p, data);
    }
    return { sale };
  }

  return { crearVenta };
};
