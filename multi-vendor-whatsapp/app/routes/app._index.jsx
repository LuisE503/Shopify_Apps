import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// La configuración vive en app-data metafields para que la Theme App Extension
// la lea desde Liquid (app.metafields.whatsapp_router.*) sin tocar el backend.
const METAFIELD_NAMESPACE = "whatsapp_router";
const VENDORS_KEY = "vendors";
const MESSAGE_KEY = "message";
const CART_MESSAGE_KEY = "cart_message";
const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 40;
const SAVE_BAR_ID = "vendors-save-bar";
const MIN_PHONE_DIGITS = 8;
const MAX_MESSAGE_LENGTH = 500;
const MIN_WEIGHT = 1;
const MAX_WEIGHT = 5;
const WEIGHT_OPTIONS = [1, 2, 3, 4, 5];
const STATS_DAYS = 30;
const CHART_DAYS = 14;
const TOP_PRODUCTS = 5;
const TOP_VENDORS = 5;

// Prefijos telefónicos más habituales para el público de la app. Se elige el
// prefijo más largo que coincida, así "503" gana a "5" y "1809" a "1".
const COUNTRY_CODES = [
  ["1809", "República Dominicana"],
  ["1829", "República Dominicana"],
  ["1849", "República Dominicana"],
  ["1787", "Puerto Rico"],
  ["1939", "Puerto Rico"],
  ["1", "EE. UU. / Canadá"],
  ["34", "España"],
  ["351", "Portugal"],
  ["52", "México"],
  ["501", "Belice"],
  ["502", "Guatemala"],
  ["503", "El Salvador"],
  ["504", "Honduras"],
  ["505", "Nicaragua"],
  ["506", "Costa Rica"],
  ["507", "Panamá"],
  ["509", "Haití"],
  ["51", "Perú"],
  ["53", "Cuba"],
  ["54", "Argentina"],
  ["55", "Brasil"],
  ["56", "Chile"],
  ["57", "Colombia"],
  ["58", "Venezuela"],
  ["591", "Bolivia"],
  ["593", "Ecuador"],
  ["595", "Paraguay"],
  ["598", "Uruguay"],
  ["39", "Italia"],
  ["44", "Reino Unido"],
  ["49", "Alemania"],
  ["33", "Francia"],
];

// Las mismas plantillas recomendadas viven en los bloques Liquid de la extensión
const DEFAULT_MESSAGE =
  "Hola, me interesa este producto:\n{producto} - {precio}\nCantidad: {cantidad}\n{url}";
const DEFAULT_CART_MESSAGE =
  "Hola, quiero hacer este pedido:\n{pedido}\nTotal: {total}\n{url}";

const PRODUCT_PLACEHOLDERS = ["producto", "precio", "cantidad", "sku", "url"];
const CART_PLACEHOLDERS = ["pedido", "total", "cantidad", "url"];

// Ejemplo usado para previsualizar el mensaje y probar los números
const SAMPLE_PRODUCT = "Camiseta Azul (Talla M)";
const SAMPLE_PRICE = "$12.00";
const SAMPLE_QUANTITY = "2";
const SAMPLE_SKU = "CAM-AZ-M";
const SAMPLE_URL = "https://tu-tienda.com/products/camiseta-azul";
const SAMPLE_CART = {
  pedido: "- 2× Camiseta Azul (Talla M) — $24.00\n- 1× Gorra Negra — $15.00",
  total: "$39.00",
  cantidad: "3",
  url: "https://tu-tienda.com/cart/123:2,456:1",
};

// Nombres de archivo de los bloques en extensions/whatsapp-button/blocks/
const PRODUCT_BLOCK_HANDLE = "whatsapp_button";
const FLOAT_BLOCK_HANDLE = "whatsapp_float";
const CART_BLOCK_HANDLE = "whatsapp_cart";

// Lunes primero, como se lee un horario en LATAM. El valor coincide con
// Date.getDay() en JavaScript (0 = domingo), que es lo que usa el storefront.
const WEEK_DAYS = [
  { value: 1, label: "Lun" },
  { value: 2, label: "Mar" },
  { value: 3, label: "Mié" },
  { value: 4, label: "Jue" },
  { value: 5, label: "Vie" },
  { value: 6, label: "Sáb" },
  { value: 0, label: "Dom" },
];
const WEEKDAYS_ONLY = [1, 2, 3, 4, 5];
const INTL_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Configuración recomendada: activo, prioridad normal, disponible siempre
const DEFAULT_START = "08:00";
const DEFAULT_END = "18:00";
const RESET_MODAL_ID = "reset-config-modal";

const TIME_OPTIONS = (() => {
  const options = [];
  for (let hour = 0; hour < 24; hour += 1) {
    for (const minutes of ["00", "30"]) {
      options.push(`${String(hour).padStart(2, "0")}:${minutes}`);
    }
  }
  return options;
})();

const digitsOnly = (value) => String(value ?? "").replace(/\D/g, "");

// "El Salvador (+503)" bajo el campo del número: confirma al instante que el
// código de país es el correcto, el error más común al cargar vendedores
const countryHint = (phone) => {
  const digits = digitsOnly(phone);
  const generic = "Código de país + número";
  if (digits.length < 3) return generic;
  const match = COUNTRY_CODES.filter(([code]) => digits.startsWith(code)).sort(
    (a, b) => b[0].length - a[0].length,
  )[0];
  return match ? `${match[1]} (+${match[0]}) · ${generic.toLowerCase()}` : generic;
};

const initialsOf = (name) =>
  String(name ?? "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");

// Se aceptan separadores comunes al escribir: +503 6860-2600, (503) 686 02600.
// Cualquier otro carácter (letras, símbolos) se marca como error visible.
const ALLOWED_PHONE_CHARS = /^[\d\s+().-]*$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const renderMessage = (template, values) =>
  Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, value),
    String(template ?? ""),
  );

// Horario guardado -> horario normalizado (null = disponible siempre)
const toHours = (hours) => {
  if (!hours || typeof hours !== "object") return null;
  const start = TIME_PATTERN.test(hours.start) ? hours.start : null;
  const end = TIME_PATTERN.test(hours.end) ? hours.end : null;
  if (!start || !end) return null;
  const days = Array.isArray(hours.days)
    ? hours.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    : [];
  if (days.length === 0) return null;
  return { start, end, days };
};

// Peso del reparto: cuántas veces entra este vendedor en cada vuelta
const toWeight = (value) => {
  const weight = Number.parseInt(value, 10);
  if (!Number.isFinite(weight)) return 1;
  return Math.min(Math.max(weight, MIN_WEIGHT), MAX_WEIGHT);
};

// Etiquetas de producto que atiende un vendedor (vacío = todos los productos).
// Acepta un array o texto separado por comas; normaliza a minúsculas sin repetir.
const toTags = (value) => {
  const list = Array.isArray(value) ? value : String(value ?? "").split(",");
  const seen = new Set();
  const tags = [];
  for (const raw of list) {
    const tag = String(raw ?? "").trim().toLowerCase().slice(0, MAX_TAG_LENGTH);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
};

// Normaliza un vendedor venido de la API (campos ausentes = valores por defecto)
const toVendor = (v) => ({
  name: String(v?.name ?? ""),
  phone: String(v?.phone ?? ""),
  active: v?.active !== false,
  weight: toWeight(v?.weight),
  hours: toHours(v?.hours),
  tags: toTags(v?.tags),
});

// Contador módulo-level: garantiza ids de fila únicos y estables para React.
// El campo `saved` guarda lo que está en Shopify para marcar qué fila cambió.
let rowIdCounter = 0;
const makeRows = (list) =>
  (list.length > 0 ? list : [{ name: "", phone: "", active: true }]).map(
    (v) => {
      const hours = toHours(v.hours);
      return {
        id: ++rowIdCounter,
        name: v.name ?? "",
        phone: v.phone ?? "",
        active: v.active !== false,
        weight: toWeight(v.weight),
        scheduled: Boolean(hours),
        start: hours ? hours.start : DEFAULT_START,
        end: hours ? hours.end : DEFAULT_END,
        days: hours ? hours.days : WEEKDAYS_ONLY,
        tags: toTags(v.tags).join(", "),
        // Solo interfaz: las opciones avanzadas se muestran abiertas cuando
        // el vendedor ya tiene algo configurado en ellas
        expanded:
          Boolean(hours) || toWeight(v.weight) !== 1 || toTags(v.tags).length > 0,
        saved: JSON.stringify([
          v.name ?? "",
          v.phone ?? "",
          v.active !== false,
          toWeight(v.weight),
          hours,
          toTags(v.tags),
        ]),
      };
    },
  );

// Lo que se guardaría de esta fila, en el mismo formato que `saved`
const rowSignature = (row) =>
  JSON.stringify([
    row.name.trim(),
    row.phone.trim(),
    row.active,
    toWeight(row.weight),
    row.scheduled
      ? toHours({ start: row.start, end: row.end, days: row.days })
      : null,
    toTags(row.tags),
  ]);

const isRowDirty = (row) => rowSignature(row) !== row.saved;

// ¿Este vendedor se aleja de la configuración recomendada?
const isRowCustomized = (row) =>
  !row.active ||
  toWeight(row.weight) !== 1 ||
  row.scheduled ||
  toTags(row.tags).length > 0;

// Vuelve a lo recomendado sin tocar nombre ni número
const resetRowConfig = (row) => ({
  ...row,
  active: true,
  weight: 1,
  scheduled: false,
  start: DEFAULT_START,
  end: DEFAULT_END,
  days: WEEKDAYS_ONLY,
  tags: "",
});

const moveItem = (list, from, to) => {
  if (from < 0 || to < 0 || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
};

const formatPrice = (amount, currencyCode) => {
  try {
    return new Intl.NumberFormat("es", {
      style: "currency",
      currency: currencyCode,
    }).format(Number(amount));
  } catch {
    return String(amount);
  }
};

// Firma de lo visible en pantalla, ignorando filas totalmente vacías
const visibleSignature = (rows) =>
  JSON.stringify(
    rows
      .filter((r) => r.name.trim() || r.phone.trim())
      .map((r) => rowSignature(r)),
  );

const savedSignature = (saved) =>
  JSON.stringify(
    saved.map((v) =>
      JSON.stringify([
        v.name,
        v.phone,
        v.active,
        toWeight(v.weight),
        toHours(v.hours),
        toTags(v.tags),
      ]),
    ),
  );

const describeSchedule = (row) => {
  if (!row.scheduled) return "Disponible siempre";
  const labels = WEEK_DAYS.filter((d) => row.days.includes(d.value)).map(
    (d) => d.label,
  );
  if (labels.length === 0) return "Sin días seleccionados";
  const crossesMidnight = row.start > row.end;
  return `${labels.join(", ")} · ${row.start}–${row.end}${crossesMidnight ? " (del día siguiente)" : ""}`;
};

/* -------------------------------------------------------------------- */
/* Hora de la tienda y turnos (misma lógica que el storefront)           */
/* -------------------------------------------------------------------- */

/** Día y minutos actuales en el huso horario de la tienda. */
const shopClock = (timeZone) => {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date());
    const read = (type) => parts.find((p) => p.type === type)?.value;
    const day = INTL_WEEKDAYS.indexOf(read("weekday"));
    const hour = Number(read("hour")) % 24;
    const minute = Number(read("minute"));
    if (day < 0 || Number.isNaN(hour) || Number.isNaN(minute)) return null;
    return { day, minutes: hour * 60 + minute };
  } catch {
    return null;
  }
};

const toMinutes = (time) => {
  const [h, m] = String(time).split(":").map(Number);
  return h * 60 + m;
};

const isOnDuty = (hours, clock) => {
  if (!hours || !clock) return true;
  const start = toMinutes(hours.start);
  const end = toMinutes(hours.end);
  if (start === end) return true;
  const inDays = (day) => hours.days.length === 0 || hours.days.includes(day);

  if (start < end) {
    return inDays(clock.day) && clock.minutes >= start && clock.minutes < end;
  }
  // Turno nocturno que cruza la medianoche
  if (clock.minutes >= start) return inDays(clock.day);
  return clock.minutes < end && inDays((clock.day + 6) % 7);
};

const formatClock = (clock) =>
  clock
    ? `${String(Math.floor(clock.minutes / 60)).padStart(2, "0")}:${String(clock.minutes % 60).padStart(2, "0")}`
    : null;

/* -------------------------------------------------------------------- */
/* Estadísticas                                                          */
/* -------------------------------------------------------------------- */

const relativeTime = (isoDate) => {
  if (!isoDate) return null;
  const minutes = Math.max(
    0,
    Math.round((Date.now() - new Date(isoDate).getTime()) / 60000),
  );
  if (minutes < 1) return "hace un momento";
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.round(hours / 24);
  return `hace ${days} día${days === 1 ? "" : "s"}`;
};

// Fecha "YYYY-MM-DD" y etiqueta corta ("lun 4") en la zona horaria de la tienda:
// un clic a las 23:30 en El Salvador es de ese día, no del siguiente en UTC
const dayKey = (date, timeZone) => {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone ?? undefined,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
};

const dayLabel = (date, timeZone) => {
  try {
    return new Intl.DateTimeFormat("es", {
      timeZone: timeZone ?? undefined,
      weekday: "short",
      day: "numeric",
    }).format(date);
  } catch {
    return date.toISOString().slice(5, 10);
  }
};

/**
 * Clics de los últimos 30 días: por vendedor, los productos más pedidos y
 * la serie diaria de las últimas dos semanas para la gráfica.
 */
const loadClickStats = async (shop, timeZone) => {
  const dayMs = 24 * 60 * 60 * 1000;
  const since = new Date(Date.now() - STATS_DAYS * dayMs);
  const chartSince = new Date(Date.now() - CHART_DAYS * dayMs);
  const empty = { byPhone: {}, topProducts: [], byDay: [], total: 0 };

  try {
    const [byVendor, byProduct, recent] = await Promise.all([
      db.vendorClick.groupBy({
        by: ["vendorPhone"],
        where: { shop, createdAt: { gte: since } },
        _count: { _all: true },
        _max: { createdAt: true },
      }),
      db.vendorClick.groupBy({
        by: ["productTitle"],
        where: { shop, createdAt: { gte: since }, productTitle: { not: null } },
        _count: { _all: true },
        orderBy: { _count: { productTitle: "desc" } },
        take: TOP_PRODUCTS,
      }),
      db.vendorClick.findMany({
        where: { shop, createdAt: { gte: chartSince } },
        select: { createdAt: true },
      }),
    ]);

    const byPhone = {};
    let total = 0;
    for (const row of byVendor) {
      byPhone[row.vendorPhone] = {
        count: row._count._all,
        lastClickAt: row._max.createdAt?.toISOString() ?? null,
      };
      total += row._count._all;
    }

    const countsByDay = new Map();
    for (const row of recent) {
      const key = dayKey(row.createdAt, timeZone);
      countsByDay.set(key, (countsByDay.get(key) ?? 0) + 1);
    }
    const byDay = [];
    for (let i = CHART_DAYS - 1; i >= 0; i -= 1) {
      const date = new Date(Date.now() - i * dayMs);
      const key = dayKey(date, timeZone);
      byDay.push({ key, label: dayLabel(date, timeZone), count: countsByDay.get(key) ?? 0 });
    }

    return {
      byPhone,
      total,
      byDay,
      topProducts: byProduct.map((row) => ({
        title: row.productTitle,
        count: row._count._all,
      })),
    };
  } catch {
    // Las estadísticas son un extra: si fallan, el panel debe seguir abriendo
    return empty;
  }
};

/* -------------------------------------------------------------------- */
/* Enlaces directos al editor de temas                                   */
/* -------------------------------------------------------------------- */

/**
 * Shopify identifica los bloques en estos enlaces por el client_id de la app
 * (su documentación llama a este valor api_key) seguido del nombre del bloque.
 */
const themeEditorLinks = (shop) => {
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
 * Lee la plantilla de producto y los ajustes del tema publicado (y de los
 * temas de desarrollo, para poder probar antes de publicar) y devuelve dónde
 * está colocado cada bloque. Requiere el permiso read_themes; si falla por
 * cualquier motivo devuelve null y el panel simplemente no muestra el estado.
 */
const detectInstallation = async (admin) => {
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

      if (
        !status.productBlock &&
        hasEnabledAppBlock(productJson, PRODUCT_BLOCK_HANDLE)
      ) {
        status.productBlock = { theme: theme.name, published: theme.role === "MAIN" };
      }
      if (!status.cartBlock && hasEnabledAppBlock(cartJson, CART_BLOCK_HANDLE)) {
        status.cartBlock = { theme: theme.name, published: theme.role === "MAIN" };
      }
      if (
        !status.floatEmbed &&
        hasEnabledAppBlock(embedRoot(settingsJson), FLOAT_BLOCK_HANDLE)
      ) {
        status.floatEmbed = { theme: theme.name, published: theme.role === "MAIN" };
      }
    }
    return status;
  } catch {
    return null;
  }
};

/* -------------------------------------------------------------------- */
/* Loader y action                                                       */
/* -------------------------------------------------------------------- */

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  const [install, response] = await Promise.all([
    detectInstallation(admin),
    admin.graphql(
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
    ),
  ]);
  const responseJson = await response.json();
  const installation = responseJson.data?.currentAppInstallation;
  const storedVendors = installation?.vendors?.jsonValue;
  const timeZone = responseJson.data?.shop?.ianaTimezone ?? null;
  const currencyCode = responseJson.data?.shop?.currencyCode ?? "USD";

  // Después del GraphQL: la serie diaria se agrupa en la zona horaria de la tienda
  const stats = await loadClickStats(session.shop, timeZone);

  return {
    shop: session.shop,
    vendors: Array.isArray(storedVendors) ? storedVendors.map(toVendor) : [],
    message: installation?.message?.value || DEFAULT_MESSAGE,
    cartMessage: installation?.cartMessage?.value || DEFAULT_CART_MESSAGE,
    stats,
    timeZone,
    currencyCode,
    clock: shopClock(timeZone),
    editorLinks: themeEditorLinks(session.shop),
    install,
  };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();

  let payload;
  try {
    payload = JSON.parse(formData.get("payload"));
  } catch {
    return { ok: false, errors: [{ message: "Datos inválidos" }] };
  }

  // Red de seguridad del servidor: normaliza, valida y elimina duplicados.
  // La validación principal (con mensajes por campo) ocurre en el cliente.
  const seenPhones = new Set();
  const cleanVendors = (Array.isArray(payload?.vendors) ? payload.vendors : [])
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

  const cleanMessage =
    String(payload?.message ?? "")
      .trim()
      .slice(0, MAX_MESSAGE_LENGTH) || DEFAULT_MESSAGE;
  const cleanCartMessage =
    String(payload?.cartMessage ?? "")
      .trim()
      .slice(0, MAX_MESSAGE_LENGTH) || DEFAULT_CART_MESSAGE;

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
    };
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
    {
      variables: {
        metafields: [
          {
            ownerId: installId,
            namespace: METAFIELD_NAMESPACE,
            key: VENDORS_KEY,
            type: "json",
            value: JSON.stringify(cleanVendors),
          },
          {
            ownerId: installId,
            namespace: METAFIELD_NAMESPACE,
            key: MESSAGE_KEY,
            type: "multi_line_text_field",
            value: cleanMessage,
          },
          {
            ownerId: installId,
            namespace: METAFIELD_NAMESPACE,
            key: CART_MESSAGE_KEY,
            type: "multi_line_text_field",
            value: cleanCartMessage,
          },
        ],
      },
    },
  );
  const responseJson = await response.json();
  const errors = responseJson.data?.metafieldsSet?.userErrors ?? [
    { message: "Respuesta inesperada de la API de Shopify" },
  ];

  return {
    ok: errors.length === 0,
    errors,
    saved: {
      vendors: cleanVendors,
      message: cleanMessage,
      cartMessage: cleanCartMessage,
    },
  };
};

/* -------------------------------------------------------------------- */
/* Componentes                                                           */
/* -------------------------------------------------------------------- */

/**
 * Tarjeta de un vendedor.
 *
 * Lo esencial (nombre, número, activo) siempre a la vista; prioridad y
 * horario quedan en "Opciones", que se abre sola si ya hay algo configurado.
 *
 * @param row            fila del estado local (ver makeRows)
 * @param index / count  posición en la lista, para los botones de orden
 * @param errors         errores de esta fila: { name, phone, hours, days }
 * @param previewMessage mensaje de ejemplo para el enlace de prueba
 * @param stats          { count, lastClickAt } de este número, si hay clics
 * @param share          fracción de la rotación que le corresponde (0-1)
 * @param onDuty         true/false si tiene horario, null si no
 * @param onChange       (id, campo, valor) => void
 * @param onMove         (id, -1 | 1) => void
 * @param onReset        (id) => void — vuelve a la configuración recomendada
 * @param onRemove       (id) => void
 */
/* eslint-disable react/prop-types -- el proyecto es JavaScript y no usa
   prop-types en ninguna ruta; los props quedan documentados arriba */
function VendorRow({
  row,
  index,
  count,
  errors,
  previewMessage,
  stats,
  share,
  onDuty,
  onChange,
  onMove,
  onReset,
  onRemove,
}) {
  const phoneDigits = digitsOnly(row.phone);
  const canTest = !errors.phone && phoneDigits.length >= MIN_PHONE_DIGITS;
  const testUrl = `https://wa.me/${phoneDigits}?text=${encodeURIComponent(previewMessage)}`;
  const sharePercent = Math.round(share * 100);
  const customized = isRowCustomized(row);

  // Resumen de lo configurado cuando las opciones están plegadas
  const rowTags = toTags(row.tags);
  const summary = [
    toWeight(row.weight) !== 1 ? `Prioridad ${toWeight(row.weight)}×` : null,
    row.scheduled ? describeSchedule(row) : null,
    rowTags.length > 0 ? `Solo: ${rowTags.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const toggleDay = (day) => {
    const days = row.days.includes(day)
      ? row.days.filter((d) => d !== day)
      : [...row.days, day].sort((a, b) => a - b);
    onChange(row.id, "days", days);
  };

  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="base">
        <s-grid gridTemplateColumns="1fr 1fr" gap="base">
          <s-text-field
            label="Nombre"
            placeholder="Ej: María"
            value={row.name}
            {...(errors.name ? { error: errors.name } : {})}
            onInput={(e) => onChange(row.id, "name", e.currentTarget.value)}
          ></s-text-field>
          <s-text-field
            label="Número de WhatsApp"
            placeholder="Ej: 50371234567"
            details={countryHint(row.phone)}
            value={row.phone}
            {...(errors.phone ? { error: errors.phone } : {})}
            onInput={(e) => onChange(row.id, "phone", e.currentTarget.value)}
          ></s-text-field>
        </s-grid>

        <s-stack direction="inline" gap="base" alignItems="center">
          {row.name.trim() && (
            <s-avatar
              initials={initialsOf(row.name)}
              alt={row.name}
              size="small"
            ></s-avatar>
          )}
          <s-switch
            label="Activo"
            checked={row.active}
            onChange={(e) => onChange(row.id, "active", e.currentTarget.checked)}
          ></s-switch>
          {row.active && row.scheduled && onDuty !== null && (
            <s-badge tone={onDuty ? "success" : "auto"}>
              {onDuty ? "En turno ahora" : "Fuera de turno"}
            </s-badge>
          )}
          {!row.expanded && summary && <s-badge tone="info">{summary}</s-badge>}
          {stats && (
            <s-badge tone="info">
              {`${stats.count} clic(s) · ${relativeTime(stats.lastClickAt)}`}
            </s-badge>
          )}
          {isRowDirty(row) && <s-badge tone="warning">Sin guardar</s-badge>}
          <s-button
            variant="tertiary"
            icon={row.expanded ? "chevron-up" : "chevron-down"}
            onClick={() => onChange(row.id, "expanded", !row.expanded)}
          >
            {row.expanded ? "Ocultar opciones" : "Opciones"}
          </s-button>
          {canTest && (
            <s-button variant="tertiary" href={testUrl} target="_blank">
              Probar en WhatsApp
            </s-button>
          )}
          <s-button
            icon="arrow-up"
            variant="tertiary"
            accessibilityLabel="Subir en la lista"
            {...(index === 0 ? { disabled: true } : {})}
            onClick={() => onMove(row.id, -1)}
          ></s-button>
          <s-button
            icon="arrow-down"
            variant="tertiary"
            accessibilityLabel="Bajar en la lista"
            {...(index === count - 1 ? { disabled: true } : {})}
            onClick={() => onMove(row.id, 1)}
          ></s-button>
          <s-button
            icon="delete"
            variant="tertiary"
            tone="critical"
            accessibilityLabel={`Eliminar vendedor ${row.name || "sin nombre"}`}
            onClick={() => onRemove(row.id)}
          ></s-button>
        </s-stack>

        {row.expanded && (
          <s-box padding="base" background="subdued" borderRadius="base">
            <s-stack direction="block" gap="base">
              <s-grid gridTemplateColumns="1fr 1fr" gap="base" alignItems="end">
                <s-select
                  label="Prioridad"
                  details={
                    row.active && sharePercent > 0
                      ? `≈ ${sharePercent}% de la rotación`
                      : "Turnos por vuelta"
                  }
                  value={String(row.weight)}
                  onChange={(e) =>
                    onChange(row.id, "weight", Number(e.currentTarget.value))
                  }
                >
                  {WEIGHT_OPTIONS.map((weight) => (
                    <s-option key={weight} value={String(weight)}>
                      {weight === 1 ? "1 (normal)" : `${weight}×`}
                    </s-option>
                  ))}
                </s-select>
                <s-switch
                  label="Horario de atención"
                  details="Solo recibe clics en sus días y horas"
                  checked={row.scheduled}
                  onChange={(e) =>
                    onChange(row.id, "scheduled", e.currentTarget.checked)
                  }
                ></s-switch>
              </s-grid>

              {row.scheduled && (
                <s-stack direction="block" gap="base">
                  <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                    <s-select
                      label="Desde"
                      value={row.start}
                      onChange={(e) =>
                        onChange(row.id, "start", e.currentTarget.value)
                      }
                    >
                      {TIME_OPTIONS.map((time) => (
                        <s-option key={time} value={time}>
                          {time}
                        </s-option>
                      ))}
                    </s-select>
                    <s-select
                      label="Hasta"
                      value={row.end}
                      {...(errors.hours ? { error: errors.hours } : {})}
                      onChange={(e) =>
                        onChange(row.id, "end", e.currentTarget.value)
                      }
                    >
                      {TIME_OPTIONS.map((time) => (
                        <s-option key={time} value={time}>
                          {time}
                        </s-option>
                      ))}
                    </s-select>
                  </s-grid>

                  <s-stack direction="inline" gap="base" alignItems="center">
                    {WEEK_DAYS.map((day) => (
                      <s-checkbox
                        key={day.value}
                        label={day.label}
                        checked={row.days.includes(day.value)}
                        onChange={() => toggleDay(day.value)}
                      ></s-checkbox>
                    ))}
                  </s-stack>

                  {errors.days && (
                    <s-text tone="critical">{errors.days}</s-text>
                  )}
                  <s-text tone="neutral">{describeSchedule(row)}</s-text>
                </s-stack>
              )}

              <s-text-field
                label="Solo atiende productos con estas etiquetas"
                placeholder="Ej: electrónica, mayoreo"
                details="Separadas por coma. Vacío = atiende todos los productos. Si un producto lleva la etiqueta de un especialista, solo él recibe ese clic."
                value={row.tags}
                onInput={(e) => onChange(row.id, "tags", e.currentTarget.value)}
              ></s-text-field>

              {customized && (
                <s-stack direction="inline" gap="base">
                  <s-button
                    variant="tertiary"
                    icon="undo"
                    onClick={() => onReset(row.id)}
                  >
                    Restablecer a lo recomendado
                  </s-button>
                </s-stack>
              )}
            </s-stack>
          </s-box>
        )}
      </s-stack>
    </s-box>
  );
}

/**
 * Guía de puesta en marcha con enlaces que abren el editor de temas con el
 * bloque ya seleccionado, y comprobación automática de si ya está colocado.
 * Es lo que más dudas genera al instalar la app ("no veo el botón").
 *
 * @param hasVendors   ya hay al menos un vendedor activo guardado
 * @param links        { addProductBlock, activateFloat } o null
 * @param storefront   URL de la tienda para probar
 * @param install      resultado de detectInstallation, o null si no se pudo leer
 * @param onRefresh    vuelve a comprobar el tema
 * @param refreshing   true mientras se comprueba
 */
function SetupGuide({
  hasVendors,
  links,
  storefront,
  install,
  onRefresh,
  refreshing,
}) {
  // Sin datos del tema no se afirma nada: mejor callar que equivocarse
  const placement = (found) => {
    if (!install) return null;
    if (!found) return <s-badge tone="warning">Pendiente</s-badge>;
    return (
      <s-badge tone="success">
        {found.published
          ? `Instalado en «${found.theme}»`
          : `Instalado en «${found.theme}» (tema no publicado)`}
      </s-badge>
    );
  };

  const allDone =
    hasVendors && Boolean(install?.productBlock) && Boolean(install?.floatEmbed);

  // Con todo hecho, la guía se aparta: una línea y un enlace para volver a verla
  const [showStepsAnyway, setShowStepsAnyway] = useState(false);

  if (allDone && !showStepsAnyway) {
    return (
      <s-section heading="Puesta en marcha">
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-badge tone="success">Todo listo</s-badge>
          <s-text>
            Vendedores guardados y botones colocados en tu tema. Tus clientes
            ya pueden escribirte.
          </s-text>
          <s-button variant="tertiary" onClick={() => setShowStepsAnyway(true)}>
            Ver los pasos
          </s-button>
        </s-stack>
      </s-section>
    );
  }

  return (
    <s-section heading="Puesta en marcha">
      <s-stack direction="block" gap="base">
        {allDone && (
          <s-banner heading="Todo listo" tone="success">
            Vendedores guardados y botones colocados en tu tema. Tus clientes ya
            pueden escribirte.
          </s-banner>
        )}

        <s-stack direction="inline" gap="base" alignItems="center">
          <s-badge tone={hasVendors ? "success" : "warning"}>1</s-badge>
          <s-text>
            {hasVendors
              ? "Vendedores guardados."
              : "Guarda al menos un vendedor activo (abajo)."}
          </s-text>
        </s-stack>

        <s-stack direction="inline" gap="base" alignItems="center">
          <s-badge tone={install?.productBlock ? "success" : "info"}>2</s-badge>
          <s-text>Coloca el botón en la página de producto.</s-text>
          {placement(install?.productBlock)}
          {links && !install?.productBlock && (
            <s-button
              variant="secondary"
              href={links.addProductBlock}
              target="_blank"
            >
              Abrir el editor con el bloque
            </s-button>
          )}
        </s-stack>

        <s-stack direction="inline" gap="base" alignItems="center">
          <s-badge tone={install?.floatEmbed ? "success" : "info"}>3</s-badge>
          <s-text>Opcional: activa el botón flotante en toda la tienda.</s-text>
          {placement(install?.floatEmbed)}
          {links && !install?.floatEmbed && (
            <s-button
              variant="secondary"
              href={links.activateFloat}
              target="_blank"
            >
              Activar botón flotante
            </s-button>
          )}
        </s-stack>

        <s-stack direction="inline" gap="base" alignItems="center">
          <s-badge tone={install?.cartBlock ? "success" : "info"}>4</s-badge>
          <s-text>
            Opcional: botón de pedido en la página del carrito (envía todos los
            productos de una vez).
          </s-text>
          {placement(install?.cartBlock)}
          {links && !install?.cartBlock && (
            <s-button
              variant="secondary"
              href={links.addCartBlock}
              target="_blank"
            >
              Abrir el editor con el bloque
            </s-button>
          )}
        </s-stack>

        <s-stack direction="inline" gap="base" alignItems="center">
          <s-badge tone="info">5</s-badge>
          <s-text>Pruébalo en tu tienda como lo vería un cliente.</s-text>
          <s-button variant="tertiary" href={storefront} target="_blank">
            Ver mi tienda
          </s-button>
        </s-stack>

        <s-stack direction="inline" gap="base" alignItems="center">
          <s-button
            variant="tertiary"
            icon="refresh"
            onClick={onRefresh}
            {...(refreshing ? { loading: true } : {})}
          >
            Volver a comprobar
          </s-button>
          <s-text tone="neutral">
            {install
              ? "Recuerda pulsar Guardar en el editor de temas: sin guardar, el bloque no queda colocado."
              : "En el editor de temas: página de producto → Agregar bloque → Aplicaciones → Botón de WhatsApp. El flotante está en Incrustaciones de aplicación."}
          </s-text>
        </s-stack>
      </s-stack>
    </s-section>
  );
}

// Un solo indicador (clics): una sola tonalidad; el gris marca los días sin clics
const BAR_COLOR = "#1a7f5a";
const BAR_EMPTY = "#e3e5e7";
const CHART_HEIGHT = 72;

/**
 * Actividad de los últimos 30 días: gráfica diaria de dos semanas, reparto
 * real entre vendedores y productos más consultados.
 *
 * @param stats    { total, byDay, byPhone, topProducts }
 * @param vendors  vendedores guardados, para mostrar nombres en vez de números
 */
function ActivitySection({ stats, vendors }) {
  if (stats.total === 0) {
    return (
      <s-section slot="aside" heading={`Actividad (${STATS_DAYS} días)`}>
        <s-text tone="neutral">
          Aún no hay clics registrados. Aparecerán aquí en cuanto un cliente
          pulse el botón en tu tienda.
        </s-text>
      </s-section>
    );
  }

  const byDay = stats.byDay ?? [];
  const maxDay = Math.max(1, ...byDay.map((d) => d.count));
  const chartTotal = byDay.reduce((sum, d) => sum + d.count, 0);

  const nameByPhone = new Map(vendors.map((v) => [v.phone, v.name]));
  const perVendor = Object.entries(stats.byPhone)
    .map(([phone, info]) => ({
      phone,
      name: nameByPhone.get(phone) ?? `+${phone}`,
      count: info.count,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_VENDORS);
  const maxVendor = Math.max(1, ...perVendor.map((v) => v.count));

  return (
    <s-section slot="aside" heading={`Actividad (${STATS_DAYS} días)`}>
      <s-stack direction="block" gap="base">
        <s-text>
          <s-text type="strong">{stats.total}</s-text> clic(s) en total.
        </s-text>

        {byDay.length > 0 && (
          <s-stack direction="block" gap="small-300">
            <s-text type="strong">{`Últimos ${CHART_DAYS} días`}</s-text>
            <div
              role="img"
              aria-label={`${chartTotal} clic(s) en los últimos ${CHART_DAYS} días`}
              style={{
                display: "flex",
                alignItems: "flex-end",
                gap: "3px",
                height: `${CHART_HEIGHT}px`,
              }}
            >
              {byDay.map((day) => (
                <div
                  key={day.key}
                  title={`${day.label}: ${day.count} clic(s)`}
                  style={{
                    flex: 1,
                    display: "flex",
                    alignItems: "flex-end",
                    height: "100%",
                  }}
                >
                  <div
                    style={{
                      width: "100%",
                      height: `${
                        day.count > 0
                          ? Math.max(6, Math.round((day.count / maxDay) * CHART_HEIGHT))
                          : 2
                      }px`,
                      background: day.count > 0 ? BAR_COLOR : BAR_EMPTY,
                      borderRadius: "3px 3px 0 0",
                    }}
                  />
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: "3px" }}>
              {byDay.map((day, index) => (
                <div
                  key={day.key}
                  style={{
                    flex: 1,
                    textAlign: "center",
                    fontSize: "11px",
                    color: "#6b7280",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                  }}
                >
                  {index % 2 === 0 ? day.label : ""}
                </div>
              ))}
            </div>
            <details>
              <summary style={{ cursor: "pointer", fontSize: "12px", color: "#6b7280" }}>
                Ver como tabla
              </summary>
              <table style={{ width: "100%", fontSize: "12px", borderCollapse: "collapse" }}>
                <tbody>
                  {byDay.map((day) => (
                    <tr key={day.key}>
                      <td style={{ padding: "2px 0" }}>{day.label}</td>
                      <td style={{ textAlign: "right" }}>{day.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </s-stack>
        )}

        {perVendor.length > 0 && (
          <s-stack direction="block" gap="small-300">
            <s-text type="strong">Reparto entre vendedores</s-text>
            {perVendor.map((vendor) => (
              <div
                key={vendor.phone}
                style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "2px 8px" }}
              >
                <s-text>{vendor.name}</s-text>
                <s-text tone="neutral">
                  {`${vendor.count} · ${Math.round((vendor.count / stats.total) * 100)}%`}
                </s-text>
                <div
                  style={{
                    gridColumn: "1 / -1",
                    height: "6px",
                    background: BAR_EMPTY,
                    borderRadius: "3px",
                  }}
                >
                  <div
                    style={{
                      width: `${Math.round((vendor.count / maxVendor) * 100)}%`,
                      height: "100%",
                      background: BAR_COLOR,
                      borderRadius: "3px",
                    }}
                  />
                </div>
              </div>
            ))}
          </s-stack>
        )}

        {stats.topProducts.length > 0 && (
          <s-stack direction="block" gap="small-300">
            <s-text type="strong">Productos más consultados</s-text>
            <s-ordered-list>
              {stats.topProducts.map((product) => (
                <s-list-item key={product.title}>
                  {product.title} · {product.count}
                </s-list-item>
              ))}
            </s-ordered-list>
          </s-stack>
        )}
      </s-stack>
    </s-section>
  );
}
/* eslint-enable react/prop-types */

export default function Index() {
  const {
    shop,
    vendors: vendorsOnLoad,
    message: messageOnLoad,
    cartMessage: cartMessageOnLoad,
    stats,
    timeZone,
    currencyCode,
    clock,
    editorLinks,
    install,
  } = useLoaderData();
  const fetcher = useFetcher();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();

  // `saved*` refleja lo que está en Shopify; `rows`/`message` lo que se edita
  const [saved, setSaved] = useState(vendorsOnLoad);
  const [savedMessage, setSavedMessage] = useState(messageOnLoad);
  const [rows, setRows] = useState(() => makeRows(vendorsOnLoad));
  const [message, setMessage] = useState(messageOnLoad);
  const [savedCartMessage, setSavedCartMessage] = useState(cartMessageOnLoad);
  const [cartMessage, setCartMessage] = useState(cartMessageOnLoad);

  // Producto real elegido para la vista previa (null = ejemplo genérico)
  const [previewProduct, setPreviewProduct] = useState(null);
  // Guardar con Ctrl+S: el atajo necesita la versión más reciente de handleSave
  const saveRef = useRef(null);

  const isSaving =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";

  // Valida cada fila con contenido; las filas totalmente vacías se ignoran
  const validation = useMemo(() => {
    const filledRows = rows.filter((r) => r.name.trim() || r.phone.trim());
    const seenPhones = new Set();
    const errors = new Map();

    for (const row of filledRows) {
      const rawPhone = row.phone.trim();
      const phone = digitsOnly(rawPhone);
      const rowErrors = {};

      if (!row.name.trim()) {
        rowErrors.name = "Escribe un nombre";
      }

      if (!ALLOWED_PHONE_CHARS.test(rawPhone)) {
        rowErrors.phone = "Solo se permiten números. Ejemplo: 50368602600";
      } else if (phone.length < MIN_PHONE_DIGITS) {
        rowErrors.phone = `Mínimo ${MIN_PHONE_DIGITS} dígitos, incluye el código de país`;
      } else if (seenPhones.has(phone)) {
        rowErrors.phone = "Este número ya está en la lista";
      }
      seenPhones.add(phone);

      if (row.scheduled) {
        if (row.days.length === 0) {
          rowErrors.days = "Selecciona al menos un día";
        }
        if (row.start === row.end) {
          rowErrors.hours = "La hora de inicio y fin no pueden ser iguales";
        }
      }

      if (Object.keys(rowErrors).length > 0) {
        errors.set(row.id, rowErrors);
      }
    }

    const messageError = !message.trim()
      ? "Escribe el mensaje que recibirá tu vendedor"
      : null;
    const cartMessageError = !cartMessage.trim()
      ? "Escribe el mensaje del pedido"
      : null;

    const vendors = filledRows.map((r) => ({
      name: r.name.trim(),
      phone: digitsOnly(r.phone),
      active: r.active,
      weight: toWeight(r.weight),
      hours: r.scheduled
        ? { start: r.start, end: r.end, days: r.days }
        : null,
      tags: toTags(r.tags),
    }));

    return {
      errors,
      messageError,
      cartMessageError,
      vendors,
      hasErrors:
        errors.size > 0 || Boolean(messageError) || Boolean(cartMessageError),
    };
  }, [rows, message, cartMessage]);

  // "Hay cambios" = lo que se ve en pantalla difiere de lo guardado en Shopify
  const isDirty = useMemo(
    () =>
      visibleSignature(rows) !== savedSignature(saved) ||
      message.trim() !== savedMessage ||
      cartMessage.trim() !== savedCartMessage,
    [rows, saved, message, savedMessage, cartMessage, savedCartMessage],
  );

  const previewMessage = useMemo(
    () =>
      renderMessage(message, {
        producto: previewProduct?.title ?? SAMPLE_PRODUCT,
        precio: previewProduct?.price ?? SAMPLE_PRICE,
        cantidad: SAMPLE_QUANTITY,
        sku: previewProduct?.sku ?? SAMPLE_SKU,
        url: previewProduct?.url ?? SAMPLE_URL,
      }),
    [message, previewProduct],
  );

  const previewCartMessage = useMemo(
    () => renderMessage(cartMessage, SAMPLE_CART),
    [cartMessage],
  );

  // ¿Algo se aleja de la configuración recomendada? (solo filas con contenido)
  const isCustomized =
    rows.some((r) => (r.name.trim() || r.phone.trim()) && isRowCustomized(r)) ||
    message.trim() !== DEFAULT_MESSAGE ||
    cartMessage.trim() !== DEFAULT_CART_MESSAGE;

  // Reparto teórico entre los activos, según la prioridad de cada uno
  const totalWeight = rows
    .filter((r) => r.active && (r.name.trim() || r.phone.trim()))
    .reduce((sum, r) => sum + toWeight(r.weight), 0);

  const activeCount = saved.filter((v) => v.active).length;
  const scheduledCount = saved.filter((v) => v.active && v.hours).length;
  const shopTime = formatClock(clock);

  // La Save Bar oficial del admin aparece solo cuando hay cambios sin guardar
  useEffect(() => {
    if (isDirty) {
      shopify.saveBar.show(SAVE_BAR_ID);
    } else {
      shopify.saveBar.hide(SAVE_BAR_ID);
    }
  }, [isDirty, shopify]);

  useEffect(() => () => shopify.saveBar.hide(SAVE_BAR_ID), [shopify]);

  // Tras un guardado exitoso, sincroniza la UI con lo que quedó en Shopify
  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.data.ok) {
      const {
        vendors,
        message: savedText,
        cartMessage: savedCartText,
      } = fetcher.data.saved;
      setSaved(vendors);
      setRows(makeRows(vendors));
      setSavedMessage(savedText);
      setMessage(savedText);
      setSavedCartMessage(savedCartText);
      setCartMessage(savedCartText);
      const activos = vendors.filter((v) => v.active).length;
      shopify.toast.show(`Guardado: ${activos} vendedor(es) activo(s)`);
    } else {
      shopify.toast.show("No se pudo guardar", { isError: true });
    }
  }, [fetcher.data, shopify]);

  const updateRow = (id, field, value) => {
    setRows((current) =>
      current.map((r) => (r.id === id ? { ...r, [field]: value } : r)),
    );
  };

  const addRow = () =>
    setRows((current) => [
      ...current,
      ...makeRows([{ name: "", phone: "", active: true }]),
    ]);

  const removeRow = (id) =>
    setRows((current) => current.filter((r) => r.id !== id));

  const handleSave = () => {
    if (validation.hasErrors) {
      shopify.toast.show("Corrige los campos marcados en rojo", {
        isError: true,
      });
      return;
    }
    fetcher.submit(
      {
        payload: JSON.stringify({
          vendors: validation.vendors,
          message: message.trim(),
          cartMessage: cartMessage.trim(),
        }),
      },
      { method: "POST" },
    );
  };

  const handleDiscard = () => {
    setRows(makeRows(saved));
    setMessage(savedMessage);
    setCartMessage(savedCartMessage);
  };

  // Chips "+ {producto}": el comerciante no tiene por qué saber la sintaxis
  const appendPlaceholder = (current, key) => {
    const trimmed = current.replace(/\s+$/, "");
    return `${trimmed}${trimmed ? " " : ""}{${key}}`;
  };
  const insertPlaceholder = (key) =>
    setMessage((current) => appendPlaceholder(current, key));
  const insertCartPlaceholder = (key) =>
    setCartMessage((current) => appendPlaceholder(current, key));

  // Sin {producto} o {url} el vendedor recibe un mensaje sin contexto
  const missingPlaceholders = ["producto", "url"].filter(
    (key) => !message.includes(`{${key}}`),
  );
  // Sin {pedido} el mensaje del carrito no dice qué se está pidiendo
  const missingCartPlaceholders = ["pedido"].filter(
    (key) => !cartMessage.includes(`{${key}}`),
  );

  const moveRow = (id, delta) =>
    setRows((current) => {
      const from = current.findIndex((r) => r.id === id);
      return moveItem(current, from, from + delta);
    });

  const resetRow = (id) =>
    setRows((current) =>
      current.map((r) => (r.id === id ? resetRowConfig(r) : r)),
    );

  // Nada se escribe en Shopify hasta que el comerciante pulse Guardar:
  // la barra aparece y puede revisar o descartar el cambio
  const resetAll = () => {
    setRows((current) => current.map(resetRowConfig));
    setMessage(DEFAULT_MESSAGE);
    setCartMessage(DEFAULT_CART_MESSAGE);
    shopify.toast.show("Configuración recomendada aplicada. Guarda para confirmar.");
  };

  const pickPreviewProduct = async () => {
    try {
      const selection = await shopify.resourcePicker({
        type: "product",
        multiple: false,
      });
      const product = selection?.[0];
      if (!product) return;

      const variant = product.variants?.[0];
      const hasVariants =
        (product.variants?.length ?? 0) > 1 &&
        variant?.title &&
        variant.title !== "Default Title";
      const variantId = String(variant?.id ?? "").split("/").pop();

      setPreviewProduct({
        title: hasVariants ? `${product.title} (${variant.title})` : product.title,
        price: variant?.price
          ? formatPrice(variant.price, currencyCode)
          : SAMPLE_PRICE,
        sku: variant?.sku || SAMPLE_SKU,
        url: `https://${shop}/products/${product.handle}${hasVariants && variantId ? `?variant=${variantId}` : ""}`,
      });
    } catch {
      // El comerciante cerró el selector sin elegir
    }
  };

  saveRef.current = isDirty ? handleSave : null;

  useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveRef.current?.();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <s-page heading="Multi-Vendor WhatsApp Router">
      {isCustomized && (
        <s-button
          slot="secondary-actions"
          icon="reset"
          commandFor={RESET_MODAL_ID}
          command="--show"
        >
          Configuración recomendada
        </s-button>
      )}

      <s-modal id={RESET_MODAL_ID} heading="Volver a la configuración recomendada">
        <s-stack direction="block" gap="base">
          <s-text>
            Se aplicará la configuración con la que la app funciona mejor para
            la mayoría de tiendas. Tus vendedores y sus números se conservan.
          </s-text>
          <s-unordered-list>
            <s-list-item>Todos los vendedores activos</s-list-item>
            <s-list-item>Prioridad normal para todos (reparto por igual)</s-list-item>
            <s-list-item>Sin horarios ni etiquetas: todos atienden todo</s-list-item>
            <s-list-item>Mensajes recomendados (producto y carrito)</s-list-item>
          </s-unordered-list>
          <s-text tone="neutral">
            No se guarda nada hasta que pulses Guardar: podrás revisar el
            resultado o descartarlo.
          </s-text>
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          commandFor={RESET_MODAL_ID}
          command="--hide"
          onClick={resetAll}
        >
          Aplicar
        </s-button>
        <s-button
          slot="secondary-actions"
          commandFor={RESET_MODAL_ID}
          command="--hide"
        >
          Cancelar
        </s-button>
      </s-modal>

      <SetupGuide
        hasVendors={activeCount > 0}
        links={editorLinks}
        storefront={`https://${shop}/collections/all`}
        install={install}
        onRefresh={() => revalidator.revalidate()}
        refreshing={revalidator.state === "loading"}
      />

      <s-section heading="Vendedores de WhatsApp">
        <s-paragraph>
          Agrega los números de tus vendedores. Los clics de tus clientes en el
          botón &quot;Comprar por WhatsApp&quot; se repartirán entre los
          vendedores activos que estén en su horario, según su prioridad.
        </s-paragraph>

        <s-stack direction="inline" gap="base" alignItems="center">
          <s-badge tone={activeCount > 0 ? "success" : "auto"}>
            {`${activeCount} activo(s) de ${saved.length} guardado(s)`}
          </s-badge>
          {scheduledCount > 0 && (
            <s-badge tone="info">{`${scheduledCount} con horario`}</s-badge>
          )}
          {shopTime && (
            <s-badge tone="auto">{`Hora de tu tienda: ${shopTime}`}</s-badge>
          )}
          {isDirty && <s-badge tone="warning">Cambios sin guardar</s-badge>}
        </s-stack>

        {activeCount === 0 && (
          <s-banner heading="Ningún vendedor activo" tone="info">
            El botón de WhatsApp no aparecerá en tu tienda hasta que guardes al
            menos un vendedor activo.
          </s-banner>
        )}
        {fetcher.data && !fetcher.data.ok && (
          <s-banner heading="No se pudo guardar" tone="critical">
            Shopify rechazó el guardado. Intenta de nuevo; si el problema
            persiste, revisa los datos ingresados.
          </s-banner>
        )}

        <s-stack direction="block" gap="base">
          {rows.map((row, index) => {
            const hours = row.scheduled
              ? toHours({ start: row.start, end: row.end, days: row.days })
              : null;
            return (
              <VendorRow
                key={row.id}
                row={row}
                index={index}
                count={rows.length}
                errors={validation.errors.get(row.id) ?? {}}
                previewMessage={previewMessage}
                stats={stats.byPhone[digitsOnly(row.phone)] ?? null}
                share={
                  row.active && totalWeight > 0
                    ? toWeight(row.weight) / totalWeight
                    : 0
                }
                onDuty={hours && clock ? isOnDuty(hours, clock) : null}
                onChange={updateRow}
                onMove={moveRow}
                onReset={resetRow}
                onRemove={removeRow}
              />
            );
          })}
        </s-stack>

        <s-stack direction="inline" gap="base">
          <s-button icon="plus" onClick={addRow}>
            Agregar vendedor
          </s-button>
        </s-stack>
      </s-section>

      <s-section heading="Mensaje que enviará el cliente">
        <s-paragraph>
          Este es el texto que aparecerá escrito en WhatsApp cuando el cliente
          pulse el botón de un producto. Se rellenan solos: {"{producto}"} (con
          su talla o color), {"{precio}"}, {"{cantidad}"} (la que elija el
          cliente), {"{sku}"} y {"{url}"}.
        </s-paragraph>

        {message.trim() && missingPlaceholders.length > 0 && (
          <s-banner
            heading={`Tu mensaje no incluye ${missingPlaceholders.map((k) => `{${k}}`).join(" ni ")}`}
            tone="warning"
          >
            Sin {"{producto}"} el vendedor no sabrá qué producto le interesa al
            cliente; sin {"{url}"} no podrá abrirlo. Añádelos con los botones
            de abajo.
          </s-banner>
        )}

        <s-text-area
          label="Plantilla del mensaje"
          rows={3}
          maxLength={MAX_MESSAGE_LENGTH}
          value={message}
          {...(validation.messageError
            ? { error: validation.messageError }
            : {})}
          onInput={(e) => setMessage(e.currentTarget.value)}
        ></s-text-area>

        <s-stack direction="inline" gap="base" alignItems="center">
          {PRODUCT_PLACEHOLDERS.map((key) => (
            <s-button
              key={key}
              variant="tertiary"
              onClick={() => insertPlaceholder(key)}
              {...(message.includes(`{${key}}`) ? { disabled: true } : {})}
            >
              {`+ {${key}}`}
            </s-button>
          ))}
          {message.trim() !== DEFAULT_MESSAGE && (
            <s-button
              variant="tertiary"
              icon="undo"
              onClick={() => setMessage(DEFAULT_MESSAGE)}
            >
              Usar mensaje recomendado
            </s-button>
          )}
          <s-button variant="tertiary" icon="product" onClick={pickPreviewProduct}>
            {previewProduct
              ? "Cambiar producto de ejemplo"
              : "Previsualizar con un producto real"}
          </s-button>
          {previewProduct && (
            <s-button
              variant="tertiary"
              icon="x"
              onClick={() => setPreviewProduct(null)}
            >
              Volver al ejemplo
            </s-button>
          )}
        </s-stack>

        <s-box padding="base" background="subdued" borderRadius="base">
          <s-stack direction="block" gap="small-300">
            <s-text type="strong">
              {previewProduct
                ? "Vista previa con tu producto"
                : "Vista previa (producto de ejemplo)"}
            </s-text>
            <div style={{ whiteSpace: "pre-wrap" }}>
              <s-text>{previewMessage}</s-text>
            </div>
          </s-stack>
        </s-box>
      </s-section>

      <s-section heading="Mensaje para pedidos del carrito">
        <s-paragraph>
          Cuando el cliente tiene varios productos en el carrito, el botón de
          la página del carrito (y el flotante, fuera de las fichas de
          producto) envía el pedido completo. Se rellenan solos: {"{pedido}"}{" "}
          (un renglón por artículo con cantidad, variante y precio),{" "}
          {"{total}"}, {"{cantidad}"} (artículos en total) y {"{url}"} (un
          enlace que recrea el carrito para el vendedor).
        </s-paragraph>

        {cartMessage.trim() && missingCartPlaceholders.length > 0 && (
          <s-banner heading="Tu mensaje no incluye {pedido}" tone="warning">
            Sin {"{pedido}"} el vendedor no verá qué productos quiere el
            cliente. Añádelo con el botón de abajo.
          </s-banner>
        )}

        <s-text-area
          label="Plantilla del pedido"
          rows={4}
          maxLength={MAX_MESSAGE_LENGTH}
          value={cartMessage}
          {...(validation.cartMessageError
            ? { error: validation.cartMessageError }
            : {})}
          onInput={(e) => setCartMessage(e.currentTarget.value)}
        ></s-text-area>

        <s-stack direction="inline" gap="base" alignItems="center">
          {CART_PLACEHOLDERS.map((key) => (
            <s-button
              key={key}
              variant="tertiary"
              onClick={() => insertCartPlaceholder(key)}
              {...(cartMessage.includes(`{${key}}`) ? { disabled: true } : {})}
            >
              {`+ {${key}}`}
            </s-button>
          ))}
          {cartMessage.trim() !== DEFAULT_CART_MESSAGE && (
            <s-button
              variant="tertiary"
              icon="undo"
              onClick={() => setCartMessage(DEFAULT_CART_MESSAGE)}
            >
              Usar mensaje recomendado
            </s-button>
          )}
        </s-stack>

        <s-box padding="base" background="subdued" borderRadius="base">
          <s-stack direction="block" gap="small-300">
            <s-text type="strong">Vista previa (carrito de ejemplo)</s-text>
            <div style={{ whiteSpace: "pre-wrap" }}>
              <s-text>{previewCartMessage}</s-text>
            </div>
          </s-stack>
        </s-box>
      </s-section>

      <ActivitySection stats={stats} vendors={saved} />

      <s-section slot="aside" heading="¿Cómo funciona?">
        <s-unordered-list>
          <s-list-item>
            Cada clic va al siguiente vendedor activo de la lista, por turnos.
            La prioridad da más turnos por vuelta a quien la tenga más alta.
          </s-list-item>
          <s-list-item>
            El número debe incluir el código de país, sin el signo +. Ejemplo
            para El Salvador: 50371234567.
          </s-list-item>
          <s-list-item>
            Activa &quot;Horario&quot; para que un vendedor solo reciba clics
            en sus días y horas
            {timeZone ? ` (hora de ${timeZone})` : ""}. Si a una hora nadie
            está en turno, se reparte entre todos los activos: nunca se pierde
            una venta.
          </s-list-item>
          <s-list-item>
            Usa &quot;Probar en WhatsApp&quot; para confirmar que el número es
            correcto antes de publicarlo en tu tienda.
          </s-list-item>
          <s-list-item>
            Etiquetas: si un vendedor solo atiende productos con cierta
            etiqueta (por ejemplo &quot;electrónica&quot;), esos productos van
            solo a él; el resto va a los vendedores sin etiquetas.
          </s-list-item>
          <s-list-item>
            En la tienda, el botón muestra &quot;En línea&quot; o &quot;Fuera
            de horario · te respondemos mañana a las 08:00&quot; según los
            horarios de tus vendedores. Se configura en el editor de temas.
          </s-list-item>
          <s-list-item>
            ¿Te perdiste configurando? &quot;Configuración recomendada&quot;
            (arriba) lo deja como al principio sin borrar vendedores. Cada
            vendedor tiene también su propio &quot;Restablecer&quot; en
            Opciones.
          </s-list-item>
          <s-list-item>
            El aspecto del botón (colores, tamaño, texto) se ajusta en el editor
            de temas. Para volver a sus valores iniciales, elimina el bloque y
            agrégalo de nuevo.
          </s-list-item>
          <s-list-item>Atajo: Ctrl+S (⌘S en Mac) guarda los cambios.</s-list-item>
        </s-unordered-list>
      </s-section>

      <ui-save-bar id={SAVE_BAR_ID} discardConfirmation="">
        <button
          variant="primary"
          onClick={handleSave}
          {...(isSaving ? { loading: "" } : {})}
        ></button>
        <button onClick={handleDiscard}></button>
      </ui-save-bar>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
