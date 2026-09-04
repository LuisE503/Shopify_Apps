/**
 * Multi-Vendor WhatsApp Order Router
 *
 * Reparte los clics entre los vendedores activos con una estrategia round
 * robin guardada en localStorage: cada clic del visitante avanza al siguiente
 * vendedor de la lista. Respeta horarios, prioridades y stock.
 */
(function () {
  "use strict";

  // El bloque de producto y el flotante incluyen este mismo archivo; en una
  // ficha con ambos, el navegador lo ejecutaría dos veces
  if (window.__mvwRouterLoaded) return;
  window.__mvwRouterLoaded = true;

  var STORAGE_KEY = "mvw:vendor-index";
  var MAX_WEIGHT = 5;

  // Selectores habituales del botón "Añadir al carrito" en los temas de Shopify
  var ADD_TO_CART_SELECTORS = [
    'form[action*="/cart/add"] [name="add"]',
    'form[action*="/cart/add"] button[type="submit"]',
    ".product-form__submit",
    ".shopify-payment-button",
  ];

  // Bloques ya inicializados; se refrescan todos cuando cambia el turno
  var blocks = [];

  /* ------------------------------------------------------------------ */
  /* Round robin                                                         */
  /* ------------------------------------------------------------------ */

  function readIndex(total) {
    try {
      var stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === null) {
        // Primer visitante: arranca en una posición al azar. Sin esto, todos
        // los visitantes nuevos irían siempre al primer vendedor de la lista.
        var start = Math.floor(Math.random() * total);
        window.localStorage.setItem(STORAGE_KEY, String(start));
        return start;
      }
      var parsed = parseInt(stored, 10);
      return isNaN(parsed) || parsed < 0 ? 0 : parsed;
    } catch (error) {
      // Navegación privada o cookies bloqueadas: se reparte al azar
      return Math.floor(Math.random() * total);
    }
  }

  function advanceIndex(current, total) {
    try {
      window.localStorage.setItem(STORAGE_KEY, String((current + 1) % total));
    } catch (error) {
      // Sin almacenamiento no se puede rotar; el enlace sigue funcionando
    }
  }

  /* ------------------------------------------------------------------ */
  /* Horarios                                                            */
  /* ------------------------------------------------------------------ */

  /** "08:30" -> 510 minutos. Devuelve null si el formato no es válido. */
  function toMinutes(time) {
    var match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(time || ""));
    if (!match) return null;
    return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
  }

  /**
   * Hora actual en el huso de la tienda, no en el del visitante: un cliente
   * en otro país debe ver disponible a quien esté en turno en la tienda.
   * `offset` llega desde Liquid con el formato "-0600".
   */
  function shopNow(offset) {
    var match = /^([+-])(\d{2})(\d{2})$/.exec(String(offset || ""));
    var now = new Date();
    if (!match) {
      return {
        day: now.getDay(),
        minutes: now.getHours() * 60 + now.getMinutes(),
      };
    }

    var sign = match[1] === "-" ? -1 : 1;
    var offsetMinutes =
      sign * (parseInt(match[2], 10) * 60 + parseInt(match[3], 10));
    // Se desplaza la marca de tiempo para que los getters locales devuelvan
    // la hora de pared de la tienda
    var shifted = new Date(
      now.getTime() + now.getTimezoneOffset() * 60000 + offsetMinutes * 60000,
    );
    return {
      day: shifted.getDay(),
      minutes: shifted.getHours() * 60 + shifted.getMinutes(),
    };
  }

  function includesDay(days, day) {
    return !Array.isArray(days) || days.length === 0 || days.indexOf(day) !== -1;
  }

  /** ¿Este vendedor está en su turno ahora mismo? Sin horario, siempre sí. */
  function isOnDuty(vendor, now) {
    var hours = vendor.hours;
    if (!hours) return true;

    var start = toMinutes(hours.start);
    var end = toMinutes(hours.end);
    if (start === null || end === null || start === end) return true;

    if (start < end) {
      return (
        includesDay(hours.days, now.day) &&
        now.minutes >= start &&
        now.minutes < end
      );
    }

    // Turno nocturno que cruza la medianoche (por ejemplo 22:00 a 06:00).
    // Antes de medianoche cuenta el día del turno; después, el día anterior.
    if (now.minutes >= start) return includesDay(hours.days, now.day);
    return now.minutes < end && includesDay(hours.days, (now.day + 6) % 7);
  }

  /**
   * Vendedores que pueden atender ahora. Si nadie está en turno se usan
   * todos: es preferible una respuesta tardía a perder la venta.
   */
  function availableVendors(vendors, offset) {
    var now = shopNow(offset);
    var onDuty = vendors.filter(function (vendor) {
      return isOnDuty(vendor, now);
    });
    return onDuty.length > 0 ? onDuty : vendors;
  }

  /* ------------------------------------------------------------------ */
  /* Prioridad                                                           */
  /* ------------------------------------------------------------------ */

  function weightOf(vendor) {
    var weight = parseInt(vendor.weight, 10);
    if (isNaN(weight) || weight < 1) return 1;
    return Math.min(weight, MAX_WEIGHT);
  }

  /**
   * Reparte por rondas según la prioridad: con A(3) y B(1) el orden queda
   * A, B, A, A. Intercalar en vez de repetir en bloque evita que un mismo
   * vendedor reciba varios clientes seguidos.
   */
  function expandByWeight(vendors) {
    var maxWeight = 1;
    vendors.forEach(function (vendor) {
      maxWeight = Math.max(maxWeight, weightOf(vendor));
    });

    var expanded = [];
    for (var round = 0; round < maxWeight; round += 1) {
      vendors.forEach(function (vendor) {
        if (weightOf(vendor) > round) expanded.push(vendor);
      });
    }
    return expanded;
  }

  /**
   * Vendedor al que le toca el próximo clic, evaluado en este instante:
   * el turno y el stock pueden cambiar mientras la página sigue abierta.
   */
  function resolveVendor(config) {
    var all = Array.isArray(config.vendors) ? config.vendors : [];
    if (all.length === 0) return null;

    var rotation = expandByWeight(availableVendors(all, config.shopUtcOffset));
    var index = readIndex(rotation.length) % rotation.length;
    return { vendor: rotation[index], index: index, total: rotation.length };
  }

  /* ------------------------------------------------------------------ */
  /* Producto, variantes y mensaje                                       */
  /* ------------------------------------------------------------------ */

  /**
   * Id de la variante que el cliente tiene seleccionada ahora mismo.
   * Los temas mantienen el parámetro ?variant= de la URL y el campo oculto
   * name="id" del formulario sincronizados con el selector de opciones.
   */
  function currentVariantId() {
    try {
      var fromUrl = new URLSearchParams(window.location.search).get("variant");
      if (fromUrl) return String(fromUrl);
    } catch (error) {
      // Navegador antiguo sin URLSearchParams: se usa el formulario
    }

    var input = document.querySelector('form[action*="/cart/add"] [name="id"]');
    if (input && input.value) return String(input.value);

    return null;
  }

  function currentVariant(config) {
    var variantId = currentVariantId();
    if (!variantId) return null;
    var variant = (config.variants || {})[variantId];
    return variant ? { id: variantId, data: variant } : null;
  }

  /** ¿Hay stock de lo que el cliente tiene seleccionado ahora mismo? */
  function isInStock(config) {
    var selected = currentVariant(config);
    if (selected) return selected.data.available !== false;
    return config.productAvailable !== false;
  }

  function fillTemplate(template, values) {
    var text = String(template || "");
    Object.keys(values).forEach(function (key) {
      text = text.split("{" + key + "}").join(values[key]);
    });
    return text;
  }

  /** Rellena {producto}, {precio} y {url} con la variante elegida, si la hay. */
  function buildMessage(config) {
    // El botón flotante fuera de una ficha de producto no tiene qué sustituir
    if (!config.productUrl || !config.productTitle) {
      return String(config.messageTemplate || "");
    }

    var label = config.productTitle;
    var url = config.productUrl;
    var price = config.productPrice || "";
    var selected = currentVariant(config);

    if (selected) {
      label = label + " (" + (selected.data.title || "") + ")";
      url = url + (url.indexOf("?") === -1 ? "?" : "&") + "variant=" + selected.id;
      if (selected.data.price) price = selected.data.price;
    }

    return fillTemplate(config.messageTemplate, {
      producto: label,
      precio: price,
      url: url,
    });
  }

  function buildLink(vendor, message) {
    return (
      "https://wa.me/" + vendor.phone + "?text=" + encodeURIComponent(message)
    );
  }

  /* ------------------------------------------------------------------ */
  /* Estadísticas                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Avisa al backend de la app de que este vendedor recibió un clic.
   * Va con sendBeacon para que el envío sobreviva a la navegación hacia
   * WhatsApp; si algo falla, el cliente se va igual a su chat.
   */
  function trackClick(config, vendor) {
    if (!config.clickEndpoint) return;
    var body = JSON.stringify({
      name: vendor.name,
      phone: vendor.phone,
      product: config.productTitle || null,
    });

    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(
          config.clickEndpoint,
          new Blob([body], { type: "application/json" }),
        );
        return;
      }
      fetch(config.clickEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body,
        keepalive: true,
      }).catch(function () {});
    } catch (error) {
      // Las estadísticas nunca deben interrumpir una venta
    }
  }

  /* ------------------------------------------------------------------ */
  /* Añadir al carrito                                                   */
  /* ------------------------------------------------------------------ */

  function hideAddToCart(customSelector) {
    var selectors = ADD_TO_CART_SELECTORS.slice();
    if (customSelector) {
      selectors.push(customSelector);
    }

    selectors.forEach(function (selector) {
      var nodes;
      try {
        nodes = document.querySelectorAll(selector);
      } catch (error) {
        return; // Selector inválido escrito por el comerciante
      }
      Array.prototype.forEach.call(nodes, function (node) {
        node.style.display = "none";
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* Bloques                                                             */
  /* ------------------------------------------------------------------ */

  function setupBlock(element) {
    if (element.dataset.mvwReady === "true") return;

    var configElement = element.querySelector("[data-mvw-config]");
    var button = element.querySelector("[data-mvw-button]");
    if (!configElement || !button) return;

    var config;
    try {
      config = JSON.parse(configElement.textContent);
    } catch (error) {
      return;
    }
    if (!Array.isArray(config.vendors) || config.vendors.length === 0) return;

    var labelElement = element.querySelector("[data-mvw-label]");
    var behavior = config.outOfStockBehavior || "show";

    /**
     * Aplica lo que el comerciante eligió para los productos agotados.
     * Se vuelve a evaluar en cada cambio de variante: en un mismo producto
     * puede haber una talla agotada y otra disponible.
     */
    function applyStockState() {
      if (behavior === "show") return;
      var inStock = isInStock(config);

      if (behavior === "hide") {
        element.hidden = !inStock;
      } else if (behavior === "label" && labelElement) {
        labelElement.textContent = inStock
          ? config.defaultLabel
          : config.outOfStockLabel;
      }
    }

    // Sustituye el enlace de reserva que ya venía renderizado desde Liquid
    function refresh() {
      var current = resolveVendor(config);
      if (current) {
        button.href = buildLink(current.vendor, buildMessage(config));
      }
      applyStockState();
    }

    button.addEventListener("click", function () {
      // Momento decisivo: se resuelve todo aquí por si el tema cambió la
      // variante sin avisar o si otro botón de la página ya avanzó el turno
      var current = resolveVendor(config);
      if (!current) return;

      button.href = buildLink(current.vendor, buildMessage(config));
      advanceIndex(current.index, current.total);
      trackClick(config, current.vendor);

      // El resto de botones de la página pasan al siguiente vendedor
      blocks.forEach(function (entry) {
        if (entry.element !== element) entry.refresh();
      });
    });

    if (config.hideAddToCart) {
      hideAddToCart(config.customSelector);
    }

    blocks.push({ element: element, refresh: refresh });
    element.dataset.mvwReady = "true";
    refresh();
  }

  function refreshAll() {
    blocks.forEach(function (entry) {
      entry.refresh();
    });
  }

  function init() {
    var found = document.querySelectorAll("[data-mvw-block]");
    Array.prototype.forEach.call(found, setupBlock);

    // Si el cliente cambia de talla o color, los enlaces se actualizan
    var productForm = document.querySelector('form[action*="/cart/add"]');
    if (productForm && productForm.dataset.mvwWatched !== "true") {
      productForm.dataset.mvwWatched = "true";
      productForm.addEventListener("change", function () {
        // Algunos temas actualizan el campo oculto justo después del evento
        window.setTimeout(refreshAll, 0);
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // El editor de temas recarga secciones sin recargar la página
  document.addEventListener("shopify:section:load", init);
  document.addEventListener("shopify:block:select", init);
})();
