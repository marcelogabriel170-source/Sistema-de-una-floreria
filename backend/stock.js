// ==========================================
// MOTOR DE STOCK: RECETAS DE ARREGLOS Y TALLOS SUELTOS (REMANENTES)
// ==========================================
// - El stock de cada producto se cuenta en paquetes cerrados (product.stock).
// - Si el producto define stemsPerPackage (12, 24…), los tallos que sobran de un paquete abierto
//   se guardan en product.looseStems.
// - Un arreglo con receta (product.recipe) no usa stock propio: al venderlo se descuentan sus insumos,
//   en paquetes o en tallos. Si faltan tallos sueltos, se abren paquetes automáticamente.

const tieneReceta = p => Array.isArray(p && p.recipe) && p.recipe.length > 0;

module.exports = function crearMotorStock({ addMovement, round2 }) {
  // Convierte los productos pedidos en lo que hay que descontar de cada insumo
  // items: [{ productId, quantity }]  → { error } | { needs: Map(productId → { packages, stems, usos:Set }) }
  function calcularNecesidades(data, items) {
    const needs = new Map();
    const sumar = (productId, packages, stems, uso) => {
      const n = needs.get(productId) || { packages: 0, stems: 0, usos: new Set() };
      n.packages += packages; n.stems += stems; if (uso) n.usos.add(uso);
      needs.set(productId, n);
    };
    for (const item of items) {
      const p = data.products.find(x => x.id === item.productId);
      if (!p) return { error: "Hay productos que ya no existen." };
      const q = item.quantity;
      if (!tieneReceta(p)) { sumar(p.id, q, 0, null); continue; }
      for (const ing of p.recipe) {
        const base = data.products.find(x => x.id === ing.productId);
        if (!base || !base.active) return { error: `La receta de ${p.name} usa un insumo que ya no está disponible. Revísala en Productos.` };
        if (ing.unit === "tallo") sumar(base.id, 0, ing.quantity * q, p.name);
        else sumar(base.id, ing.quantity * q, 0, p.name);
      }
    }
    return { needs };
  }

  // Revisa que alcance todo; devuelve { error } o un plan listo para aplicar
  function planificar(data, items) {
    const r = calcularNecesidades(data, items);
    if (r.error) return r;
    const plan = [];
    for (const [productId, n] of r.needs) {
      const p = data.products.find(x => x.id === productId);
      const loose = Number(p.looseStems) || 0, spp = Number(p.stemsPerPackage) || 0;
      if (n.stems > 0 && spp < 1) {
        return { error: `${p.name} se usa por tallos en una receta, pero no tiene «tallos por paquete». Configúralo en Productos.` };
      }
      const opened = n.stems > loose ? Math.ceil((n.stems - loose) / spp) : 0;
      if (n.packages + opened > p.stock) {
        const uso = n.usos.size ? ` (insumo de ${[...n.usos].join(", ")})` : "";
        const sueltos = loose ? ` y ${loose} tallo${loose === 1 ? "" : "s"} suelto${loose === 1 ? "" : "s"}` : "";
        return { error: `Stock insuficiente para ${p.name}${uso}. Disponible: ${p.stock} paquete${p.stock === 1 ? "" : "s"}${sueltos}.` };
      }
      plan.push({ product: p, packages: n.packages, stems: n.stems, opened, usos: [...n.usos] });
    }
    return { plan };
  }

  // Aplica el plan, deja cada cambio en Movimientos y devuelve lo consumido (para poder anularlo)
  function aplicar(data, plan, reference, motivo) {
    const consumo = [];
    for (const { product: p, packages, stems, opened, usos } of plan) {
      const detalle = usos.length ? `${motivo} · insumo de ${usos.join(", ")}` : motivo;
      if (packages > 0) {
        const before = p.stock; p.stock -= packages;
        addMovement(data, { type: "salida", productId: p.id, productName: p.name, quantity: packages, stockBefore: before, stockAfter: p.stock, reference, note: detalle });
      }
      if (opened > 0) {
        const before = p.stock; p.stock -= opened;
        addMovement(data, { type: "apertura", productId: p.id, productName: p.name, quantity: opened, stockBefore: before, stockAfter: p.stock, reference,
          note: `Se abrieron ${opened} paquete${opened === 1 ? "" : "s"}: +${opened * p.stemsPerPackage} tallos sueltos` });
      }
      if (stems > 0) {
        const before = (Number(p.looseStems) || 0) + opened * p.stemsPerPackage;
        p.looseStems = before - stems;
        addMovement(data, { type: "salida", unit: "tallo", productId: p.id, productName: p.name, quantity: stems, stockBefore: before, stockAfter: p.looseStems, reference, note: detalle });
      }
      consumo.push({ productId: p.id, productName: p.name, packages, stems, opened });
    }
    return consumo;
  }

  // Devuelve lo consumido (anulación). Los paquetes abiertos vuelven como tallos sueltos.
  function devolver(data, consumo, reference, motivo) {
    for (const c of consumo) {
      const p = data.products.find(x => x.id === c.productId);
      if (!p) continue;
      if (c.packages > 0) {
        const before = p.stock; p.stock += c.packages;
        addMovement(data, { type: "devolucion", productId: p.id, productName: p.name, quantity: c.packages, stockBefore: before, stockAfter: p.stock, reference, note: motivo });
      }
      if (c.stems > 0) {
        const before = Number(p.looseStems) || 0; p.looseStems = before + c.stems;
        addMovement(data, { type: "devolucion", unit: "tallo", productId: p.id, productName: p.name, quantity: c.stems, stockBefore: before, stockAfter: p.looseStems, reference, note: motivo });
      }
    }
  }

  // Cuántos arreglos se pueden armar con los insumos actuales
  function disponibleReceta(data, p) {
    if (!tieneReceta(p)) return p.stock;
    let min = Infinity;
    for (const ing of p.recipe) {
      const base = data.products.find(x => x.id === ing.productId);
      if (!base || !base.active || ing.quantity <= 0) return 0;
      const capacidad = ing.unit === "tallo"
        ? base.stock * (Number(base.stemsPerPackage) || 0) + (Number(base.looseStems) || 0)
        : base.stock;
      min = Math.min(min, Math.floor(capacidad / ing.quantity));
    }
    return min === Infinity ? 0 : min;
  }

  // Costo de un arreglo según su receta (paquete: costo del paquete; tallo: costo del paquete / tallos por paquete)
  function costoReceta(data, recipe, costoDe) {
    let total = 0;
    for (const ing of recipe || []) {
      const c = costoDe(ing.productId);
      if (c === null) return null;
      if (ing.unit === "tallo") {
        const spp = ing.stemsPerPackage || (data.products.find(x => x.id === ing.productId) || {}).stemsPerPackage;
        if (!spp) return null;
        total += c / spp * ing.quantity;
      } else total += c * ing.quantity;
    }
    return round2(total);
  }

  return { tieneReceta, planificar, aplicar, devolver, disponibleReceta, costoReceta };
};
module.exports.tieneReceta = tieneReceta;
