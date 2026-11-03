document.addEventListener("DOMContentLoaded", () => {
  const $ = id => document.getElementById(id);
  const limaHoy = () => new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10);
  const pct = v => v === null || v === undefined ? "—" : `${new Intl.NumberFormat("es-PE", { maximumFractionDigits: 1 }).format(v)} %`;
  let report = null;

  function rango(tipo) {
    const hoy = limaHoy(), d = new Date(hoy + "T12:00:00Z");
    const iso = x => x.toISOString().slice(0, 10);
    if (tipo === "hoy") return [hoy, hoy];
    if (tipo === "semana") return [iso(new Date(d - 6 * 864e5)), hoy];
    if (tipo === "mesAnterior") {
      const ini = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)), fin = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0));
      return [iso(ini), iso(fin)];
    }
    return [hoy.slice(0, 8) + "01", hoy];
  }

  async function load() {
    try {
      report = await api(`/reports?from=${$("rep-from").value}&to=${$("rep-to").value}`);
      render();
      $("export-report").disabled = false;
    } catch (e) { showMessage("report-message", e.message, "error"); }
  }

  function render() {
    const r = report.resumen;
    const cards = [
      ["Ventas", "↗", euro(r.ingresos), `${r.ventas} comprobante${r.ventas === 1 ? "" : "s"}${r.anuladas ? ` · ${r.anuladas} anulada${r.anuladas === 1 ? "" : "s"}` : ""}`],
      ["Ganancia estimada", "S/", euro(r.ganancia), `Costo de lo vendido: ${euro(r.costoVendido)}`],
      ["Merma", "⚠", `${r.mermaPaquetes} paq.`, `Valor al costo: ${euro(r.mermaValor)}`],
      ["Compras", "▤", euro(r.compras), `${r.pedidos} pedido${r.pedidos === 1 ? "" : "s"} con entrega en el periodo`]
    ];
    $("report-stats").innerHTML = cards.map(([l, i, v, n]) => `<div class="stat-card"><div class="stat-top">${l} <span class="stat-icon">${i}</span></div><div class="stat-value" style="font-size:24px">${v}</div><div class="stat-note">${escapeHtml(n)}</div></div>`).join("");

    $("rep-products").innerHTML = report.productos.length ? report.productos.map((p, i) => `<tr>
      <td>${i + 1}</td><td><strong>${escapeHtml(p.name)}</strong>${p.type === "Accesorio" ? '<div class="muted">Accesorio</div>' : ""}</td>
      <td>${p.quantity}</td><td class="price">${euro(p.revenue)}</td>
      <td>${p.sinCosto === p.quantity ? '<span class="muted">Sin costo</span>' : euro(p.cost) + (p.sinCosto ? `<div class="muted">${p.sinCosto} sin costo</div>` : "")}</td>
      <td class="price">${p.profit === null ? "—" : euro(p.profit)}</td><td>${pct(p.margin)}</td></tr>`).join("") : emptyRow(7, "No hay ventas en este periodo.");

    const m = report.merma;
    $("rep-waste-sub").textContent = Object.keys(m.porMotivo).length
      ? Object.entries(m.porMotivo).map(([k, v]) => `${k}: ${v}`).join(" · ") : "Paquetes perdidos y su valor al costo.";
    $("rep-waste").innerHTML = m.porProducto.length ? m.porProducto.map(w => `<tr>
      <td><strong>${escapeHtml(w.name)}</strong></td><td>${w.quantity}</td>
      <td>${w.sinCosto === w.quantity ? '<span class="muted">Sin costo</span>' : euro(w.value)}</td>
      <td class="muted" style="white-space:normal;min-width:170px">${Object.entries(w.motivos).map(([k, v]) => `${escapeHtml(k)}: ${v}`).join(" · ")}</td></tr>`).join("") : emptyRow(4, "No hay merma en este periodo.");

    $("rep-purchases").innerHTML = report.compras.length ? report.compras.map(c => `<tr>
      <td><strong>${escapeHtml(c.name)}</strong></td><td>${c.entries}</td><td>${c.packages}</td>
      <td class="price">${euro(c.amount)}${c.sinCosto ? `<div class="muted">${c.sinCosto} paq. sin costo</div>` : ""}</td></tr>`).join("") : emptyRow(4, "No hay entradas en este periodo.");

    const chips = (obj) => Object.entries(obj).map(([k, v]) => `<span class="badge">${escapeHtml(k)}: ${v}</span>`).join(" ");
    const o = report.pedidos;
    $("rep-orders").innerHTML = Object.keys(o.porEstado).length
      ? `<div><div class="muted" style="margin-bottom:6px">Por estado</div>${chips(o.porEstado)}</div><div><div class="muted" style="margin-bottom:6px">Por canal</div>${chips(o.porCanal)}</div>`
      : `<div class="empty" style="padding:12px">No hay pedidos con entrega en este periodo.</div>`;
  }

  // ---------- Exportar a Excel (.xlsx, una hoja por sección) ----------
  $("export-report").addEventListener("click", () => {
    if (!report) return;
    const r = report.resumen, n = v => v === null || v === undefined ? "" : v;
    const hojas = {
      "Resumen": [["Reporte Studio Floral"], ["Desde", report.from], ["Hasta", report.to], [],
        ["Ventas (S/)", r.ingresos], ["N.° de ventas", r.ventas], ["IGV incluido (S/)", r.igv], ["Costo de lo vendido (S/)", r.costoVendido],
        ["Ganancia estimada (S/)", r.ganancia], ["Ventas anuladas", r.anuladas], ["Monto anulado (S/)", r.montoAnulado],
        ["Merma (paquetes)", r.mermaPaquetes], ["Merma valorizada (S/)", r.mermaValor], ["Compras (S/)", r.compras], ["Pedidos con entrega", r.pedidos]],
      "Productos": [["#", "Producto", "Tipo", "Cantidad", "Ventas (S/)", "Costo (S/)", "Ganancia (S/)", "Margen (%)", "Unidades sin costo"],
        ...report.productos.map((p, i) => [i + 1, p.name, p.type, p.quantity, p.revenue, p.cost, n(p.profit), n(p.margin), p.sinCosto])],
      "Merma": [["N.°", "Fecha", "Producto", "Paquetes", "Motivo", "Detalle", "Valor (S/)", "Registró"],
        ...report.merma.registros.map(w => [w.number, dateTime(w.date), w.productName, w.quantity, w.reasonLabel, w.note, n(w.value), w.user?.name || ""])],
      "Compras": [["Proveedor", "Entradas", "Paquetes", "Monto (S/)", "Paquetes sin costo"],
        ...report.compras.map(c => [c.name, c.entries, c.packages, c.amount, c.sinCosto])],
      "Ventas": [["Comprobante", "Fecha", "Cliente", "Vendedor", "Total (S/)", "Estado", "Motivo de anulación"],
        ...report.ventasDetalle.map(s => [s.ticketNumber, dateTime(s.date), s.customer, s.seller, s.total, s.status, s.voidReason])]
    };
    const archivo = `studio-floral-reporte-${report.from}-a-${report.to}`;
    if (window.XLSX) {
      const wb = XLSX.utils.book_new();
      for (const [nombre, filas] of Object.entries(hojas)) {
        const ws = XLSX.utils.aoa_to_sheet(filas);
        ws["!cols"] = filas[0].map((_, c) => ({ wch: Math.min(40, Math.max(10, ...filas.map(f => String(f[c] ?? "").length + 2))) }));
        XLSX.utils.book_append_sheet(wb, ws, nombre);
      }
      XLSX.writeFile(wb, archivo + ".xlsx");
    } else {
      // Sin conexión a la librería: se descarga un CSV que Excel también abre
      const filas = Object.entries(hojas).flatMap(([nombre, f]) => [[nombre], ...f, []]);
      const csv = filas.map(row => row.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(";")).join("\r\n");
      const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" }));
      const a = document.createElement("a"); a.href = url; a.download = archivo + ".csv"; a.click(); URL.revokeObjectURL(url);
    }
  });

  document.querySelectorAll("[data-range]").forEach(b => b.addEventListener("click", () => {
    [$("rep-from").value, $("rep-to").value] = rango(b.dataset.range); load();
  }));
  $("report-filter").addEventListener("submit", e => { e.preventDefault(); load(); });
  [$("rep-from").value, $("rep-to").value] = rango("mes");
  load();
});
