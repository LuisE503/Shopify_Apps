/**
 * Reglas y utilidades del panel compartidas por todas las páginas.
 * Este módulo no toca Shopify ni la base de datos: sirve igual en el
 * servidor (loaders/actions) y en el navegador (validación en vivo).
 */

export const MIN_PHONE_DIGITS = 8;
export const MAX_MESSAGE_LENGTH = 500;
export const MIN_WEIGHT = 1;
export const MAX_WEIGHT = 5;
export const WEIGHT_OPTIONS = [1, 2, 3, 4, 5];
export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 40;

// Las mismas plantillas recomendadas viven en los bloques Liquid de la extensión
export const DEFAULT_MESSAGE =
  "Hola, me interesa este producto:\n{producto} - {precio}\nCantidad: {cantidad}\n{url}";
export const DEFAULT_CART_MESSAGE =
  "Hola, quiero hacer este pedido:\n{pedido}\nTotal: {total}\n{url}";

export const PRODUCT_PLACEHOLDERS = [
  "producto",
  "precio",
  "cantidad",
  "sku",
  "pago",
  "url",
];
export const CART_PLACEHOLDERS = ["pedido", "total", "cantidad", "url"];

// Ejemplos para previsualizar mensajes y probar números
export const SAMPLE_PRODUCT = "Camiseta Azul (Talla M)";
export const SAMPLE_PRICE = "$12.00";
export const SAMPLE_QUANTITY = "2";
export const SAMPLE_SKU = "CAM-AZ-M";
export const SAMPLE_URL = "https://tu-tienda.com/products/camiseta-azul";
export const SAMPLE_CHECKOUT = "https://tu-tienda.com/cart/40123456789:2";
export const SAMPLE_CART = {
  pedido: "- 2× Camiseta Azul (Talla M) — $24.00\n- 1× Gorra Negra — $15.00",
  total: "$39.00",
  cantidad: "3",
  url: "https://tu-tienda.com/cart/123:2,456:1",
};

// Lunes primero, como se lee un horario en LATAM. El valor coincide con
// Date.getDay() en JavaScript (0 = domingo), que es lo que usa el storefront.
export const WEEK_DAYS = [
  { value: 1, label: "Lun" },
  { value: 2, label: "Mar" },
  { value: 3, label: "Mié" },
  { value: 4, label: "Jue" },
  { value: 5, label: "Vie" },
  { value: 6, label: "Sáb" },
  { value: 0, label: "Dom" },
];
export const WEEKDAYS_ONLY = [1, 2, 3, 4, 5];
export const DAY_NAMES = [
  "domingo",
  "lunes",
  "martes",
  "miércoles",
  "jueves",
  "viernes",
  "sábado",
];
const INTL_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Configuración recomendada: activo, prioridad normal, disponible siempre
export const DEFAULT_START = "08:00";
export const DEFAULT_END = "18:00";

export const TIME_OPTIONS = (() => {
  const options = [];
  for (let hour = 0; hour < 24; hour += 1) {
    for (const minutes of ["00", "30"]) {
      options.push(`${String(hour).padStart(2, "0")}:${minutes}`);
    }
  }
  return options;
})();

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

// Se aceptan separadores comunes al escribir: +503 6860-2600, (503) 686 02600.
// Cualquier otro carácter (letras, símbolos) se marca como error visible.
export const ALLOWED_PHONE_CHARS = /^[\d\s+().-]*$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const pad = (n) => String(n).padStart(2, "0");

export const digitsOnly = (value) => String(value ?? "").replace(/\D/g, "");

// "El Salvador (+503)" bajo el campo del número: confirma al instante que el
// código de país es el correcto, el error más común al cargar vendedores
export const countryHint = (phone) => {
  const digits = digitsOnly(phone);
  const generic = "Código de país + número";
  if (digits.length < 3) return generic;
  const match = COUNTRY_CODES.filter(([code]) => digits.startsWith(code)).sort(
    (a, b) => b[0].length - a[0].length,
  )[0];
  return match ? `${match[1]} (+${match[0]}) · ${generic.toLowerCase()}` : generic;
};

export const initialsOf = (name) =>
  String(name ?? "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");

export const renderMessage = (template, values) =>
  Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, value),
    String(template ?? ""),
  );

// Horario guardado -> horario normalizado (null = disponible siempre)
export const toHours = (hours) => {
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
export const toWeight = (value) => {
  const weight = Number.parseInt(value, 10);
  if (!Number.isFinite(weight)) return 1;
  return Math.min(Math.max(weight, MIN_WEIGHT), MAX_WEIGHT);
};

// Etiquetas de producto que atiende un vendedor (vacío = todos los productos).
// Acepta un array o texto separado por comas; normaliza a minúsculas sin repetir.
export const toTags = (value) => {
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
export const toVendor = (v) => ({
  name: String(v?.name ?? ""),
  phone: String(v?.phone ?? ""),
  active: v?.active !== false,
  weight: toWeight(v?.weight),
  hours: toHours(v?.hours),
  tags: toTags(v?.tags),
});

/* -------------------------------------------------------------------- */
/* Filas del editor de vendedores                                        */
/* -------------------------------------------------------------------- */

// Contador módulo-level: garantiza ids de fila únicos y estables para React.
// El campo `saved` guarda lo que está en Shopify para marcar qué fila cambió.
let rowIdCounter = 0;
export const makeRows = (list) =>
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
export const rowSignature = (row) =>
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

export const isRowDirty = (row) => rowSignature(row) !== row.saved;

// ¿Este vendedor se aleja de la configuración recomendada?
export const isRowCustomized = (row) =>
  !row.active ||
  toWeight(row.weight) !== 1 ||
  row.scheduled ||
  toTags(row.tags).length > 0;

// Vuelve a lo recomendado sin tocar nombre ni número
export const resetRowConfig = (row) => ({
  ...row,
  active: true,
  weight: 1,
  scheduled: false,
  start: DEFAULT_START,
  end: DEFAULT_END,
  days: WEEKDAYS_ONLY,
  tags: "",
});

export const moveItem = (list, from, to) => {
  if (from < 0 || to < 0 || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
};

// Firma de lo visible en pantalla, ignorando filas totalmente vacías
export const visibleSignature = (rows) =>
  JSON.stringify(
    rows
      .filter((r) => r.name.trim() || r.phone.trim())
      .map((r) => rowSignature(r)),
  );

export const savedSignature = (saved) =>
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

/**
 * Valida las filas con contenido (las totalmente vacías se ignoran) y
 * devuelve los errores por fila y la lista lista para guardar.
 */
export const validateVendorRows = (rows) => {
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

  const vendors = filledRows.map((r) => ({
    name: r.name.trim(),
    phone: digitsOnly(r.phone),
    active: r.active,
    weight: toWeight(r.weight),
    hours: r.scheduled ? { start: r.start, end: r.end, days: r.days } : null,
    tags: toTags(r.tags),
  }));

  return { errors, vendors };
};

export const describeSchedule = (row) => {
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
export const shopClock = (timeZone) => {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone ?? undefined,
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

export const toMinutes = (time) => {
  const [h, m] = String(time).split(":").map(Number);
  return h * 60 + m;
};

export const isOnDuty = (hours, clock) => {
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

/** Próxima apertura entre los vendedores con horario, o null si no hay. */
export const nextOpening = (vendors, clock) => {
  if (!clock) return null;
  let best = null;
  for (const vendor of vendors) {
    if (!vendor.hours) continue;
    const start = toMinutes(vendor.hours.start);
    for (let offset = 0; offset < 8; offset += 1) {
      const day = (clock.day + offset) % 7;
      const days = vendor.hours.days;
      if (days.length > 0 && !days.includes(day)) continue;
      if (offset === 0 && start <= clock.minutes) continue;
      const candidate = { dayOffset: offset, minutes: start, day, name: vendor.name };
      if (
        !best ||
        candidate.dayOffset < best.dayOffset ||
        (candidate.dayOffset === best.dayOffset && candidate.minutes < best.minutes)
      ) {
        best = candidate;
      }
      break;
    }
  }
  return best;
};

/** "hoy a las 08:00", "mañana a las 09:30", "el lunes a las 08:00". */
export const describeOpening = (opening) => {
  if (!opening) return null;
  const when =
    opening.dayOffset === 0
      ? "hoy"
      : opening.dayOffset === 1
        ? "mañana"
        : `el ${DAY_NAMES[opening.day]}`;
  return `${when} a las ${pad(Math.floor(opening.minutes / 60))}:${pad(opening.minutes % 60)}`;
};

export const formatClock = (clock) =>
  clock ? `${pad(Math.floor(clock.minutes / 60))}:${pad(clock.minutes % 60)}` : null;

export const formatPrice = (amount, currencyCode) => {
  try {
    return new Intl.NumberFormat("es", {
      style: "currency",
      currency: currencyCode,
    }).format(Number(amount));
  } catch {
    return String(amount);
  }
};

export const relativeTime = (isoDate) => {
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
