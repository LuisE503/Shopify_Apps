import { useEffect, useMemo, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// La configuración vive en app-data metafields para que la Theme App Extension
// la lea desde Liquid (app.metafields.whatsapp_router.*) sin tocar el backend.
const METAFIELD_NAMESPACE = "whatsapp_router";
const VENDORS_KEY = "vendors";
const MESSAGE_KEY = "message";
const SAVE_BAR_ID = "vendors-save-bar";
const MIN_PHONE_DIGITS = 8;
const MAX_MESSAGE_LENGTH = 500;
const MIN_WEIGHT = 1;
const MAX_WEIGHT = 5;
const WEIGHT_OPTIONS = [1, 2, 3, 4, 5];
const STATS_DAYS = 30;
const TOP_PRODUCTS = 5;

const DEFAULT_MESSAGE = "Hola, me interesa este producto: {producto} - {url}";

// Ejemplo usado para previsualizar el mensaje y probar los números
const SAMPLE_PRODUCT = "Camiseta Azul (Talla M)";
const SAMPLE_PRICE = "$12.00";
const SAMPLE_URL = "https://tu-tienda.com/products/camiseta-azul";

// Nombres de archivo de los bloques en extensions/whatsapp-button/blocks/
const PRODUCT_BLOCK_HANDLE = "whatsapp_button";
const FLOAT_BLOCK_HANDLE = "whatsapp_float";

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

// Normaliza un vendedor venido de la API (campos ausentes = valores por defecto)
const toVendor = (v) => ({
  name: String(v?.name ?? ""),
  phone: String(v?.phone ?? ""),
  active: v?.active !== false,
  weight: toWeight(v?.weight),
  hours: toHours(v?.hours),
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
        start: hours ? hours.start : "08:00",
        end: hours ? hours.end : "18:00",
        days: hours ? hours.days : WEEKDAYS_ONLY,
        saved: JSON.stringify([
          v.name ?? "",
          v.phone ?? "",
          v.active !== false,
          toWeight(v.weight),
          hours,
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
  ]);

const isRowDirty = (row) => rowSignature(row) !== row.saved;

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

/** Clics de los últimos 30 días: por vendedor, y los productos más pedidos. */
const loadClickStats = async (shop) => {
  const since = new Date(Date.now() - STATS_DAYS * 24 * 60 * 60 * 1000);
  const empty = { byPhone: {}, topProducts: [], total: 0 };

  try {
    const [byVendor, byProduct] = await Promise.all([
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

    return {
      byPhone,
      total,
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
    activateFloat: `${editor}?context=apps&activateAppId=${apiKey}/${FLOAT_BLOCK_HANDLE}`,
  };
};

/* -------------------------------------------------------------------- */
/* Loader y action                                                       */
/* -------------------------------------------------------------------- */

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  const [stats, response] = await Promise.all([
    loadClickStats(session.shop),
    admin.graphql(
      `#graphql
        query getWhatsappConfig($namespace: String!) {
          shop {
            ianaTimezone
          }
          currentAppInstallation {
            vendors: metafield(namespace: $namespace, key: "vendors") {
              jsonValue
            }
            message: metafield(namespace: $namespace, key: "message") {
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

  return {
    shop: session.shop,
    vendors: Array.isArray(storedVendors) ? storedVendors.map(toVendor) : [],
    message: installation?.message?.value || DEFAULT_MESSAGE,
    stats,
    timeZone,
    clock: shopClock(timeZone),
    editorLinks: themeEditorLinks(session.shop),
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
    saved: { vendors: cleanVendors, message: cleanMessage },
  };
};

/* -------------------------------------------------------------------- */
/* Componentes                                                           */
/* -------------------------------------------------------------------- */

/**
 * Tarjeta de un vendedor.
 *
 * @param row            fila del estado local (ver makeRows)
 * @param errors         errores de esta fila: { name, phone, hours, days }
 * @param previewMessage mensaje de ejemplo para el enlace de prueba
 * @param stats          { count, lastClickAt } de este número, si hay clics
 * @param share          fracción de la rotación que le corresponde (0-1)
 * @param onDuty         true/false si tiene horario, null si no
 * @param onChange       (id, campo, valor) => void
 * @param onRemove       (id) => void
 */
/* eslint-disable react/prop-types -- el proyecto es JavaScript y no usa
   prop-types en ninguna ruta; los props quedan documentados arriba */
function VendorRow({
  row,
  errors,
  previewMessage,
  stats,
  share,
  onDuty,
  onChange,
  onRemove,
}) {
  const phoneDigits = digitsOnly(row.phone);
  const canTest = !errors.phone && phoneDigits.length >= MIN_PHONE_DIGITS;
  const testUrl = `https://wa.me/${phoneDigits}?text=${encodeURIComponent(previewMessage)}`;
  const sharePercent = Math.round(share * 100);

  const toggleDay = (day) => {
    const days = row.days.includes(day)
      ? row.days.filter((d) => d !== day)
      : [...row.days, day].sort((a, b) => a - b);
    onChange(row.id, "days", days);
  };

  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="base">
        <s-grid gridTemplateColumns="2fr 2fr 1fr" gap="base">
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
            details="Código de país + número"
            value={row.phone}
            {...(errors.phone ? { error: errors.phone } : {})}
            onInput={(e) => onChange(row.id, "phone", e.currentTarget.value)}
          ></s-text-field>
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
        </s-grid>

        <s-stack direction="inline" gap="base" alignItems="center">
          <s-switch
            label="Activo"
            checked={row.active}
            onChange={(e) => onChange(row.id, "active", e.currentTarget.checked)}
          ></s-switch>
          <s-switch
            label="Horario"
            checked={row.scheduled}
            onChange={(e) =>
              onChange(row.id, "scheduled", e.currentTarget.checked)
            }
          ></s-switch>
          {row.active && row.scheduled && onDuty !== null && (
            <s-badge tone={onDuty ? "success" : "auto"}>
              {onDuty ? "En turno ahora" : "Fuera de turno"}
            </s-badge>
          )}
          {stats && (
            <s-badge tone="info">
              {`${stats.count} clic(s) · ${relativeTime(stats.lastClickAt)}`}
            </s-badge>
          )}
          {isRowDirty(row) && <s-badge tone="warning">Sin guardar</s-badge>}
          {canTest && (
            <s-button variant="tertiary" href={testUrl} target="_blank">
              Probar en WhatsApp
            </s-button>
          )}
          <s-button
            icon="delete"
            variant="tertiary"
            tone="critical"
            accessibilityLabel={`Eliminar vendedor ${row.name || "sin nombre"}`}
            onClick={() => onRemove(row.id)}
          ></s-button>
        </s-stack>

        {row.scheduled && (
          <s-box padding="base" background="subdued" borderRadius="base">
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

              {errors.days && <s-text tone="critical">{errors.days}</s-text>}
              <s-text tone="neutral">{describeSchedule(row)}</s-text>
            </s-stack>
          </s-box>
        )}
      </s-stack>
    </s-box>
  );
}

/**
 * Guía de puesta en marcha con enlaces que abren el editor de temas con el
 * bloque ya seleccionado. Es lo que más dudas genera al instalar la app.
 *
 * @param hasVendors   ya hay al menos un vendedor activo guardado
 * @param links        { addProductBlock, activateFloat } o null
 * @param storefront   URL de la tienda para probar
 */
function SetupGuide({ hasVendors, links, storefront }) {
  return (
    <s-section heading="Puesta en marcha">
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-badge tone={hasVendors ? "success" : "warning"}>1</s-badge>
          <s-text>
            {hasVendors
              ? "Vendedores guardados."
              : "Guarda al menos un vendedor activo (abajo)."}
          </s-text>
        </s-stack>

        <s-stack direction="inline" gap="base" alignItems="center">
          <s-badge tone="info">2</s-badge>
          <s-text>Coloca el botón en la página de producto.</s-text>
          {links && (
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
          <s-badge tone="info">3</s-badge>
          <s-text>Opcional: activa el botón flotante en toda la tienda.</s-text>
          {links && (
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
          <s-badge tone="info">4</s-badge>
          <s-text>Pruébalo en tu tienda como lo vería un cliente.</s-text>
          <s-button variant="tertiary" href={storefront} target="_blank">
            Ver mi tienda
          </s-button>
        </s-stack>

        {!links && (
          <s-text tone="neutral">
            En el editor de temas: página de producto → Agregar bloque →
            Aplicaciones → Botón de WhatsApp. El flotante está en
            Incrustaciones de aplicación.
          </s-text>
        )}
      </s-stack>
    </s-section>
  );
}

/**
 * Actividad de los últimos 30 días.
 *
 * @param stats  { total, topProducts }
 */
function ActivitySection({ stats }) {
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

  return (
    <s-section slot="aside" heading={`Actividad (${STATS_DAYS} días)`}>
      <s-stack direction="block" gap="base">
        <s-text>
          <s-text type="strong">{stats.total}</s-text> clic(s) en total. El
          detalle por vendedor está en cada tarjeta.
        </s-text>
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
    stats,
    timeZone,
    clock,
    editorLinks,
  } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  // `saved*` refleja lo que está en Shopify; `rows`/`message` lo que se edita
  const [saved, setSaved] = useState(vendorsOnLoad);
  const [savedMessage, setSavedMessage] = useState(messageOnLoad);
  const [rows, setRows] = useState(() => makeRows(vendorsOnLoad));
  const [message, setMessage] = useState(messageOnLoad);

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

    const vendors = filledRows.map((r) => ({
      name: r.name.trim(),
      phone: digitsOnly(r.phone),
      active: r.active,
      weight: toWeight(r.weight),
      hours: r.scheduled
        ? { start: r.start, end: r.end, days: r.days }
        : null,
    }));

    return {
      errors,
      messageError,
      vendors,
      hasErrors: errors.size > 0 || Boolean(messageError),
    };
  }, [rows, message]);

  // "Hay cambios" = lo que se ve en pantalla difiere de lo guardado en Shopify
  const isDirty = useMemo(
    () =>
      visibleSignature(rows) !== savedSignature(saved) ||
      message.trim() !== savedMessage,
    [rows, saved, message, savedMessage],
  );

  const previewMessage = useMemo(
    () =>
      renderMessage(message, {
        producto: SAMPLE_PRODUCT,
        precio: SAMPLE_PRICE,
        url: SAMPLE_URL,
      }),
    [message],
  );

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
      const { vendors, message: savedText } = fetcher.data.saved;
      setSaved(vendors);
      setRows(makeRows(vendors));
      setSavedMessage(savedText);
      setMessage(savedText);
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
        }),
      },
      { method: "POST" },
    );
  };

  const handleDiscard = () => {
    setRows(makeRows(saved));
    setMessage(savedMessage);
  };

  return (
    <s-page heading="Multi-Vendor WhatsApp Router">
      <SetupGuide
        hasVendors={activeCount > 0}
        links={editorLinks}
        storefront={`https://${shop}`}
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
          {rows.map((row) => {
            const hours = row.scheduled
              ? toHours({ start: row.start, end: row.end, days: row.days })
              : null;
            return (
              <VendorRow
                key={row.id}
                row={row}
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
          pulse el botón. Puedes usar {"{producto}"}, {"{precio}"} y{" "}
          {"{url}"}: se reemplazan solos por el producto (con su talla o
          color), su precio y su enlace.
        </s-paragraph>

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

        <s-box padding="base" background="subdued" borderRadius="base">
          <s-stack direction="block" gap="small-300">
            <s-text type="strong">Vista previa</s-text>
            <s-text>{previewMessage}</s-text>
          </s-stack>
        </s-box>
      </s-section>

      <ActivitySection stats={stats} />

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
        </s-unordered-list>
      </s-section>

      <ui-save-bar id={SAVE_BAR_ID}>
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
