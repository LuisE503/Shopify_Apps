import { useState } from "react";
import { useLoaderData, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { loadConfig } from "../lib/config.server";
import { loadClickStats, todayKey } from "../lib/stats.server";
import { PERIODS, longLabelForKey, parseDay, resolveRange } from "../lib/periods";
import { WEEK_DAYS, toWeight } from "../lib/vendors";
import { BarChart, EmptyState, ShareList, StatTile } from "../components/charts";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const config = await loadConfig(admin);
  const today = todayKey(config.timeZone);
  const range = resolveRange(new URL(request.url).searchParams, today);
  const stats = await loadClickStats(session.shop, config.timeZone, range);

  return {
    range,
    today,
    vendors: config.vendors,
    timeZone: config.timeZone,
    stats,
  };
};

const labelEveryFor = (days) => {
  if (days <= 7) return 1;
  if (days <= 31) return 3;
  if (days <= 90) return 7;
  return 14;
};

const formatNumber = (value, digits = 0) =>
  Number(value).toLocaleString("es", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

export default function Activity() {
  const { range, today, vendors, timeZone, stats } = useLoaderData();
  const navigate = useNavigate();

  const isCustom = range.preset === null;
  const [customOpen, setCustomOpen] = useState(isCustom);
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);

  const days = stats.days;
  const validRange = Boolean(parseDay(from) && parseDay(to) && from <= to);
  const periodLabel = isCustom
    ? `del ${longLabelForKey(stats.from)} al ${longLabelForKey(stats.to)}`
    : `últimos ${days} días`;

  const deltaPercent =
    stats.previousTotal > 0
      ? Math.round(((stats.total - stats.previousTotal) / stats.previousTotal) * 100)
      : null;
  const averagePerDay = days > 0 ? stats.total / days : 0;
  const bestDay = stats.byDay.reduce(
    (best, day) => (day.count > (best?.count ?? 0) ? day : best),
    null,
  );

  // Reparto real frente al configurado. Los activos sin clics también salen:
  // ver un 0 % es precisamente lo que revela un problema de horario o etiqueta.
  const activeVendors = vendors.filter((v) => v.active);
  const totalWeight = activeVendors.reduce((sum, v) => sum + toWeight(v.weight), 0);
  const shareRows = activeVendors.map((vendor) => ({
    key: vendor.phone,
    name: vendor.name,
    phone: vendor.phone,
    count: stats.byPhone[vendor.phone]?.count ?? 0,
    expected: totalWeight > 0 ? toWeight(vendor.weight) / totalWeight : null,
  }));
  for (const [phone, info] of Object.entries(stats.byPhone)) {
    if (!activeVendors.some((v) => v.phone === phone)) {
      const known = vendors.find((v) => v.phone === phone);
      shareRows.push({
        key: phone,
        name: known ? `${known.name} (inactivo)` : `+${phone} (ya no está)`,
        phone,
        count: info.count,
        expected: null,
      });
    }
  }
  shareRows.sort((a, b) => b.count - a.count);
  const topVendor = shareRows[0]?.count > 0 ? shareRows[0] : null;

  const hourItems = stats.byHour.map((count, hour) => ({
    key: String(hour),
    label: `${hour}h`,
    count,
  }));
  const weekdayItems = WEEK_DAYS.map((day) => ({
    key: String(day.value),
    label: day.label,
    count: stats.byWeekday[day.value] ?? 0,
  }));
  const peakHour = hourItems.reduce(
    (best, item) => (item.count > (best?.count ?? 0) ? item : best),
    null,
  );

  const goToPreset = (preset) => navigate(`/app/actividad?days=${preset}`);
  const applyRange = () => {
    if (!validRange) return;
    navigate(`/app/actividad?from=${from}&to=${to}`);
  };

  const exportCsv = () => {
    const quote = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    const lines = [
      `Clics por día (${stats.from} a ${stats.to})`,
      "fecha,clics",
      ...stats.byDay.map((day) => `${day.key},${day.count}`),
      "",
      "Clics por hora del día",
      "hora,clics",
      ...stats.byHour.map((count, hour) => `${hour},${count}`),
      "",
      "Clics por vendedor",
      "vendedor,telefono,clics",
      ...shareRows.map((row) => `${quote(row.name)},${row.phone},${row.count}`),
      "",
      "Productos más consultados",
      "producto,clics",
      ...stats.topProducts.map((product) => `${quote(product.title)},${product.count}`),
    ];
    // BOM inicial: así Excel abre el archivo con acentos correctos
    const byteOrderMark = String.fromCharCode(0xfeff);
    const blob = new Blob([byteOrderMark + lines.join("\r\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `whatsapp-clics-${stats.from}_${stats.to}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <s-page heading="Actividad">
      {stats.total > 0 && (
        <s-button slot="secondary-actions" icon="export" onClick={exportCsv}>
          Exportar CSV
        </s-button>
      )}

      <s-section heading="Periodo">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-button-group>
              {PERIODS.map((preset) => (
                <s-button
                  key={preset}
                  variant={!isCustom && range.preset === preset ? "primary" : "secondary"}
                  onClick={() => goToPreset(preset)}
                >
                  {`${preset} días`}
                </s-button>
              ))}
              <s-button
                variant={isCustom ? "primary" : "secondary"}
                icon="calendar"
                onClick={() => setCustomOpen((open) => !open)}
              >
                Elegir fechas
              </s-button>
            </s-button-group>
            <s-text tone="neutral">
              {`Mostrando ${periodLabel} · ${days} día(s)${timeZone ? ` · hora de ${timeZone}` : ""}`}
            </s-text>
          </s-stack>

          {customOpen && (
            <s-stack direction="inline" gap="base" alignItems="end">
              <s-date-field
                label="Desde"
                value={from}
                allow={`--${today}`}
                onChange={(e) => setFrom(e.currentTarget.value)}
              ></s-date-field>
              <s-date-field
                label="Hasta"
                value={to}
                allow={`--${today}`}
                onChange={(e) => setTo(e.currentTarget.value)}
              ></s-date-field>
              <s-button
                variant="primary"
                onClick={applyRange}
                {...(validRange ? {} : { disabled: true })}
              >
                Aplicar
              </s-button>
              {!validRange && (
                <s-text tone="critical">La fecha inicial debe ser anterior a la final.</s-text>
              )}
            </s-stack>
          )}
        </s-stack>
      </s-section>

      {stats.total === 0 ? (
        <s-section>
          <EmptyState title="Sin clics en este periodo">
            Cuando un cliente pulse el botón de WhatsApp en tu tienda, aquí verás
            cuándo escriben, qué productos consultan y qué vendedor los atendió.
            Prueba con otro periodo o comprueba en Resumen que el botón está
            colocado.
          </EmptyState>
        </s-section>
      ) : (
        <>
          <s-section>
            <div className="mvw-tiles">
              <StatTile
                label={isCustom ? "Clics en el periodo" : `Clics en ${days} días`}
                value={formatNumber(stats.total)}
                delta={{ percent: deltaPercent, label: `vs. ${days} días anteriores` }}
              />
              <StatTile
                label="Promedio por día"
                value={formatNumber(averagePerDay, averagePerDay < 10 ? 1 : 0)}
                hint={bestDay ? `Mejor día: ${bestDay.label} (${bestDay.count})` : undefined}
              />
              <StatTile
                label="Hora con más clics"
                value={peakHour && peakHour.count > 0 ? peakHour.label : "—"}
                hint={
                  peakHour && peakHour.count > 0
                    ? `${peakHour.count} clic(s) a esa hora. Útil para armar turnos.`
                    : undefined
                }
                text
              />
              <StatTile
                label="Vendedor con más clics"
                value={topVendor ? topVendor.name : "—"}
                hint={topVendor ? `${topVendor.count} clic(s)` : undefined}
                text
              />
            </div>
          </s-section>

          <s-section heading="Clics por día">
            <BarChart
              items={stats.byDay}
              labelEvery={labelEveryFor(days)}
              height={120}
              ariaLabel={`${stats.total} clic(s) ${periodLabel}`}
            />
          </s-section>

          <s-section heading="A qué hora escriben tus clientes">
            <s-paragraph>
              Hora de tu tienda. Si la mayoría de clics llega fuera del horario de
              tus vendedores, ajusta sus turnos en Vendedores.
            </s-paragraph>
            <BarChart
              items={hourItems}
              labelEvery={3}
              height={100}
              ariaLabel="Clics por hora del día"
            />
          </s-section>

          <s-section heading="Qué días escriben">
            <BarChart
              items={weekdayItems}
              labelEvery={1}
              height={90}
              ariaLabel="Clics por día de la semana"
            />
          </s-section>

          <s-section heading="Reparto entre vendedores">
            <s-paragraph>
              La marca oscura indica lo que le corresponde a cada vendedor según su
              prioridad. Si la barra queda muy por debajo, algo lo está limitando:
              un horario estrecho, etiquetas o que estuvo inactivo.
            </s-paragraph>
            <ShareList rows={shareRows} total={stats.total} />
          </s-section>

          {stats.topProducts.length > 0 && (
            <s-section heading="Productos más consultados">
              <s-ordered-list>
                {stats.topProducts.map((product) => (
                  <s-list-item key={product.title}>
                    {product.title} · {product.count}
                  </s-list-item>
                ))}
              </s-ordered-list>
            </s-section>
          )}
        </>
      )}

      <s-section slot="aside" heading="Cómo leer estos datos">
        <s-unordered-list>
          <s-list-item>
            Un clic es una conversación abierta en WhatsApp, no una venta: la
            venta se cierra en el chat, fuera de Shopify.
          </s-list-item>
          <s-list-item>
            Las horas y los días se cuentan en la zona horaria de tu tienda.
          </s-list-item>
          <s-list-item>
            La variación compara con el periodo anterior de la misma duración.
          </s-list-item>
          <s-list-item>
            Los clics de más de 180 días se eliminan automáticamente.
          </s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
