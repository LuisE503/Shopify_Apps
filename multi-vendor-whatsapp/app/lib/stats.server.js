/**
 * Estadísticas de clics leídas de la base de datos de la app.
 * Todo se agrupa en la zona horaria de la tienda: un clic a las 23:30 en
 * El Salvador es de ese día (y de esa hora), no del siguiente en UTC.
 */
import db from "../db.server";
import { DEFAULT_PERIOD, MAX_RANGE_DAYS, formatDay, parseDay } from "./periods";

const TOP_PRODUCTS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
// Al consultar la base de datos se amplía la ventana para cubrir cualquier
// zona horaria; el filtro exacto se hace después por clave de día
const TZ_MARGIN_MS = 14 * 60 * 60 * 1000;
const INTL_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Fecha "YYYY-MM-DD", hora (0-23) y día de la semana en la zona horaria dada. */
const partsIn = (date, timeZone) => {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone ?? undefined,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
      weekday: "short",
    }).formatToParts(date);
    const read = (type) => parts.find((p) => p.type === type)?.value;
    return {
      key: `${read("year")}-${read("month")}-${read("day")}`,
      hour: Number(read("hour")) % 24,
      weekday: Math.max(0, INTL_WEEKDAYS.indexOf(read("weekday"))),
    };
  } catch {
    return {
      key: date.toISOString().slice(0, 10),
      hour: date.getUTCHours(),
      weekday: date.getUTCDay(),
    };
  }
};

/** Etiqueta corta ("lun 5") de una clave de día. Se toma el mediodía UTC para
 * que ninguna zona horaria la desplace al día anterior o siguiente. */
const labelForKey = (key, timeZone) => {
  const date = new Date(`${key}T12:00:00Z`);
  try {
    return new Intl.DateTimeFormat("es", {
      timeZone: timeZone ?? undefined,
      weekday: "short",
      day: "numeric",
    }).format(date);
  } catch {
    return key.slice(5);
  }
};

/** Etiqueta con mes ("5 sep") para encabezados de rango. */
export const longLabelForKey = (key) => {
  const date = new Date(`${key}T12:00:00Z`);
  try {
    return new Intl.DateTimeFormat("es", {
      timeZone: "UTC",
      day: "numeric",
      month: "short",
    }).format(date);
  } catch {
    return key;
  }
};

const shiftKey = (key, days) => formatDay(new Date(parseDay(key).getTime() + days * DAY_MS));

/** Clave del día de hoy en la zona horaria de la tienda. */
export const todayKey = (timeZone) => partsIn(new Date(), timeZone).key;

/**
 * Normaliza lo pedido: un número de días hacia atrás hasta hoy, o un rango
 * { from, to } explícito. Devuelve siempre un rango válido y acotado.
 */
const resolveWindow = (timeZone, rangeOrDays) => {
  const today = todayKey(timeZone);

  if (rangeOrDays && typeof rangeOrDays === "object") {
    const from = parseDay(rangeOrDays.from);
    const to = parseDay(rangeOrDays.to);
    if (from && to && from <= to) {
      const toKey = formatDay(to) > today ? today : formatDay(to);
      const span = Math.min(
        MAX_RANGE_DAYS,
        Math.round((parseDay(toKey).getTime() - from.getTime()) / DAY_MS) + 1,
      );
      return { from: shiftKey(toKey, -(span - 1)), to: toKey, days: span };
    }
  }

  const days =
    Number.isInteger(rangeOrDays) && rangeOrDays > 0
      ? Math.min(rangeOrDays, MAX_RANGE_DAYS)
      : DEFAULT_PERIOD;
  return { from: shiftKey(today, -(days - 1)), to: today, days };
};

export const emptyStats = (range) => ({
  ...range,
  total: 0,
  previousTotal: 0,
  today: 0,
  byPhone: {},
  byDay: [],
  byHour: Array(24).fill(0),
  byWeekday: Array(7).fill(0),
  topProducts: [],
});

/**
 * Clics del rango: serie diaria, por hora del día, por día de la semana,
 * por vendedor, productos más consultados, y el total del periodo anterior
 * (misma duración, justo antes) para mostrar la variación.
 *
 * @param rangeOrDays  número de días hasta hoy, o { from, to } en "YYYY-MM-DD"
 */
export const loadClickStats = async (shop, timeZone, rangeOrDays = DEFAULT_PERIOD) => {
  const range = resolveWindow(timeZone, rangeOrDays);
  const { from, to, days } = range;
  const previousFrom = shiftKey(from, -days);
  const previousTo = shiftKey(from, -1);

  try {
    const clicks = await db.vendorClick.findMany({
      where: {
        shop,
        createdAt: {
          gte: new Date(parseDay(previousFrom).getTime() - TZ_MARGIN_MS),
          lte: new Date(parseDay(to).getTime() + DAY_MS + TZ_MARGIN_MS),
        },
      },
      select: { createdAt: true, vendorPhone: true, productTitle: true },
      orderBy: { createdAt: "asc" },
    });

    const today = todayKey(timeZone);
    const countsByDay = new Map();
    const products = new Map();
    const byPhone = {};
    const byHour = Array(24).fill(0);
    const byWeekday = Array(7).fill(0);
    let total = 0;
    let previousTotal = 0;
    let todayCount = 0;

    for (const click of clicks) {
      const parts = partsIn(click.createdAt, timeZone);

      if (parts.key >= previousFrom && parts.key <= previousTo) {
        previousTotal += 1;
        continue;
      }
      if (parts.key < from || parts.key > to) continue;

      total += 1;
      countsByDay.set(parts.key, (countsByDay.get(parts.key) ?? 0) + 1);
      byHour[parts.hour] += 1;
      byWeekday[parts.weekday] += 1;
      if (parts.key === today) todayCount += 1;

      // Los clics vienen en orden ascendente: el último visto es el más reciente
      const entry = byPhone[click.vendorPhone] ?? { count: 0, lastClickAt: null };
      entry.count += 1;
      entry.lastClickAt = click.createdAt.toISOString();
      byPhone[click.vendorPhone] = entry;

      if (click.productTitle) {
        products.set(click.productTitle, (products.get(click.productTitle) ?? 0) + 1);
      }
    }

    const byDay = [];
    for (let i = 0; i < days; i += 1) {
      const key = shiftKey(from, i);
      byDay.push({ key, label: labelForKey(key, timeZone), count: countsByDay.get(key) ?? 0 });
    }

    const topProducts = [...products.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_PRODUCTS)
      .map(([title, count]) => ({ title, count }));

    return {
      ...range,
      total,
      previousTotal,
      today: todayCount,
      byPhone,
      byDay,
      byHour,
      byWeekday,
      topProducts,
    };
  } catch {
    // Las estadísticas son un extra: si fallan, el panel debe seguir abriendo
    return emptyStats(range);
  }
};
