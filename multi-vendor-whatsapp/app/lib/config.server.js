/**
 * Lectura y escritura de la configuración de la app en Shopify.
 *
 * Todo vive en app-data metafields para que la Theme App Extension lo lea
 * desde Liquid (app.metafields.whatsapp_router.*) sin tocar este backend.
 */
import {
  DEFAULT_CART_MESSAGE,
  DEFAULT_MESSAGE,
  MAX_MESSAGE_LENGTH,
  MIN_PHONE_DIGITS,
  digitsOnly,
  toHours,
  toTags,
  toVendor,
  toWeight,
} from "./vendors";

export const METAFIELD_NAMESPACE = "whatsapp_router";
const VENDORS_KEY = "vendors";
const MESSAGE_KEY = "message";
const CART_MESSAGE_KEY = "cart_message";

// Nombres de archivo de los bloques en extensions/whatsapp-button/blocks/
export const PRODUCT_BLOCK_HANDLE = "whatsapp_button";
export const CART_BLOCK_HANDLE = "whatsapp_cart";
export const FLOAT_BLOCK_HANDLE = "whatsapp_float";

/** Vendedores, plantillas y datos de la tienda que usan todas las páginas. */
export const loadConfig = async (admin) => {
  const response = await admin.graphql(
    `#graphql
      query getWhatsappConfig($namespace: String!) {
        shop {
          ianaTimezone
          currencyCode
        }
        currentAppInstallation {
          vendors: metafield(namespace: $namespace, key: "vendors") {
            jsonValue
          }
          message: metafield(namespace: $namespace, key: "message") {
            value
          }
          cartMessage: metafield(namespace: $namespace, key: "cart_message") {
            value
          }
        }
      }`,
    { variables: { namespace: METAFIELD_NAMESPACE } },
  );
  const data = (await response.json()).data;
  const installation = data?.currentAppInstallation;
  const storedVendors = installation?.vendors?.jsonValue;

  return {
    vendors: Array.isArray(storedVendors) ? storedVendors.map(toVendor) : [],
    message: installation?.message?.value || DEFAULT_MESSAGE,
    cartMessage: installation?.cartMessage?.value || DEFAULT_CART_MESSAGE,
    timeZone: data?.shop?.ianaTimezone ?? null,
    currencyCode: data?.shop?.currencyCode ?? "USD",
  };
};

const cleanVendorList = (list) => {
  const seenPhones = new Set();
  return (Array.isArray(list) ? list : [])
    .map((v) => ({
      name: String(v?.name ?? "").trim(),
      phone: digitsOnly(v?.phone),
      active: v?.active !== false,
      weight: toWeight(v?.weight),
      hours: toHours(v?.hours),
      tags: toTags(v?.tags),
    }))
    .filter((v) => {
      if (!v.name || v.phone.length < MIN_PHONE_DIGITS) return false;
      if (seenPhones.has(v.phone)) return false;
      seenPhones.add(v.phone);
      return true;
    });
};

const cleanTemplate = (value, fallback) =>
  String(value ?? "")
    .trim()
    .slice(0, MAX_MESSAGE_LENGTH) || fallback;

/**
 * Guarda solo las claves presentes en `payload` (vendors, message,
 * cartMessage). Así cada página escribe lo suyo sin pisar lo demás.
 * Red de seguridad del servidor: normaliza, valida y elimina duplicados.
 */
export const saveConfig = async (admin, payload) => {
  const saved = {};
  if ("vendors" in payload) saved.vendors = cleanVendorList(payload.vendors);
  if ("message" in payload) {
    saved.message = cleanTemplate(payload.message, DEFAULT_MESSAGE);
  }
  if ("cartMessage" in payload) {
    saved.cartMessage = cleanTemplate(payload.cartMessage, DEFAULT_CART_MESSAGE);
  }
  if (Object.keys(saved).length === 0) {
    return { ok: false, errors: [{ message: "Nada que guardar" }], saved };
  }

  const installResponse = await admin.graphql(
    `#graphql
      query {
        currentAppInstallation {
          id
        }
      }`,
  );
  const installId = (await installResponse.json()).data?.currentAppInstallation
    ?.id;
  if (!installId) {
    return {
      ok: false,
      errors: [{ message: "No se pudo identificar la instalación de la app" }],
      saved,
    };
  }

  const metafields = [];
  if (saved.vendors) {
    metafields.push({
      ownerId: installId,
      namespace: METAFIELD_NAMESPACE,
      key: VENDORS_KEY,
      type: "json",
      value: JSON.stringify(saved.vendors),
    });
  }
  if (saved.message) {
    metafields.push({
      ownerId: installId,
      namespace: METAFIELD_NAMESPACE,
      key: MESSAGE_KEY,
      type: "multi_line_text_field",
      value: saved.message,
    });
  }
  if (saved.cartMessage) {
    metafields.push({
      ownerId: installId,
      namespace: METAFIELD_NAMESPACE,
      key: CART_MESSAGE_KEY,
      type: "multi_line_text_field",
      value: saved.cartMessage,
    });
  }

  const response = await admin.graphql(
    `#graphql
      mutation saveWhatsappConfig($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
          }
          userErrors {
            field
            message
          }
        }
      }`,
    { variables: { metafields } },
  );
  const errors = (await response.json()).data?.metafieldsSet?.userErrors ?? [
    { message: "Respuesta inesperada de la API de Shopify" },
  ];

  return { ok: errors.length === 0, errors, saved };
};

/* -------------------------------------------------------------------- */
/* Enlaces directos al editor de temas                                   */
/* -------------------------------------------------------------------- */

/**
 * Shopify identifica los bloques en estos enlaces por el client_id de la app
 * (su documentación llama a este valor api_key) seguido del nombre del bloque.
 */
export const themeEditorLinks = (shop) => {
  // eslint-disable-next-line no-undef
  const apiKey = process.env.SHOPIFY_API_KEY;
  if (!apiKey) return null;
  const editor = `https://${shop}/admin/themes/current/editor`;
  return {
    addProductBlock: `${editor}?template=product&addAppBlockId=${apiKey}/${PRODUCT_BLOCK_HANDLE}&target=mainSection`,
    addCartBlock: `${editor}?template=cart&addAppBlockId=${apiKey}/${CART_BLOCK_HANDLE}&target=mainSection`,
    activateFloat: `${editor}?context=apps&activateAppId=${apiKey}/${FLOAT_BLOCK_HANDLE}`,
  };
};

/* -------------------------------------------------------------------- */
/* ¿Está el bloque colocado en el tema?                                  */
/* -------------------------------------------------------------------- */

// settings_data.json suele empezar con un comentario /* ... */ que no es JSON
const parseThemeJson = (text) => {
  try {
    return JSON.parse(String(text ?? "").replace(/\/\*[\s\S]*?\*\//g, ""));
  } catch {
    return null;
  }
};

/** Busca en cualquier nivel un bloque de la app con ese handle, no desactivado. */
const hasEnabledAppBlock = (root, handle) => {
  const marker = `/blocks/${handle}/`;
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (
      typeof node.type === "string" &&
      node.type.includes(marker) &&
      node.disabled !== true
    ) {
      return true;
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") stack.push(value);
    }
  }
  return false;
};

// En settings_data.json los embeds activos viven en `current` (objeto) o en
// el preset al que `current` apunta por nombre
const embedRoot = (settings) => {
  if (!settings) return null;
  if (settings.current && typeof settings.current === "object") {
    return settings.current;
  }
  return settings.presets?.[settings.current] ?? settings;
};

/**
 * Lee las plantillas de producto y carrito y los ajustes del tema publicado
 * (y de los temas de desarrollo, para poder probar antes de publicar) y
 * devuelve dónde está colocado cada bloque. Requiere el permiso read_themes;
 * si falla por cualquier motivo devuelve null y el panel no afirma nada.
 */
export const detectInstallation = async (admin) => {
  try {
    const response = await admin.graphql(
      `#graphql
        query whereIsTheBlock {
          themes(first: 5, roles: [MAIN, DEVELOPMENT]) {
            nodes {
              name
              role
              files(
                filenames: ["templates/product.json", "templates/cart.json", "config/settings_data.json"]
                first: 3
              ) {
                nodes {
                  filename
                  body {
                    ... on OnlineStoreThemeFileBodyText {
                      content
                    }
                  }
                }
              }
            }
          }
        }`,
    );
    const themes = (await response.json()).data?.themes?.nodes;
    if (!Array.isArray(themes) || themes.length === 0) return null;

    const status = {
      productBlock: null,
      cartBlock: null,
      floatEmbed: null,
      mainTheme: null,
    };
    // El tema publicado manda; los de desarrollo solo si el publicado no lo tiene
    const ordered = [...themes].sort((a) => (a.role === "MAIN" ? -1 : 1));

    for (const theme of ordered) {
      if (theme.role === "MAIN") status.mainTheme = theme.name;
      const files = Object.fromEntries(
        (theme.files?.nodes ?? []).map((f) => [f.filename, f.body?.content ?? ""]),
      );
      const productJson = parseThemeJson(files["templates/product.json"]);
      const cartJson = parseThemeJson(files["templates/cart.json"]);
      const settingsJson = parseThemeJson(files["config/settings_data.json"]);
      const where = { theme: theme.name, published: theme.role === "MAIN" };

      if (!status.productBlock && hasEnabledAppBlock(productJson, PRODUCT_BLOCK_HANDLE)) {
        status.productBlock = where;
      }
      if (!status.cartBlock && hasEnabledAppBlock(cartJson, CART_BLOCK_HANDLE)) {
        status.cartBlock = where;
      }
      if (!status.floatEmbed && hasEnabledAppBlock(embedRoot(settingsJson), FLOAT_BLOCK_HANDLE)) {
        status.floatEmbed = where;
      }
    }
    return status;
  } catch {
    return null;
  }
};
