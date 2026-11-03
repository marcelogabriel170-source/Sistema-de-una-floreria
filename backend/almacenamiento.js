// ==========================================
// ALMACENAMIENTO: POSTGRESQL O ARCHIVO JSON
// ==========================================
// - Si existe la variable DATABASE_URL, los datos se guardan en PostgreSQL (persisten aunque el servidor
//   se reinicie, por ejemplo en Render).
// - Si no existe, se usa el archivo backend/data.json, como antes (cómodo para trabajar en la PC).
//
// El resto del sistema sigue usando readData() y writeData(). Con PostgreSQL:
// - Al arrancar se cargan todos los datos en memoria.
// - readData() devuelve una copia; writeData() actualiza la memoria y guarda en la base de datos solo lo que
//   cambió, dentro de una transacción. Las escrituras se hacen en orden, una tras otra.
//
// Tablas:
//   registros(coleccion, id, seq, datos JSONB)  → un registro por fila (productos, ventas, pedidos, usuarios…)
//   ajustes(clave, valor JSONB)                   → valores sueltos (correlativos, configuración, último ticket…)

const fs = require("fs");
const path = require("path");

// Colecciones que se guardan de la más antigua a la más nueva (las demás van de la más nueva a la más antigua)
const ORDEN_ASCENDENTE = new Set(["users"]);
const COLECCIONES_CONOCIDAS = ["products", "suppliers", "associations", "costHistory", "sales", "entries", "counts",
  "movements", "waste", "orders", "users"];

const esColeccion = v => Array.isArray(v) && v.every(x => x && typeof x === "object" && typeof x.id === "string");

module.exports = function crearAlmacenamiento({ archivo, url, initialData, log = console }) {
  // ---------------- Modo archivo JSON ----------------
  if (!url) {
    const asegurar = () => {
      fs.mkdirSync(path.dirname(archivo), { recursive: true });
      if (!fs.existsSync(archivo)) fs.writeFileSync(archivo, JSON.stringify(initialData(), null, 2), "utf8");
    };
    return {
      tipo: "JSON local",
      async init() { asegurar(); },
      read() {
        asegurar();
        try { return JSON.parse(fs.readFileSync(archivo, "utf8")); }
        catch (error) {
          log.error("No se pudo leer data.json:", error.message);
          throw new Error("El archivo de datos no es válido. Haz una copia y revisa backend/data.json.");
        }
      },
      write(data) {
        const temp = archivo + ".tmp";
        fs.writeFileSync(temp, JSON.stringify(data, null, 2), "utf8");
        fs.renameSync(temp, archivo);
      },
      async flush() {},
      async close() {},
      estado() { return { tipo: "JSON local", pendiente: false, error: null }; }
    };
  }

  // ---------------- Modo PostgreSQL ----------------
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: url, max: 3 });
  let cache = null;                 // datos en memoria
  let guardado = new Map();         // "coleccion\0id" → JSON guardado en la base (para saber qué cambió)
  let ajustesGuardados = new Map(); // clave → JSON guardado
  let seqPorClave = new Map();      // "coleccion\0id" → seq (orden de llegada)
  let siguienteSeq = 1;
  let cadena = Promise.resolve();   // escrituras en orden
  let pendiente = false, ultimoError = null;

  async function crearTablas(cliente) {
    await cliente.query(`CREATE TABLE IF NOT EXISTS registros (
      coleccion TEXT NOT NULL, id TEXT NOT NULL, seq BIGINT NOT NULL, datos JSONB NOT NULL,
      actualizado TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (coleccion, id))`);
    await cliente.query("CREATE INDEX IF NOT EXISTS registros_coleccion_seq ON registros (coleccion, seq)");
    await cliente.query(`CREATE TABLE IF NOT EXISTS ajustes (
      clave TEXT PRIMARY KEY, valor JSONB NOT NULL, actualizado TIMESTAMPTZ NOT NULL DEFAULT now())`);
  }

  // Lo que hay que escribir para pasar de lo guardado a "data"
  function calcularCambios(data) {
    const upserts = [], borrados = [], ajustes = [];
    const vistos = new Set();
    for (const [clave, valor] of Object.entries(data)) {
      if (esColeccion(valor)) {
        // Los registros nuevos reciben un número de orden: en las colecciones "más nueva primero"
        // el primero del arreglo es el más nuevo, así que se numeran de atrás hacia adelante
        const lista = ORDEN_ASCENDENTE.has(clave) ? valor : [...valor].reverse();
        for (const reg of lista) {
          const k = clave + "\0" + reg.id;
          if (vistos.has(k)) continue;          // id repetido: se guarda una sola vez
          vistos.add(k);
          const json = JSON.stringify(reg);
          if (!seqPorClave.has(k)) seqPorClave.set(k, siguienteSeq++);
          if (guardado.get(k) !== json) upserts.push({ k, coleccion: clave, id: reg.id, seq: seqPorClave.get(k), json });
        }
      } else if (valor !== undefined) {
        const json = JSON.stringify(valor);
        if (ajustesGuardados.get(clave) !== json) ajustes.push({ clave, json });
      }
    }
    for (const k of guardado.keys()) if (!vistos.has(k)) borrados.push(k);
    const clavesBorradas = [...ajustesGuardados.keys()].filter(c => !(c in data) || esColeccion(data[c]));
    return { upserts, borrados, ajustes, clavesBorradas };
  }

  async function guardar(data) {
    const c = calcularCambios(data);
    if (!c.upserts.length && !c.borrados.length && !c.ajustes.length && !c.clavesBorradas.length) return;
    const cliente = await pool.connect();
    try {
      await cliente.query("BEGIN");
      // Se escriben en grupos para no hacer una consulta por registro
      for (let i = 0; i < c.upserts.length; i += 500) {
        const grupo = c.upserts.slice(i, i + 500);
        await cliente.query(
          `INSERT INTO registros (coleccion, id, seq, datos)
           SELECT * FROM UNNEST($1::text[], $2::text[], $3::bigint[], $4::jsonb[])
           ON CONFLICT (coleccion, id) DO UPDATE SET datos = EXCLUDED.datos, actualizado = now()`,
          [grupo.map(u => u.coleccion), grupo.map(u => u.id), grupo.map(u => u.seq), grupo.map(u => u.json)]);
      }
      if (c.borrados.length) {
        const pares = c.borrados.map(k => k.split("\0"));
        await cliente.query(
          "DELETE FROM registros r USING UNNEST($1::text[], $2::text[]) AS b(coleccion, id) WHERE r.coleccion = b.coleccion AND r.id = b.id",
          [pares.map(p => p[0]), pares.map(p => p[1])]);
      }
      for (const a of c.ajustes) {
        await cliente.query(
          `INSERT INTO ajustes (clave, valor) VALUES ($1, $2::jsonb)
           ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado = now()`, [a.clave, a.json]);
      }
      if (c.clavesBorradas.length) await cliente.query("DELETE FROM ajustes WHERE clave = ANY($1::text[])", [c.clavesBorradas]);
      await cliente.query("COMMIT");
      // Solo después de confirmar se marca como guardado
      for (const u of c.upserts) guardado.set(u.k, u.json);
      for (const k of c.borrados) { guardado.delete(k); seqPorClave.delete(k); }
      for (const a of c.ajustes) ajustesGuardados.set(a.clave, a.json);
      for (const k of c.clavesBorradas) ajustesGuardados.delete(k);
    } catch (error) {
      await cliente.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      cliente.release();
    }
  }

  // Guarda el estado más reciente; si falla, se reintenta en la próxima escritura o a los 5 segundos
  function programarGuardado() {
    pendiente = true;
    cadena = cadena.then(async () => {
      if (!pendiente) return;
      pendiente = false;
      try {
        await guardar(cache);
        ultimoError = null;
      } catch (error) {
        pendiente = true;
        ultimoError = error.message;
        log.error("⚠️ No se pudo guardar en PostgreSQL (se reintentará):", error.message);
        setTimeout(() => { if (pendiente) programarGuardado(); }, 5000).unref();
      }
    });
    return cadena;
  }

  return {
    tipo: "PostgreSQL",
    async init() {
      const cliente = await pool.connect();
      try {
        await crearTablas(cliente);
        const regs = await cliente.query("SELECT coleccion, id, seq, datos FROM registros ORDER BY coleccion, seq");
        const ajs = await cliente.query("SELECT clave, valor FROM ajustes");
        if (!regs.rowCount && !ajs.rowCount) {
          // Base vacía: si hay un data.json de antes, se importa; si no, se empieza con los datos iniciales
          let inicial = null;
          if (archivo && fs.existsSync(archivo)) {
            try { inicial = JSON.parse(fs.readFileSync(archivo, "utf8")); log.log(`📥 Importando ${archivo} a PostgreSQL…`); }
            catch (error) { log.error("No se pudo importar data.json:", error.message); }
          }
          cache = inicial || initialData();
          await guardar(cache);
        } else {
          const data = {};
          for (const r of regs.rows) {
            (data[r.coleccion] = data[r.coleccion] || []).push(r.datos);
            const k = r.coleccion + "\0" + r.id;
            guardado.set(k, JSON.stringify(r.datos));
            seqPorClave.set(k, Number(r.seq));
            siguienteSeq = Math.max(siguienteSeq, Number(r.seq) + 1);
          }
          // En memoria, las colecciones van de la más nueva a la más antigua (salvo las ascendentes)
          for (const [clave, lista] of Object.entries(data)) if (!ORDEN_ASCENDENTE.has(clave)) lista.reverse();
          for (const r of ajs.rows) { data[r.clave] = r.valor; ajustesGuardados.set(r.clave, JSON.stringify(r.valor)); }
          // Una colección vacía no tiene filas: se recrea como arreglo vacío
          for (const clave of COLECCIONES_CONOCIDAS) if (!Array.isArray(data[clave])) data[clave] = [];
          for (const [clave, valor] of Object.entries(initialData())) if (Array.isArray(valor) && !Array.isArray(data[clave])) data[clave] = [];
          cache = data;
        }
      } finally {
        cliente.release();
      }
    },
    read() {
      if (!cache) throw new Error("La base de datos todavía no está lista.");
      return structuredClone(cache);
    },
    write(data) {
      cache = structuredClone(data);
      programarGuardado();
    },
    // Espera a que todo lo pendiente quede guardado (se usa al apagar el servidor y en las pruebas)
    async flush() {
      await cadena;
      if (pendiente) await programarGuardado();
      if (pendiente || ultimoError) throw new Error(ultimoError || "Quedaron datos sin guardar.");
    },
    async close() { await pool.end(); },
    estado() { return { tipo: "PostgreSQL", pendiente, error: ultimoError }; }
  };
};
