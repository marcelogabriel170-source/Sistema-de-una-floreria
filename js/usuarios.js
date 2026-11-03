document.addEventListener("DOMContentLoaded", () => {
  const $ = id => document.getElementById(id);
  const panel = $("user-form-panel"), form = $("user-form"), table = $("users-table");
  let users = [];

  const close = () => { form.reset(); $("user-id").value = ""; panel.classList.add("hidden"); };
  const open = (u) => {
    form.reset();
    $("user-id").value = u ? u.id : "";
    $("user-form-title").textContent = u ? `Editar usuario: ${u.username}` : "Nuevo usuario";
    $("user-name").value = u ? u.name : "";
    $("user-username").value = u ? u.username : "";
    $("user-username").disabled = Boolean(u);
    $("user-role").value = u ? u.role : "vendedor";
    $("user-password").required = !u;
    $("user-password").placeholder = u ? "Déjala en blanco para no cambiarla" : "Mínimo 6 caracteres";
    $("user-password-label").textContent = u ? "Nueva contraseña" : "Contraseña *";
    panel.classList.remove("hidden");
    $("user-name").focus();
  };
  $("new-user-btn").addEventListener("click", () => open(null));
  ["close-user-form", "cancel-user"].forEach(id => $(id).addEventListener("click", close));

  async function load() {
    try {
      users = await api("/users");
      table.innerHTML = users.map(u => `<tr>
        <td><strong>${escapeHtml(u.name)}</strong>${u.id === window.USER?.id ? ' <span class="badge">Tú</span>' : ""}</td>
        <td>${escapeHtml(u.username)}</td>
        <td><span class="badge ${u.role === "admin" ? "" : "low"}">${escapeHtml(u.roleLabel)}</span></td>
        <td><span class="badge ${u.active ? "" : "inactive"}">${u.active ? "Activo" : "Inactivo"}</span></td>
        <td><div class="row-actions">
          <button class="btn btn-secondary btn-small" data-edit="${u.id}">Editar</button>
          <button class="btn ${u.active ? "btn-danger" : "btn-secondary"} btn-small" data-toggle="${u.id}" data-active="${!u.active}">${u.active ? "Desactivar" : "Activar"}</button>
        </div></td></tr>`).join("") || emptyRow(5, "No hay usuarios.");
    } catch (e) { table.innerHTML = emptyRow(5, e.message); }
  }

  table.addEventListener("click", async e => {
    const edit = e.target.closest("[data-edit]"), toggle = e.target.closest("[data-toggle]");
    if (edit) open(users.find(u => u.id === edit.dataset.edit));
    if (toggle) {
      const active = toggle.dataset.active === "true";
      if (!confirm(active ? "¿Activar este usuario?" : "¿Desactivar este usuario? Ya no podrá iniciar sesión.")) return;
      try { await api(`/users/${toggle.dataset.toggle}`, { method: "PUT", body: JSON.stringify({ active }) }); showMessage("user-message", active ? "Usuario activado." : "Usuario desactivado."); load(); }
      catch (err) { showMessage("user-message", err.message, "error"); }
    }
  });

  form.addEventListener("submit", async e => {
    e.preventDefault();
    const id = $("user-id").value;
    const body = { name: $("user-name").value, role: $("user-role").value, password: $("user-password").value };
    if (!id) body.username = $("user-username").value;
    try {
      await api(id ? `/users/${id}` : "/users", { method: id ? "PUT" : "POST", body: JSON.stringify(body) });
      close(); showMessage("user-message", id ? "Usuario actualizado." : "Usuario creado. Ya puede iniciar sesión."); load();
    } catch (err) { showMessage("user-message", err.message, "error"); }
  });

  load();
});
