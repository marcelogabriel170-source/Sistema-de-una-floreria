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
  const closeForm = () => { form.reset(); document.getElementById("supplier-id").value = ""; document.getElementById("supplier-form-title").textContent = "Registrar proveedor"; formPanel.classList.add("hidden"); updateCodeHint(); };
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
    const list = suppliers.filter(s => [s.ruc, s.name, s.contact, s.phone, s.email, s.productCode].some(v => String(v || "").toLowerCase().includes(q)));
    const target = document.getElementById("suppliers-list");
    target.innerHTML = list.length ? list.map(s => `<div style="padding:14px 0;border-bottom:1px solid #f0f1ed"><div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start"><div><strong>${escapeHtml(s.name)}</strong> <span class="badge ${s.active ? "" : "inactive"}">${s.active ? "Activo" : "Inactivo"}</span><div class="muted">${escapeHtml(s.contact)}</div>${s.productCode ? `<div class="muted">Código: <strong>${escapeHtml(s.productCode)}</strong> · ${escapeHtml(productNameByCode(s.productCode))}</div>` : `<div class="muted" style="color:#a23e37">Sin código de producto: edítalo para asignarle uno.</div>`}</div><div class="row-actions">${s.active ? `<button class="btn btn-secondary btn-small" data-supplier-edit="${s.id}">Editar</button>` : ""}<button class="btn ${s.active ? "btn-danger" : "btn-secondary"} btn-small" data-supplier-toggle="${s.id}" data-active="${!s.active}">${s.active ? "Desactivar" : "Activar"}</button></div></div><div class="muted" style="margin-top:8px">☎ ${escapeHtml(s.phone)} · ✉ ${escapeHtml(s.email)}</div>${s.notes ? `<div class="muted">${escapeHtml(s.notes)}</div>` : ""}</div>`).join("") : `<div class="empty">No hay proveedores para mostrar.</div>`;
  }
  document.getElementById("suppliers-list").addEventListener("click", async e => {
    const edit = e.target.closest("[data-supplier-edit]"), toggle = e.target.closest("[data-supplier-toggle]");
    if (edit) {
      const s = suppliers.find(x => x.id === edit.dataset.supplierEdit); if (!s) return;
      document.getElementById("supplier-id").value = s.id;
      ["ruc", "name", "address", "status", "condition", "contact", "phone", "email", "notes"].forEach(key => document.getElementById(`supplier-${key}`).value = s[key] || "");
      codeInput.value = s.productCode || ""; updateCodeHint();
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
    payload.productCode = codeInput.value.trim().toUpperCase();
    try { await api(id ? `/suppliers/${id}` : "/suppliers", { method: id ? "PUT" : "POST", body: JSON.stringify(payload) }); closeForm(); showMessage("supplier-message", id ? "Proveedor actualizado." : "Proveedor registrado."); await loadAll(); }
    catch (err) { showMessage("supplier-message", err.message, "error"); }
  });
  // ---- Código de producto del proveedor ----
  const codeInput = document.getElementById("supplier-code");
  const codeHint = document.getElementById("supplier-code-hint");
  const productNameByCode = code => (codes.find(c => c.code === code) || {}).name || "producto no encontrado";
  function updateCodeHint() {
    const value = codeInput.value.trim().toUpperCase();
    const found = codes.find(c => c.code === value);
    if (!value) { codeHint.style.color = ""; codeHint.textContent = "Escribe el código del producto que te vende este proveedor."; return; }
    codeHint.style.color = found ? "#2e6a40" : "#a23e37";
    codeHint.textContent = found ? `✓ ${found.code} → ${found.name} (${found.category})` : "Ese código no existe. Elige uno de la lista.";
  }
  function fillCodes() {
    document.getElementById("product-codes").innerHTML = codes.map(c => `<option value="${escapeHtml(c.code)}">${escapeHtml(c.name)}</option>`).join("");
    document.getElementById("supplier-code-chips").innerHTML = codes.map(c => `<button type="button" class="btn btn-secondary btn-small" data-code="${escapeHtml(c.code)}">${escapeHtml(c.code)} · ${escapeHtml(c.name)}</button>`).join("");
    updateCodeHint();
  }
  codeInput.addEventListener("input", () => { codeInput.value = codeInput.value.toUpperCase(); updateCodeHint(); });
  document.getElementById("supplier-code-chips").addEventListener("click", e => {
    const chip = e.target.closest("[data-code]"); if (!chip) return;
    codeInput.value = chip.dataset.code; updateCodeHint();
  });
  loadAll();
});
