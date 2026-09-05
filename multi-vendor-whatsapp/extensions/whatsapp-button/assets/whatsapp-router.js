/**
 * Multi-Vendor WhatsApp Order Router
 *
 * Reparte los clics entre los vendedores activos con una estrategia round
 * robin guardada en localStorage: cada clic del visitante avanza al siguiente
 * vendedor. Respeta etiquetas de producto, horarios, prioridades y stock, y
 * puede enviar el carrito completo como pedido.
 *
 * Cada bloque lleva su configuración en un <script type="application/json">:
 *   mode: "product" | "cart" | "generic"
 *   vendors[]: { name, phone, weight, hours, tags }
 *   producto: messageTemplate, productTitle, productUrl, productPrice,
 *             productSku, productTags, productAvailable, variants,
 *             quantitySelector, outOfStockBehavior, outOfStockLabel, defaultLabel
 *   carrito:  cartMessageTemplate, cart (instantánea), shopUrl, currency, locale
 *   genérico: genericMessage, cartAware
 *   availability: { enabled, onlineText, offlineText }
 */
(function () {
  "use strict";

  // Varios bloques incluyen este mismo archivo; se ejecuta una sola vez
  if (window.__mvwRouterLoaded) return;
  window.__mvwRouterLoaded = true;

  var STORAGE_KEY = "mvw:vendor-index";
  var MAX_WEIGHT = 5;
  var STATUS_REFRESH_MS = 60000;
  var DEFAULT_QUANTITY_SELECTOR = 'form[action*="/cart/add"] [name="quantity"]';
  var DAY_NAMES = [
    "domingo",
    "lunes",
    "martes",
    "miércoles",
    "jueves",
    "viernes",
    "sábado",
  ];

  // Selectores habituales del botón "Añadir al carrito" en los temas de Shopify
  var ADD_TO_CART_SELECTORS = [
    'form[action*="/cart/add"] [name="add"]',
    'form[action*="/cart/add"] button[type="submit"]',
    ".product-form__submit",
    ".shopify-payment-button",
  ];

  // Bloques ya inicializados; se refrescan todos cuando cambia algo
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

  function pad(value) {
    return (value < 10 ? "0" : "") + value;
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

    // Turno nocturno que cruza la medianoche (por ejemplo 22:00 a 06:00)
    if (now.minutes >= start) return includesDay(hours.days, now.day);
    return now.minutes < end && includesDay(hours.days, (now.day + 6) % 7);
  }

  /**
   * Próxima apertura entre los vendedores con horario: {dayOffset, minutes}
   * (0 = hoy, 1 = mañana...). Se usa para el texto "te respondemos a las…".
   */
  function nextOpening(vendors, now) {
    var best = null;
    vendors.forEach(function (vendor) {
      var hours = vendor.hours;
      if (!hours) return;
      var start = toMinutes(hours.start);
      if (start === null) return;

      for (var offset = 0; offset < 8; offset += 1) {
        var day = (now.day + offset) % 7;
        if (!includesDay(hours.days, day)) continue;
        if (offset === 0 && start <= now.minutes) continue;
        var candidate = { dayOffset: offset, minutes: start, day: day };
        if (
          !best ||
          candidate.dayOffset < best.dayOffset ||
          (candidate.dayOffset === best.dayOffset &&
            candidate.minutes < best.minutes)
        ) {
          best = candidate;
        }
        break;
      }
    });
    return best;
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
  /* Etiquetas de producto                                               */
  /* ------------------------------------------------------------------ */

  function lower(value) {
    return String(value || "").trim().toLowerCase();
  }

  function hasTags(vendor) {
    return Array.isArray(vendor.tags) && vendor.tags.length > 0;
  }

  /**
   * Especialistas primero: si algún vendedor tiene etiquetas que coinciden
   * con las del producto, solo ellos lo reciben. Si no hay coincidencia, va
   * a los vendedores sin etiquetas (generales). Sin generales, a todos.
   * Fuera de una ficha de producto (carrito, páginas generales) atienden los
   * generales.
   */
  function eligibleByTags(vendors, productTags) {
    var generalists = vendors.filter(function (vendor) {
      return !hasTags(vendor);
    });

    if (Array.isArray(productTags)) {
      var tags = productTags.map(lower);
      var specialists = vendors.filter(function (vendor) {
        return (
          hasTags(vendor) &&
          vendor.tags.some(function (tag) {
            return tags.indexOf(lower(tag)) !== -1;
          })
        );
      });
      if (specialists.length > 0) return specialists;
    }

    return generalists.length > 0 ? generalists : vendors;
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
   * A, B, A, A. Intercalar evita que un vendedor reciba varios seguidos.
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
   * etiquetas → turno → prioridad → posición del round robin.
   */
  function resolveVendor(config) {
    var all = Array.isArray(config.vendors) ? config.vendors : [];
    if (all.length === 0) return null;

    var byTags = eligibleByTags(
      all,
      config.mode === "product" ? config.productTags : null,
    );
    var rotation = expandByWeight(
      availableVendors(byTags, config.shopUtcOffset),
    );
    var index = readIndex(rotation.length) % rotation.length;
    return { vendor: rotation[index], index: index, total: rotation.length };
  }

  /* ------------------------------------------------------------------ */
  /* Producto, variantes, cantidad y mensaje                             */
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

  /** Cantidad elegida en el selector del tema (1 si no hay selector). */
  function currentQuantity(config) {
    var selector = config.quantitySelector || DEFAULT_QUANTITY_SELECTOR;
    var input = null;
    try {
      input = document.querySelector(selector);
    } catch (error) {
      input = document.querySelector(DEFAULT_QUANTITY_SELECTOR);
    }
    var quantity = input ? parseInt(input.value, 10) : NaN;
    return isNaN(quantity) || quantity < 1 ? 1 : quantity;
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

  /** Mensaje de una ficha de producto con la variante y cantidad actuales. */
  function buildProductMessage(config) {
    var label = config.productTitle;
    var url = config.productUrl;
    var price = config.productPrice || "";
    var sku = config.productSku || "";
    var selected = currentVariant(config);

    if (selected) {
      label = label + " (" + (selected.data.title || "") + ")";
      url = url + (url.indexOf("?") === -1 ? "?" : "&") + "variant=" + selected.id;
      if (selected.data.price) price = selected.data.price;
      if (selected.data.sku) sku = selected.data.sku;
    }

    return fillTemplate(config.messageTemplate, {
      producto: label,
      precio: price,
      cantidad: String(currentQuantity(config)),
      sku: sku,
      url: url,
    });
  }

  /* ------------------------------------------------------------------ */
  /* Carrito                                                             */
  /* ------------------------------------------------------------------ */

  function formatMoney(cents, currency, locale) {
    var amount = Number(cents || 0) / 100;
    try {
      return new Intl.NumberFormat(locale || undefined, {
        style: "currency",
        currency: currency || "USD",
      }).format(amount);
    } catch (error) {
      return amount.toFixed(2) + " " + (currency || "");
    }
  }

  /**
   * Mensaje con el pedido completo. `cart` tiene la forma de /cart.js
   * (o la instantánea que Liquid deja en la configuración como respaldo).
   */
  function buildCartMessage(config, cart) {
    var items = (cart && cart.items) || [];
    var currency = (cart && cart.currency) || config.currency;

    var lines = items.map(function (item) {
      var name = item.product_title || "";
      if (item.variant_title && item.variant_title !== "Default Title") {
        name += " (" + item.variant_title + ")";
      }
      return (
        "- " +
        item.quantity +
        "× " +
        name +
        " — " +
        formatMoney(item.final_line_price, currency, config.locale)
      );
    });

    var permalink =
      config.shopUrl +
      "/cart/" +
      items
        .map(function (item) {
          return item.variant_id + ":" + item.quantity;
        })
        .join(",");

    return fillTemplate(config.cartMessageTemplate, {
      pedido: lines.join("\n"),
      total: formatMoney(cart ? cart.total_price : 0, currency, config.locale),
      cantidad: String(cart ? cart.item_count : 0),
      url: permalink,
    });
  }

  function fetchCart() {
    return fetch("/cart.js", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    }).then(function (response) {
      if (!response.ok) throw new Error("cart");
      return response.json();
    });
  }

  /** Mensaje que este bloque enviaría ahora mismo sin consultar el carrito. */
  function syncMessage(config) {
    if (config.mode === "product") return buildProductMessage(config);
    if (config.mode === "cart") return buildCartMessage(config, config.cart);
    if (config.cartAware && config.cart && config.cart.item_count > 0) {
      return buildCartMessage(config, config.cart);
    }
    return String(config.genericMessage || "");
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
  function trackClick(config, vendor, label) {
    if (!config.clickEndpoint) return;
    var body = JSON.stringify({
      name: vendor.name,
      phone: vendor.phone,
      product: label || null,
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
  /* Disponibilidad en vivo                                              */
  /* ------------------------------------------------------------------ */

  /**
   * "En línea" cuando alguien está en turno; si no, cuándo vuelve a haber
   * alguien. Solo tiene sentido si algún vendedor tiene horario configurado.
   */
  function applyStatus(entry) {
    var status = entry.status;
    var config = entry.config;
    var settings = config.availability;
    if (!status) return;

    var vendors = Array.isArray(config.vendors) ? config.vendors : [];
    var scheduled = vendors.filter(function (vendor) {
      return Boolean(vendor.hours);
    });
    if (!settings || !settings.enabled || scheduled.length === 0) {
      status.hidden = true;
      return;
    }

    var now = shopNow(config.shopUtcOffset);
    var online = vendors.some(function (vendor) {
      return isOnDuty(vendor, now);
    });

    var text;
    if (online) {
      text = String(settings.onlineText || "");
    } else {
      var opening = nextOpening(scheduled, now);
      var hora = opening
        ? pad(Math.floor(opening.minutes / 60)) + ":" + pad(opening.minutes % 60)
        : "";
      var dia = "";
      if (opening) {
        dia =
          opening.dayOffset === 0
            ? "hoy"
            : opening.dayOffset === 1
              ? "mañana"
              : "el " + DAY_NAMES[opening.day];
      }
      text = fillTemplate(settings.offlineText, { hora: hora, dia: dia });
    }

    status.classList.toggle("mvw-status--online", online);
    status.classList.toggle("mvw-status--offline", !online);
    if (entry.statusText) entry.statusText.textContent = text;
    status.setAttribute("title", text);
    status.hidden = text.trim() === "";
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
    var entry = {
      element: element,
      config: config,
      status: element.querySelector("[data-mvw-status]"),
      statusText: element.querySelector("[data-mvw-status-text]"),
      refresh: refresh,
    };

    /**
     * Aplica lo que el comerciante eligió para los productos agotados.
     * Se vuelve a evaluar en cada cambio de variante: en un mismo producto
     * puede haber una talla agotada y otra disponible.
     */
    function applyStockState() {
      if (config.mode !== "product" || behavior === "show") return;
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
        button.href = buildLink(current.vendor, syncMessage(config));
      }
      applyStockState();
      applyStatus(entry);
    }

    function finish(current, label) {
      advanceIndex(current.index, current.total);
      trackClick(config, current.vendor, label);
      // El resto de botones de la página pasan al siguiente vendedor
      blocks.forEach(function (other) {
        if (other.element !== element) other.refresh();
      });
    }

    var needsLiveCart =
      config.mode === "cart" || (config.mode === "generic" && config.cartAware);

    button.addEventListener("click", function (event) {
      // Momento decisivo: se resuelve todo aquí por si el tema cambió la
      // variante o cantidad sin avisar, o si otro botón ya avanzó el turno
      var current = resolveVendor(config);
      if (!current) return;

      if (!needsLiveCart) {
        button.href = buildLink(current.vendor, syncMessage(config));
        finish(current, config.productTitle || null);
        return;
      }

      // El carrito puede haber cambiado desde el cajón lateral sin recargar:
      // se consulta /cart.js. La pestaña se abre ya, dentro del clic, para
      // que el bloqueador de ventanas emergentes no la impida después.
      event.preventDefault();
      var popup = null;
      try {
        popup = window.open("", "_blank");
      } catch (error) {
        popup = null;
      }

      function go(message, label) {
        var link = buildLink(current.vendor, message);
        if (popup) {
          popup.location.href = link;
        } else {
          window.location.href = link;
        }
        finish(current, label);
      }

      fetchCart()
        .then(function (cart) {
          if (cart && cart.item_count > 0) {
            go(
              buildCartMessage(config, cart),
              "Carrito (" + cart.item_count + " artículos)",
            );
          } else if (config.mode === "cart") {
            go(buildCartMessage(config, config.cart), "Carrito");
          } else {
            go(String(config.genericMessage || ""), null);
          }
        })
        .catch(function () {
          go(syncMessage(config), null);
        });
    });

    if (config.hideAddToCart) {
      hideAddToCart(config.customSelector);
    }

    blocks.push(entry);
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

    // Si el cliente cambia de talla, color o cantidad, los enlaces se actualizan
    var productForm = document.querySelector('form[action*="/cart/add"]');
    if (productForm && productForm.dataset.mvwWatched !== "true") {
      productForm.dataset.mvwWatched = "true";
      productForm.addEventListener("change", function () {
        // Algunos temas actualizan el campo oculto justo después del evento
        window.setTimeout(refreshAll, 0);
      });
      productForm.addEventListener("input", function () {
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

  // El estado "en línea / fuera de horario" cambia con la hora
  window.setInterval(function () {
    blocks.forEach(applyStatus);
  }, STATUS_REFRESH_MS);
})();
