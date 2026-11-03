// Utilidades para las pruebas: cada archivo de pruebas levanta su propia app con datos nuevos.
const fs = require("fs");
const os = require("os");
const path = require("path");
const request = require("supertest");

// Crea una app aislada. Por defecto usa un archivo JSON temporal; con { databaseUrl } usa PostgreSQL.
async function crearApp({ databaseUrl, dataInicial, dir: dirFijo } = {}) {
  process.env.NODE_ENV = "test";
  process.env.WHATSAPP_DESACTIVADO = "1";
  const dir = dirFijo || fs.mkdtempSync(path.join(os.tmpdir(), "floreria-"));
  process.env.DATA_FILE = path.join(dir, "data.json");
  if (dataInicial) fs.writeFileSync(process.env.DATA_FILE, JSON.stringify(dataInicial));
  if (databaseUrl) process.env.DATABASE_URL = databaseUrl; else delete process.env.DATABASE_URL;
  let mod;
  jest.isolateModules(() => { mod = require("../backend/servidor"); });
  await mod.iniciar();
  return { ...mod, dir };
}

// Inicia sesión y devuelve un "agente" que conserva la cookie de sesión
async function entrar(app, username, password) {
  const agente = request.agent(app);
  const res = await agente.post("/api/login").send({ username, password });
  if (res.status !== 200) throw new Error(`No se pudo entrar como ${username}: ${res.status} ${JSON.stringify(res.body)}`);
  return agente;
}

const boleta = (items, extra = {}) => ({
  documentType: "boleta", customer: { docType: "DNI", docNumber: "12345678", name: "Cliente de prueba" }, items, ...extra
});

async function producto(agente, id) {
  const res = await agente.get("/api/products");
  return res.body.find(p => p.id === id || p.code === id || p.name === id);
}

module.exports = { crearApp, entrar, boleta, producto, request };
