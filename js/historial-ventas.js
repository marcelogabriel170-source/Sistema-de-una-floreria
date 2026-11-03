document.addEventListener("DOMContentLoaded", async () => {
    const table = document.getElementById("lista-historial-ventas");
    const countEl = document.getElementById("historial-count");

    async function load() {
        try {
            const sales = await api("/sales");
            const anuladas = sales.filter(s => s.status === "anulada").length;
            if (countEl) {
                countEl.textContent = `${sales.length} venta${sales.length === 1 ? "" : "s"} registrada${sales.length === 1 ? "" : "s"}${anuladas ? ` · ${anuladas} anulada${anuladas === 1 ? "" : "s"}` : ""}`;
            }
            if (!sales.length) {
                table.innerHTML = emptyRow(6, "Todavía no hay ventas registradas en el sistema.");
                return;
            }
            table.innerHTML = sales.map(sale => {
                const anulada = sale.status === "anulada";
                const itemsList = sale.items.map(i =>
                    `<div style="margin-bottom: 4px;">• <strong>${escapeHtml(i.name)}</strong> × ${i.quantity} <span class="muted">(${euro(i.subtotal)})</span></div>`
                ).join("");
                return `
                <tr${anulada ? ' style="opacity:.75"' : ""}>
                    <td>
                        <strong>${escapeHtml(sale.ticketNumber)}</strong>
                        ${sale.documentType === "factura"
                            ? `<div class="muted">Factura · RUC ${escapeHtml(sale.customer?.docNumber)}</div><div class="muted">${escapeHtml(sale.customer?.name)}</div>`
                            : sale.documentType === "boleta"
                            ? `<div class="muted">Boleta · DNI ${escapeHtml(sale.customer?.docNumber || sale.customer?.dni)}</div><div class="muted">${escapeHtml(sale.customer?.name)}</div>`
                            : `<div class="muted">Ticket</div>`}
                    </td>
                    <td>${dateTime(sale.date)}${sale.seller ? `<div class="muted">Vendió: ${escapeHtml(sale.seller.name)}</div>` : ""}</td>
                    <td>${itemsList}</td>
                    <td class="price"><strong>${anulada ? `<s>${euro(sale.total)}</s>` : euro(sale.total)}</strong></td>
                    <td>${anulada
                        ? `<span class="badge danger">Anulada</span><div class="muted" style="white-space:normal;max-width:220px">${escapeHtml(sale.voided?.reason || "")}${sale.voided?.user ? " · " + escapeHtml(sale.voided.user.name) : ""}</div>`
                        : `<span class="badge">Válida</span>`}</td>
                    <td class="solo-admin">${anulada ? "" : `<button class="btn btn-danger btn-small" data-void="${sale.id}" data-number="${escapeHtml(sale.ticketNumber)}">Anular</button>`}</td>
                </tr>`;
            }).join("");
        } catch (e) {
            showMessage("historial-message", e.message, "error");
            table.innerHTML = emptyRow(6, e.message);
        }
    }

    // Anular una venta (solo administrador): pide el motivo y devuelve el stock
    table.addEventListener("click", async e => {
        const btn = e.target.closest("[data-void]");
        if (!btn) return;
        const reason = prompt(`Motivo para anular ${btn.dataset.number}:\n(Los productos vuelven al stock)`);
        if (reason === null) return;
        if (reason.trim().length < 3) return showMessage("historial-message", "Escribe el motivo de la anulación.", "error");
        try {
            await api(`/sales/${btn.dataset.void}/void`, { method: "POST", body: JSON.stringify({ reason }) });
            showMessage("historial-message", `Venta ${btn.dataset.number} anulada. El stock se devolvió.`);
            load();
        } catch (err) { showMessage("historial-message", err.message, "error"); }
    });

    load();
});
