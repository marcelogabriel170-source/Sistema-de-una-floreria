// Inventario: entradas (HU-07), salidas (HU-08), inventario físico y diferencias (HU-09, HU-10),
// bajo stock (HU-15), merma y tallos sueltos. Reproduce los casos CP-12 a CP-22 del informe.
const { crearApp, entrar, boleta, producto } = require("./ayuda");

let app, admin, vendedor;
const ROSAS = "p-demo-2";          // Rosas rojas: 8 paquetes, costo S/ 8.25
const PROVEEDOR = "s-demo-1";      // Flores del Valle
beforeAll(async () => {
  ({ app } = await crearApp());
  admin = await entrar(app, "admin", "admin123");
  vendedor = await entrar(app, "vendedor", "vendedor123");
});

describe("Entradas de mercadería (HU-07)", () => {
  test("CP-12: una entrada aumenta el stock, se numera E-00001 y pasa al historial de costos", async () => {
    const res = await vendedor.post("/api/inventory/entries")
      .send({ supplierId: PROVEEDOR, items: [{ productId: ROSAS, quantity: 20, unitCost: 9 }] }).expect(201);
    expect(res.body.number).toBe("E-00001");
    expect((await producto(admin, ROSAS)).stock).toBe(28);
    const costos = (await admin.get("/api/costs")).body;
    expect(costos[0]).toMatchObject({ productId: ROSAS, cost: 9 });
  });

  test("CP-13: rechaza cantidad cero", async () => {
    const res = await vendedor.post("/api/inventory/entries").send({ supplierId: PROVEEDOR, items: [{ productId: ROSAS, quantity: 0 }] }).expect(400);
    expect(res.body.error).toMatch(/mayor que cero/);
  });

  test("CP-14: rechaza productos no asociados al proveedor y entradas sin proveedor", async () => {
    const claveles = await producto(admin, "CLA-002");
    let res = await vendedor.post("/api/inventory/entries").send({ supplierId: PROVEEDOR, items: [{ productId: claveles.id, quantity: 5 }] }).expect(400);
    expect(res.body.error).toMatch(/no está asociado/);
    res = await vendedor.post("/api/inventory/entries").send({ items: [{ productId: ROSAS, quantity: 5 }] }).expect(400);
    expect(res.body.error).toMatch(/proveedor activo/);
  });
});

describe("Salidas por venta (HU-08)", () => {
  test("CP-15: una venta descuenta el stock y queda en Movimientos con el usuario", async () => {
    const res = await vendedor.post("/api/sales").send(boleta([{ type: "product", productId: ROSAS, quantity: 19 }])).expect(201);
    expect(res.body.ticketNumber).toBe("B001-00000001");
    expect((await producto(admin, ROSAS)).stock).toBe(9);
    const mov = (await admin.get("/api/inventory/movements")).body[0];
    expect(mov).toMatchObject({ type: "salida", quantity: 19, stockBefore: 28, stockAfter: 9, reference: "B001-00000001" });
    expect(mov.user.username).toBe("vendedor");
  });

  test("CP-16: no deja vender más de lo que hay", async () => {
    const res = await vendedor.post("/api/sales").send(boleta([{ type: "product", productId: ROSAS, quantity: 50 }])).expect(400);
    expect(res.body.error).toMatch(/Stock insuficiente para Rosas rojas\. Disponible: 9/);
  });
});

describe("Inventario físico y diferencias (HU-09, HU-10)", () => {
  let conteo;
  test("CP-17: guarda el conteo IF-00001 con la diferencia", async () => {
    const res = await vendedor.post("/api/inventory/counts")
      .send({ responsible: "Vendedor", note: "Conteo semanal", items: [{ productId: ROSAS, counted: 7 }] }).expect(201);
    conteo = res.body;
    expect(conteo.number).toBe("IF-00001");
    expect(conteo.lines[0]).toMatchObject({ systemStock: 9, counted: 7, difference: -2 });
  });

  test("CP-18 y CP-19: exige responsable y conteos enteros ≥ 0", async () => {
    await vendedor.post("/api/inventory/counts").send({ items: [{ productId: ROSAS, counted: 7 }] }).expect(400);
    await vendedor.post("/api/inventory/counts").send({ responsible: "X", items: [{ productId: ROSAS, counted: -1 }] }).expect(400);
  });

  test("CP-20: las diferencias se valorizan con el último costo", async () => {
    const res = await admin.get(`/api/inventory/counts/${conteo.id}`).expect(200);
    const linea = res.body.lines[0];
    expect(linea.difference * linea.unitValue).toBe(-18);
  });

  test("CP-21: el administrador puede ajustar el stock al conteo", async () => {
    await admin.post("/api/inventory/counts").send({ responsible: "Admin", adjustStock: true, items: [{ productId: ROSAS, counted: 7 }] }).expect(201);
    expect((await producto(admin, ROSAS)).stock).toBe(7);
  });
});

describe("Stock mínimo por producto (HU-15)", () => {
  test("CP-22: avisa con el proveedor a llamar cuando llega a su mínimo", async () => {
    const alertas = (await vendedor.get("/api/alerts/stock")).body;
    const rosas = alertas.find(a => a.productId === ROSAS);
    expect(rosas).toMatchObject({ stock: 7, minStock: 10 });
    expect(rosas.supplier.name).toBe("Flores del Valle");
  });

  test("cada producto puede tener su propio mínimo", async () => {
    const p = await producto(admin, ROSAS);
    await admin.put(`/api/products/${ROSAS}`).send({ ...p, minStock: 3 }).expect(200);
    const alertas = (await vendedor.get("/api/alerts/stock")).body;
    expect(alertas.find(a => a.productId === ROSAS)).toBeUndefined();
    expect((await producto(admin, ROSAS)).minStockEfectivo).toBe(3);
  });
});

describe("Tallos sueltos y merma", () => {
  test("abrir un paquete lo pasa a tallos sueltos", async () => {
    const p = await producto(admin, ROSAS);
    await admin.put(`/api/products/${ROSAS}`).send({ ...p, stemsPerPackage: 24 }).expect(200);
    const res = await vendedor.post("/api/inventory/open").send({ productId: ROSAS }).expect(200);
    expect(res.body).toMatchObject({ stock: 6, looseStems: 24 });
  });

  test("no deja abrir productos sin «tallos por paquete»", async () => {
    const res = await vendedor.post("/api/inventory/open").send({ productId: "p-demo-3" }).expect(400);
    expect(res.body.error).toMatch(/tallos por paquete/);
  });

  test("merma en paquetes: descuenta, se numera y se valoriza", async () => {
    const res = await vendedor.post("/api/inventory/waste").send({ productId: ROSAS, quantity: 1, reason: "marchita" }).expect(201);
    expect(res.body).toMatchObject({ number: "MR-00001", unit: "paquete", stockBefore: 6, stockAfter: 5, value: 9 });
  });

  test("merma en tallos sueltos", async () => {
    const res = await vendedor.post("/api/inventory/waste").send({ productId: ROSAS, quantity: 6, unit: "tallo", reason: "sobrante" }).expect(201);
    expect(res.body).toMatchObject({ unit: "tallo", stockBefore: 24, stockAfter: 18, value: 2.25 });
  });

  test("valida la merma: cantidad, stock disponible y motivo", async () => {
    await vendedor.post("/api/inventory/waste").send({ productId: ROSAS, quantity: 0, reason: "marchita" }).expect(400);
    await vendedor.post("/api/inventory/waste").send({ productId: ROSAS, quantity: 99, reason: "marchita" }).expect(400);
    await vendedor.post("/api/inventory/waste").send({ productId: ROSAS, quantity: 99, unit: "tallo", reason: "marchita" }).expect(400);
    const res = await vendedor.post("/api/inventory/waste").send({ productId: ROSAS, quantity: 1, reason: "otro" }).expect(400);
    expect(res.body.error).toMatch(/Describe el motivo/);
  });
});
