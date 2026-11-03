document.addEventListener("DOMContentLoaded", () => {
  const formPanel = document.getElementById("supplier-form-panel"), form = document.getElementById("supplier-form");
  let suppliers = [], codes = [];

  const rucInput = document.getElementById("supplier-ruc");
  const consultRucBtn = document.getElementById("consult-ruc-btn");

  consultRucBtn.addEventListener("click", async () => {
    const ruc = rucInput.value.trim();
    const message = document.getElementById("ruc-message");

    if (!/^\d{11}$/.test(ruc)) {
      message.textContent = "Ingresa un RUC válido de 11 dígitos.";
      return;
    }

    consultRucBtn.disabled = true;
    message.textContent = "Consultando RUC...";

    try {
      // La consulta se realiza a través del backend.
      const data = await api(
        `/consulta-ruc/${encodeURIComponent(ruc)}`
      );

      document.getElementById("supplier-name").value =
        data.razonSocial || data.razon_social || "";

      document.getElementById("supplier-address").value =
        data.direccion || data.domicilio_fiscal || "";

      document.getElementById("supplier-status").value =
        data.estado || "";

      document.getElementById("supplier-condition").value =
        data.condicion || "";

      // Solo completar estos campos si la fuente los proporciona.
      if (data.telefono) {
        document.getElementById("supplier-phone").value =
          data.telefono;
      }

      if (data.correo || data.email) {
        document.getElementById("supplier-email").value =
          data.correo || data.email;
      }

      message.textContent = data.razonSocial || data.razon_social
        ? "Datos encontrados. Revisa la información antes de guardar."
        : "No se encontraron datos para ese RUC.";
    } catch (error) {
      message.textContent =
        error.message || "No se pudo consultar el RUC.";
    } finally {
      consultRucBtn.disabled = false;
    }
  });

  const openForm = () => { formPanel.classList.remove("hidden"); document.getElementById("supplier-name").focus(); };
  const closeForm = () => { form.reset(); document.getElementById("supplier-id").value = ""; document.getElementById("supplier-form-title").textContent = "Registrar proveedor"; formPanel.classList.add("hidden"); fillCodes([]); };
  document.getElementById("new-supplier-btn").addEventListener("click", () => { closeForm(); openForm(); });
  ["close-supplier-form", "cancel-supplier"].forEach(id => document.getElementById(id).addEventListener("click", closeForm));
  document.getElementById("supplier-search").addEventListener("input", renderSuppliers);
  async function loadAll() {
    try {
      [suppliers, codes] = await Promise.all([api("/suppliers"), api("/product-codes")]);
      renderSuppliers(); fillCodes();
    } catch (e) { showMessage("supplier-message", e.message, "error"); }
  }
  function renderSuppliers() {
    const q = document.getElementById("supplier-search").value.toLowerCase();
    const list = suppliers.filter(s => [s.ruc, s.name, s.contact, s.phone, s.email, ...supplierCodes(s), ...supplierCodes(s).map(productNameByCode)].some(v => String(v || "").toLowerCase().includes(q)));
    const target = document.getElementById("suppliers-list");
    target.innerHTML = list.length ? list.map(s => `<div style="padding:14px 0;border-bottom:1px solid #f0f1ed"><div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start"><div><strong>${escapeHtml(s.name)}</strong> <span class="badge ${s.active ? "" : "inactive"}">${s.active ? "Activo" : "Inactivo"}</span><div class="muted">${escapeHtml(s.contact)}</div>${supplierCodes(s).length ? `<div class="muted">Abastece: ${supplierCodes(s).map(c => `<strong>${escapeHtml(c)}</strong> ${escapeHtml(productNameByCode(c))}`).join(" · ")}</div>` : `<div class="muted" style="color:#a23e37">Sin productos asignados: edítalo para elegirlos.</div>`}</div><div class="row-actions">${s.active ? `<button class="btn btn-secondary btn-small" data-supplier-edit="${s.id}">Editar</button>` : ""}<button class="btn ${s.active ? "btn-danger" : "btn-secondary"} btn-small" data-supplier-toggle="${s.id}" data-active="${!s.active}">${s.active ? "Desactivar" : "Activar"}</button></div></div><div class="muted" style="margin-top:8px">☎ ${escapeHtml(s.phone)} · ✉ ${escapeHtml(s.email)}</div>${s.notes ? `<div class="muted">${escapeHtml(s.notes)}</div>` : ""}</div>`).join("") : `<div class="empty">No hay proveedores para mostrar.</div>`;
  }
  document.getElementById("suppliers-list").addEventListener("click", async e => {
    const edit = e.target.closest("[data-supplier-edit]"), toggle = e.target.closest("[data-supplier-toggle]");
    if (edit) {
      const s = suppliers.find(x => x.id === edit.dataset.supplierEdit); if (!s) return;
      document.getElementById("supplier-id").value = s.id;
      ["ruc", "name", "address", "status", "condition", "contact", "phone", "email", "notes"].forEach(key => document.getElementById(`supplier-${key}`).value = s[key] || "");
      fillCodes(supplierCodes(s));
      document.getElementById("supplier-form-title").textContent = "Editar proveedor"; openForm(); window.scrollTo({ top: 0, behavior: "smooth" });
    }
    if (toggle) {
      const active = toggle.dataset.active === "true";
      if (!confirm(`${active ? "¿Activar" : "¿Desactivar"} proveedor?`)) return;
      try { await api(`/suppliers/${toggle.dataset.supplierToggle}/active`, { method: "PATCH", body: JSON.stringify({ active }) }); showMessage("supplier-message", `Proveedor ${active ? "activado" : "desactivado"}.`); await loadAll(); }
      catch (err) { showMessage("supplier-message", err.message, "error"); }
    }
  });
  form.addEventListener("submit", async e => {
    e.preventDefault();
    const id = document.getElementById("supplier-id").value;
    const payload = {};

    [
      "ruc",
      "name",
      "address",
      "status",
      "condition",
      "contact",
      "phone",
      "email",
      "notes"
    ].forEach(key => {
      const field = document.getElementById(`supplier-${key}`);
      payload[key] = field ? field.value.trim() : "";
    });
    payload.productCodes = checkedCodes();
    if (!payload.productCodes.length) return showMessage("supplier-message", "Marca al menos un producto que abastece este proveedor.", "error");
    try { await api(id ? `/suppliers/${id}` : "/suppliers", { method: id ? "PUT" : "POST", body: JSON.stringify(payload) }); closeForm(); showMessage("supplier-message", id ? "Proveedor actualizado." : "Proveedor registrado."); await loadAll(); }
    catch (err) { showMessage("supplier-message", err.message, "error"); }
  });
  // ---- Productos que abastece el proveedor (por código) ----
  const codesBox = document.getElementById("supplier-code-chips");
  const codeHint = document.getElementById("supplier-code-hint");
  const productNameByCode = code => (codes.find(c => c.code === code) || {}).name || "producto no encontrado";
  const supplierCodes = s => Array.isArray(s.productCodes) ? s.productCodes : (s.productCode ? [s.productCode] : []);
  const checkedCodes = () => [...codesBox.querySelectorAll("input:checked")].map(i => i.value);
  function updateCodeHint() {
    const n = checkedCodes().length;
    codeHint.style.color = n ? "#2e6a40" : "";
    codeHint.textContent = n ? `✓ ${n} producto${n === 1 ? "" : "s"} seleccionado${n === 1 ? "" : "s"}.` : "Marca todos los productos que te vende este proveedor. Los códigos se crean en Productos.";
  }
  function fillCodes(selected = checkedCodes()) {
    codesBox.innerHTML = codes.length ? codes.map(c => `<label class="code-check${c.active ? "" : " inactive"}">
        <input type="checkbox" value="${escapeHtml(c.code)}" ${selected.includes(c.code) ? "checked" : ""} ${c.active ? "" : "disabled"}>
        <span><strong>${escapeHtml(c.code)}</strong> · ${escapeHtml(c.name)}</span></label>`).join("")
      : `<div class="muted">Todavía no hay productos con código. Créalos en <a href="/paginas/catalogo.html" style="text-decoration:underline">Productos</a>.</div>`;
    updateCodeHint();
  }
  codesBox.addEventListener("change", updateCodeHint);
  loadAll();
});
