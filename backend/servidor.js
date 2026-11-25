const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

// Lee el archivo .env (si existe) para cargar claves como DNI_API_TOKEN sin instalar nada extra
(function cargarEnv() {
  const archivo = path.resolve(__dirname, "..", ".env");
  if (!fs.existsSync(archivo)) return;
  for (const linea of fs.readFileSync(archivo, "utf8").split(/\r?\n/)) {
    const m = linea.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || linea.trim().startsWith("#")) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
})();

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(__dirname);
const DATA_FILE = path.join(DATA_DIR, "data.json");

app.use(express.json({ limit: "1mb" }));

// ==========================================
// INICIO DE SESIÓN Y ROLES (administrador y vendedor)
// ==========================================
// Las contraseñas se guardan con scrypt (nunca en texto plano en memoria) y se pueden cambiar en el archivo .env:
// ADMIN_USER, ADMIN_PASSWORD, VENDEDOR_USER, VENDEDOR_PASSWORD
function hashPassword(password, salt) { return crypto.scryptSync(String(password), salt, 32); }
function crearUsuario(username, password, role, name) {
  const salt = crypto.randomBytes(16);
  return { username: String(username).trim().toLowerCase(), role, name, salt, hash: hashPassword(password, salt) };
}
const USUARIOS = [
  crearUsuario(process.env.ADMIN_USER || "admin", process.env.ADMIN_PASSWORD || "Admin2026", "administrador", "Administrador"),
  crearUsuario(process.env.VENDEDOR_USER || "vendedor", process.env.VENDEDOR_PASSWORD || "Vendedor2026", "vendedor", "Vendedor")
];
const SALT_FALSA = crypto.randomBytes(16);

const SESION_HORAS = 8;
const sesiones = new Map();          // token -> { username, name, role, expira }
const intentosFallidos = new Map();  // ip -> { count, hasta }

// Páginas que puede abrir el vendedor. ticket.html es el comprobante que se abre al confirmar una venta.
const PAGINAS_VENDEDOR = new Set(["index.html", "inventario.html", "proveedores.html", "nueva-venta.html", "ticket.html"]);
// API que puede usar el vendedor (todo lo demás exige ser administrador).
// Nota: /alerts/stock (aviso de stock bajo) NO está aquí: solo lo recibe el administrador.
const API_VENDEDOR = [
  ["GET", /^\/(products|suppliers|product-codes|costs|associations|sales|ticket\/latest|inventory\/(entries|movements|counts)|inventory\/counts\/[^/]+|suppliers\/[^/]+\/products|consulta-(dni|ruc)\/[^/]+)$/],
  ["POST", /^\/(sales|suppliers|inventory\/(entries|counts))$/],
  ["PUT", /^\/suppliers\/[^/]+$/],
  ["PATCH", /^\/suppliers\/[^/]+\/active$/]
];

function leerCookie(req, nombre) {
  for (const parte of String(req.headers.cookie || "").split(";")) {
    const i = parte.indexOf("=");
    if (i > 0 && parte.slice(0, i).trim() === nombre) return decodeURIComponent(parte.slice(i + 1).trim());
  }
  return null;
}
function getSesion(req) {
  const token = leerCookie(req, "sf_session");
  const sesion = token && sesiones.get(token);
  if (!sesion) return null;
  if (sesion.expira < Date.now()) { sesiones.delete(token); return null; }
  return sesion;
}
function cookieSesion(token, maxAge) {
  return `sf_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

app.post("/api/auth/login", (req, res) => {
  const ip = req.ip || "local";
  const previo = intentosFallidos.get(ip);
  if (previo && previo.hasta > Date.now()) {
    return res.status(429).json({ error: "Demasiados intentos. Espera un minuto e inténtalo de nuevo." });
  }
  const username = String(req.body.username || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const user = USUARIOS.find(u => u.username === username);
  const calculado = hashPassword(password, user ? user.salt : SALT_FALSA);
  const valido = !!user && crypto.timingSafeEqual(calculado, user.hash);

  if (!valido) {
    const bloqueoVencido = previo && previo.hasta > 0 && previo.hasta <= Date.now();
    const registro = (!previo || bloqueoVencido) ? { count: 0, hasta: 0 } : previo;
    registro.count += 1;
    if (registro.count >= 5) { registro.hasta = Date.now() + 60 * 1000; registro.count = 0; }
    intentosFallidos.set(ip, registro);
    return res.status(401).json({ error: "Usuario o contraseña incorrectos." });
  }

  intentosFallidos.delete(ip);
  const token = crypto.randomBytes(32).toString("hex");
  sesiones.set(token, { username: user.username, name: user.name, role: user.role, expira: Date.now() + SESION_HORAS * 3600 * 1000 });
  res.setHeader("Set-Cookie", cookieSesion(token, SESION_HORAS * 3600));
  res.json({ username: user.username, name: user.name, role: user.role });
});

app.post("/api/auth/logout", (req, res) => {
  const token = leerCookie(req, "sf_session");
  if (token) sesiones.delete(token);
  res.setHeader("Set-Cookie", cookieSesion("", 0));
  res.json({ ok: true });
});

// Todo lo demás de /api exige sesión y respeta el rol
app.use("/api", (req, res, next) => {
  if (req.path === "/health" || req.path === "/auth/login" || req.path === "/auth/logout") return next();
  const sesion = getSesion(req);
  if (!sesion) return res.status(401).json({ error: "Inicia sesión para continuar." });

  // Protección básica contra peticiones enviadas desde otro sitio
  if (!["GET", "HEAD"].includes(req.method) && req.headers.origin) {
    let origenOk = false;
    try { origenOk = new URL(req.headers.origin).host === req.headers.host; } catch { /* origen inválido */ }
    if (!origenOk) return res.status(403).json({ error: "Origen no permitido." });
  }

  req.sesion = sesion;
  if (sesion.role === "vendedor" && req.path !== "/auth/me") {
    const permitido = API_VENDEDOR.some(([metodo, patron]) => metodo === req.method && patron.test(req.path));
    if (!permitido) return res.status(403).json({ error: "Tu rol de vendedor no tiene permiso para esta acción." });
  }
  next();
});

app.get("/api/auth/me", (req, res) => {
  const { username, name, role } = req.sesion;
  res.json({ username, name, role });
});

// Páginas: sin sesión se ve solo el login; el vendedor solo abre sus páginas
function paginaProtegida(req, res, next) {
  const archivo = path.basename(req.path) || "index.html";
  const sesion = getSesion(req);
  if (archivo === "login.html") {
    return sesion ? res.redirect("/paginas/index.html") : next();
  }
  if (!sesion) return res.redirect("/paginas/login.html");
  if (sesion.role === "vendedor" && !PAGINAS_VENDEDOR.has(archivo)) return res.redirect("/paginas/index.html");
  next();
}
app.use("/css", express.static(path.join(ROOT, "css")));
app.use("/js", express.static(path.join(ROOT, "js")));
app.use("/imagenes", express.static(path.join(ROOT, "imagenes")));
app.use("/paginas", paginaProtegida, express.static(path.join(ROOT, "paginas")));

// ==========================================
// CONFIGURACIÓN DE WHATSAPP (CLIENTE LOCAL)
// ==========================================
const whatsappClient = new Client({
  authStrategy: new LocalAuth()
});

whatsappClient.on('qr', (qr) => {
  console.log('\n📱 ESCANEA ESTE CÓDIGO QR CON TU WHATSAPP (Solo la primera vez):');
  qrcode.generate(qr, { small: true });
});

whatsappClient.on('ready', () => {
  console.log('✅ ¡El bot de WhatsApp de Studio Floral está listo y conectado!');
});

// Con WHATSAPP_DESACTIVADO=1 el servidor arranca sin abrir WhatsApp (útil para pruebas)
if (process.env.WHATSAPP_DESACTIVADO !== "1") {
  whatsappClient.initialize().catch(error => console.error("No se pudo iniciar WhatsApp:", error.message));
}

// ==========================================
// CÓDIGOS DE PRODUCTO Y STOCK MÍNIMO
// ==========================================
// Al registrar un proveedor se pide uno de estos códigos: indica qué producto abastece.
const CODIGOS_PRODUCTO = [
  { code: "ROS-001", name: "Rosas rojas", category: "Flores", price: 18, description: "Paquete de 12 rosas" },
  { code: "CLA-002", name: "Claveles", category: "Flores", price: 12, description: "Paquete de 12 claveles" },
  { code: "GIR-003", name: "Girasoles", category: "Flores", price: 15, description: "Paquete de 6 girasoles" },
  { code: "LIR-004", name: "Lirios", category: "Flores", price: 16, description: "Paquete de 6 lirios" },
  { code: "ORQ-005", name: "Orquídeas", category: "Plantas", price: 35, description: "Orquídea en maceta" }
];
const CODIGO_ROSAS = "ROS-001";
const STOCK_MINIMO = 5;          // stock mínimo general
const STOCK_MINIMO_ROSAS = 10;   // las rosas avisan antes: con 10 o menos hay que pedir

function normalizar(value) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}
function esRosa(product) {
  return product.code === CODIGO_ROSAS || /^rosas?\b/.test(normalizar(product.name));
}
function stockMinimo(product) {
  return esRosa(product) ? STOCK_MINIMO_ROSAS : STOCK_MINIMO;
}
function productoPorCodigo(data, code) {
  if (!code) return null;
  return (data.products || []).find(p => p.code === code) || null;
}

// Proveedor al que se le piden las rosas cuando el stock baja (aparece en la alerta y en el WhatsApp)
const PROVEEDOR_ROSAS = { name: "Fabio Rojas", contact: "Fabio Rojas", phone: "913162052" };
function ultimoProveedor() {
  return { ...PROVEEDOR_ROSAS, origin: "Proveedor de rosas" };
}

// Alertas que ve la pantalla: por ahora las rosas con stock en el mínimo o por debajo
function alertasDeStock(data) {
  return (data.products || [])
    .filter(p => p.active && esRosa(p) && p.stock <= STOCK_MINIMO_ROSAS)
    .map(p => ({
      productId: p.id, code: p.code || "", name: p.name, stock: p.stock, minStock: STOCK_MINIMO_ROSAS,
      supplier: ultimoProveedor(data, p)
    }));
}

// ==========================================
// FUNCIÓN DE ALERTA DE STOCK BAJO
// ==========================================
async function enviarAlertaStockBajo(product, data) {
  try {
    // Configura tu número con código de país y el sufijo '@c.us' (Ejemplo Perú: 51)
    const tuNumero = "51913162053@c.us";

    let textoMensaje = `⚠️ *¡ALERTA DE STOCK BAJO!* ⚠️\n\n` +
      `🌸 *Producto:* ${product.name}\n` +
      `📦 *Stock actual:* ${product.stock} unidades\n` +
      `🏷️ *Categoría:* ${product.category}\n\n`;

    // Rosas: además se indica a quién hay que pedirle más
    if (esRosa(product)) {
      const proveedor = ultimoProveedor(data || readData(), product);
      textoMensaje += proveedor
        ? `📞 *Pedir más al último proveedor:*\n` +
          `• Nombre: ${proveedor.name}\n` +
          (proveedor.contact ? `• Contacto: ${proveedor.contact}\n` : "") +
          `• Teléfono: ${proveedor.phone}\n\n`
        : `📞 No hay proveedor registrado para este producto (código ${CODIGO_ROSAS}).\n\n`;
    }
    textoMensaje += `_Por favor, reabastece el inventario pronto._`;

    await whatsappClient.sendMessage(tuNumero, textoMensaje);
    console.log(`⚠️ Alerta de stock bajo enviada por WhatsApp para: ${product.name}`);
  } catch (error) {
    console.error("Error al enviar la alerta de stock:", error.message);
  }
}

function initialData() {
  return {
    products: [
      { id: "p-demo-1", name: "Ramo Aurora", category: "Ramos", description: "Ramo mixto de temporada", price: 24.5, stock: 12, active: true, createdAt: new Date().toISOString() },
      { id: "p-demo-2", name: "Rosas rojas", category: "Flores", description: "Paquete de 12 rosas", price: 18, stock: 8, active: true, createdAt: new Date().toISOString() },
      { id: "p-demo-3", name: "Jarrón minimal", category: "Accesorios", description: "Jarrón cerámico", price: 14, stock: 5, active: true, createdAt: new Date().toISOString() }
    ],
    suppliers: [
      { id: "s-demo-1", name: "Flores del Valle", contact: "María López", phone: "600 123 456", email: "pedidos@floresvalle.example", notes: "Entrega semanal", active: true, createdAt: new Date().toISOString() },
      { id: "s-demo-2", name: "Verde Vivo", contact: "Equipo comercial", phone: "600 987 654", email: "ventas@verdevivo.example", notes: "Plantas y complementos", active: true, createdAt: new Date().toISOString() }
    ],
    associations: [
      { id: "a-demo-1", productId: "p-demo-1", supplierId: "s-demo-1", createdAt: new Date().toISOString() },
      { id: "a-demo-2", productId: "p-demo-2", supplierId: "s-demo-1", createdAt: new Date().toISOString() }
    ],
    costHistory: [
      { id: "c-demo-1", productId: "p-demo-1", cost: 11.5, date: new Date().toISOString(), note: "Costo inicial de ejemplo" },
      { id: "c-demo-2", productId: "p-demo-2", cost: 8.25, date: new Date().toISOString(), note: "Costo inicial de ejemplo" }
    ],
    sales: [],
    lastTicket: null
  };
}

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify(initialData(), null, 2), "utf8");
}

function readData() {
  ensureDataFile();
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (error) {
    console.error("No se pudo leer data.json:", error.message);
    throw new Error("El archivo de datos no es válido. Haz una copia y revisa backend/data.json.");
  }
}

// Al arrancar: asigna el código a los productos que ya existen, crea los que falten
// y completa el código de los proveedores antiguos a partir de lo que ya tenían asociado.
function migrarCodigos() {
  const data = readData();
  let changed = false;
  if (!Array.isArray(data.products)) data.products = [];

  for (const c of CODIGOS_PRODUCTO) {
    let p = data.products.find(x => x.code === c.code)
      || data.products.find(x => !x.code && normalizar(x.name) === normalizar(c.name));
    if (p) {
      if (p.code !== c.code) { p.code = c.code; changed = true; }
      continue;
    }
    data.products.push({
      id: id("p"), code: c.code, name: c.name, category: c.category, description: c.description,
      price: c.price, stock: 0, active: true, createdAt: new Date().toISOString()
    });
    changed = true;
  }

  for (const s of data.suppliers || []) {
    if (s.productCode) continue;
    const product = (data.associations || [])
      .filter(a => a.supplierId === s.id)
      .map(a => data.products.find(p => p.id === a.productId))
      .find(p => p && CODIGOS_PRODUCTO.some(c => c.code === p.code));
    if (product) { s.productCode = product.code; changed = true; }
  }

  // Proveedor de rosas: Fabio Rojas (ROS-001). Se crea si no existe y se vincula a las rosas.
  const soloDigitos = v => String(v || "").replace(/\D/g, "");
  if (!Array.isArray(data.suppliers)) data.suppliers = [];
  let fabio = data.suppliers.find(x => soloDigitos(x.phone) === PROVEEDOR_ROSAS.phone || normalizar(x.name) === normalizar(PROVEEDOR_ROSAS.name));
  if (!fabio) {
    fabio = {
      id: id("s"), ruc: "", name: PROVEEDOR_ROSAS.name, address: "", status: "", condition: "",
      contact: PROVEEDOR_ROSAS.contact, phone: PROVEEDOR_ROSAS.phone, email: "", productCode: CODIGO_ROSAS,
      notes: "Proveedor de rosas", active: true, createdAt: new Date().toISOString()
    };
    data.suppliers.unshift(fabio);
    changed = true;
  }
  const rosas = productoPorCodigo(data, CODIGO_ROSAS);
  if (rosas && !(data.associations || []).some(a => a.supplierId === fabio.id && a.productId === rosas.id)) {
    if (!vincularProveedor(data, fabio, CODIGO_ROSAS)) changed = true;
  }

  if (changed) writeData(data);
}

function writeData(data) {
  const temp = DATA_FILE + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(temp, DATA_FILE);
}

function id(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function text(value) { return typeof value === "string" ? value.trim() : ""; }

// ==========================================
// COMPROBANTES DE PAGO — BOLETA Y FACTURA
// ==========================================
const IGV_RATE = 0.18; // Los precios del sistema ya incluyen IGV

// Datos del negocio que aparecen en la cabecera del comprobante.
// ⚠️ Reemplazar por los datos reales del negocio.
const EMISOR = {
  ruc: "20000000001",
  razonSocial: "STUDIO FLORAL S.A.C.",
  nombreComercial: "Studio Floral",
  direccion: "Av. Ejemplo 123, La Molina - Lima - Lima",
  telefono: "(01) 000-0000"
};

const DOCUMENT_TYPES = {
  boleta:  { serie: "B001", counter: "boletaCorrelativo",  label: "BOLETA DE VENTA ELECTRÓNICA" },
  factura: { serie: "F001", counter: "facturaCorrelativo", label: "FACTURA ELECTRÓNICA" }
};

function round2(n) { return Math.round(n * 100) / 100; }

// DNI peruano: exactamente 8 dígitos y no puede ser todo ceros
function validDni(value) {
  const dni = String(value ?? "").trim();
  return /^\d{8}$/.test(dni) && dni !== "00000000" ? dni : null;
}

// RUC peruano: 11 dígitos, empieza en 10, 15, 17 o 20, y el dígito verificador es correcto
function validRuc(value) {
  const ruc = String(value ?? "").trim();
  if (!/^(10|15|17|20)\d{9}$/.test(ruc)) return null;
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(ruc[i]), 0);
  const check = (11 - (sum % 11)) % 10;
  return check === Number(ruc[10]) ? ruc : null;
}

// Valida los datos del cliente según el tipo de comprobante.
// Devuelve { error } o { customer }
function validateCustomer(documentType, body) {
  const c = body || {};
  if (documentType === "boleta") {
    const dni = validDni(c.docNumber ?? c.dni);
    const name = text(c.name);
    if (!dni) return { error: "El DNI del cliente es obligatorio para emitir la boleta y debe tener 8 dígitos." };
    if (!name) return { error: "Ingresa el nombre del cliente para emitir la boleta." };
    return { customer: { docType: "DNI", docNumber: dni, name, address: text(c.address) } };
  }
  if (documentType === "factura") {
    const ruc = validRuc(c.docNumber ?? c.ruc);
    const name = text(c.name);
    const address = text(c.address);
    if (!ruc) return { error: "Para emitir factura ingresa un RUC válido de 11 dígitos." };
    if (!name) return { error: "Ingresa la razón social del cliente para emitir la factura." };
    if (!address) return { error: "Ingresa la dirección fiscal del cliente para emitir la factura." };
    return { customer: { docType: "RUC", docNumber: ruc, name, address } };
  }
  return { error: "Selecciona el tipo de comprobante: boleta o factura." };
}

// Siguiente número de la serie (B001-00000001, F001-00000001, ...)
function nextDocumentNumber(data, documentType) {
  const cfg = DOCUMENT_TYPES[documentType];
  const correlativo = (Number(data[cfg.counter]) || 0) + 1;
  data[cfg.counter] = correlativo;
  return { serie: cfg.serie, correlativo, numero: `${cfg.serie}-${String(correlativo).padStart(8, "0")}` };
}
function positiveNumber(value) { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : null; }
function nonNegativeNumber(value) { const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : null; }

app.get("/api/health", (_req, res) => res.json({ ok: true, app: "Studio Floral", storage: "JSON local" }));
app.get("/api/data", (_req, res) => res.json(readData()));

app.get("/api/consulta-ruc/:ruc", async (req, res) => {
  const ruc = req.params.ruc;

  if (!/^\d{11}$/.test(ruc)) {
    return res.status(400).json({
      error: "El RUC debe contener exactamente 11 dígitos."
    });
  }

  try {
    const response = await fetch(
      `https://openruc.com/api/ruc/${encodeURIComponent(ruc)}`,
      { signal: AbortSignal.timeout(10000) }
    );

    if (!response.ok) {
      return res.status(502).json({
        error: "No se pudo consultar el RUC. Inténtalo nuevamente."
      });
    }

    const result = await response.json();

    if (!result.razon_social) {
      return res.status(404).json({
        error: "No se encontraron datos para ese RUC."
      });
    }

    res.json({
      ruc: result.ruc || ruc,
      razonSocial: result.razon_social || "",
      direccion: result.direccion || "",
      estado: result.estado || "",
      condicion: result.condicion || "",
      telefono: "",
      correo: ""
    });
  } catch (error) {
    console.error("Error consultando RUC:", error.message);

    res.status(502).json({
      error: "El servicio de consulta no está disponible."
    });
  }
});
// La consulta de DNI usa apis.net.pe, que exige un token. Sin token responde 401,
// por eso antes fallaba: se enviaba "Bearer undefined". Ahora el token sale del .env.
const DNI_API_URL = process.env.DNI_API_URL || "https://api.apis.net.pe/v2/reniec/dni";
const dniCache = new Map();

function dniSources(dni) {
  const sources = [];
  if (process.env.DNI_API_TOKEN) {
    sources.push({
      name: "apis.net.pe v2",
      url: `${DNI_API_URL}?numero=${encodeURIComponent(dni)}`,
      headers: { Authorization: `Bearer ${process.env.DNI_API_TOKEN}` }
    });
  }
  // Versión anterior del mismo servicio, que en algunos casos responde sin token
  sources.push({
    name: "apis.net.pe v1",
    url: `https://api.apis.net.pe/v1/dni?numero=${encodeURIComponent(dni)}`,
    headers: {}
  });
  return sources;
}

// Cada proveedor nombra los campos distinto; aquí se unifican
function normalizeDni(body, dni) {
  const r = (body && body.data) || body || {};
  const nombres = text(r.nombres || r.nombre);
  if (!nombres) return null;
  return {
    dni: text(r.numeroDocumento || r.dni) || dni,
    nombres,
    apellidoPaterno: text(r.apellidoPaterno || r.apellido_paterno),
    apellidoMaterno: text(r.apellidoMaterno || r.apellido_materno)
  };
}

app.get("/api/consulta-dni/:dni", async (req, res) => {
  const dni = req.params.dni;

  if (!/^\d{8}$/.test(dni)) {
    return res.status(400).json({ error: "El DNI debe contener exactamente 8 dígitos." });
  }
  if (dniCache.has(dni)) return res.json(dniCache.get(dni));

  let rechazadoPorToken = false;

  for (const source of dniSources(dni)) {
    try {
      const response = await fetch(source.url, {
        headers: { Accept: "application/json", ...source.headers },
        signal: AbortSignal.timeout(10000)
      });

      if (response.status === 404) {
        return res.status(404).json({ error: "No se encontraron datos para ese DNI." });
      }
      if (response.status === 401 || response.status === 403) {
        rechazadoPorToken = true;
        console.error(`Consulta DNI (${source.name}): rechazada con ${response.status}. Revisa DNI_API_TOKEN.`);
        continue;
      }
      if (!response.ok) {
        console.error(`Consulta DNI (${source.name}): respondió ${response.status}.`);
        continue;
      }

      const result = normalizeDni(await response.json(), dni);
      if (result) {
        dniCache.set(dni, result);
        return res.json(result);
      }
    } catch (error) {
      console.error(`Consulta DNI (${source.name}):`, error.message);
    }
  }

  const sinToken = !process.env.DNI_API_TOKEN;
  res.status(rechazadoPorToken || sinToken ? 503 : 502).json({
    error: rechazadoPorToken || sinToken
      ? "La consulta de DNI necesita un token válido en el archivo .env (DNI_API_TOKEN)."
      : "El servicio de consulta de DNI no respondió."
  });
});

app.get("/api/products", (req, res) => {
  const data = readData();
  const q = text(req.query.q).toLowerCase();
  const active = req.query.active;
  let items = data.products || [];
  if (active === "true") items = items.filter(p => p.active);
  if (active === "false") items = items.filter(p => !p.active);
  if (q) items = items.filter(p => [p.name, p.category, p.description].some(v => String(v || "").toLowerCase().includes(q)));
  res.json(items);
});

app.post("/api/products", (req, res) => {
  const name = text(req.body.name), category = text(req.body.category);
  const price = positiveNumber(req.body.price), stock = nonNegativeNumber(req.body.stock);
  if (!name || !category || price === null || stock === null) {
    return res.status(400).json({ error: "Completa nombre y categoría, indica un precio mayor que cero y un stock igual o mayor que cero." });
  }
  const data = readData();
  const product = { id: id("p"), name, category, description: text(req.body.description), price, stock, active: true, createdAt: new Date().toISOString() };
  data.products.unshift(product);
  writeData(data);

  // Si el producto nuevo se crea con stock bajo (<= mínimo del producto)
  if (product.stock <= stockMinimo(product)) {
    enviarAlertaStockBajo(product, data);
  }

  res.status(201).json(product);
});

app.put("/api/products/:id", (req, res) => {
  const data = readData(), p = data.products.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: "Producto no encontrado." });
  const name = text(req.body.name), category = text(req.body.category);
  const price = positiveNumber(req.body.price), stock = nonNegativeNumber(req.body.stock);
  if (!name || !category || price === null || stock === null) return res.status(400).json({ error: "Revisa los campos obligatorios y los valores numéricos." });

  Object.assign(p, { name, category, description: text(req.body.description), price, stock });
  writeData(data);

  // Si al actualizar queda con stock bajo
  if (p.stock <= stockMinimo(p)) {
    enviarAlertaStockBajo(p, data);
  }

  res.json(p);
});

app.patch("/api/products/:id/active", (req, res) => {
  const data = readData(), p = data.products.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: "Producto no encontrado." });
  p.active = Boolean(req.body.active); writeData(data); res.json(p);
});

app.get("/api/suppliers", (req, res) => {
  const data = readData(), q = text(req.query.q).toLowerCase();
  let items = data.suppliers || [];
  if (req.query.active === "true") items = items.filter(s => s.active);
  if (q) {items = items.filter(s =>[s.ruc, s.name, s.contact, s.email, s.phone].some(v => String(v || "").toLowerCase().includes(q)));}
  res.json(items);
});


// Lista de códigos de producto que se pueden asignar a un proveedor
app.get("/api/product-codes", (_req, res) => {
  const data = readData();
  res.json(CODIGOS_PRODUCTO.map(c => {
    const p = productoPorCodigo(data, c.code);
    return { code: c.code, name: p ? p.name : c.name, category: p ? p.category : c.category, productId: p ? p.id : null, active: p ? p.active : false };
  }));
});

// Alertas de stock para mostrar en pantalla (rosas con 10 o menos). Solo administrador: el middleware de /api le niega esta ruta al vendedor.
app.get("/api/alerts/stock", (_req, res) => res.json(alertasDeStock(readData())));

// El código identifica el producto que abastece el proveedor y crea el vínculo para las entradas de inventario
function validarCodigoProducto(value) {
  const code = text(value).toUpperCase();
  return CODIGOS_PRODUCTO.some(c => c.code === code) ? code : null;
}
const MENSAJE_CODIGO = `Ingresa un código de producto válido: ${CODIGOS_PRODUCTO.map(c => c.code).join(", ")}.`;

function vincularProveedor(data, supplier, code) {
  const product = productoPorCodigo(data, code);
  if (!product || !product.active) return `El producto con código ${code} no está disponible o está inactivo.`;
  if (!Array.isArray(data.associations)) data.associations = [];
  // Si el proveedor cambió de código, se quita el vínculo automático anterior
  data.associations = data.associations.filter(a => !(a.supplierId === supplier.id && a.source === "codigo" && a.productId !== product.id));
  if (!data.associations.some(a => a.productId === product.id && a.supplierId === supplier.id)) {
    data.associations.unshift({ id: id("a"), productId: product.id, supplierId: supplier.id, source: "codigo", createdAt: new Date().toISOString() });
  }
  return null;
}

app.post("/api/suppliers", (req, res) => {
  const ruc = text(req.body.ruc);
  const name = text(req.body.name);
  const contact = text(req.body.contact);
  const phone = text(req.body.phone);
  const email = text(req.body.email);

  if (!/^\d{11}$/.test(ruc)) {
    return res.status(400).json({
      error: "El RUC debe contener 11 dígitos."
    });
  }

  if (!name || !contact || !phone || !email ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({
      error: "Completa empresa, contacto, teléfono y correo válido."
    });
  }

  const productCode = validarCodigoProducto(req.body.productCode);
  if (!productCode) {
    return res.status(400).json({ error: MENSAJE_CODIGO });
  }

  const data = readData();

  if (data.suppliers.some(s => s.ruc === ruc)) {
    return res.status(409).json({
      error: "Ya existe un proveedor registrado con ese RUC."
    });
  }

  const supplier = {
    id: id("s"),
    ruc,
    name,
    address: text(req.body.address),
    status: text(req.body.status),
    condition: text(req.body.condition),
    contact,
    phone,
    email,
    productCode,
    notes: text(req.body.notes),
    active: true,
    createdAt: new Date().toISOString()
  };

  const errorVinculo = vincularProveedor(data, supplier, productCode);
  if (errorVinculo) return res.status(400).json({ error: errorVinculo });

  data.suppliers.unshift(supplier);
  writeData(data);

  res.status(201).json(supplier);
});



app.put("/api/suppliers/:id", (req, res) => {
  const data = readData();
  const s = data.suppliers.find(x => x.id === req.params.id);

  if (!s) {
    return res.status(404).json({
      error: "Proveedor no encontrado."
    });
  }

  const ruc = text(req.body.ruc);
  const name = text(req.body.name);
  const contact = text(req.body.contact);
  const phone = text(req.body.phone);
  const email = text(req.body.email);

  if (!/^\d{11}$/.test(ruc) || !name || !contact ||
    !phone || !email ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({
      error: "Revisa el RUC y los campos obligatorios."
    });
  }

  if (data.suppliers.some(x => x.ruc === ruc && x.id !== s.id)) {
    return res.status(409).json({
      error: "Otro proveedor ya tiene ese RUC."
    });
  }

  const productCode = validarCodigoProducto(req.body.productCode);
  if (!productCode) {
    return res.status(400).json({ error: MENSAJE_CODIGO });
  }

  Object.assign(s, {
    ruc,
    name,
    address: text(req.body.address),
    status: text(req.body.status),
    condition: text(req.body.condition),
    contact,
    phone,
    email,
    productCode,
    notes: text(req.body.notes)
  });

  const errorVinculo = vincularProveedor(data, s, productCode);
  if (errorVinculo) return res.status(400).json({ error: errorVinculo });

  writeData(data);
  res.json(s);
});


app.patch("/api/suppliers/:id/active", (req, res) => {
  const data = readData(), s = data.suppliers.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: "Proveedor no encontrado." });
  s.active = Boolean(req.body.active); writeData(data); res.json(s);
});

app.get("/api/associations", (_req, res) => {
  const data = readData();
  res.json((data.associations || []).map(a => ({
    ...a,
    product: data.products.find(p => p.id === a.productId) || null,
    supplier: data.suppliers.find(s => s.id === a.supplierId) || null
  })));
});

app.post("/api/associations", (req, res) => {
  const { productId, supplierId } = req.body || {};
  const data = readData();
  const product = data.products.find(p => p.id === productId && p.active);
  const supplier = data.suppliers.find(s => s.id === supplierId && s.active);
  if (!product || !supplier) return res.status(400).json({ error: "Selecciona un producto y un proveedor activos." });
  if (data.associations.some(a => a.productId === productId && a.supplierId === supplierId)) return res.status(409).json({ error: "Esta asociación ya existe." });
  const association = { id: id("a"), productId, supplierId, createdAt: new Date().toISOString() };
  data.associations.unshift(association); writeData(data); res.status(201).json(association);
});

app.delete("/api/associations/:id", (req, res) => {
  const data = readData(), before = data.associations.length;
  data.associations = data.associations.filter(a => a.id !== req.params.id);
  if (data.associations.length === before) return res.status(404).json({ error: "Asociación no encontrada." });
  writeData(data); res.json({ ok: true });
});

app.get("/api/costs", (req, res) => {
  const data = readData();
  const history = (data.costHistory || []).map(c => ({ ...c, product: data.products.find(p => p.id === c.productId) || null }));
  res.json(history.sort((a, b) => new Date(b.date) - new Date(a.date)));
});

app.post("/api/costs", (req, res) => {
  const productId = text(req.body.productId), cost = positiveNumber(req.body.cost), note = text(req.body.note);
  const data = readData(), product = data.products.find(p => p.id === productId && p.active);
  if (!product || cost === null) return res.status(400).json({ error: "Selecciona un producto activo y registra un costo mayor que cero." });
  const record = { id: id("c"), productId, cost, date: new Date().toISOString(), note };
  data.costHistory.unshift(record); writeData(data); res.status(201).json(record);
});

// ==========================================
// INVENTARIO: ENTRADAS, INVENTARIO FÍSICO Y DIFERENCIAS
// ==========================================

function lastCost(data, productId) {
  const records = (data.costHistory || []).filter(c => c.productId === productId);
  records.sort((a, b) => new Date(b.date) - new Date(a.date));
  return records.length ? records[0].cost : null;
}

// Códigos correlativos: E-00001 para entradas, IF-00001 para inventarios físicos
function nextCode(data, counter, prefix) {
  data[counter] = (Number(data[counter]) || 0) + 1;
  return `${prefix}-${String(data[counter]).padStart(5, "0")}`;
}

// Bitácora de todo lo que mueve el stock. quantity va en positivo, salvo en los ajustes
function addMovement(data, movement) {
  if (!Array.isArray(data.movements)) data.movements = [];
  data.movements.unshift({ id: id("m"), date: new Date().toISOString(), ...movement });
}

function summarizeCount(count) {
  const lines = count.lines || [];
  const withDifference = lines.filter(l => l.difference !== 0);
  return {
    products: lines.length,
    withDifference: withDifference.length,
    shortageUnits: withDifference.filter(l => l.difference < 0).reduce((n, l) => n - l.difference, 0),
    surplusUnits: withDifference.filter(l => l.difference > 0).reduce((n, l) => n + l.difference, 0),
    valueDifference: round2(lines.reduce((n, l) => n + l.difference * l.unitValue, 0))
  };
}

// Solo salen los productos que el proveedor tiene asociado: la entrada se arma a partir de ellos
app.get("/api/suppliers/:id/products", (req, res) => {
  const data = readData();
  const supplier = data.suppliers.find(s => s.id === req.params.id);
  if (!supplier) return res.status(404).json({ error: "Proveedor no encontrado." });
  const ids = new Set((data.associations || []).filter(a => a.supplierId === supplier.id).map(a => a.productId));
  res.json(data.products.filter(p => p.active && ids.has(p.id)).map(p => ({
    id: p.id, name: p.name, category: p.category, stock: p.stock, lastCost: lastCost(data, p.id)
  })));
});

// HU-07: registrar entrada de productos
app.post("/api/inventory/entries", (req, res) => {
  const data = readData();
  const supplier = data.suppliers.find(s => s.id === text(req.body.supplierId) && s.active);
  if (!supplier) return res.status(400).json({ error: "Selecciona un proveedor activo." });

  const rawItems = Array.isArray(req.body.items) ? req.body.items : [];
  if (!rawItems.length) return res.status(400).json({ error: "Agrega al menos un producto a la entrada." });

  const allowed = new Set((data.associations || []).filter(a => a.supplierId === supplier.id).map(a => a.productId));
  const seen = new Set();
  const lines = [];

  for (const item of rawItems) {
    const product = data.products.find(p => p.id === item.productId && p.active);
    if (!product) return res.status(400).json({ error: "Hay productos que ya no existen o están inactivos." });
    if (!allowed.has(product.id)) {
      return res.status(400).json({ error: `${product.name} no está asociado a ${supplier.name}. Asócialo primero en Proveedores.` });
    }
    if (seen.has(product.id)) return res.status(400).json({ error: `${product.name} está repetido en la entrada.` });
    seen.add(product.id);

    const quantity = Number(item.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      return res.status(400).json({ error: `Indica una cantidad entera mayor que cero para ${product.name}.` });
    }

    let unitCost = null;
    if (item.unitCost !== undefined && item.unitCost !== null && item.unitCost !== "") {
      unitCost = positiveNumber(item.unitCost);
      if (unitCost === null) return res.status(400).json({ error: `El costo de ${product.name} debe ser mayor que cero.` });
    }
    lines.push({ product, quantity, unitCost });
  }

  const number = nextCode(data, "entryCorrelativo", "E");
  const date = new Date().toISOString();
  const entryLines = [];

  for (const { product, quantity, unitCost } of lines) {
    const stockBefore = product.stock;
    product.stock += quantity;
    entryLines.push({
      productId: product.id, name: product.name, category: product.category,
      quantity, unitCost, stockBefore, stockAfter: product.stock
    });
    addMovement(data, {
      type: "entrada", productId: product.id, productName: product.name, quantity,
      stockBefore, stockAfter: product.stock, reference: number, note: supplier.name
    });
    // El costo de la entrada también alimenta el historial de costos (HU-06)
    if (unitCost !== null) {
      data.costHistory.unshift({ id: id("c"), productId: product.id, cost: unitCost, date, note: `Entrada ${number}` });
    }
  }

  const entry = {
    id: id("e"), number, date,
    supplierId: supplier.id, supplierName: supplier.name, supplierRuc: supplier.ruc || "",
    documentRef: text(req.body.documentRef), note: text(req.body.note),
    items: entryLines,
    totalUnits: entryLines.reduce((n, l) => n + l.quantity, 0),
    totalCost: round2(entryLines.reduce((n, l) => n + (l.unitCost || 0) * l.quantity, 0))
  };
  if (!Array.isArray(data.entries)) data.entries = [];
  data.entries.unshift(entry);
  writeData(data);
  res.status(201).json(entry);
});

app.get("/api/inventory/entries", (_req, res) => res.json(readData().entries || []));

app.get("/api/inventory/movements", (req, res) => {
  const type = text(req.query.type);
  let items = readData().movements || [];
  if (type) items = items.filter(m => m.type === type);
  res.json(items.slice(0, 300));
});

// HU-09: registrar un inventario físico (conteo real contra el stock del sistema)
app.post("/api/inventory/counts", (req, res) => {
  const responsible = text(req.body.responsible);
  if (!responsible) return res.status(400).json({ error: "Indica quién realizó el conteo." });

  const rawItems = Array.isArray(req.body.items) ? req.body.items : [];
  if (!rawItems.length) return res.status(400).json({ error: "Ingresa el conteo de al menos un producto." });

  const data = readData();
  const seen = new Set();
  const lines = [];

  for (const item of rawItems) {
    const product = data.products.find(p => p.id === item.productId && p.active);
    if (!product) return res.status(400).json({ error: "Hay productos que ya no existen o están inactivos." });
    if (seen.has(product.id)) return res.status(400).json({ error: `${product.name} está repetido en el conteo.` });
    seen.add(product.id);

    const counted = Number(item.counted);
    if (item.counted === "" || item.counted === null || !Number.isInteger(counted) || counted < 0) {
      return res.status(400).json({ error: `El conteo de ${product.name} debe ser un número entero igual o mayor que cero.` });
    }
    lines.push({
      productId: product.id, name: product.name, category: product.category,
      systemStock: product.stock, counted, difference: counted - product.stock,
      unitValue: lastCost(data, product.id) ?? product.price
    });
  }

  const adjust = Boolean(req.body.adjustStock);
  const number = nextCode(data, "countCorrelativo", "IF");

  if (adjust) {
    for (const line of lines.filter(l => l.difference !== 0)) {
      const product = data.products.find(p => p.id === line.productId);
      product.stock = line.counted;
      addMovement(data, {
        type: "ajuste", productId: product.id, productName: product.name, quantity: line.difference,
        stockBefore: line.systemStock, stockAfter: line.counted, reference: number, note: "Ajuste por inventario físico"
      });
      if (line.difference < 0 && product.stock <= stockMinimo(product)) enviarAlertaStockBajo(product, data);
    }
  }

  const count = {
    id: id("ct"), number, date: new Date().toISOString(),
    responsible, note: text(req.body.note), adjusted: adjust, lines
  };
  if (!Array.isArray(data.physicalCounts)) data.physicalCounts = [];
  data.physicalCounts.unshift(count);
  writeData(data);
  res.status(201).json({ ...count, summary: summarizeCount(count) });
});

// HU-10: consultar diferencias de inventario
app.get("/api/inventory/counts", (_req, res) => {
  const counts = readData().physicalCounts || [];
  res.json(counts.map(({ lines, ...rest }) => ({ ...rest, summary: summarizeCount({ lines }) })));
});

app.get("/api/inventory/counts/:id", (req, res) => {
  const count = (readData().physicalCounts || []).find(c => c.id === req.params.id);
  if (!count) return res.status(404).json({ error: "Inventario físico no encontrado." });
  res.json({ ...count, summary: summarizeCount(count) });
});

// === BLOQUE DE VENTAS CON VERIFICACIÓN DE STOCK BAJO ===
app.post("/api/sales", (req, res) => {
  // El comprobante no se emite sin datos válidos del cliente:
  // se valida ANTES de tocar el inventario
  const documentType = text(req.body.documentType) || "boleta";
  const checked = validateCustomer(documentType, req.body.customer);
  if (checked.error) {
    return res.status(400).json({ error: checked.error });
  }
  const customer = checked.customer;

  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) {
    return res.status(400).json({
      error: "Añade al menos un producto o accesorio a la venta."
    });
  }

  const data = readData();
  const lines = [];
  const productQuantities = new Map();

  for (const item of items) {
    const qty = Number(item.quantity);
    if (!Number.isInteger(qty) || qty < 1) {
      return res.status(400).json({
        error: "Hay cantidades no válidas."
      });
    }

    if (item.type !== "accessory") {
      const product = data.products.find(
        p => p.id === item.productId && p.active
      );
      if (!product) {
        return res.status(400).json({
          error: "Hay productos no válidos."
        });
      }

      const accumulated = (productQuantities.get(product.id) || 0) + qty;
      productQuantities.set(product.id, accumulated);

      if (product.stock < accumulated) {
        return res.status(400).json({
          error: `Stock insuficiente para ${product.name}. Disponible: ${product.stock}.`
        });
      }

      lines.push({
        type: "product",
        productId: product.id,
        name: product.name,
        quantity: qty,
        unitPrice: product.price,
        subtotal: Math.round(product.price * qty * 100) / 100
      });
      continue;
    }

    const name = text(item.name);
    const price = positiveNumber(item.price);
    if (!name || price === null) {
      return res.status(400).json({
        error: "Hay accesorios o precios no válidos."
      });
    }

    lines.push({
      type: "accessory",
      accessoryId: text(item.accessoryId),
      name,
      quantity: qty,
      unitPrice: price,
      subtotal: Math.round(price * qty * 100) / 100
    });
  }

  // Descontar existencias y verificar si el stock queda bajo (<= mínimo del producto)
  const salidas = [];
  for (const [productId, quantity] of productQuantities) {
    const product = data.products.find(p => p.id === productId);
    salidas.push({ product, quantity, stockBefore: product.stock });
    product.stock -= quantity;

    // Si tras la venta el stock llega al mínimo del producto (5; rosas: 10), envía la alerta de WhatsApp
    if (product.stock <= stockMinimo(product)) {
      enviarAlertaStockBajo(product, data);
    }
  }

  // Detalle tributario por línea (como en un comprobante real):
  // valor unitario = precio sin IGV; importe = precio con IGV × cantidad
  const detail = lines.map(line => {
    const valorVenta = round2(line.subtotal / (1 + IGV_RATE));
    return {
      ...line,
      unit: "UND",
      valorUnitario: round2(line.unitPrice / (1 + IGV_RATE)),
      valorVenta,
      igv: round2(line.subtotal - valorVenta)
    };
  });

  const total = round2(detail.reduce((sum, line) => sum + line.subtotal, 0));

  // Totales: Op. gravada + IGV = Importe total (se ajusta el redondeo para que siempre cuadre)
  const opGravada = round2(total / (1 + IGV_RATE));
  const igv = round2(total - opGravada);
  const doc = nextDocumentNumber(data, documentType);

  // Cada venta deja su salida en la bitácora de movimientos
  for (const { product, quantity, stockBefore } of salidas) {
    addMovement(data, {
      type: "salida", productId: product.id, productName: product.name, quantity,
      stockBefore, stockAfter: product.stock, reference: doc.numero, note: "Venta"
    });
  }

  const sale = {
    id: id("v"),
    documentType,
    documentLabel: DOCUMENT_TYPES[documentType].label,
    serie: doc.serie,
    correlativo: doc.correlativo,
    // Se mantiene ticketNumber para que dashboard, reportes e historial sigan funcionando
    ticketNumber: doc.numero,
    emisor: EMISOR,
    customer,
    currency: "PEN",
    paymentCondition: "CONTADO",
    items: detail,
    opGravada,
    opExonerada: 0,
    opInafecta: 0,
    igvRate: IGV_RATE,
    igv,
    total,
    date: new Date().toISOString()
  };

  data.sales.unshift(sale);
  data.lastTicket = sale;
  writeData(data);

  res.status(201).json(sale);
});

app.get("/api/sales", (_req, res) => res.json(readData().sales || []));
app.get("/api/ticket/latest", (_req, res) => res.json(readData().lastTicket));

app.get("/", (req, res) => res.redirect(getSesion(req) ? "/paginas/index.html" : "/paginas/login.html"));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.redirect("/");
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Error interno del servidor. Revisa la terminal para más información." });
});

app.listen(PORT, () => {
  ensureDataFile();
  try { migrarCodigos(); } catch (error) { console.error("No se pudieron preparar los códigos de producto:", error.message); }
  console.log(`\n🌷 Studio Floral está disponible en http://localhost:${PORT}\n`);
});
