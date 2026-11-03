// Ventas, recetas de arreglos, anulación (HU-17), datos del emisor y reportes
const { crearApp, entrar, boleta, producto } = require("./ayuda");

let app, admin, vendedor, follaje, papel;
const ROSAS = "p-demo-2", RAMO = "p-demo-1";
beforeAll(async () => {
  ({ app } = await crearApp());
  admin = await entrar(app, "admin", "admin123");
  vendedor = await entrar(app, "vendedor", "vendedor123");
  // Rosas: 8 paquetes de 24 tallos. Follaje: 4 paquetes de 10 tallos. Papel: 10 paquetes.
  const rosas = await producto(admin, ROSAS);
  await admin.put(`/api/products/${ROSAS}`).send({ ...rosas, stemsPerPackage: 24 }).expect(200);
  follaje = (await admin.post("/api/products").send({ name: "Follaje", category: "Flores", price: 5, stock: 4, code: "FOL-010", stemsPerPackage: 10 }).expect(201)).body;
  papel = (await admin.post("/api/products").send({ name: "Papel coreano", category: "Accesorios", price: 2, stock: 10, code: "PAP-011" }).expect(201)).body;
});

describe("Comprobantes", () => {
  test("la boleta calcula el IGV incluido en el precio", async () => {
    const res = await vendedor.post("/api/sales").send(boleta([{ type: "product", productId: ROSAS, quantity: 1 }])).expect(201);
    expect(res.body).toMatchObject({ total: 18, opGravada: 15.25, igv: 2.75, documentType: "boleta" });
    expect(res.body.seller.username).toBe("vendedor");
  });

  test("la factura exige un RUC válido", async () => {
    const res = await vendedor.post("/api/sales").send({ documentType: "factura", customer: { docNumber: "123", name: "X", address: "Y" }, items: [{ type: "product", productId: ROSAS, quantity: 1 }] }).expect(400);
    expect(res.body.error).toMatch(/RUC válido/);
  });

  test("los datos del emisor se configuran y se usan en las ventas nuevas", async () => {
    await admin.put("/api/config/emisor").send({ ruc: "20601234560", razonSocial: "x", direccion: "y" }).expect(400);
    await admin.put("/api/config/emisor").send({ ruc: "20601234565", razonSocial: "Flowers Studio Peru", direccion: "Piedra Liza, Rímac", telefono: "987" }).expect(200);
    const res = await vendedor.post("/api/sales").send(boleta([{ type: "product", productId: ROSAS, quantity: 1 }])).expect(201);
    expect(res.body.emisor).toMatchObject({ ruc: "20601234565", razonSocial: "FLOWERS STUDIO PERU" });
  });
});

describe("Recetas de arreglos", () => {
  test("valida la receta: sin auto-referencia ni insumos que sean arreglos", async () => {
    let res = await admin.put(`/api/products/${RAMO}`).send({ name: "Ramo Aurora", category: "Ramos", price: 45, stock: 0, recipe: [{ productId: RAMO, quantity: 1 }] }).expect(400);
    expect(res.body.error).toMatch(/sí mismo/);
    res = await admin.put(`/api/products/${RAMO}`).send({ name: "Ramo Aurora", category: "Ramos", price: 45, stock: 0, recipe: [{ productId: papel.id, quantity: 1, unit: "tallo" }] }).expect(400);
    expect(res.body.error).toMatch(/tallos por paquete/);
  });

  test("Ramo Aurora = 6 tallos de rosa + 2 de follaje + 1 papel; muestra cuántos alcanzan", async () => {
    await admin.put(`/api/products/${RAMO}`).send({ name: "Ramo Aurora", category: "Ramos", price: 45, stock: 0, recipe: [
      { productId: ROSAS, quantity: 6, unit: "tallo" }, { productId: follaje.id, quantity: 2, unit: "tallo" }, { productId: papel.id, quantity: 1 }] }).expect(200);
    // Rosas: 6 paquetes × 24 = 144 tallos → 24 ramos; follaje 40 tallos → 20; papel 10 → 10
    expect((await producto(admin, RAMO)).available).toBe(10);
  });

  test("al vender, descuenta los insumos y abre paquetes cuando faltan tallos sueltos", async () => {
    const antes = await producto(admin, ROSAS);
    const res = await vendedor.post("/api/sales").send(boleta([{ type: "product", productId: RAMO, quantity: 3 }])).expect(201);
    expect(res.body.total).toBe(135);
    const rosas = await producto(admin, ROSAS);
    expect(rosas).toMatchObject({ stock: antes.stock - 1, looseStems: 6 });       // se abrió 1 paquete: 24 − 18 = 6
    expect(await producto(admin, follaje.id)).toMatchObject({ stock: 3, looseStems: 4 });
    expect((await producto(admin, papel.id)).stock).toBe(7);
  });

  test("si no alcanzan los insumos, explica cuál falta", async () => {
    const res = await vendedor.post("/api/sales").send(boleta([{ type: "product", productId: RAMO, quantity: 50 }])).expect(400);
    expect(res.body.error).toMatch(/insumo de Ramo Aurora/);
  });
});

describe("Anulación de ventas (HU-17)", () => {
  test("solo con motivo; devuelve los insumos (los tallos vuelven como sueltos) y no se anula dos veces", async () => {
    const venta = (await vendedor.post("/api/sales").send(boleta([{ type: "product", productId: RAMO, quantity: 1 }])).expect(201)).body;
    const rosasAntes = await producto(admin, ROSAS);
    await admin.post(`/api/sales/${venta.id}/void`).send({ reason: "" }).expect(400);
    const res = await admin.post(`/api/sales/${venta.id}/void`).send({ reason: "Cliente se arrepintió" }).expect(200);
    expect(res.body.status).toBe("anulada");
    expect((await producto(admin, ROSAS)).looseStems).toBe(rosasAntes.looseStems + 6);
    await admin.post(`/api/sales/${venta.id}/void`).send({ reason: "otra vez" }).expect(400);
  });
});

describe("Reportes", () => {
  test("no suman las anuladas y calculan la ganancia con el costo de compra", async () => {
    const r = (await admin.get("/api/reports")).body;
    expect(r.resumen.anuladas).toBe(1);
    const rosas = r.productos.find(p => p.name === "Rosas rojas");
    expect(rosas).toMatchObject({ quantity: 2, revenue: 36, cost: 16.5, profit: 19.5 });
    expect(r.ventasDetalle.some(v => v.status === "Anulada")).toBe(true);
  });

  test("valida el rango de fechas", async () => {
    await admin.get("/api/reports?from=2026-12-01&to=2026-11-01").expect(400);
  });
});
