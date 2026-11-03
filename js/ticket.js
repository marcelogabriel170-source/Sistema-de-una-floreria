document.addEventListener("DOMContentLoaded", async () => {
    const tableBody = document.getElementById("tickets-table-body");
    const container = document.getElementById("ticket-container");
    const countEl = document.getElementById("tickets-count");
    const printBtn = document.getElementById("print-ticket");
    const exportExcelBtn = document.getElementById("export-excel-ticket");
    const exportAllExcelBtn = document.getElementById("export-all-excel");

    let sales = [];
    let selectedSale = null;

    // Imprimir el ticket actual
    printBtn.addEventListener("click", () => window.print());

    // Descargar reporte general de todos los tickets (solo resumen: N° ticket, fecha y total)
    exportAllExcelBtn.addEventListener("click", () => {
        if (!sales.length) {
            alert("No hay tickets registrados para exportar.");
            return;
        }
        const rows = [
            ["N° Comprobante", "Tipo", "DNI/RUC cliente", "Cliente", "Fecha", "Op. gravada", "IGV", "Total"],
            ...sales.map(s => [
                s.ticketNumber,
                s.documentType === "factura" ? "Factura" : s.documentType === "boleta" ? "Boleta" : "Ticket",
                s.customer?.docNumber || s.customer?.dni || "",
                s.customer?.name || "",
                dateTime(s.date),
                normalizarComprobante(s).opGravada,
                normalizarComprobante(s).igv,
                s.total
            ])
        ];
        const csv = rows.map(row => row.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(";")).join("\r\n");
        const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "lista-general-comprobantes.csv";
        a.click();
        URL.revokeObjectURL(url);
    });

    // Descargar en Excel (CSV) únicamente el ticket seleccionado con sus detalles
    exportExcelBtn.addEventListener("click", () => {
        if (!selectedSale) return;
        const c = normalizarComprobante(selectedSale);
        const rows = [
            ["Emisor", c.emisor.razonSocial, "RUC", c.emisor.ruc],
            ["Comprobante", c.label, c.ticketNumber],
            ["Fecha", dateTime(c.date)],
            ...(c.isTicket ? [] : [
                [c.isFactura ? "Razón social" : "Cliente", c.customer.name],
                [c.customer.docType, c.customer.docNumber],
                ...(c.customer.address ? [["Dirección", c.customer.address]] : [])
            ]),
            [],
            ["Cantidad", "Unidad", "Descripción", "Valor unitario (sin IGV)", "Precio unitario (con IGV)", "Valor venta", "IGV", "Importe"]
        ];
        c.items.forEach(i => {
            rows.push([i.quantity, i.unit, i.name, i.valorUnitario, i.unitPrice, i.valorVenta, i.igv, i.subtotal]);
        });
        rows.push([]);
        rows.push(["Op. gravada", "", "", "", "", "", "", c.opGravada]);
        rows.push(["IGV (18%)", "", "", "", "", "", "", c.igv]);
        rows.push(["IMPORTE TOTAL", "", "", "", "", "", "", c.total]);
        rows.push(["SON", numeroALetras(c.total)]);

        const csv = rows.map(row => row.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(";")).join("\r\n");
        const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `comprobante-${selectedSale.ticketNumber}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    });

    async function loadSales() {
        try {
            sales = await api("/sales");
            if (countEl) {
                countEl.textContent = `${sales.length} comprobante${sales.length === 1 ? "" : "s"} emitido${sales.length === 1 ? "" : "s"}`;
            }

            if (!sales.length) {
                tableBody.innerHTML = emptyRow(4, "No hay tickets registrados.");
                container.innerHTML = `<div class="panel empty"><div class="empty-icon">🧾</div>No hay ventas registradas en el sistema.</div>`;
                printBtn.disabled = true;
                exportExcelBtn.disabled = true;
                return;
            }

            tableBody.innerHTML = sales.map(sale => `
                <tr data-id="${sale.id}" style="cursor:pointer;">
                    <td><strong>${escapeHtml(sale.ticketNumber)}</strong></td>
                    <td>${dateOnly(sale.date)}</td>
                    <td class="price">${euro(sale.total)}</td>
                    <td><button class="btn btn-secondary btn-small" data-select="${sale.id}">Ver</button></td>
                </tr>
            `).join("");

            // Seleccionar por defecto el primer ticket (el más reciente)
            if (sales.length > 0) {
                selectTicket(sales[0].id);
            }

        } catch (e) {
            showMessage("ticket-message", e.message, "error");
            tableBody.innerHTML = emptyRow(4, e.message);
        }
    }

    function selectTicket(id) {
        selectedSale = sales.find(s => s.id === id);
        if (!selectedSale) return;

        // Resaltar la fila seleccionada en la tabla
        document.querySelectorAll("#tickets-table-body tr").forEach(tr => {
            tr.style.backgroundColor = tr.dataset.id === id ? "#f0f4f1" : "";
        });

        printBtn.disabled = false;
        exportExcelBtn.disabled = false;

        container.innerHTML = renderComprobante(selectedSale);
    }

    tableBody.addEventListener("click", e => {
        const btn = e.target.closest("[data-select]") || e.target.closest("tr[data-id]");
        if (!btn) return;
        const id = btn.dataset.select || btn.dataset.id;
        selectTicket(id);
    });

    loadSales();
});