document.addEventListener("DOMContentLoaded", () => {
    let products = [];
    let cart = [];

    const typeSelect = document.getElementById("sale-type");
    const productSelect = document.getElementById("sale-product");
    const quantityInput = document.getElementById("sale-quantity");
    const addForm = document.getElementById("sale-add-form");
    const cartTable = document.getElementById("sale-cart");
    const totalElement = document.getElementById("sale-total");
    const taxElement = document.getElementById("sale-tax-breakdown");
    const completeButton = document.getElementById("complete-sale");

    // Boleta
    const boletaFields = document.getElementById("boleta-fields");
    const dniInput = document.getElementById("customer-dni");
    const dniHelp = document.getElementById("customer-dni-help");
    const nameInput = document.getElementById("customer-name");
    const dniButton = document.getElementById("buscar-dni");

    // Factura
    const facturaFields = document.getElementById("factura-fields");
    const rucInput = document.getElementById("customer-ruc");
    const rucHelp = document.getElementById("customer-ruc-help");
    const rucButton = document.getElementById("buscar-ruc");
    const businessInput = document.getElementById("customer-business");
    const addressInput = document.getElementById("customer-address");

    const IGV_RATE = 0.18;

    function documentType() {
        return document.querySelector('input[name="doc-type"]:checked').value;
    }

    // DNI peruano: 8 dígitos, no todo ceros
    function isValidDni(value) {
        return /^\d{8}$/.test(value) && value !== "00000000";
    }

    // RUC peruano: 11 dígitos, empieza en 10/15/17/20 y dígito verificador correcto
    function isValidRuc(ruc) {
        if (!/^(10|15|17|20)\d{9}$/.test(ruc)) return false;
        const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
        const sum = weights.reduce((acc, w, i) => acc + w * Number(ruc[i]), 0);
        return (11 - (sum % 11)) % 10 === Number(ruc[10]);
    }

    // Resultado de la última consulta de DNI; se muestra tal cual en vez del "DNI válido" genérico
    let dniStatus = null;

    function setHelp(el, message, state) {
        el.textContent = message;
        el.style.color = state === "error" ? "#a23e37" : state === "ok" ? "#2e6a40" : "";
    }

    // Revisa los datos del cliente según el tipo de comprobante
    function customerIsValid() {
        if (documentType() === "boleta") {
            return isValidDni(dniInput.value.trim()) && Boolean(nameInput.value.trim());
        }
        return isValidRuc(rucInput.value.trim()) && Boolean(businessInput.value.trim()) && Boolean(addressInput.value.trim());
    }

    // El botón solo se habilita con carrito y datos del cliente completos
    function updateCompleteButton() {
        completeButton.disabled = !(cart.length && customerIsValid());

        const dni = dniInput.value.trim();
        dniButton.disabled = !isValidDni(dni);
        if (!dni) setHelp(dniHelp, "Obligatorio: sin DNI no se puede emitir la boleta.");
        else if (!isValidDni(dni)) setHelp(dniHelp, `DNI incompleto o no válido (${dni.length}/8 dígitos).`, "error");
        else if (dniStatus) setHelp(dniHelp, dniStatus.text, dniStatus.state);
        else setHelp(dniHelp, "DNI válido ✓", "ok");

        const ruc = rucInput.value.trim();
        rucButton.disabled = !isValidRuc(ruc);
        if (!ruc) setHelp(rucHelp, "Obligatorio para factura. Puedes buscarlo para autocompletar.");
        else if (ruc.length < 11) setHelp(rucHelp, `RUC incompleto (${ruc.length}/11 dígitos).`, "error");
        else if (!isValidRuc(ruc)) setHelp(rucHelp, "RUC no válido. Revisa los dígitos.", "error");
        else setHelp(rucHelp, "RUC válido ✓ — pulsa Buscar para autocompletar.", "ok");
    }

    // Cambiar entre boleta y factura
    document.querySelectorAll('input[name="doc-type"]').forEach(radio => {
        radio.addEventListener("change", () => {
            const isFactura = documentType() === "factura";
            boletaFields.classList.toggle("hidden", isFactura);
            facturaFields.classList.toggle("hidden", !isFactura);
            completeButton.textContent = isFactura
                ? "Confirmar venta y emitir factura"
                : "Confirmar venta y emitir boleta";
            updateCompleteButton();
        });
    });

    // Solo números en DNI y RUC
    dniInput.addEventListener("input", () => {
        dniInput.value = dniInput.value.replace(/\D/g, "").slice(0, 8);
        dniStatus = null;
        updateCompleteButton();

        // Al completar los 8 dígitos se consulta solo
        if (isValidDni(dniInput.value)) consultarDni(dniInput.value);
    });

    // Para reintentar sin tener que borrar y volver a escribir el DNI
    dniButton.addEventListener("click", () => consultarDni(dniInput.value.trim()));

    async function consultarDni(dni) {
        dniButton.disabled = true;
        dniButton.textContent = "Buscando…";
        setHelp(dniHelp, "Consultando datos del cliente…", "");

        try {
            const data = await api(`/consulta-dni/${encodeURIComponent(dni)}`);

            // Si mientras tanto cambió el DNI, esta respuesta ya no corresponde
            if (dniInput.value.trim() !== dni) return;

            // Formato RENIEC: apellidos primero y luego nombres
            nameInput.value = [data.apellidoPaterno, data.apellidoMaterno, data.nombres]
                .filter(Boolean).join(" ").trim();
            dniStatus = nameInput.value
                ? { text: "Datos del cliente encontrados ✓", state: "ok" }
                : { text: "No llegaron nombres. Escríbelos a mano.", state: "error" };
        } catch (error) {
            if (dniInput.value.trim() !== dni) return;
            dniStatus = { text: `${error.message} Puedes escribir el nombre a mano.`, state: "error" };
        } finally {
            dniButton.textContent = "Buscar";
        }

        updateCompleteButton();
    }

    rucInput.addEventListener("input", () => {
        rucInput.value = rucInput.value.replace(/\D/g, "").slice(0, 11);
        updateCompleteButton();
    });
    [nameInput, businessInput, addressInput].forEach(input => input.addEventListener("input", updateCompleteButton));

    // Autocompletar razón social y dirección con la consulta de RUC que ya usa el sistema
    rucButton.addEventListener("click", async () => {
        const ruc = rucInput.value.trim();
        rucButton.disabled = true;
        rucButton.textContent = "Buscando…";
        let message, state;
        try {
            const data = await api(`/consulta-ruc/${encodeURIComponent(ruc)}`);
            businessInput.value = data.razonSocial || "";
            addressInput.value = data.direccion || "";
            const estado = [data.estado, data.condicion].filter(Boolean).join(" / ");
            message = `Datos encontrados ✓ ${estado ? "(" + estado + ")" : ""}`;
            state = "ok";
        } catch (error) {
            message = `${error.message} Puedes escribir los datos a mano.`;
            state = "error";
        }
        rucButton.textContent = "Buscar";
        updateCompleteButton();
        setHelp(rucHelp, message, state);
    });

    // Cargar todos los productos activos desde la API unificada
    async function loadProducts() {
        try {
            const result = await api("/products?active=true");
            // En arreglos con receta, el stock es cuántos se pueden armar con los insumos
            products = (Array.isArray(result) ? result : []).map(p => p.recipe && p.recipe.length ? { ...p, stock: p.available ?? 0 } : p);
            updateProductOptions();
        } catch (error) {
            showMessage("sale-message", error.message, "error");
        }
    }

    // Actualizar el desplegable de productos según la categoría seleccionada
    function updateProductOptions() {
        const selectedCategory = typeSelect.value;
        productSelect.replaceChildren();

        if (!selectedCategory) {
            const defaultOpt = document.createElement("option");
            defaultOpt.value = "";
            defaultOpt.textContent = "Primero selecciona una categoría";
            productSelect.appendChild(defaultOpt);
            productSelect.disabled = true;
            return;
        }

        productSelect.disabled = false;
        const filtered = products.filter(p => p.category === selectedCategory && Number(p.stock) > 0);

        const initialOption = document.createElement("option");
        initialOption.value = "";
        initialOption.textContent = filtered.length ? "Selecciona un producto" : `No hay stock disponible en ${selectedCategory}`;
        productSelect.appendChild(initialOption);

        filtered.forEach(product => {
            const option = document.createElement("option");
            option.value = String(product.id);
            option.textContent = `${product.name} — ${euro(product.price)} · stock: ${product.stock}`;
            productSelect.appendChild(option);
        });
    }

    // Dibujar el carrito y calcular el total
    function renderCart() {
        cartTable.replaceChildren();
        if (!cart.length) {
            const row = document.createElement("tr");
            const cell = document.createElement("td");
            cell.colSpan = 4;
            cell.className = "empty";
            cell.textContent = "Aún no has añadido productos al pedido.";
            row.appendChild(cell);
            cartTable.appendChild(row);
        } else {
            cart.forEach(item => {
                const row = document.createElement("tr");
                const nameCell = document.createElement("td");
                const name = document.createElement("strong");
                const detail = document.createElement("div");
                name.textContent = item.name;
                detail.className = "muted";
                detail.textContent = `${item.category} · ${euro(item.price)} / unidad`;
                nameCell.append(name, detail);

                const quantityCell = document.createElement("td");
                quantityCell.textContent = item.quantity;

                const subtotalCell = document.createElement("td");
                subtotalCell.className = "price";
                subtotalCell.textContent = euro(item.price * item.quantity);

                const actionCell = document.createElement("td");
                const removeButton = document.createElement("button");
                removeButton.type = "button";
                removeButton.className = "btn btn-danger btn-small";
                removeButton.dataset.remove = item.productId;
                removeButton.textContent = "×";
                removeButton.setAttribute("aria-label", `Eliminar ${item.name}`);
                actionCell.appendChild(removeButton);

                row.append(nameCell, quantityCell, subtotalCell, actionCell);
                cartTable.appendChild(row);
            });
        }
        const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
        totalElement.textContent = euro(total);
        const opGravada = Math.round((total / (1 + IGV_RATE)) * 100) / 100;
        taxElement.textContent = `Op. gravada: ${euro(opGravada)} · IGV (18%): ${euro(total - opGravada)}`;
        updateCompleteButton();
    }

    // Evento al cambiar la categoría seleccionada
    typeSelect.addEventListener("change", () => {
        updateProductOptions();
    });

    // Añadir producto al carrito
    addForm.addEventListener("submit", event => {
        event.preventDefault();
        const quantity = Number(quantityInput.value);
        const productId = productSelect.value;

        if (!productId) {
            showMessage("sale-message", "Selecciona un producto válido.", "error");
            return;
        }
        if (!Number.isInteger(quantity) || quantity < 1) {
            showMessage("sale-message", "Introduce una cantidad válida.", "error");
            return;
        }

        const product = products.find(p => String(p.id) === productId);
        if (!product) {
            showMessage("sale-message", "El producto seleccionado no existe.", "error");
            return;
        }

        const existingItem = cart.find(i => i.productId === product.id);
        const currentQtyInCart = existingItem ? existingItem.quantity : 0;

        if (currentQtyInCart + quantity > Number(product.stock)) {
            showMessage("sale-message", `Stock insuficiente para ${product.name}. Disponible: ${product.stock}.`, "error");
            return;
        }

        if (existingItem) {
            existingItem.quantity += quantity;
        } else {
            cart.push({
                productId: product.id,
                name: product.name,
                category: product.category,
                price: Number(product.price),
                quantity
            });
        }

        renderCart();
        quantityInput.value = 1;
        showMessage("sale-message", "Producto añadido al pedido.");
    });

    // Eliminar artículo del carrito
    cartTable.addEventListener("click", event => {
        const button = event.target.closest("[data-remove]");
        if (!button) return;
        cart = cart.filter(item => item.productId !== button.dataset.remove);
        renderCart();
    });

    // Completar venta y enviar a la API
    document.getElementById("complete-sale").addEventListener("click", async () => {
        if (!cart.length) {
            showMessage("sale-message", "Añade al menos un producto antes de confirmar.", "error");
            return;
        }

        const type = documentType();
        let customer;
        if (type === "boleta") {
            const dni = dniInput.value.trim();
            const name = nameInput.value.trim();
            if (!isValidDni(dni)) {
                showMessage("sale-message", "El DNI del cliente es obligatorio para emitir la boleta (8 dígitos).", "error");
                dniInput.focus();
                return;
            }
            if (!name) {
                showMessage("sale-message", "Ingresa el nombre del cliente para emitir la boleta.", "error");
                nameInput.focus();
                return;
            }
            customer = { docNumber: dni, name };
        } else {
            const ruc = rucInput.value.trim();
            const name = businessInput.value.trim();
            const address = addressInput.value.trim();
            if (!isValidRuc(ruc)) {
                showMessage("sale-message", "Para emitir factura ingresa un RUC válido de 11 dígitos.", "error");
                rucInput.focus();
                return;
            }
            if (!name || !address) {
                showMessage("sale-message", "Completa la razón social y la dirección fiscal para emitir la factura.", "error");
                (name ? addressInput : businessInput).focus();
                return;
            }
            customer = { docNumber: ruc, name, address };
        }

        const docLabel = type === "factura" ? "factura" : "boleta";
        const docId = type === "factura" ? `RUC ${customer.docNumber}` : `DNI ${customer.docNumber}`;
        if (!confirm(`¿Emitir ${docLabel} a ${customer.name} (${docId})? Se descontará el stock disponible en el inventario.`)) {
            return;
        }

        try {
            const sale = await api("/sales", {
                method: "POST",
                body: JSON.stringify({
                    documentType: type,
                    customer,
                    items: cart.map(item => ({
                        productId: item.productId,
                        quantity: item.quantity
                    }))
                })
            });

            cart = [];
            [dniInput, nameInput, rucInput, businessInput, addressInput].forEach(input => { input.value = ""; });
            renderCart();
            showMessage("sale-message", `${type === "factura" ? "Factura" : "Boleta"} ${sale.ticketNumber} emitida correctamente.`);
            await loadProducts();
            setTimeout(() => {
                location.href = "/paginas/ticket.html";
            }, 700);
        } catch (error) {
            showMessage("sale-message", error.message, "error");
            await loadProducts();
        }
    });

    loadProducts();
});