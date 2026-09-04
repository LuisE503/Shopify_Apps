/**
 * Multi-Vendor WhatsApp Order Router
 *
 * Reparte los clics entre los vendedores activos con una estrategia round
 * robin guardada en localStorage: cada clic del visitante avanza al siguiente
 * vendedor de la lista.
 */
(function () {
  "use strict";

  var STORAGE_KEY = "mvw:vendor-index";

  // Selectores habituales del botón "Añadir al carrito" en los temas de Shopify
  var ADD_TO_CART_SELECTORS = [
    'form[action*="/cart/add"] [name="add"]',
    'form[action*="/cart/add"] button[type="submit"]',
    ".product-form__submit",
    ".shopify-payment-button",
  ];

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

  function buildLink(vendor, message) {
    return (
      "https://wa.me/" + vendor.phone + "?text=" + encodeURIComponent(message)
    );
  }

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
      return { day: now.getDay(), minutes: now.getHours() * 60 + now.getMinutes() };
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

  /** ¿Este vendedor está en su turno ahora mismo? Sin horario, siempre sí. */
  function isOnDuty(vendor, now) {
    var hours = vendor.hours;
    if (!hours) return true;

    var start = toMinutes(hours.start);
    var end = toMinutes(hours.end);
    if (start === null || end === null || start === end) return true;

    var days = hours.days;
    var withinDays =
      !Array.isArray(days) || days.length === 0 || days.indexOf(now.day) !== -1;

    if (start < end) {
      return withinDays && now.minutes >= start && now.minutes < end;
    }

    // Turno nocturno que cruza la medianoche (por ejemplo 22:00 a 06:00).
    // Antes de medianoche cuenta el día del turno; después, el día anterior.
    if (now.minutes >= start) return withinDays;
    var previousDay = (now.day + 6) % 7;
    var withinPreviousDay =
      !Array.isArray(days) ||
      days.length === 0 ||
      days.indexOf(previousDay) !== -1;
    return now.minutes < end && withinPreviousDay;
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

  /** Rellena {producto} y {url} añadiendo la variante elegida, si la hay. */
  function buildMessage(config) {
    // El botón flotante fuera de una ficha de producto no tiene qué sustituir
    if (!config.productUrl || !config.productTitle) {
      return String(config.messageTemplate || "");
    }

    var label = config.productTitle;
    var url = config.productUrl;
    var variantId = currentVariantId();
    var variant = variantId ? (config.variants || {})[variantId] : null;

    if (variant) {
      label = label + " (" + (variant.title || "") + ")";
      url = url + (url.indexOf("?") === -1 ? "?" : "&") + "variant=" + variantId;
    }

    return String(config.messageTemplate)
      .split("{producto}")
      .join(label)
      .split("{url}")
      .join(url);
  }

  /** ¿Hay stock de lo que el cliente tiene seleccionado ahora mismo? */
  function isInStock(config) {
    var variantId = currentVariantId();
    var variant = variantId ? (config.variants || {})[variantId] : null;
    if (variant) return variant.available !== false;
    return config.productAvailable !== false;
  }

  /**
   * Avisa al backend de la app de que este vendedor recibió un clic.
   * Va con sendBeacon para que el envío sobreviva a la navegación hacia
   * WhatsApp; si algo falla, el cliente se va igual a su chat.
   */
  function trackClick(endpoint, vendor) {
    if (!endpoint) return;
    var body = JSON.stringify({ name: vendor.name, phone: vendor.phone });

    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(
          endpoint,
          new Blob([body], { type: "application/json" }),
        );
        return;
      }
      fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body,
        keepalive: true,
      }).catch(function () {});
    } catch (error) {
      // Las estadísticas nunca deben interrumpir una venta
    }
  }

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

  function setupBlock(block) {
    if (block.dataset.mvwReady === "true") return;

    var configElement = block.querySelector("[data-mvw-config]");
    var button = block.querySelector("[data-mvw-button]");
    if (!configElement || !button) return;

    var config;
    try {
      config = JSON.parse(configElement.textContent);
    } catch (error) {
      return;
    }

    var allVendors = Array.isArray(config.vendors) ? config.vendors : [];
    if (allVendors.length === 0) return;

    var vendors = availableVendors(allVendors, config.shopUtcOffset);
    var index = readIndex(vendors.length) % vendors.length;
    var vendor = vendors[index];

    var labelElement = block.querySelector("[data-mvw-label]");
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
        block.hidden = !inStock;
      } else if (behavior === "label" && labelElement) {
        labelElement.textContent = inStock
          ? config.defaultLabel
          : config.outOfStockLabel;
      }
    }

    // Sustituye el enlace de reserva que ya venía renderizado desde Liquid
    function refreshLink() {
      button.href = buildLink(vendor, buildMessage(config));
      applyStockState();
    }

    refreshLink();

    // Si el cliente cambia de talla o color, el enlace se actualiza
    var productForm = document.querySelector('form[action*="/cart/add"]');
    if (productForm) {
      productForm.addEventListener("change", function () {
        // Algunos temas actualizan el campo oculto justo después del evento
        window.setTimeout(refreshLink, 0);
      });
    }

    button.addEventListener("click", function () {
      // Momento decisivo: se recalcula por si el tema cambió la variante
      // sin disparar un evento que hayamos escuchado
      refreshLink();
      advanceIndex(index, vendors.length);
      trackClick(config.clickEndpoint, vendor);
    });

    if (config.hideAddToCart) {
      hideAddToCart(config.customSelector);
    }

    block.dataset.mvwReady = "true";
  }

  function init() {
    var blocks = document.querySelectorAll("[data-mvw-block]");
    Array.prototype.forEach.call(blocks, setupBlock);
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
