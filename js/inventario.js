document.addEventListener("DOMContentLoaded", () => {
  const $ = id => document.getElementById(id);
  const LOW_STOCK = 5;

  let products = [];
  let entries = [];
  let expandedEntries = new Set();
  let currentCount = null;
  let pendingCountId = null;
  // Lo que se va escribiendo en el conteo se guarda aquí para no perderlo al cambiar de pestaña
  const countValues = {};

  const loaders = {
    existencias: loadStock,
    entradas: loadEntries,
    fisico: loadCountForm,
    diferencias: loadDifferences,
    movimientos: loadMovements
  };

  function notify(message, type = "success") {
    showMessage("inv-message", message, type);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openTab(name) {
    if (!loaders[name]) name = "existencias";
    document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === name));
    document.querySelectorAll("[data-section]").forEach(s => s.classList.toggle("hidden", s.dataset.section !== name));
    history.replaceState(null, "", name === "existencias" ? location.pathname : "#" + name);
    loaders[name]();
  }

  document.querySelector(".tabs").addEventListener("click", e => {
    const tab = e.target.closest("[data-tab]");
    if (tab) openTab(tab.dataset.tab);
  });

  // ---------- Existencias ----------
  $("inventory-search").addEventListener("input", renderStock);

  async function loadStock() {
    try {
      products = await api("/products?active=true");
      renderStock();
    } catch (e) {
      $("inventory-table").innerHTML = emptyRow(5, e.message);
    }
  }

  // Estado del producto. "Reponer pronto" es un aviso de stock bajo: el vendedor solo ve "Disponible" o "Agotado".
  function estadoStock(p) {
    if (p.stock === 0) return `<span class="badge low">Agotado</span>`;
    if (p.stock <= LOW_STOCK) return `<span class="badge low solo-admin">Reponer pronto</span><span class="badge solo-vendedor">Disponible</span>`;
    return `<span class="badge">Disponible</span>`;
  }

  function renderStock() {
    const q = $("inventory-search").value.toLowerCase();
    const list = products.filter(p => [p.name, p.category].some(v => String(v).toLowerCase().includes(q)));
    const low = products.filter(p => p.stock <= LOW_STOCK);
    const none = products.filter(p => p.stock === 0);
    const stats = [
      ["Referencias activas", "✿", products.length, "Productos activos"],
      ["Paquetes en stock", "▤", products.reduce((s, p) => s + p.stock, 0), "Suma de paquetes"],
      ["Stock bajo", "!", low.length, `${LOW_STOCK} paquetes o menos`],
      ["Sin existencias", "○", none.length, "Stock igual a cero"]
    ];
    // La tarjeta "Stock bajo" es un aviso de reposición: solo la ve el administrador
    $("inventory-stats").innerHTML = stats.map(([label, icon, value, note]) =>
      `<div class="stat-card${label === "Stock bajo" ? " solo-admin" : ""}"><div class="stat-top">${label} <span class="stat-icon">${icon}</span></div><div class="stat-value">${value}</div><div class="stat-note">${note}</div></div>`
    ).join("");

    $("inventory-table").innerHTML = list.length ? list.map(p => `
      <tr>
        <td><div class="product-cell"><div class="product-thumb">${productIcon(p.category)}</div><div><div class="product-name">${escapeHtml(p.name)}</div><div class="muted">${escapeHtml(p.description || "")}</div></div></div></td>
        <td>${escapeHtml(p.category)}</td>
        <td class="price">${p.stock}</td>
        <td>${estadoStock(p)}</td>
        <td><a class="btn btn-secondary btn-small" href="/paginas/catalogo.html">Editar stock</a></td>
      </tr>`).join("") : emptyRow(5, "No hay resultados.");
  }

  // ---------- Entradas ----------
  async function loadEntries() {
    try {
      const [suppliers, list] = await Promise.all([api("/suppliers?active=true"), api("/inventory/entries")]);
      entries = list;
      const select = $("entry-supplier");
      const previous = select.value;
      select.innerHTML = `<option value="">Selecciona proveedor</option>` +
        suppliers.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("");
      select.value = suppliers.some(s => s.id === previous) ? previous : "";
      renderEntries();
      if (select.value) loadSupplierProducts(select.value);
    } catch (e) {
      $("entries-table").innerHTML = emptyRow(6, e.message);
    }
  }

  function renderEntries() {
    $("entries-table").innerHTML = entries.length ? entries.map(en => {
      const open = expandedEntries.has(en.id);
      const main = `
        <tr>
          <td><strong>${escapeHtml(en.number)}</strong></td>
          <td>${dateTime(en.date)}</td>
          <td>${escapeHtml(en.supplierName)}<div class="muted">${escapeHtml(en.documentRef || "")}</div></td>
          <td>${en.totalUnits}</td>
          <td>${en.totalCost ? euro(en.totalCost) : "—"}</td>
          <td><button class="btn btn-secondary btn-small" type="button" data-entry-toggle="${en.id}">${open ? "Ocultar" : "Ver detalle"}</button></td>
        </tr>`;
      if (!open) return main;
      const lines = en.items.map(l =>
        `<tr><td>${escapeHtml(l.name)}</td><td>+${l.quantity}</td><td>${l.unitCost ? euro(l.unitCost) : "—"}</td><td>${l.stockBefore} → ${l.stockAfter}</td></tr>`
      ).join("");
      const note = en.note ? `<div class="muted" style="margin-bottom:8px">Observaciones: ${escapeHtml(en.note)}</div>` : "";
      return main + `
        <tr class="detail-row"><td colspan="6">${note}
          <table><thead><tr><th>Producto</th><th>Cantidad</th><th>Costo unit.</th><th>Stock</th></tr></thead><tbody>${lines}</tbody></table>
        </td></tr>`;
    }).join("") : emptyRow(6, "Todavía no se registró ninguna entrada.");
  }

  $("entries-table").addEventListener("click", e => {
    const btn = e.target.closest("[data-entry-toggle]");
    if (!btn) return;
    const id = btn.dataset.entryToggle;
    expandedEntries.has(id) ? expandedEntries.delete(id) : expandedEntries.add(id);
    renderEntries();
  });

  $("entry-supplier").addEventListener("change", e => loadSupplierProducts(e.target.value));

  // La lista de productos depende del proveedor elegido (según el código de producto que tiene en Proveedores)
  async function loadSupplierProducts(supplierId) {
    const body = $("entry-products");
    if (!supplierId) {
      body.innerHTML = emptyRow(4, "Elige un proveedor para ver sus productos.");
      return;
    }
    try {
      const list = await api(`/suppliers/${encodeURIComponent(supplierId)}/products`);
      body.innerHTML = list.length ? list.map(p => `
        <tr data-product="${p.id}">
          <td><div class="product-name">${escapeHtml(p.name)}</div><div class="muted">${escapeHtml(p.category)}</div></td>
          <td>${p.stock}</td>
          <td><input class="table-input" type="number" min="1" step="1" data-qty aria-label="Cantidad de ${escapeHtml(p.name)}"></td>
          <td><input class="table-input" type="number" min="0.01" step="0.01" data-cost placeholder="${p.lastCost ? Number(p.lastCost).toFixed(2) : "0.00"}" title="${p.lastCost ? "Último costo registrado" : "Sin costo previo"}" aria-label="Costo de ${escapeHtml(p.name)}"></td>
        </tr>`).join("")
        : `<tr><td colspan="4" class="empty">Este proveedor no tiene producto asignado. Edítalo en <a href="/paginas/proveedores.html" style="text-decoration:underline">Proveedores</a> y asígnale un código de producto.</td></tr>`;
    } catch (e) {
      body.innerHTML = emptyRow(4, e.message);
    }
  }

  $("entry-form").addEventListener("submit", async e => {
    e.preventDefault();
    const supplierId = $("entry-supplier").value;
    const items = [...$("entry-products").querySelectorAll("tr[data-product]")]
      .map(row => ({
        productId: row.dataset.product,
        quantity: row.querySelector("[data-qty]").value.trim(),
        unitCost: row.querySelector("[data-cost]").value.trim()
      }))
      .filter(item => item.quantity !== "");

    if (!supplierId) return notify("Selecciona un proveedor.", "error");
    if (!items.length) return notify("Indica la cantidad recibida de al menos un producto.", "error");

    $("entry-submit").disabled = true;
    try {
      const entry = await api("/inventory/entries", {
        method: "POST",
        body: JSON.stringify({ supplierId, documentRef: $("entry-doc").value, note: $("entry-note").value, items })
      });
      $("entry-doc").value = "";
      $("entry-note").value = "";
      notify(`Entrada ${entry.number} registrada: ${entry.totalUnits} unidades sumadas al stock.`);
      await loadEntries();
    } catch (err) {
      notify(err.message, "error");
    } finally {
      $("entry-submit").disabled = false;
    }
  });

  // ---------- Inventario físico ----------
  async function loadCountForm() {
    try {
      products = await api("/products?active=true");
      renderCountForm();
    } catch (e) {
      $("count-table").innerHTML = emptyRow(5, e.message);
    }
  }

  function diffCell(stock, value) {
    if (value === "" || value === undefined) return "—";
    const diff = Number(value) - stock;
    if (diff === 0) return "0";
    return `<span class="${diff < 0 ? "diff-neg" : "diff-pos"}">${diff > 0 ? "+" : ""}${diff}</span>`;
  }

  function renderCountForm() {
    $("count-table").innerHTML = products.length ? products.map(p => `
      <tr data-product="${p.id}" data-stock="${p.stock}" data-search="${escapeHtml((p.name + " " + p.category).toLowerCase())}">
        <td><div class="product-name">${escapeHtml(p.name)}</div></td>
        <td>${escapeHtml(p.category)}</td>
        <td>${p.stock}</td>
        <td><input class="table-input" type="number" min="0" step="1" data-count value="${countValues[p.id] ?? ""}" aria-label="Conteo de ${escapeHtml(p.name)}"></td>
        <td data-diff>${diffCell(p.stock, countValues[p.id])}</td>
      </tr>`).join("") : emptyRow(5, "No hay productos activos para contar.");
    filterCountRows();
  }

  function filterCountRows() {
    const q = $("count-search").value.toLowerCase();
    $("count-table").querySelectorAll("tr[data-product]").forEach(row => {
      row.hidden = !row.dataset.search.includes(q);
    });
  }

  $("count-search").addEventListener("input", filterCountRows);

  $("count-table").addEventListener("input", e => {
    const input = e.target.closest("[data-count]");
    if (!input) return;
    const row = input.closest("tr");
    countValues[row.dataset.product] = input.value;
    row.querySelector("[data-diff]").innerHTML = diffCell(Number(row.dataset.stock), input.value);
  });

  $("count-form").addEventListener("submit", async e => {
    e.preventDefault();
    const items = [...$("count-table").querySelectorAll("tr[data-product]")]
      .map(row => ({ productId: row.dataset.product, stock: Number(row.dataset.stock), counted: row.querySelector("[data-count]").value.trim() }))
      .filter(item => item.counted !== "");

    if (!items.length) return notify("Ingresa el conteo de al menos un producto.", "error");
    if (items.some(i => !Number.isInteger(Number(i.counted)) || Number(i.counted) < 0)) {
      return notify("Los conteos deben ser números enteros iguales o mayores que cero.", "error");
    }

    const adjust = $("count-adjust").checked;
    const changes = items.filter(i => Number(i.counted) !== i.stock).length;
    if (adjust && changes && !confirm(`Se va a cambiar el stock de ${changes} producto(s) al valor contado. ¿Continuar?`)) return;

    $("count-submit").disabled = true;
    try {
      const count = await api("/inventory/counts", {
        method: "POST",
        body: JSON.stringify({
          responsible: $("count-responsible").value,
          note: $("count-note").value,
          adjustStock: adjust,
          items: items.map(i => ({ productId: i.productId, counted: Number(i.counted) }))
        })
      });
      Object.keys(countValues).forEach(k => delete countValues[k]);
      $("count-note").value = "";
      $("count-adjust").checked = false;
      pendingCountId = count.id;
      openTab("diferencias");
      const s = count.summary;
      notify(`Inventario ${count.number} guardado: ${s.products} productos contados, ${s.withDifference} con diferencia.`);
    } catch (err) {
      notify(err.message, "error");
    } finally {
      $("count-submit").disabled = false;
    }
  });

  // ---------- Diferencias ----------
  async function loadDifferences() {
    try {
      const counts = await api("/inventory/counts");
      const select = $("diff-count");
      if (!counts.length) {
        select.innerHTML = `<option value="">Sin inventarios</option>`;
        currentCount = null;
        $("diff-info").textContent = "";
        $("diff-stats").innerHTML = "";
        $("diff-table").innerHTML = `<tr><td colspan="6" class="empty">Todavía no hay inventarios físicos. Registra uno en la pestaña Inventario físico.</td></tr>`;
        return;
      }
      const keep = pendingCountId || select.value;
      select.innerHTML = counts.map(c =>
        `<option value="${c.id}">${escapeHtml(c.number)} · ${dateTime(c.date)}</option>`).join("");
      select.value = counts.some(c => c.id === keep) ? keep : counts[0].id;
      pendingCountId = null;
      await loadCountDetail(select.value);
    } catch (e) {
      $("diff-table").innerHTML = emptyRow(6, e.message);
    }
  }

  async function loadCountDetail(id) {
    try {
      currentCount = await api(`/inventory/counts/${encodeURIComponent(id)}`);
      renderDifferences();
    } catch (e) {
      $("diff-table").innerHTML = emptyRow(6, e.message);
    }
  }

  function renderDifferences() {
    const c = currentCount;
    if (!c) return;
    const s = c.summary;
    const filter = $("diff-filter").value;

    $("diff-info").textContent = [
      `Responsable: ${c.responsible}`,
      c.adjusted ? "Stock del sistema ajustado al conteo" : "Stock del sistema sin ajustar",
      c.note ? `Observaciones: ${c.note}` : ""
    ].filter(Boolean).join(" · ");

    const stats = [
      ["Productos contados", s.products, "En este inventario"],
      ["Con diferencia", s.withDifference, "Distintos al sistema"],
      ["Faltantes", s.shortageUnits, "Unidades de menos"],
      ["Sobrantes", s.surplusUnits, "Unidades de más"],
      ["Valor de la diferencia", euro(s.valueDifference), "Estimado"]
    ];
    $("diff-stats").innerHTML = stats.map(([label, value, note]) =>
      `<div class="stat-card"><div class="stat-top">${label}</div><div class="stat-value">${value}</div><div class="stat-note">${note}</div></div>`
    ).join("");

    const rows = c.lines
      .filter(l => filter === "all" || (filter === "diff" && l.difference !== 0) ||
        (filter === "short" && l.difference < 0) || (filter === "over" && l.difference > 0))
      .sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));

    $("diff-table").innerHTML = rows.length ? rows.map(l => {
      const state = l.difference < 0 ? ["Faltante", "danger"] : l.difference > 0 ? ["Sobrante", "low"] : ["Conforme", ""];
      const sign = l.difference > 0 ? "+" : "";
      return `<tr>
        <td><div class="product-name">${escapeHtml(l.name)}</div><div class="muted">${escapeHtml(l.category)}</div></td>
        <td>${l.systemStock}</td>
        <td>${l.counted}</td>
        <td class="${l.difference < 0 ? "diff-neg" : l.difference > 0 ? "diff-pos" : ""}">${sign}${l.difference}</td>
        <td>${l.difference ? euro(l.difference * l.unitValue) : "—"}</td>
        <td><span class="badge ${state[1]}">${state[0]}</span></td>
      </tr>`;
    }).join("") : emptyRow(6, "No hay productos con ese filtro.");
  }

  $("diff-count").addEventListener("change", e => e.target.value && loadCountDetail(e.target.value));
  $("diff-filter").addEventListener("change", renderDifferences);

  // ---------- Movimientos ----------
  async function loadMovements() {
    try {
      const type = $("move-type").value;
      const list = await api(`/inventory/movements${type ? "?type=" + type : ""}`);
      const badge = { entrada: "", salida: "low", ajuste: "inactive" };
      const label = { entrada: "Entrada", salida: "Salida", ajuste: "Ajuste" };
      $("move-table").innerHTML = list.length ? list.map(m => {
        const qty = m.type === "entrada" ? `+${m.quantity}` : m.type === "salida" ? `−${m.quantity}` : (m.quantity > 0 ? "+" : "") + m.quantity;
        return `<tr>
          <td>${dateTime(m.date)}</td>
          <td><span class="badge ${badge[m.type] || ""}">${label[m.type] || escapeHtml(m.type)}</span></td>
          <td>${escapeHtml(m.productName)}</td>
          <td class="price">${qty}</td>
          <td>${m.stockBefore} → ${m.stockAfter}</td>
          <td>${escapeHtml(m.reference || "—")}</td>
          <td>${escapeHtml(m.note || "")}</td>
        </tr>`;
      }).join("") : emptyRow(7, "Todavía no hay movimientos registrados.");
    } catch (e) {
      $("move-table").innerHTML = emptyRow(7, e.message);
    }
  }

  $("move-type").addEventListener("change", loadMovements);

  window.addEventListener("hashchange", () => openTab(location.hash.slice(1)));
  openTab(location.hash.slice(1));
});
