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
    var label = config.productTitle;
    var url = config.productUrl;
    var variants = config.variants || {};
    var variantId = currentVariantId();

    if (variantId && variants[variantId]) {
      label = label + " (" + variants[variantId] + ")";
      url = url + (url.indexOf("?") === -1 ? "?" : "&") + "variant=" + variantId;
    }

    return String(config.messageTemplate)
      .split("{producto}")
      .join(label)
      .split("{url}")
      .join(url);
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

    var vendors = Array.isArray(config.vendors) ? config.vendors : [];
    if (vendors.length === 0) return;

    var index = readIndex(vendors.length) % vendors.length;
    var vendor = vendors[index];

    // Sustituye el enlace de reserva que ya venía renderizado desde Liquid
    function refreshLink() {
      button.href = buildLink(vendor, buildMessage(config));
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
