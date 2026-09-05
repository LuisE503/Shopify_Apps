import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { loadConfig } from "../lib/config.server";
import { PERIODS, loadClickStats, normalizePeriod } from "../lib/stats.server";
import { WEEK_DAYS, toWeight } from "../lib/vendors";
import { BarChart, EmptyState, ShareList, StatTile } from "../components/charts";

const TOP_VENDORS = 8;

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const days = normalizePeriod(new URL(request.url).searchParams.get("days"));
  const config = await loadConfig(admin);
  const stats = await loadClickStats(session.shop, config.timeZone, days);

  return { days, vendors: config.vendors, timeZone: config.timeZone, stats };
};

const labelEveryFor = (days) => (days <= 7 ? 1 : days <= 30 ? 3 : 7);

const csvCell = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;

export default function Activity() {
  const { days, vendors, timeZone, stats } = useLoaderData();

  const deltaPercent =
    stats.previousTotal > 0
      ? Math.round(((stats.total - stats.previousTotal) / stats.previousTotal) * 100)
      : null;
  const perDay = stats.total > 0 ? (stats.total / days).toFixed(1) : "0";
  const bestDay = stats.byDay.reduce(
    (best, day) => (day.count > (best?.count ?? 0) ? day : best),
    null,
  );

  // Serie por hora: etiqueta cada 3 horas para que no choquen
  const hourItems = stats.byHour.map((count, hour) => ({
    key: `h${hour}`,
    label: `${hour}h`,
    count,
  }));
  const peakHour = hourItems.reduce(
    (best, item) => (item.count > (best?.count ?? 0) ? item : best),
    null,
  );

  // Lunes primero, como en el resto del panel
  const weekdayItems = WEEK_DAYS.map((day) => ({
    key: `d${day.value}`,
    label: day.label,
    count: stats.byWeekday[day.value] ?? 0,
  }));

  // Reparto real frente a la prioridad configurada (solo vendedores activos)
  const activeVendors = vendors.filter((v) => v.active);
  const totalWeight = activeVendors.reduce((sum, v) => sum + toWeight(v.weight), 0);
  const nameByPhone = new Map(vendors.map((v) => [v.phone, v.name]));
  const expectedByPhone = new Map(
    activeVendors.map((v) => [v.phone, totalWeight > 0 ? toWeight(v.weight) / totalWeight : null]),
  );
  const shareRows = Object.entries(stats.byPhone)
    .map(([phone, info]) => ({
      key: phone,
      phone,
      name: nameByPhone.get(phone) ?? `+${phone}`,
      count: info.count,
      expected: expectedByPhone.get(phone) ?? null,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_VENDORS);
  const topVendor = shareRows[0];

  const exportCsv = () => {
    const lines = [
      "fecha,clics",
      ...stats.byDay.map((day) => `${day.key},${day.count}`),
      "",
      "hora,clics",
      ...stats.byHour.map((count, hour) => `${hour},${count}`),
      "",
      "vendedor,telefono,clics",
      ...shareRows.map((row) => `${csvCell(row.name)},${row.phone},${row.count}`),
      "",
      "producto,clics",
      ...stats.topProducts.map((p) => `${csvCell(p.title)},${p.count}`),
    ];
    // BOM (U+FEFF) para que Excel abra los acentos correctamente
    const bom = String.fromCharCode(0xfeff);
    const blob = new Blob([bom + lines.join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `whatsapp-clics-${days}-dias.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <s-page heading="Actividad">
      {stats.total > 0 && (
        <s-button slot="secondary-actions" icon="export" onClick={exportCsv}>
          Exportar CSV
        </s-button>
      )}

      <s-section>
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-text>Periodo:</s-text>
          <s-button-group>
            {PERIODS.map((period) => (
              <s-button
                key={period}
                href={`/app/actividad?days=${period}`}
                variant={period === days ? "primary" : "secondary"}
              >
                {`${period} días`}
              </s-button>
            ))}
          </s-button-group>
          {timeZone && <s-text tone="neutral">{`Hora de ${timeZone}`}</s-text>}
        </s-stack>
      </s-section>

      {stats.total === 0 ? (
        <s-section>
          <EmptyState title={`Sin clics en los últimos ${days} días`}>
            Cuando un cliente pulse el botón de WhatsApp en tu tienda, aquí
            verás cuándo escriben, qué productos consultan y qué vendedor los
            atendió. Un clic es una conversación abierta, no una venta.
          </EmptyState>
        </s-section>
      ) : (
        <>
          <s-section>
            <div className="mvw-tiles">
              <StatTile
                label={`Clics en ${days} días`}
                value={stats.total}
                delta={{ percent: deltaPercent, label: `vs. ${days} días anteriores` }}
              />
              <StatTile label="Promedio por día" value={perDay} />
              <StatTile
                label="Mejor día"
                value={bestDay ? bestDay.count : 0}
                hint={bestDay ? bestDay.label : undefined}
              />
              <StatTile
                label="Hora con más clics"
                value={peakHour && peakHour.count > 0 ? peakHour.label : "—"}
                hint={peakHour && peakHour.count > 0 ? `${peakHour.count} clic(s)` : undefined}
              />
            </div>
          </s-section>

          <s-section heading="Clics por día">
            <BarChart
              items={stats.byDay}
              labelEvery={labelEveryFor(days)}
              height={130}
              ariaLabel={`${stats.total} clics en ${days} días`}
            />
          </s-section>

          <s-section heading="A qué hora escriben tus clientes">
            <s-paragraph>
              Úsalo para decidir los turnos: si la mayoría escribe por la
              noche, conviene que alguien esté atendiendo a esa hora.
            </s-paragraph>
            <BarChart
              items={hourItems}
              labelEvery={3}
              height={110}
              ariaLabel="Clics por hora del día"
            />
          </s-section>

          <s-section heading="Qué días escriben más">
            <BarChart
              items={weekdayItems}
              labelEvery={1}
              height={100}
              ariaLabel="Clics por día de la semana"
            />
          </s-section>

          {shareRows.length > 0 && (
            <s-section heading="Reparto entre vendedores">
              <s-paragraph>
                Lo que recibió cada vendedor frente a lo que le corresponde por
                su prioridad. Si un vendedor queda muy por debajo, revisa su
                horario o sus etiquetas.
              </s-paragraph>
              <ShareList rows={shareRows} total={stats.total} />
            </s-section>
          )}

          {stats.topProducts.length > 0 && (
            <s-section slot="aside" heading="Productos más consultados">
              <s-ordered-list>
                {stats.topProducts.map((product) => (
                  <s-list-item key={product.title}>
                    {product.title} · {product.count}
                  </s-list-item>
                ))}
              </s-ordered-list>
            </s-section>
          )}

          {topVendor && (
            <s-section slot="aside" heading="Vendedor con más clics">
              <s-text>
                <s-text type="strong">{topVendor.name}</s-text>
                {` · ${topVendor.count} clic(s) (${Math.round((topVendor.count / stats.total) * 100)} %)`}
              </s-text>
            </s-section>
          )}
        </>
      )}

      <s-section slot="aside" heading="Sobre estos datos">
        <s-unordered-list>
          <s-list-item>
            Se cuenta cada pulsación del botón de WhatsApp. La venta ocurre en
            WhatsApp y no se mide aquí.
          </s-list-item>
          <s-list-item>
            Las horas y los días se calculan en la zona horaria de tu tienda.
          </s-list-item>
          <s-list-item>
            Los datos se conservan 180 días. Exporta el CSV si quieres
            guardarlos más tiempo.
          </s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
