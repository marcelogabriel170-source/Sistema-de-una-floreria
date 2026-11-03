document.addEventListener("DOMContentLoaded", () => {
  const formPanel = document.getElementById("product-form-panel");
  const form = document.getElementById("product-form");
  const table = document.getElementById("products-table");
  let products = [];
  const formOpen = () => { formPanel.classList.remove("hidden"); document.getElementById("product-name").focus(); };
  const formClose = () => { document.getElementById("recipe-rows").innerHTML = ""; ["product-stock-field", "product-min-field", "product-stems-field"].forEach(id => document.getElementById(id).classList.remove("hidden")); document.getElementById("product-stock").required = true; form.reset(); document.getElementById("product-id").value = ""; document.getElementById("product-form-title").textContent = "Registrar producto"; formPanel.classList.add("hidden"); };
  document.getElementById("new-product-btn").addEventListener("click", () => { formClose(); formOpen(); });
  ["close-product-form", "cancel-product"].forEach(id => document.getElementById(id).addEventListener("click", formClose));
  document.getElementById("product-search").addEventListener("input", renderProducts);
  document.getElementById("product-status").addEventListener("change", renderProducts);

  async function loadProducts() {
    try {
      products = await api("/products");
      renderProducts();
      fillCostProducts();
    } catch (e) { showMessage("product-message", e.message, "error"); }
  }
  // ---------- Receta del arreglo ----------
  const recipeRows = document.getElementById("recipe-rows");
  const insumos = () => products.filter(p => p.active && !(p.recipe && p.recipe.length) && p.id !== document.getElementById("product-id").value);
  function addRecipeRow(ing = {}) {
    const row = document.createElement("div");
    row.className = "recipe-row";
    row.innerHTML = `<select class="rec-product" aria-label="Insumo"><option value="">Insumo…</option>${insumos().map(p =>
        `<option value="${p.id}" data-stems="${p.stemsPerPackage || ""}">${escapeHtml(p.name)}${p.code ? " · " + escapeHtml(p.code) : ""}</option>`).join("")}</select>
      <input class="rec-qty" type="number" min="1" step="1" value="${ing.quantity || 1}" aria-label="Cantidad">
      <select class="rec-unit" aria-label="Unidad"><option value="paquete">paquete(s)</option><option value="tallo">tallo(s)</option></select>
      <button type="button" class="btn btn-secondary btn-small rec-del" aria-label="Quitar insumo">✕</button>`;
    recipeRows.appendChild(row);
    if (ing.productId) row.querySelector(".rec-product").value = ing.productId;
    row.querySelector(".rec-unit").value = ing.unit || "paquete";
    syncUnit(row);
    toggleRecipeMode();
  }
  // Solo se puede usar por tallos si el insumo tiene «tallos por paquete»
  function syncUnit(row) {
    const opt = row.querySelector(".rec-product").selectedOptions[0];
    const tallo = row.querySelector('.rec-unit option[value="tallo"]');
    tallo.disabled = !(opt && opt.dataset.stems);
    if (tallo.disabled) row.querySelector(".rec-unit").value = "paquete";
  }
  // Un arreglo con receta no usa stock propio: se oculta el stock y el mínimo
  function toggleRecipeMode() {
    const has = recipeRows.children.length > 0;
    document.getElementById("product-stock-field").classList.toggle("hidden", has);
    document.getElementById("product-min-field").classList.toggle("hidden", has);
    document.getElementById("product-stems-field").classList.toggle("hidden", has);
    document.getElementById("product-stock").required = !has;
  }
  recipeRows.addEventListener("change", e => { const row = e.target.closest(".recipe-row"); if (row && e.target.classList.contains("rec-product")) syncUnit(row); });
  recipeRows.addEventListener("click", e => { if (e.target.closest(".rec-del")) { e.target.closest(".recipe-row").remove(); toggleRecipeMode(); } });
  document.getElementById("recipe-add").addEventListener("click", () => addRecipeRow());
  const readRecipe = () => [...recipeRows.querySelectorAll(".recipe-row")].map(r => ({
    productId: r.querySelector(".rec-product").value, quantity: Number(r.querySelector(".rec-qty").value), unit: r.querySelector(".rec-unit").value
  }));
  const stockCell = p => {
    if (p.recipe && p.recipe.length) return `<span class="badge">Receta</span><div class="muted">Alcanza para ${p.available ?? 0}</div>`;
    const low = p.stock <= p.minStockEfectivo;
    return `${p.stock}${p.looseStems ? `<div class="muted">+ ${p.looseStems} tallos sueltos</div>` : ""}<div class="muted" style="${low ? "color:#a23e37" : ""}">mín. ${p.minStockEfectivo}</div>`;
  };

  function renderProducts() {
    const q = document.getElementById("product-search").value.toLowerCase();
    const status = document.getElementById("product-status").value;
    const list = products.filter(p => (status === "all" || (status === "active" ? p.active : !p.active)) && [p.name,p.category,p.description].some(v => String(v || "").toLowerCase().includes(q)));
    document.getElementById("product-count").textContent = `${list.length} producto${list.length === 1 ? "" : "s"} · ${status === "active" ? "solo activos" : status === "inactive" ? "inactivos" : "todos los estados"}`;
    if (!list.length) { table.innerHTML = emptyRow(6, "No hay productos que coincidan con la búsqueda."); return; }
    table.innerHTML = list.map(p => `<tr>
      <td><div class="product-cell"><div class="product-thumb">${productIcon(p.category)}</div><div><div class="product-name">${escapeHtml(p.name)}${p.code ? ` <span class="badge">${escapeHtml(p.code)}</span>` : ""}</div><div class="muted">${escapeHtml(p.description || "Sin descripción")}</div>${p.recipe && p.recipe.length ? `<div class="muted">Usa: ${p.recipe.map(r => `${r.quantity} ${r.unit === "tallo" ? "tallo" : "paq."}${r.quantity === 1 ? "" : "s"} de ${escapeHtml((products.find(x => x.id === r.productId) || r).name)}`).join(" · ").replace(/paq\.s/g, "paq.")}</div>` : ""}</div></div></td>
      <td>${escapeHtml(p.category)}</td><td class="price">${euro(p.price)}</td><td>${stockCell(p)}</td>
      <td><span class="badge ${p.active ? "" : "inactive"}">${p.active ? "Activo" : "Inactivo"}</span></td>
      <td><div class="row-actions">${p.active ? `<button class="btn btn-secondary btn-small" data-edit="${p.id}">Editar</button>` : ""}<button class="btn ${p.active ? "btn-danger" : "btn-secondary"} btn-small" data-toggle="${p.id}" data-active="${!p.active}">${p.active ? "Desactivar" : "Activar"}</button></div></td>
    </tr>`).join("");
  }
  table.addEventListener("click", async e => {
    const edit = e.target.closest("[data-edit]");
    const toggle = e.target.closest("[data-toggle]");
    if (edit) {
      const p = products.find(x => x.id === edit.dataset.edit); if (!p) return;
      document.getElementById("product-id").value = p.id;
      document.getElementById("product-name").value = p.name;
      document.getElementById("product-category").value = p.category;
      document.getElementById("product-price").value = p.price;
      document.getElementById("product-stock").value = p.stock;
      document.getElementById("product-description").value = p.description || "";
      document.getElementById("product-code").value = p.code || "";
      document.getElementById("product-min").value = Number.isInteger(p.minStock) ? p.minStock : "";
      document.getElementById("product-stems").value = p.stemsPerPackage || "";
      recipeRows.innerHTML = ""; (p.recipe || []).forEach(addRecipeRow); toggleRecipeMode();
      document.getElementById("product-form-title").textContent = "Editar producto";
      formOpen(); window.scrollTo({ top: 0, behavior: "smooth" });
    }
    if (toggle) {
      const active = toggle.dataset.active === "true";
      if (!confirm(`${active ? "¿Activar" : "¿Desactivar"} este producto?`)) return;
      try { await api(`/products/${toggle.dataset.toggle}/active`, { method: "PATCH", body: JSON.stringify({ active }) }); showMessage("product-message", `Producto ${active ? "activado" : "desactivado"}.`); await loadProducts(); }
      catch (err) { showMessage("product-message", err.message, "error"); }
    }
  });
  form.addEventListener("submit", async e => {
    e.preventDefault();
    const id = document.getElementById("product-id").value;
    const recipe = readRecipe();
    if (recipe.some(r => !r.productId)) return showMessage("product-message", "Elige el insumo de cada fila de la receta (o quita la fila vacía).", "error");
    const payload = { name: document.getElementById("product-name").value, category: document.getElementById("product-category").value, price: Number(document.getElementById("product-price").value),
      stock: recipe.length ? 0 : Number(document.getElementById("product-stock").value), description: document.getElementById("product-description").value,
      code: document.getElementById("product-code").value, minStock: document.getElementById("product-min").value,
      stemsPerPackage: document.getElementById("product-stems").value, recipe };
    try {
      await api(id ? `/products/${id}` : "/products", { method: id ? "PUT" : "POST", body: JSON.stringify(payload) });
      formClose(); showMessage("product-message", id ? "Producto actualizado correctamente." : "Producto registrado correctamente."); await loadProducts();
    } catch (err) { showMessage("product-message", err.message, "error"); }
  });
  async function fillCostProducts() {
    const select = document.getElementById("cost-product");
    const active = products.filter(p => p.active);
    select.innerHTML = `<option value="">Selecciona un producto</option>` + active.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
  }
  async function loadCosts() {
    if ((await window.sessionReady)?.role !== "admin") return; // el vendedor no ve costos
    try {
      const costs = await api("/costs");
      document.getElementById("costs-table").innerHTML = costs.length ? costs.map(c => `<tr><td>${dateTime(c.date)}</td><td>${escapeHtml(c.product?.name || "Producto no disponible")}</td><td class="price">${euro(c.cost)}</td><td>${escapeHtml(c.note || "—")}</td></tr>`).join("") : emptyRow(4, "Todavía no hay costos registrados.");
    } catch (e) { document.getElementById("costs-table").innerHTML = emptyRow(4, e.message); }
  }
  document.getElementById("cost-form").addEventListener("submit", async e => {
    e.preventDefault();
    try {
      await api("/costs", { method: "POST", body: JSON.stringify({ productId: document.getElementById("cost-product").value, cost: Number(document.getElementById("cost-value").value), note: document.getElementById("cost-note").value }) });
      e.target.reset(); showMessage("product-message", "Costo de compra registrado; el historial anterior se conserva."); await loadCosts();
    } catch (err) { showMessage("product-message", err.message, "error"); }
  });
  loadProducts(); loadCosts();
});
