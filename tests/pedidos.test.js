// Pedidos personalizados, su conversión en venta y proveedores con varios productos
const { crearApp, entrar, producto } = require("./ayuda");

let app, admin, vendedor, vendedorId;
const ROSAS = "p-demo-2";
beforeAll(async () => {
  ({ app } = await crearApp());
  admin = await entrar(app, "admin", "admin123");
  vendedor = await entrar(app, "vendedor", "vendedor123");
  vendedorId = (await vendedor.get("/api/me")).body.id;
});

describe("Pedidos", () => {
  let pedido;
  test("valida canal, responsable y que el adelanto no supere el precio", async () => {
    const base = { customerName: "Rosa", channel: "whatsapp", description: "Ramo", deliveryDate: "2026-11-05", responsibleId: vendedorId };
    await vendedor.post("/api/orders").send({ ...base, channel: "fax" }).expect(400);
    await vendedor.post("/api/orders").send({ ...base, responsibleId: "" }).expect(400);
    await vendedor.post("/api/orders").send({ ...base, total: 50, advance: 60 }).expect(400);
  });

  test("se registra con número P-00001 y avanza de estado con historial", async () => {
    pedido = (await vendedor.post("/api/orders").send({
      customerName: "Rosa Díaz", channel: "instagram", description: "Caja de rosas", deliveryDate: "2026-11-05",
      total: 60, advance: 20, responsibleId: vendedorId, items: [{ productId: ROSAS, quantity: 2 }]
    }).expect(201)).body;
    expect(pedido).toMatchObject({ number: "P-00001", status: "pendiente", channelLabel: "Instagram" });
    const res = await vendedor.put(`/api/orders/${pedido.id}`).send({ status: "preparacion" }).expect(200);
    expect(res.body.history).toHaveLength(2);
  });

  test("solo un pedido entregado se convierte en venta: cobra el precio acordado y descuenta el stock", async () => {
    await vendedor.post(`/api/orders/${pedido.id}/sale`).send({ documentType: "boleta", customer: { docNumber: "12345678", name: "Rosa Díaz" } }).expect(400);
    await vendedor.put(`/api/orders/${pedido.id}`).send({ status: "entregado" }).expect(200);
    const res = await vendedor.post(`/api/orders/${pedido.id}/sale`).send({ documentType: "boleta", customer: { docNumber: "12345678", name: "Rosa Díaz" } }).expect(201);
    expect(res.body.sale.total).toBe(60);
    expect(res.body.order.saleNumber).toBe(res.body.sale.ticketNumber);
    expect((await producto(admin, ROSAS)).stock).toBe(6);
    await vendedor.post(`/api/orders/${pedido.id}/sale`).send({ documentType: "boleta", customer: { docNumber: "12345678", name: "Rosa Díaz" } }).expect(400);
  });

  test("si se anula esa venta, vuelve el stock y el pedido queda libre", async () => {
    const venta = (await vendedor.get("/api/orders")).body[0];
    await admin.post(`/api/sales/${venta.saleId}/void`).send({ reason: "Error de cobro" }).expect(200);
    expect((await producto(admin, ROSAS)).stock).toBe(8);
    expect((await vendedor.get("/api/orders")).body[0].saleId).toBeNull();
  });
});

describe("Productos y proveedores", () => {
  test("los códigos de producto son únicos y con formato válido", async () => {
    await admin.post("/api/products").send({ name: "X", category: "Flores", price: 1, stock: 1, code: "ROS-001" }).expect(400);
    await admin.post("/api/products").send({ name: "X", category: "Flores", price: 1, stock: 1, code: "mal código" }).expect(400);
  });

  test("un proveedor puede abastecer varios productos y todos aparecen en sus entradas", async () => {
    const s = (await admin.post("/api/suppliers").send({ ruc: "20111111111", name: "Mercado Mayorista", contact: "Juan", phone: "999", email: "j@x.pe",
      productCodes: ["ROS-001", "GIR-003", "LIR-004"] }).expect(201)).body;
    const productos = (await admin.get(`/api/suppliers/${s.id}/products`)).body.map(p => p.name).sort();
    expect(productos).toEqual(["Girasoles", "Lirios", "Rosas rojas"]);
    await admin.post("/api/suppliers").send({ ruc: "20222222222", name: "Z", contact: "J", phone: "9", email: "z@x.pe", productCodes: [] }).expect(400);
    await admin.post("/api/suppliers").send({ ruc: "20222222222", name: "Z", contact: "J", phone: "9", email: "z@x.pe", productCodes: ["NO-EXISTE"] }).expect(400);
  });

  test("si cambia el código de un producto, se actualiza en sus proveedores", async () => {
    const p = await producto(admin, ROSAS);
    await admin.put(`/api/products/${ROSAS}`).send({ ...p, code: "ROS-100" }).expect(200);
    const proveedores = (await admin.get("/api/suppliers")).body;
    expect(proveedores.find(s => s.name === "Mercado Mayorista").productCodes).toContain("ROS-100");
  });
});
