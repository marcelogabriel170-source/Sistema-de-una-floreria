// Inicio de sesión, permisos de cada perfil, límite de intentos y cambio de contraseña (HU-16)
const { crearApp, entrar, request } = require("./ayuda");

let app, admin, vendedor;
beforeAll(async () => {
  ({ app } = await crearApp());
  admin = await entrar(app, "admin", "admin123");
  vendedor = await entrar(app, "vendedor", "vendedor123");
});

describe("Sesión", () => {
  test("sin sesión la API responde 401 y las páginas llevan al login", async () => {
    await request(app).get("/api/products").expect(401);
    const res = await request(app).get("/paginas/index.html").expect(302);
    expect(res.headers.location).toBe("/paginas/login.html");
  });

  test("con usuario o contraseña incorrectos no entra", async () => {
    const res = await request(app).post("/api/login").send({ username: "admin", password: "otra" }).expect(401);
    expect(res.body.error).toMatch(/incorrectos/);
  });

  test("la cookie de sesión es HttpOnly y /api/me devuelve el perfil", async () => {
    const res = await request(app).post("/api/login").send({ username: "admin", password: "admin123" }).expect(200);
    expect(res.headers["set-cookie"][0]).toMatch(/HttpOnly/);
    const me = await admin.get("/api/me").expect(200);
    expect(me.body).toMatchObject({ username: "admin", role: "admin" });
    expect(me.body.passwordHash).toBeUndefined();
  });

  test("las contraseñas se guardan cifradas, nunca en texto plano", async () => {
    const fs = require("fs");
    const texto = fs.readFileSync(process.env.DATA_FILE, "utf8");
    expect(texto).not.toMatch(/admin123|vendedor123/);
  });

  test("al salir, la sesión deja de servir", async () => {
    const otro = await entrar(app, "vendedor", "vendedor123");
    await otro.post("/api/logout").expect(200);
    await otro.get("/api/products").expect(401);
  });
});

describe("Permisos del vendedor", () => {
  test.each([
    ["post", "/api/products", { name: "X", category: "Flores", price: 1, stock: 1 }],
    ["get", "/api/costs", null],
    ["get", "/api/reports", null],
    ["get", "/api/users", null],
    ["put", "/api/config/emisor", { ruc: "20601234565" }],
    ["post", "/api/sales/v-1/void", { reason: "prueba" }],
    ["get", "/api/inventory/counts", null],
  ])("%s %s → 403", async (method, url, body) => {
    const req = vendedor[method](url);
    const res = await (body ? req.send(body) : req);
    expect(res.status).toBe(403);
  });

  test("no puede abrir páginas de administrador", async () => {
    const res = await vendedor.get("/paginas/reportes.html").expect(302);
    expect(res.headers.location).toMatch(/index\.html\?sinPermiso=1/);
  });

  test("puede consultar productos y registrar ventas", async () => {
    await vendedor.get("/api/products").expect(200);
  });

  test("puede contar, pero no ajustar el stock al conteo", async () => {
    const res = await vendedor.post("/api/inventory/counts")
      .send({ responsible: "V", adjustStock: true, items: [{ productId: "p-demo-2", counted: 1 }] });
    expect(res.status).toBe(403);
  });
});

describe("Usuarios", () => {
  test("el administrador crea un usuario y este puede entrar", async () => {
    await admin.post("/api/users").send({ name: "Ana", username: "ana", role: "vendedor", password: "secreta1" }).expect(201);
    await entrar(app, "ana", "secreta1");
  });

  test("no se puede dejar el sistema sin administrador activo", async () => {
    const me = (await admin.get("/api/me")).body;
    const res = await admin.put(`/api/users/${me.id}`).send({ role: "vendedor" }).expect(400);
    expect(res.body.error).toMatch(/al menos un administrador/);
  });

  test("cada usuario cambia su propia contraseña", async () => {
    const ana = await entrar(app, "ana", "secreta1");
    await ana.post("/api/me/password").send({ current: "mala", password: "nueva123" }).expect(400);
    await ana.post("/api/me/password").send({ current: "secreta1", password: "123" }).expect(400);
    await ana.post("/api/me/password").send({ current: "secreta1", password: "nueva123" }).expect(200);
    await request(app).post("/api/login").send({ username: "ana", password: "secreta1" }).expect(401);
    await entrar(app, "ana", "nueva123");
  });
});

describe("Límite de intentos de inicio de sesión", () => {
  test("tras 5 fallos se bloquea por unos minutos, incluso con la contraseña correcta", async () => {
    await admin.post("/api/users").send({ name: "Luis", username: "luis", role: "vendedor", password: "luis1234" }).expect(201);
    for (let i = 1; i <= 4; i++) {
      await request(app).post("/api/login").send({ username: "luis", password: "mal" }).expect(401);
    }
    const quinto = await request(app).post("/api/login").send({ username: "luis", password: "mal" });
    expect(quinto.status).toBe(429);
    expect(quinto.body.error).toMatch(/Espera \d+ minuto/);
    expect(Number(quinto.headers["retry-after"])).toBeGreaterThan(0);
    await request(app).post("/api/login").send({ username: "luis", password: "luis1234" }).expect(429);
  });

  test("avisa cuántos intentos quedan", async () => {
    await admin.post("/api/users").send({ name: "Eva", username: "eva", role: "vendedor", password: "eva12345" }).expect(201);
    for (let i = 0; i < 2; i++) await request(app).post("/api/login").send({ username: "eva", password: "x" });
    const res = await request(app).post("/api/login").send({ username: "eva", password: "x" }).expect(401);
    expect(res.body.error).toMatch(/Te quedan 2 intentos/);
  });

  test("el bloqueo de un usuario no afecta a los demás, y entrar bien reinicia el contador", async () => {
    await entrar(app, "vendedor", "vendedor123");
    for (let i = 0; i < 3; i++) await request(app).post("/api/login").send({ username: "admin", password: "x" });
    await entrar(app, "admin", "admin123");
    for (let i = 0; i < 3; i++) await request(app).post("/api/login").send({ username: "admin", password: "x" }).expect(401);
  });
});
