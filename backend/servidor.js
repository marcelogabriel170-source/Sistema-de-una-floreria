const express = require("express");
const fs = require("fs");
const path = require("path");
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
// Archivo de datos cuando no hay base de datos (se puede cambiar con DATA_FILE, por ejemplo en las pruebas)
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data.json");

// Render (y otros servicios) pasan la IP real del cliente en X-Forwarded-For: se usa para limitar intentos de login
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));

// Dónde se guardan los datos: PostgreSQL si hay DATABASE_URL; si no, el archivo JSON
const storage = require("./almacenamiento")({ archivo: DATA_FILE, url: process.env.DATABASE_URL, initialData });

// Inicio de sesión y perfiles (administrador y vendedor). Va antes de servir las páginas.
const auth = require("./auth")(app, { readData, writeData, id, text, estadoAlmacenamiento: () => storage.estado() });
app.use("/css", express.static(path.join(ROOT, "css")));
app.use("/js", express.static(path.join(ROOT, "js")));
app.use("/imagenes", express.static(path.join(ROOT, "imagenes")));
app.use("/paginas", express.static(path.join(ROOT, "paginas")));

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
if (process.env.WHATSAPP_DESACTIVADO !== "1" && process.env.NODE_ENV !== "test") {
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
// Stock mínimo de cada producto (lo define la dueña en Productos). Si no lo definió: 10 para rosas y 5 para el resto
function stockMinimo(product) {
  if (Number.isInteger(product.minStock) && product.minStock >= 0) return product.minStock;
  return esRosa(product) ? STOCK_MINIMO_ROSAS : STOCK_MINIMO;
}
function productoPorCodigo(data, code) {
  if (!code) return null;
  return (data.products || []).find(p => p.code === code) || null;
}

// Último proveedor que trajo el producto: primero la entrada de inventario más reciente;
// si todavía no hay entradas, el último proveedor registrado con el código de ese producto.
function ultimoProveedor(data, product) {
  const suppliers = data.suppliers || [];
  for (const entry of data.entries || []) {            // data.entries va de la más nueva a la más vieja
    if ((entry.items || []).some(i => i.productId === product.id)) {
      const s = suppliers.find(x => x.id === entry.supplierId);
      return {
        name: (s && s.name) || entry.supplierName || "",
        contact: (s && s.contact) || "",
        phone: (s && s.phone) || "",
        origin: `Última entrada ${entry.number}`
      };
    }
  }
  const linked = (data.associations || [])
    .filter(a => a.productId === product.id)
    .map(a => ({ a, s: suppliers.find(x => x.id === a.supplierId) }))
    .filter(x => x.s)
    .sort((x, y) => new Date(y.a.createdAt) - new Date(x.a.createdAt));
  const best = linked.find(x => x.s.active) || linked[0];
  return best ? { name: best.s.name, contact: best.s.contact, phone: best.s.phone, origin: "Proveedor registrado para este producto" } : null;
}

// Alertas que ve la pantalla: productos con stock en su mínimo o por debajo (los arreglos con receta no tienen stock propio)
function alertasDeStock(data) {
  return (data.products || [])
    .filter(p => p.active && !(Array.isArray(p.recipe) && p.recipe.length) && p.stock <= stockMinimo(p))
    .sort((a, b) => a.stock - b.stock)
    .map(p => ({
      productId: p.id, code: p.code || "", name: p.name, stock: p.stock, minStock: stockMinimo(p),
      supplier: ultimoProveedor(data, p)
    }));
}

// ==========================================
// FUNCIÓN DE ALERTA DE STOCK BAJO
// ==========================================
async function enviarAlertaStockBajo(product, data) {
  // Sin WhatsApp (desactivado o en pruebas) el aviso se ve solo en pantalla
  if (process.env.WHATSAPP_DESACTIVADO === "1" || process.env.NODE_ENV === "test") return;
  try {
    // Configura tu número con código de país y el sufijo '@c.us' (Ejemplo Perú: 51)
    const tuNumero = "51913162053@c.us";

    let textoMensaje = `⚠️ *¡ALERTA DE STOCK BAJO!* ⚠️\n\n` +
      `🌸 *Producto:* ${product.name}\n` +
      `📦 *Stock actual:* ${product.stock} unidades\n` +
      `🏷️ *Categoría:* ${product.category}\n\n`;

    // Se indica a quién hay que pedirle más
    {
      const proveedor = ultimoProveedor(data || readData(), product);
      textoMensaje += proveedor
        ? `📞 *Pedir más al último proveedor:*\n` +
          `• Nombre: ${proveedor.name}\n` +
          (proveedor.contact ? `• Contacto: ${proveedor.contact}\n` : "") +
          `• Teléfono: ${proveedor.phone}\n\n`
        : `📞 No hay proveedor registrado para este producto${product.code ? ` (código ${product.code})` : ""}.\n\n`;
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

// Lectura y escritura de datos (ver backend/almacenamiento.js)
function readData() { return storage.read(); }

// Al arrancar: asigna el código a los productos que ya existen, crea los que falten
// y completa el código de los proveedores antiguos a partir de lo que ya tenían asociado.
function migrarCodigos() {
  const data = readData();
  let changed = false;
  // Los códigos iniciales se cargan una sola vez; después la dueña los administra desde Productos
  if (data.codigosIniciales) return;
  data.codigosIniciales = true; changed = true;
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
    if (s.productCode && !Array.isArray(s.productCodes)) { s.productCodes = [s.productCode]; changed = true; }
    if (s.productCode) continue;
    const product = (data.associations || [])
      .filter(a => a.supplierId === s.id)
      .map(a => data.products.find(p => p.id === a.productId))
      .find(p => p && CODIGOS_PRODUCTO.some(c => c.code === p.code));
    if (product) { s.productCode = product.code; s.productCodes = [product.code]; changed = true; }
  }

  if (changed) writeData(data);
}

function writeData(data) { storage.write(data); }

function id(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function text(value) { return typeof value === "string" ? value.trim() : ""; }

// ==========================================
// COMPROBANTES DE PAGO — BOLETA Y FACTURA
// ==========================================
const IGV_RATE = 0.18; // Los precios del sistema ya incluyen IGV

// Los datos del negocio (emisor) se configuran en la página Configuración: ver backend/gestion.js

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
  if (q) items = items.filter(p => [p.name, p.code, p.category, p.description].some(v => String(v || "").toLowerCase().includes(q)));
  // Datos calculados: mínimo efectivo y, en arreglos con receta, cuántos se pueden armar con los insumos
  res.json(items.map(p => ({
    ...p,
    minStockEfectivo: stockMinimo(p),
    ...(motor.tieneReceta(p) ? { available: motor.disponibleReceta(data, p) } : {})
  })));
});

// Valida y arma los datos de un producto (código, stock mínimo, tallos por paquete y receta)
function datosProducto(body, data, actual) {
  const name = text(body.name), category = text(body.category);
  const price = positiveNumber(body.price), stock = nonNegativeNumber(body.stock);
  if (!name || !category || price === null || stock === null || !Number.isInteger(stock)) {
    return { error: "Completa nombre y categoría, indica un precio mayor que cero y un stock entero igual o mayor que cero." };
  }
  const code = text(body.code).toUpperCase();
  if (code && !/^[A-Z0-9][A-Z0-9-]{1,14}$/.test(code)) return { error: "El código debe tener de 2 a 15 letras, números o guiones, sin espacios (ej. ROS-001)." };
  if (code && data.products.some(p => p.code === code && (!actual || p.id !== actual.id))) return { error: `El código ${code} ya lo usa otro producto.` };

  let minStock = null;
  if (body.minStock !== undefined && body.minStock !== null && body.minStock !== "") {
    minStock = Number(body.minStock);
    if (!Number.isInteger(minStock) || minStock < 0) return { error: "El stock mínimo debe ser un número entero igual o mayor que cero." };
  }
  let stemsPerPackage = null;
  if (body.stemsPerPackage !== undefined && body.stemsPerPackage !== null && body.stemsPerPackage !== "") {
    stemsPerPackage = Number(body.stemsPerPackage);
    if (!Number.isInteger(stemsPerPackage) || stemsPerPackage < 1 || stemsPerPackage > 500) return { error: "Los tallos por paquete deben ser un número entero entre 1 y 500 (ej. 12 o 24)." };
  }
  if (actual && !stemsPerPackage && Number(actual.looseStems) > 0) {
    return { error: `${actual.name} todavía tiene ${actual.looseStems} tallos sueltos: no puedes quitar los tallos por paquete.` };
  }

  // Receta: [{ productId, quantity, unit: "paquete" | "tallo" }]
  const recipe = [];
  for (const raw of Array.isArray(body.recipe) ? body.recipe : []) {
    const ing = data.products.find(p => p.id === raw.productId);
    const quantity = Number(raw.quantity);
    const unit = raw.unit === "tallo" ? "tallo" : "paquete";
    if (!ing || !ing.active) return { error: "La receta tiene un insumo que no existe o está inactivo." };
    if (actual && ing.id === actual.id) return { error: "Un producto no puede ser insumo de sí mismo." };
    if (motor.tieneReceta(ing)) return { error: `${ing.name} ya es un arreglo con receta: no se puede usar como insumo.` };
    if (!Number.isInteger(quantity) || quantity < 1) return { error: `Indica una cantidad entera mayor que cero para ${ing.name}.` };
    if (unit === "tallo" && !ing.stemsPerPackage) return { error: `Para usar ${ing.name} por tallos, primero indica sus «tallos por paquete».` };
    if (recipe.some(r => r.productId === ing.id && r.unit === unit)) return { error: `${ing.name} está repetido en la receta.` };
    recipe.push({ productId: ing.id, name: ing.name, quantity, unit });
  }
  if (recipe.length && actual && data.products.some(p => motor.tieneReceta(p) && p.recipe.some(r => r.productId === actual.id))) {
    return { error: `${actual.name} es insumo de otro arreglo: no puede tener receta propia.` };
  }
  return { product: { name, category, description: text(body.description), price, stock, code: code || undefined, minStock, stemsPerPackage, recipe } };
}

app.post("/api/products", (req, res) => {
  const data = readData();
  const r = datosProducto(req.body || {}, data, null);
  if (r.error) return res.status(400).json({ error: r.error });
  const product = { id: id("p"), ...r.product, looseStems: 0, active: true, createdAt: new Date().toISOString() };
  data.products.unshift(product);
  writeData(data);
  if (!motor.tieneReceta(product) && product.stock <= stockMinimo(product)) enviarAlertaStockBajo(product, data);
  res.status(201).json(product);
});

app.put("/api/products/:id", (req, res) => {
  const data = readData(), p = data.products.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: "Producto no encontrado." });
  const r = datosProducto(req.body || {}, data, p);
  if (r.error) return res.status(400).json({ error: r.error });
  const codeBefore = p.code;
  Object.assign(p, r.product);
  if (!p.code) delete p.code;
  // Si cambió el código, se actualiza en los proveedores que lo tenían
  if (codeBefore && codeBefore !== p.code) {
    for (const s of data.suppliers || []) {
      if (Array.isArray(s.productCodes)) s.productCodes = s.productCodes.map(c => c === codeBefore ? p.code : c).filter(Boolean);
      if (s.productCode === codeBefore) s.productCode = (s.productCodes || [])[0] || "";
    }
  }
  writeData(data);
  if (!motor.tieneReceta(p) && p.stock <= stockMinimo(p)) enviarAlertaStockBajo(p, data);
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


// Lista de códigos de producto que se pueden asignar a un proveedor (los define la dueña en Productos)
app.get("/api/product-codes", (_req, res) => {
  const data = readData();
  res.json((data.products || []).filter(p => p.code && !motor.tieneReceta(p))
    .sort((a, b) => a.code.localeCompare(b.code))
    .map(p => ({ code: p.code, name: p.name, category: p.category, productId: p.id, active: p.active })));
});

// Alertas de stock para mostrar en pantalla (productos en su stock mínimo o por debajo)
app.get("/api/alerts/stock", (_req, res) => res.json(alertasDeStock(readData())));

// Los códigos identifican los productos que abastece el proveedor y crean el vínculo para las entradas de inventario.
// Acepta productCodes (lista) y, por compatibilidad, productCode (uno solo).
function validarCodigos(data, body) {
  const raw = Array.isArray(body.productCodes) ? body.productCodes : (body.productCode ? [body.productCode] : []);
  const codes = [...new Set(raw.map(c => text(c).toUpperCase()).filter(Boolean))];
  if (!codes.length) return { error: "Elige al menos un producto que abastece este proveedor." };
  for (const code of codes) {
    const p = productoPorCodigo(data, code);
    if (!p) return { error: `El código ${code} no existe. Créalo primero en Productos.` };
    if (!p.active) return { error: `El producto ${p.name} (${code}) está inactivo.` };
  }
  return { codes };
}

function vincularProveedor(data, supplier, codes) {
  if (!Array.isArray(data.associations)) data.associations = [];
  const ids = codes.map(c => productoPorCodigo(data, c).id);
  // Se quitan los vínculos automáticos de productos que ya no abastece
  data.associations = data.associations.filter(a => !(a.supplierId === supplier.id && a.source === "codigo" && !ids.includes(a.productId)));
  for (const productId of ids) {
    if (!data.associations.some(a => a.productId === productId && a.supplierId === supplier.id)) {
      data.associations.unshift({ id: id("a"), productId, supplierId: supplier.id, source: "codigo", createdAt: new Date().toISOString() });
    }
  }
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

  const data = readData();
  const vc = validarCodigos(data, req.body);
  if (vc.error) return res.status(400).json({ error: vc.error });

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
    productCodes: vc.codes,
    productCode: vc.codes[0],
    notes: text(req.body.notes),
    active: true,
    createdAt: new Date().toISOString()
  };

  vincularProveedor(data, supplier, vc.codes);
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

  const vc = validarCodigos(data, req.body);
  if (vc.error) return res.status(400).json({ error: vc.error });

  Object.assign(s, {
    ruc,
    name,
    address: text(req.body.address),
    status: text(req.body.status),
    condition: text(req.body.condition),
    contact,
    phone,
    email,
    productCodes: vc.codes,
    productCode: vc.codes[0],
    notes: text(req.body.notes)
  });

  vincularProveedor(data, s, vc.codes);

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
// Usuario que hizo la operación (nombre y usuario), para la trazabilidad
function quien() {
  const u = auth.currentRequestUser();
  return u ? { id: u.id, name: u.name, username: u.username } : null;
}

function addMovement(data, movement) {
  if (!Array.isArray(data.movements)) data.movements = [];
  data.movements.unshift({ id: id("m"), date: new Date().toISOString(), user: quien(), ...movement });
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
    id: id("e"), number, date, user: quien(),
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

// Abrir un paquete: pasa de paquetes cerrados a tallos sueltos (remanentes)
app.post("/api/inventory/open", (req, res) => {
  const data = readData();
  const p = data.products.find(x => x.id === req.body.productId && x.active);
  if (!p) return res.status(400).json({ error: "Elige un producto activo." });
  if (!p.stemsPerPackage) return res.status(400).json({ error: `${p.name} no tiene «tallos por paquete» configurado. Configúralo en Productos.` });
  const packages = Number(req.body.packages || 1);
  if (!Number.isInteger(packages) || packages < 1) return res.status(400).json({ error: "Indica cuántos paquetes abrir." });
  if (packages > p.stock) return res.status(400).json({ error: `Solo hay ${p.stock} paquete(s) cerrados de ${p.name}.` });
  const before = p.stock, looseBefore = Number(p.looseStems) || 0;
  p.stock -= packages;
  p.looseStems = looseBefore + packages * p.stemsPerPackage;
  addMovement(data, { type: "apertura", productId: p.id, productName: p.name, quantity: packages, stockBefore: before, stockAfter: p.stock, reference: "",
    note: `Paquete abierto: +${packages * p.stemsPerPackage} tallos sueltos (${looseBefore} → ${p.looseStems})` });
  writeData(data);
  if (p.stock <= stockMinimo(p)) enviarAlertaStockBajo(p, data);
  res.json(p);
});

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
    id: id("ct"), number, date: new Date().toISOString(), user: quien(),
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
app.get("/api/sales", (_req, res) => res.json(readData().sales || []));
app.get("/api/ticket/latest", (_req, res) => res.json(readData().lastTicket));

// Motor de stock (recetas de arreglos y tallos sueltos) y creación de ventas
const motor = require("./stock")({ addMovement, round2 });
const ventas = require("./ventas")({
  validateCustomer, nextDocumentNumber, DOCUMENT_TYPES, IGV_RATE, round2, positiveNumber, text, id, quien,
  stockMinimo, enviarAlertaStockBajo, emisorActual: data => gestion.emisorActual(data), motor
});

app.post("/api/sales", (req, res) => {
  const data = readData();
  const r = ventas.crearVenta(data, req.body || {});
  if (r.error) return res.status(400).json({ error: r.error });
  writeData(data);
  res.status(201).json(r.sale);
});

// Merma, anulación de ventas, datos del emisor, pedidos y reportes (Sprint 3)
const gestion = require("./gestion")(app, {
  readData, writeData, id, text, addMovement, quien, nextCode, stockMinimo, enviarAlertaStockBajo, validRuc, round2, motor, ventas
});

app.get("/", (_req, res) => res.sendFile(path.join(ROOT, "paginas", "index.html")));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(ROOT, "paginas", "index.html"));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Error interno del servidor. Revisa la terminal para más información." });
});

// Prepara los datos (conecta con la base de datos, crea los usuarios iniciales y los códigos)
async function iniciar() {
  await storage.init();
  try { auth.ensureUsers(); } catch (error) { console.error("No se pudieron crear los usuarios iniciales:", error.message); }
  try { migrarCodigos(); } catch (error) { console.error("No se pudieron preparar los códigos de producto:", error.message); }
}

module.exports = { app, iniciar, storage };

// Con «npm start» se arranca el servidor; en las pruebas solo se usa la app
if (require.main === module) {
  iniciar().then(() => {
    const server = app.listen(PORT, () => {
      console.log(`\n🌷 Studio Floral está disponible en http://localhost:${PORT} (datos: ${storage.tipo})\n`);
    });
    // Al apagar (Render envía SIGTERM) se termina de guardar lo pendiente
    const apagar = async () => {
      server.close();
      try { await storage.flush(); await storage.close(); } catch (error) { console.error("Error al cerrar:", error.message); }
      process.exit(0);
    };
    process.on("SIGTERM", apagar);
    process.on("SIGINT", apagar);
  }).catch(error => {
    console.error("❌ No se pudo iniciar el sistema:", error.message);
    if (process.env.DATABASE_URL) console.error("Revisa DATABASE_URL (servidor, usuario, contraseña y que la base exista).");
    process.exit(1);
  });
}
