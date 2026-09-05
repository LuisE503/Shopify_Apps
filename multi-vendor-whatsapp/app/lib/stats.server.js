/**
 * Estadísticas de clics leídas de la base de datos de la app.
 * Todo se agrupa en la zona horaria de la tienda: un clic a las 23:30 en
 * El Salvador es de ese día (y de esa hora), no del siguiente en UTC.
 */
import db from "../db.server";

export const PERIODS = [7, 30, 90];
export const DEFAULT_PERIOD = 30;
const TOP_PRODUCTS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
const INTL_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const normalizePeriod = (value) => {
  const days = Number.parseInt(value, 10);
  return PERIODS.includes(days) ? days : DEFAULT_PERIOD;
};

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

export const emptyStats = (days = DEFAULT_PERIOD) => ({
  days,
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
 * Clics del periodo: serie diaria, por hora del día, por día de la semana,
 * por vendedor, productos más consultados, y el total del periodo anterior
 * para mostrar la variación.
 */
export const loadClickStats = async (shop, timeZone, days = DEFAULT_PERIOD) => {
  const since = new Date(Date.now() - days * DAY_MS);
  const previousSince = new Date(Date.now() - 2 * days * DAY_MS);

  try {
    const [clicks, previousTotal] = await Promise.all([
      db.vendorClick.findMany({
        where: { shop, createdAt: { gte: since } },
        select: { createdAt: true, vendorPhone: true, productTitle: true },
        orderBy: { createdAt: "asc" },
      }),
      db.vendorClick.count({
        where: { shop, createdAt: { gte: previousSince, lt: since } },
      }),
    ]);

    const todayKey = partsIn(new Date(), timeZone).key;
    const countsByDay = new Map();
    const products = new Map();
    const byPhone = {};
    const byHour = Array(24).fill(0);
    const byWeekday = Array(7).fill(0);
    let today = 0;

    for (const click of clicks) {
      const parts = partsIn(click.createdAt, timeZone);
      countsByDay.set(parts.key, (countsByDay.get(parts.key) ?? 0) + 1);
      byHour[parts.hour] += 1;
      byWeekday[parts.weekday] += 1;
      if (parts.key === todayKey) today += 1;

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
    for (let i = days - 1; i >= 0; i -= 1) {
      const date = new Date(Date.now() - i * DAY_MS);
      const key = partsIn(date, timeZone).key;
      byDay.push({ key, label: dayLabel(date, timeZone), count: countsByDay.get(key) ?? 0 });
    }

    const topProducts = [...products.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_PRODUCTS)
      .map(([title, count]) => ({ title, count }));

    return {
      days,
      total: clicks.length,
      previousTotal,
      today,
      byPhone,
      byDay,
      byHour,
      byWeekday,
      topProducts,
    };
  } catch {
    // Las estadísticas son un extra: si fallan, el panel debe seguir abriendo
    return emptyStats(days);
  }
};
