/**
 * Periodos de la página de actividad. Módulo puro: lo usan el servidor
 * (para leer la URL) y el navegador (para pintar los botones), así que no
 * puede vivir junto al acceso a la base de datos.
 */

export const PERIODS = [7, 30, 90];
export const DEFAULT_PERIOD = 30;
export const MAX_RANGE_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const normalizePeriod = (value) => {
  const days = Number.parseInt(value, 10);
  return PERIODS.includes(days) ? days : DEFAULT_PERIOD;
};

/** "2026-09-05" -> Date a medianoche UTC, o null si no es una fecha válida. */
export const parseDay = (value) => {
  if (!DATE_PATTERN.test(String(value ?? ""))) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
};

export const formatDay = (date) => date.toISOString().slice(0, 10);

/** "2026-09-05" -> "5 sept" para encabezados de rango. */
export const longLabelForKey = (key) => {
  const date = parseDay(key);
  if (!date) return String(key ?? "");
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

/**
 * Resuelve el rango pedido en la URL: `from`/`to` (fechas) tienen prioridad
 * sobre `days` (preset). Devuelve siempre un rango válido y acotado.
 *
 * @returns {{ from: string, to: string, days: number, preset: number | null }}
 */
export const resolveRange = (searchParams, todayKey) => {
  const today = parseDay(todayKey) ?? new Date();
  const from = parseDay(searchParams.get("from"));
  const requestedTo = parseDay(searchParams.get("to"));
  // No hay clics del futuro: un "hasta" posterior a hoy se recorta a hoy
  const to = requestedTo && requestedTo > today ? today : requestedTo;

  if (from && to && from <= to) {
    const span = Math.min(
      MAX_RANGE_DAYS,
      Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1,
    );
    const boundedFrom = new Date(to.getTime() - (span - 1) * DAY_MS);
    return { from: formatDay(boundedFrom), to: formatDay(to), days: span, preset: null };
  }

  const days = normalizePeriod(searchParams.get("days"));
  const start = new Date(today.getTime() - (days - 1) * DAY_MS);
  return { from: formatDay(start), to: formatDay(today), days, preset: days };
};
