// Base de datos PostgreSQL: los datos sobreviven a un reinicio del servidor.
// Se ejecuta solo si existe TEST_DATABASE_URL (una base de datos de pruebas que se puede vaciar), por ejemplo:
//   TEST_DATABASE_URL=postgres://usuario:clave@localhost:5432/floreria_test npm test
const { Pool } = require("pg");
const { crearApp, entrar, boleta, producto, request } = require("./ayuda");

const URL = process.env.TEST_DATABASE_URL;
const describirSiHayBase = URL ? describe : describe.skip;

async function vaciarBase() {
  const pool = new Pool({ connectionString: URL });
  await pool.query("DROP TABLE IF EXISTS registros; DROP TABLE IF EXISTS ajustes;");
  await pool.end();
}
// "Reinicia" el servidor: guarda lo pendiente, cierra la conexión y levanta una app nueva con la misma base
async function reiniciar(actual) {
  await actual.storage.flush();
  await actual.storage.close();
  return crearApp({ databaseUrl: URL });
}

describirSiHayBase("PostgreSQL", () => {
  beforeAll(vaciarBase);

  test("guarda en tablas y todo sigue ahí después de reiniciar", async () => {
    let srv = await crearApp({ databaseUrl: URL });
    expect(srv.storage.tipo).toBe("PostgreSQL");
    let admin = await entrar(srv.app, "admin", "admin123");
    const vendedorId = (await (await entrar(srv.app, "vendedor", "vendedor123")).get("/api/me")).body.id;

    await admin.post("/api/products").send({ name: "Girasol gigante", category: "Flores", price: 20, stock: 5, code: "GIG-001" }).expect(201);
    await admin.post("/api/users").send({ name: "Ana", username: "ana", role: "vendedor", password: "secreta1" }).expect(201);
    await admin.put("/api/config/emisor").send({ ruc: "20601234565", razonSocial: "Flowers Studio Peru", direccion: "Rímac" }).expect(200);
    const venta = (await admin.post("/api/sales").send(boleta([{ type: "product", productId: "p-demo-2", quantity: 2 }])).expect(201)).body;
    await admin.post("/api/orders").send({ customerName: "Rosa", channel: "tiktok", description: "Ramo", deliveryDate: "2026-11-05", responsibleId: vendedorId }).expect(201);

    // Se puede consultar con SQL: cada producto es una fila
    const pool = new Pool({ connectionString: URL });
    await srv.storage.flush();
    const fila = await pool.query("SELECT datos->>'name' AS nombre FROM registros WHERE coleccion = 'products' AND datos->>'code' = 'GIG-001'");
    expect(fila.rows[0].nombre).toBe("Girasol gigante");
    await pool.end();

    srv = await reiniciar(srv);
    admin = await entrar(srv.app, "admin", "admin123");
    await entrar(srv.app, "ana", "secreta1");                                   // usuarios
    expect((await producto(admin, "GIG-001")).name).toBe("Girasol gigante");     // productos
    expect((await producto(admin, "p-demo-2")).stock).toBe(6);                  // stock
    const ventas = (await admin.get("/api/sales")).body;
    expect(ventas[0].id).toBe(venta.id);                                        // ventas
    expect((await admin.get("/api/orders")).body[0].number).toBe("P-00001");     // pedidos
    expect((await admin.get("/api/config/emisor")).body.ruc).toBe("20601234565"); // configuración
    const productos = (await admin.get("/api/products")).body;
    expect(productos[0].name).toBe("Girasol gigante");                          // se conserva el orden (más nuevo primero)

    // Los correlativos continúan: la siguiente boleta es la 2
    const otra = (await admin.post("/api/sales").send(boleta([{ type: "product", productId: "p-demo-2", quantity: 1 }])).expect(201)).body;
    expect(otra.ticketNumber).toBe("B001-00000002");

    // Lo que se borra también se borra en la base
    const s = (await admin.post("/api/suppliers").send({ ruc: "20111111111", name: "M", contact: "J", phone: "9", email: "m@x.pe", productCodes: ["ROS-001", "GIR-003"] }).expect(201)).body;
    await admin.put(`/api/suppliers/${s.id}`).send({ ruc: "20111111111", name: "M", contact: "J", phone: "9", email: "m@x.pe", productCodes: ["ROS-001"] }).expect(200);
    srv = await reiniciar(srv);
    admin = await entrar(srv.app, "admin", "admin123");
    expect((await admin.get(`/api/suppliers/${s.id}/products`)).body.map(p => p.name)).toEqual(["Rosas rojas"]);

    const salud = await request(srv.app).get("/api/health").expect(200);
    expect(salud.body).toMatchObject({ ok: true, storage: "PostgreSQL" });
    await srv.storage.flush(); await srv.storage.close();
  });

  test("si la base está vacía, importa el data.json que ya existía", async () => {
    await vaciarBase();
    const anterior = { products: [{ id: "p-viejo", name: "Lirio blanco", category: "Flores", price: 10, stock: 3, active: true, createdAt: "2026-10-01T00:00:00.000Z" }],
      suppliers: [], associations: [], costHistory: [], sales: [], lastTicket: null, boletaCorrelativo: 41 };
    let srv = await crearApp({ databaseUrl: URL, dataInicial: anterior });
    const admin = await entrar(srv.app, "admin", "admin123");
    expect((await producto(admin, "p-viejo")).name).toBe("Lirio blanco");
    const venta = (await admin.post("/api/sales").send(boleta([{ type: "product", productId: "p-viejo", quantity: 1 }])).expect(201)).body;
    expect(venta.ticketNumber).toBe("B001-00000042");
    await srv.storage.flush(); await srv.storage.close();
  });
});
