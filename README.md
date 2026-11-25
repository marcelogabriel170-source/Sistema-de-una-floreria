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

**Alerta de rosas.** Cuando el stock de las rosas llega a 10 o menos (el resto de productos sigue avisando con 5 o menos) se muestra una ventana de alerta en pantalla y se envía el mensaje de WhatsApp. La ventana aparece en **cada página** que se abre mientras el stock siga bajo.

**El aviso de stock bajo es solo para el administrador.** El vendedor no ve la ventana de alerta, ni el panel "Revisión de existencias" del Resumen, ni la tarjeta "Stock bajo" de Inventario (allí solo ve "Disponible" o "Agotado", sin "Reponer pronto"). Además el servidor le niega `/api/alerts/stock` (HTTP 403), así que no depende solo de lo que muestre la pantalla. El WhatsApp sigue llegando al número configurado en `enviarAlertaStockBajo`. Indica que hay que pedir más al proveedor de rosas: **Fabio Rojas, teléfono 913162052** (definido en `PROVEEDOR_ROSAS` de `backend/servidor.js`). Al arrancar, el servidor crea a Fabio Rojas en Proveedores con el código ROS-001 si no existe (RUC y correo quedan vacíos hasta que se completen al editarlo).

## Inicio de sesión y roles
Al abrir el sistema se pide usuario y contraseña (`/paginas/login.html`). La sesión dura 8 horas y se cierra con el botón "Cerrar sesión". Tras 5 intentos fallidos se bloquea el acceso 1 minuto.

| Rol | Usuario | Contraseña inicial | Páginas |
|---|---|---|---|
| Administrador | `admin` | `Admin2026` | Todas |
| Vendedor | `vendedor` | `Vendedor2026` | Resumen, Inventario, Proveedores y Nueva venta |

Para cambiar usuarios o contraseñas, agrega estas líneas al archivo `.env` y reinicia: `ADMIN_USER`, `ADMIN_PASSWORD`, `VENDEDOR_USER`, `VENDEDOR_PASSWORD`.

Los permisos se validan en el servidor, no solo en el menú (incluida la alerta de stock bajo, que es solo del administrador): el vendedor no puede abrir las demás páginas ni usar la API de catálogo, costos, asociaciones ni el volcado de datos. Al confirmar una venta abre su comprobante (`ticket.html`), pero sin el listado de Comprobantes en el menú.

## IGV en los comprobantes
Los precios del sistema ya incluyen IGV (18 %). El IGV **siempre se calcula y se guarda** en cada venta (`opGravada`, `igv` y el detalle por línea en `data.json`), pero **solo se muestra en la factura**:

| Comprobante | Qué se ve en pantalla, impresión y CSV |
|---|---|
| Boleta | Cantidad, descripción, precio unitario, importe y **importe total**. Sin Op. gravada, sin I.G.V. y sin la leyenda "Los precios incluyen IGV". |
| Factura | Detalle tributario completo: valor unitario, valor de venta, Op. gravada, exonerada, inafecta, I.G.V. (18 %) e importe total. |

En la pantalla de **Nueva venta**, el renglón "Op. gravada · IGV (18%)" tampoco aparece con Boleta; solo se muestra al elegir Factura. La "Lista general" en CSV (pestaña Comprobantes) conserva las columnas Op. gravada e IGV porque es un reporte interno de contabilidad.

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
