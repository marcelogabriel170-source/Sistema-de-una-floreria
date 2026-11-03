# Studio Floral — Sistema de gestión

Aplicación web para gestionar productos, proveedores con código de producto, costos de compra e inventario (entradas, inventario físico y diferencias). Incluye también ventas con boleta y factura, tickets, dashboard y reportes.

## Requisitos
- Node.js 18 o superior
- Navegador moderno
- No requiere base de datos: guarda la información en `backend/data.json`.

## Instalación y ejecución
1. Descomprime el proyecto.
2. Abre una terminal dentro de `Sistema_Floreria`.
3. Ejecuta:
   ```bash
   npm install
   npm start
   ```
4. Abre `http://localhost:3000`.

En desarrollo, puedes ejecutar `npm run dev` si tu versión de Node.js admite `--watch`.

## Alcance y relación con el informe técnico
Sprint 1:
- HU-01: registrar productos.
- HU-02: modificar productos.
- HU-03: consultar productos activos.
- HU-04: registrar proveedores.
- HU-05: asociar productos con proveedores. Ahora se hace al registrar el proveedor: se pide el código del producto que abastece (ver "Códigos de producto").
- HU-06: registrar costo de compra y mantener su historial.

Sprint 2 (módulo Inventario, pestañas en `paginas/inventario.html`):
- HU-07: registrar entrada de productos (pestaña Entradas).
- HU-08: registrar salida de productos. Cada venta descuenta stock y queda anotada en Movimientos.
- HU-09: realizar inventario físico (pestaña Inventario físico).
- HU-10: consultar diferencias de inventario (pestaña Diferencias).

Las demás páginas (ticket, dashboard, reportes) siguen como estaban. No marques una historia como aceptada hasta que el equipo y el Product Owner hayan comprobado sus criterios.

## Cómo funciona el módulo de inventario
**Entradas (HU-07).** Se elige el proveedor y el sistema muestra solo el producto cuyo código se asignó a ese proveedor en la pantalla de Proveedores; los productos no se escriben a mano. Se anota la cantidad recibida de cada uno (y, si se quiere, el costo unitario, que pasa al historial de costos). Al registrar, el stock sube y se genera un número `E-00001`, `E-00002`, etc. Si un proveedor no aparece con producto, hay que editarlo en Proveedores y asignarle un código.

**Inventario físico (HU-09).** Se escribe lo que realmente hay de cada producto; lo que se deja en blanco no se cuenta. Al guardar se crea un registro `IF-00001` con el stock que tenía el sistema en ese momento. La casilla "Ajustar el stock del sistema" es opcional: si se marca, el stock queda igual al conteo y el cambio se anota como ajuste.

**Diferencias (HU-10).** Se elige un inventario físico y se ve, por producto, el stock del sistema, lo contado, la diferencia y su valor estimado (último costo registrado, o el precio de venta si no hay costo). Se puede filtrar por faltantes, sobrantes o solo con diferencia.

**Movimientos.** Lista de entradas, salidas por venta y ajustes, con el stock antes y después.

## Códigos de producto y alerta de rosas
Al registrar o editar un proveedor se pide un **código de producto**, que además lo vincula con ese producto para las entradas de inventario:

| Código | Producto |
|---|---|
| ROS-001 | Rosas rojas |
| CLA-002 | Claveles |
| GIR-003 | Girasoles |
| LIR-004 | Lirios |
| ORQ-005 | Orquídeas |

Al arrancar, el servidor asigna estos códigos a los productos existentes y crea los que falten (stock 0). Los proveedores antiguos reciben el código del producto que ya tenían asociado.

**Alerta de rosas.** Cuando el stock de las rosas llega a 10 o menos (el resto de productos sigue avisando con 5 o menos) se muestra una ventana de alerta en pantalla y se envía el mensaje de WhatsApp. Indica que hay que pedir más al último proveedor que las trajo, con su nombre, la persona de contacto y el teléfono. El "último proveedor" es el de la entrada de inventario más reciente que incluya rosas; si todavía no hay entradas, el último proveedor registrado con el código ROS-001.

## Inicio de sesión y perfiles (HU-16)
Al abrir el sistema se pide usuario y contraseña. Hay dos perfiles:

| Acción | Administrador | Vendedor |
|---|:-:|:-:|
| Resumen, dashboard y alertas de stock | Sí | Sí |
| Consultar productos y stock | Sí | Sí |
| Crear, editar o desactivar productos | Sí | No |
| Proveedores y costos de compra | Sí | No |
| Entradas de mercadería | Sí | Sí |
| Inventario físico (contar) | Sí | Sí |
| Ajustar el stock al conteo y ver diferencias | Sí | No |
| Nueva venta, comprobantes e historial | Sí | Sí |
| Reportes | Sí | No |
| Crear y administrar usuarios (página Usuarios) | Sí | No |

**Usuarios iniciales** (se crean solos la primera vez):
- `admin` / `admin123` (Administrador)
- `vendedor` / `vendedor123` (Vendedor)

Cámbialos al entrar, en la página **Usuarios**. Para que las contraseñas iniciales no sean las de ejemplo, define las variables de entorno `ADMIN_PASSWORD` y `VENDEDOR_PASSWORD` (en el archivo `.env` o en Render) antes del primer arranque.

**Seguridad.** Las contraseñas se guardan cifradas (scrypt). La sesión dura 12 horas y se guarda en una cookie HttpOnly. Los permisos se validan en el servidor: si un vendedor intenta una acción de administrador, la API responde 403. Cada venta, entrada, conteo y movimiento guarda qué usuario lo hizo.

**En Render (plan gratuito).** Los datos se reinician cuando el servidor se reinicia, y con ellos los usuarios: vuelven `admin` y `vendedor` con las contraseñas de `ADMIN_PASSWORD` y `VENDEDOR_PASSWORD`. Por eso conviene definir esas dos variables en Render (Environment).

## Sprint 3: merma, anulación, emisor, pedidos y reportes

**Merma (HU-08).** En Inventario › Merma se registra el producto, la cantidad en paquetes y el motivo (marchita, dañada, sobrante de paquete abierto u otro). Se descuenta del stock, recibe un número `MR-00001` y aparece en Movimientos. Se valoriza con el último costo de compra. La pueden registrar el administrador y el vendedor.

**Anular ventas (HU-17).** Solo el administrador, desde Comprobantes o Historial de ventas. Pide un motivo, devuelve al stock lo vendido (movimiento «Devolución») y el comprobante queda marcado como ANULADO. Las ventas anuladas no se suman en el dashboard ni en los reportes.

**Datos del emisor.** En Configuración (solo administrador) se guardan el RUC (se valida el dígito verificador), la razón social, el nombre comercial, la dirección y el teléfono. Se usan en cada boleta y factura nueva; las ya emitidas conservan los datos con los que salieron.

**Pedidos personalizados (objetivo 7).** En Pedidos se anota el cliente, el canal (WhatsApp, Instagram, TikTok o presencial), el detalle, la fecha y hora de entrega, el precio y el adelanto, y el responsable. Estados: pendiente → en preparación → entregado (o cancelado). Se marcan los pedidos para hoy y los atrasados.

**Reportes (objetivo 8, solo administrador).** Filtro por fechas; ventas, ganancia estimada (ventas − costo de compra vigente a la fecha de cada venta), productos más vendidos, merma del periodo, compras por proveedor y pedidos. El botón «Exportar a Excel» descarga un .xlsx con cinco hojas (Resumen, Productos, Merma, Compras y Ventas). La librería SheetJS está incluida en `js/vendor/` (licencia Apache-2.0), así que funciona sin internet.

## Stock como trabaja una florería (recetas, tallos sueltos y más)

**Recetas de arreglos.** En Productos, un arreglo (ramo, caja…) puede tener receta: qué insumos usa y cuántos, en paquetes o en tallos. Ejemplo: Ramo Aurora = 6 tallos de rosas + 2 tallos de follaje + 1 paquete de papel coreano. Al venderlo se descuentan los insumos (no el stock propio del arreglo) y la venta muestra cuántos se pueden armar con lo que hay. Un insumo no puede tener receta propia.

**Tallos sueltos (remanentes).** Si un producto tiene «tallos por paquete» (12, 24…), en Inventario › Existencias se puede abrir un paquete: pasa a tallos sueltos. Las recetas que usan tallos toman primero los sueltos y, si faltan, abren paquetes automáticamente. La merma se puede registrar en paquetes o en tallos sueltos. Si se anula una venta, los tallos vuelven como sueltos.

**Pedidos que se convierten en venta.** Un pedido puede indicar qué productos usa. Cuando se marca como entregado aparece «Generar boleta»: pide el DNI (boleta) o RUC (factura), cobra el precio acordado del pedido y descuenta del stock sus productos o los insumos de sus recetas. Si esa venta se anula, el pedido queda libre para generarla de nuevo.

**Stock mínimo por producto.** Cada producto tiene su propio mínimo (por defecto 5, y 10 para rosas). Al llegar a él se avisa en pantalla y por WhatsApp, con el proveedor al que hay que pedir.

**Códigos de producto y proveedores con varios productos.** Los códigos (ROS-001, etc.) se crean y editan en Productos. Un proveedor puede abastecer varios productos: se marcan en su ficha y todos aparecen al registrar sus entradas.

**Cambiar mi contraseña.** Botón «Contraseña» en la barra superior, para cualquier usuario (pide la contraseña actual).

**Avisos del día.** Al entrar se muestra una ventana con los productos en su stock mínimo y los pedidos para hoy o atrasados.

## Consulta automática de DNI y RUC
- El RUC usa openruc.com y no necesita configuración.
- El DNI usa apis.net.pe, que exige un token. Antes no se enviaba ninguno y por eso la consulta fallaba. Para activarla:
  1. Copia `.env.example` como `.env` (en la raíz del proyecto, junto a `package.json`).
  2. Escribe tu token en `DNI_API_TOKEN=`.
  3. Reinicia con `npm start`.
- Si la consulta no responde, la pantalla de venta avisa el motivo y se puede escribir el nombre a mano. También hay un botón Buscar para reintentar.
- El archivo `.env` no debe subirse a ningún repositorio (ya está en `.gitignore`).

## Persistencia temporal
Los datos se guardan en `backend/data.json`, sin SQL Server ni otra base de datos. Esto permite conservar datos al reiniciar el servidor, pero es una solución temporal para desarrollo académico; no ofrece las garantías de concurrencia, seguridad y recuperación de una base de datos real. Haz copias de seguridad de ese archivo.

## Estructura
- `backend/servidor.js`: API REST y servicio web.
- `backend/data.json`: almacenamiento local persistente, se crea automáticamente.
- `.env`: claves del sistema (token de DNI). Se crea a partir de `.env.example`.
- `css/estilos.css`: estilos responsive.
- `js/`: lógica del frontend por módulo.
- `paginas/`: pantallas del sistema.
- `imagenes/`: recursos visuales locales.

## Nota para la entrega
Antes de entregar, prueba el flujo de registro, edición, búsqueda, proveedores (con código de producto), costos, entradas, inventario físico y diferencias en el equipo del proyecto. No marques historias como aceptadas hasta que el equipo y el Product Owner hayan comprobado los criterios del informe.
