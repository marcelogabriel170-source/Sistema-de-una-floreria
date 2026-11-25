// ==========================================================
// COMPROBANTE DE PAGO (Boleta / Factura) — formato de negocio real
// Requiere app.js (euro, escapeHtml)
// ==========================================================

// Emisor por defecto, para ventas antiguas que no guardaron los datos del negocio
const EMISOR_DEFECTO = {
  ruc: "20000000001",
  razonSocial: "STUDIO FLORAL S.A.C.",
  nombreComercial: "Studio Floral",
  direccion: "Av. Ejemplo 123, La Molina - Lima - Lima",
  telefono: "(01) 000-0000"
};

// ---------- Monto en letras: 125.50 -> "CIENTO VEINTICINCO CON 50/100 SOLES" ----------
function numeroALetras(monto) {
  const UNIDADES = ["", "UNO", "DOS", "TRES", "CUATRO", "CINCO", "SEIS", "SIETE", "OCHO", "NUEVE",
    "DIEZ", "ONCE", "DOCE", "TRECE", "CATORCE", "QUINCE", "DIECISÉIS", "DIECISIETE", "DIECIOCHO", "DIECINUEVE",
    "VEINTE", "VEINTIUNO", "VEINTIDÓS", "VEINTITRÉS", "VEINTICUATRO", "VEINTICINCO", "VEINTISÉIS",
    "VEINTISIETE", "VEINTIOCHO", "VEINTINUEVE"];
  const DECENAS = ["", "", "", "TREINTA", "CUARENTA", "CINCUENTA", "SESENTA", "SETENTA", "OCHENTA", "NOVENTA"];
  const CENTENAS = ["", "CIENTO", "DOSCIENTOS", "TRESCIENTOS", "CUATROCIENTOS", "QUINIENTOS",
    "SEISCIENTOS", "SETECIENTOS", "OCHOCIENTOS", "NOVECIENTOS"];

  function hasta999(n) {
    if (n === 0) return "";
    if (n === 100) return "CIEN";
    const c = Math.floor(n / 100), r = n % 100;
    let out = CENTENAS[c];
    if (r) {
      const dec = r < 30 ? UNIDADES[r] : DECENAS[Math.floor(r / 10)] + (r % 10 ? " Y " + UNIDADES[r % 10] : "");
      out = (out ? out + " " : "") + dec;
    }
    return out;
  }

  function entero(n) {
    if (n === 0) return "CERO";
    const millones = Math.floor(n / 1000000);
    const miles = Math.floor((n % 1000000) / 1000);
    const resto = n % 1000;
    const partes = [];
    if (millones) partes.push(millones === 1 ? "UN MILLÓN" : hasta999(millones).replace(/UNO$/, "UN") + " MILLONES");
    if (miles) partes.push(miles === 1 ? "MIL" : hasta999(miles).replace(/UNO$/, "UN") + " MIL");
    if (resto) partes.push(hasta999(resto));
    return partes.join(" ");
  }

  const valor = Math.round(Number(monto || 0) * 100);
  const soles = Math.floor(valor / 100);
  const centimos = String(valor % 100).padStart(2, "0");
  return `${entero(soles)} CON ${centimos}/100 SOLES`;
}

// Para ventas antiguas (antes de este cambio) que no tenían IGV por línea
function itemConImpuestos(item) {
  const rate = 0.18;
  const unitPrice = Number(item.unitPrice ?? item.subtotal / item.quantity);
  const valorVenta = item.valorVenta ?? Math.round((item.subtotal / (1 + rate)) * 100) / 100;
  return {
    ...item,
    unit: item.unit || "UND",
    unitPrice,
    valorUnitario: item.valorUnitario ?? Math.round((unitPrice / (1 + rate)) * 100) / 100,
    valorVenta,
    igv: item.igv ?? Math.round((item.subtotal - valorVenta) * 100) / 100
  };
}

// Normaliza cualquier venta (nueva, boleta antigua o ticket antiguo) a un formato común
function normalizarComprobante(sale) {
  const isFactura = sale.documentType === "factura";
  const isBoleta = sale.documentType === "boleta";
  const customer = sale.customer || {};
  const total = Number(sale.total || 0);
  const opGravada = sale.opGravada ?? Math.round((total / 1.18) * 100) / 100;
  return {
    ...sale,
    isFactura,
    isBoleta,
    isTicket: !isFactura && !isBoleta,
    label: sale.documentLabel || (isFactura ? "FACTURA ELECTRÓNICA" : isBoleta ? "BOLETA DE VENTA ELECTRÓNICA" : "TICKET DE VENTA"),
    emisor: sale.emisor || EMISOR_DEFECTO,
    customer: {
      docType: customer.docType || (isFactura ? "RUC" : "DNI"),
      docNumber: customer.docNumber || customer.dni || customer.ruc || "",
      name: customer.name || "",
      address: customer.address || ""
    },
    items: (sale.items || []).map(itemConImpuestos),
    opGravada,
    opExonerada: sale.opExonerada || 0,
    opInafecta: sale.opInafecta || 0,
    igv: sale.igv ?? Math.round((total - opGravada) * 100) / 100,
    total,
    paymentCondition: sale.paymentCondition || "CONTADO"
  };
}

function fechaEmision(iso) {
  const d = new Date(iso);
  const fecha = d.toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" });
  const hora = d.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit", hour12: false });
  return { fecha, hora };
}

// ---------- HTML del comprobante ----------
function renderComprobante(rawSale) {
  const s = normalizarComprobante(rawSale);
  const e = s.emisor;
  const { fecha, hora } = fechaEmision(s.date);
  const money = v => euro(v).replace("S/ ", "");

  const clienteHtml = s.isTicket ? "" : `
    <table class="cpe-info">
      <tr><td>${s.isFactura ? "Razón social" : "Cliente"}</td><td>: ${escapeHtml(s.customer.name)}</td></tr>
      <tr><td>${escapeHtml(s.customer.docType)}</td><td>: ${escapeHtml(s.customer.docNumber)}</td></tr>
      ${s.customer.address ? `<tr><td>Dirección</td><td>: ${escapeHtml(s.customer.address)}</td></tr>` : ""}
      <tr><td>Fecha emisión</td><td>: ${fecha} &nbsp; Hora: ${hora}</td></tr>
      <tr><td>Moneda</td><td>: SOLES (PEN)</td></tr>
      <tr><td>Forma de pago</td><td>: ${escapeHtml(s.paymentCondition)}</td></tr>
    </table>`;

  // En factura se muestra el valor unitario SIN IGV (como exige el formato);
  // en boleta se muestra el precio unitario CON IGV
  const lineasHtml = s.items.map(i => `
      <tr>
        <td class="num">${i.quantity}</td>
        <td>${escapeHtml(i.unit)}</td>
        <td>${escapeHtml(i.name)}</td>
        <td class="num">${money(s.isFactura ? i.valorUnitario : i.unitPrice)}</td>
        <td class="num">${money(s.isFactura ? i.valorVenta : i.subtotal)}</td>
      </tr>`).join("");

  // El IGV siempre se calcula y se guarda en la venta, pero SOLO se muestra en la factura.
  // En la boleta (y en el ticket antiguo) únicamente aparece el importe total.
  const totalesHtml = s.isFactura
    ? `<tr><td>Op. gravada</td><td>S/</td><td class="num">${money(s.opGravada)}</td></tr>
      <tr><td>Op. exonerada</td><td>S/</td><td class="num">${money(s.opExonerada)}</td></tr>
      <tr><td>Op. inafecta</td><td>S/</td><td class="num">${money(s.opInafecta)}</td></tr>
      <tr><td>I.G.V. (18%)</td><td>S/</td><td class="num">${money(s.igv)}</td></tr>
      <tr class="cpe-total"><td>IMPORTE TOTAL</td><td>S/</td><td class="num">${money(s.total)}</td></tr>`
    : `<tr class="cpe-total"><td>IMPORTE TOTAL</td><td>S/</td><td class="num">${money(s.total)}</td></tr>`;

  return `
  <div class="cpe" id="comprobante-imprimible">
    <div class="cpe-header">
      <div class="cpe-emisor">
        <div class="cpe-logo">✿</div>
        <div class="cpe-razon">${escapeHtml(e.razonSocial)}</div>
        <div>${escapeHtml(e.nombreComercial)}</div>
        <div>${escapeHtml(e.direccion)}</div>
        <div>Telf.: ${escapeHtml(e.telefono)}</div>
      </div>
      <div class="cpe-box">
        <div>R.U.C. ${escapeHtml(e.ruc)}</div>
        <div class="cpe-tipo">${escapeHtml(s.label)}</div>
        <div class="cpe-numero">${escapeHtml(s.ticketNumber)}</div>
      </div>
    </div>

    ${clienteHtml}

    <table class="cpe-items">
      <thead>
        <tr>
          <th class="num">Cant.</th>
          <th>Und.</th>
          <th>Descripción</th>
          <th class="num">${s.isFactura ? "V. Unit." : "P. Unit."}</th>
          <th class="num">${s.isFactura ? "Valor venta" : "Importe"}</th>
        </tr>
      </thead>
      <tbody>${lineasHtml}</tbody>
    </table>

    <table class="cpe-totales">
      ${totalesHtml}
    </table>

    <div class="cpe-letras">SON: ${numeroALetras(s.total)}</div>

    <div class="cpe-footer">
      ${s.isTicket
        ? "Ticket interno emitido antes de implementar boletas y facturas."
        : `Representación impresa de la ${s.isFactura ? "Factura Electrónica" : "Boleta de Venta Electrónica"}.${s.isFactura ? "<br>Los precios incluyen IGV." : ""}`}
      <div style="margin-top:8px">Gracias por elegir Studio Floral 🌷</div>
    </div>
  </div>`;
}
