// ==========================================
// INICIO DE SESIÓN Y PERFILES (HU-16)
// ==========================================
// Dos perfiles: "admin" (acceso total) y "vendedor" (ventas, consulta, entradas y conteo).
// Las contraseñas se guardan cifradas con scrypt (módulo crypto de Node.js, sin instalar nada).
// La sesión es una cookie HttpOnly con un token aleatorio que se guarda en memoria:
// si el servidor se reinicia, hay que volver a iniciar sesión.
const crypto = require("crypto");
const { AsyncLocalStorage } = require("async_hooks");

const ROLES = { admin: "Administrador", vendedor: "Vendedor" };
const COOKIE = "sf_sesion";
const SESSION_HOURS = 12;
const sessions = new Map(); // token -> { userId, expires }
const requestUser = new AsyncLocalStorage(); // usuario de la petición en curso (para registrar quién hizo cada operación)

// Páginas que solo puede abrir el administrador
const ADMIN_PAGES = ["proveedores.html", "reportes.html", "usuarios.html"];

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(hash, "hex");
  return expected.length === check.length && crypto.timingSafeEqual(expected, check);
}

function publicUser(u) {
  return { id: u.id, name: u.name, username: u.username, role: u.role, roleLabel: ROLES[u.role], active: u.active, createdAt: u.createdAt };
}

function readCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return "";
}

function setSessionCookie(req, res, token, maxAgeSeconds) {
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.setHeader("Set-Cookie",
    `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`);
}

function validPassword(p) { return typeof p === "string" && p.length >= 6 && p.length <= 100; }

module.exports = function setupAuth(app, { readData, writeData, id, text }) {
  // Crea los usuarios iniciales si no existen (cambia sus contraseñas al entrar por primera vez)
  function ensureUsers() {
    const data = readData();
    if (Array.isArray(data.users) && data.users.some(u => u.role === "admin" && u.active)) return;
    data.users = Array.isArray(data.users) ? data.users : [];
    const now = new Date().toISOString();
    if (!data.users.some(u => u.username === "admin")) {
      data.users.push({ id: id("u"), name: "Administradora", username: "admin", role: "admin", active: true,
        passwordHash: hashPassword(process.env.ADMIN_PASSWORD || "admin123"), createdAt: now });
    } else {
      const a = data.users.find(u => u.username === "admin"); a.role = "admin"; a.active = true;
    }
    if (!data.users.some(u => u.username === "vendedor")) {
      data.users.push({ id: id("u"), name: "Vendedor", username: "vendedor", role: "vendedor", active: true,
        passwordHash: hashPassword(process.env.VENDEDOR_PASSWORD || "vendedor123"), createdAt: now });
    }
    writeData(data);
    console.log("👤 Usuarios iniciales creados: admin y vendedor (cambia sus contraseñas en la página Usuarios).");
  }

  function currentUser(req) {
    const token = readCookie(req, COOKIE);
    const s = token && sessions.get(token);
    if (!s) return null;
    if (s.expires < Date.now()) { sessions.delete(token); return null; }
    const u = (readData().users || []).find(x => x.id === s.userId && x.active);
    return u ? publicUser(u) : null;
  }

  // ---- Identifica al usuario en cada petición ----
  app.use((req, _res, next) => {
    req.user = currentUser(req);
    requestUser.run(req.user, next);
  });

  // ---- Protege las páginas: sin sesión se va al login; el vendedor no abre páginas de administrador ----
  app.use((req, res, next) => {
    const p = req.path;
    if (p.startsWith("/api/") || p.startsWith("/css/") || p.startsWith("/js/") || p.startsWith("/imagenes/")) return next();
    if (p === "/paginas/login.html") return req.user ? res.redirect("/paginas/index.html") : next();
    if (!req.user) return res.redirect("/paginas/login.html");
    const page = p.split("/").pop();
    if (req.user.role !== "admin" && ADMIN_PAGES.includes(page)) return res.redirect("/paginas/index.html?sinPermiso=1");
    next();
  });

  // ---- API de sesión ----
  app.post("/api/login", (req, res) => {
    const username = text(req.body.username).toLowerCase();
    const password = typeof req.body.password === "string" ? req.body.password : "";
    if (!username || !password) return res.status(400).json({ error: "Escribe tu usuario y tu contraseña." });
    const u = (readData().users || []).find(x => x.username === username);
    if (!u || !u.active || !verifyPassword(password, u.passwordHash)) {
      return res.status(401).json({ error: "Usuario o contraseña incorrectos." });
    }
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, { userId: u.id, expires: Date.now() + SESSION_HOURS * 3600 * 1000 });
    setSessionCookie(req, res, token, SESSION_HOURS * 3600);
    res.json(publicUser(u));
  });

  app.post("/api/logout", (req, res) => {
    sessions.delete(readCookie(req, COOKIE));
    setSessionCookie(req, res, "", 0);
    res.json({ ok: true });
  });

  app.get("/api/health", (_req, res) => res.json({ ok: true, app: "Studio Floral", storage: "JSON local" }));

  // ---- Toda la API exige sesión ----
  app.use("/api", (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Tu sesión terminó. Vuelve a iniciar sesión." });
    next();
  });

  app.get("/api/me", (req, res) => res.json(req.user));

  // ---- Permisos del vendedor: lo que NO puede hacer se responde con 403 ----
  const soloAdmin = (req, res, next) => req.user.role === "admin" ? next()
    : res.status(403).json({ error: "Esta acción solo la puede realizar un administrador." });
  const adminRules = [
    ["get", "/api/data"],
    ["post", "/api/products"], ["put", "/api/products/:id"], ["patch", "/api/products/:id/active"],
    ["post", "/api/suppliers"], ["put", "/api/suppliers/:id"], ["patch", "/api/suppliers/:id/active"],
    ["post", "/api/associations"], ["delete", "/api/associations/:id"],
    ["get", "/api/costs"], ["post", "/api/costs"],
    ["get", "/api/inventory/counts"], ["get", "/api/inventory/counts/:id"],
  ];
  for (const [method, route] of adminRules) app[method](route, soloAdmin);
  // El vendedor puede contar, pero solo el administrador ajusta el stock al conteo
  app.post("/api/inventory/counts", (req, res, next) => {
    if (req.body && req.body.adjustStock && req.user.role !== "admin") {
      return res.status(403).json({ error: "Solo un administrador puede ajustar el stock al conteo." });
    }
    next();
  });

  // ---- Gestión de usuarios (solo administrador) ----
  app.get("/api/users", soloAdmin, (_req, res) => res.json((readData().users || []).map(publicUser)));

  app.post("/api/users", soloAdmin, (req, res) => {
    const name = text(req.body.name);
    const username = text(req.body.username).toLowerCase();
    const role = req.body.role;
    const password = req.body.password;
    if (!name) return res.status(400).json({ error: "Escribe el nombre de la persona." });
    if (!/^[a-z0-9._-]{3,30}$/.test(username)) return res.status(400).json({ error: "El usuario debe tener de 3 a 30 letras, números, punto, guion o guion bajo, sin espacios." });
    if (!ROLES[role]) return res.status(400).json({ error: "Elige un perfil válido." });
    if (!validPassword(password)) return res.status(400).json({ error: "La contraseña debe tener al menos 6 caracteres." });
    const data = readData();
    data.users = data.users || [];
    if (data.users.some(u => u.username === username)) return res.status(400).json({ error: "Ese usuario ya existe." });
    const u = { id: id("u"), name, username, role, active: true, passwordHash: hashPassword(password), createdAt: new Date().toISOString() };
    data.users.push(u);
    writeData(data);
    res.status(201).json(publicUser(u));
  });

  app.put("/api/users/:id", soloAdmin, (req, res) => {
    const data = readData();
    const u = (data.users || []).find(x => x.id === req.params.id);
    if (!u) return res.status(404).json({ error: "Usuario no encontrado." });
    const next = { ...u };
    if (req.body.name !== undefined) {
      next.name = text(req.body.name);
      if (!next.name) return res.status(400).json({ error: "Escribe el nombre de la persona." });
    }
    if (req.body.role !== undefined) {
      if (!ROLES[req.body.role]) return res.status(400).json({ error: "Elige un perfil válido." });
      next.role = req.body.role;
    }
    if (req.body.active !== undefined) next.active = Boolean(req.body.active);
    if (req.body.password !== undefined && req.body.password !== "") {
      if (!validPassword(req.body.password)) return res.status(400).json({ error: "La contraseña debe tener al menos 6 caracteres." });
      next.passwordHash = hashPassword(req.body.password);
    }
    // Siempre debe quedar al menos un administrador activo
    const adminsLeft = data.users.filter(x => x.id !== u.id && x.role === "admin" && x.active).length;
    if (!(next.role === "admin" && next.active) && adminsLeft === 0) {
      return res.status(400).json({ error: "Debe quedar al menos un administrador activo." });
    }
    Object.assign(u, next);
    writeData(data);
    // Si se desactiva o cambia la contraseña, se cierran sus sesiones abiertas
    if (!u.active || (req.body.password !== undefined && req.body.password !== "")) {
      for (const [t, s] of sessions) if (s.userId === u.id && t !== readCookie(req, COOKIE)) sessions.delete(t);
    }
    res.json(publicUser(u));
  });

  return { ensureUsers, currentRequestUser: () => requestUser.getStore() || null };
};
