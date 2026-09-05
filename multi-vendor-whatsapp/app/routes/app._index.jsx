import { useLoaderData, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  detectInstallation,
  loadConfig,
  themeEditorLinks,
} from "../lib/config.server";
import { loadClickStats } from "../lib/stats.server";
import {
  describeOpening,
  formatClock,
  isOnDuty,
  nextOpening,
  shopClock,
} from "../lib/vendors";
import { BarChart, EmptyState, StatTile } from "../components/charts";
import { SetupGuide } from "../components/setup-guide";

const OVERVIEW_DAYS = 30;
const MINI_CHART_DAYS = 7;

/**
 * Resumen: lo que un comerciante quiere ver en cinco segundos al entrar.
 * Las ediciones viven en sus propias páginas (Vendedores, Mensajes).
 */
export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  const [config, install] = await Promise.all([
    loadConfig(admin),
    detectInstallation(admin),
  ]);
  const stats = await loadClickStats(session.shop, config.timeZone, OVERVIEW_DAYS);

  return {
    shop: session.shop,
    vendors: config.vendors,
    clock: shopClock(config.timeZone),
    stats,
    install,
    editorLinks: themeEditorLinks(session.shop),
  };
};

export default function Overview() {
  const { shop, vendors, clock, stats, install, editorLinks } = useLoaderData();
  const revalidator = useRevalidator();

  const active = vendors.filter((v) => v.active);
  const onDuty = active.filter((v) => isOnDuty(v.hours, clock));
  const scheduled = active.filter((v) => v.hours);
  const opening =
    onDuty.length === 0 && scheduled.length > 0 ? nextOpening(scheduled, clock) : null;

  const deltaPercent =
    stats.previousTotal > 0
      ? Math.round(((stats.total - stats.previousTotal) / stats.previousTotal) * 100)
      : null;
  const lastWeek = stats.byDay.slice(-MINI_CHART_DAYS);
  const topProduct = stats.topProducts[0];
  const shopTime = formatClock(clock);

  let dutyHint = "Sin horarios: todos disponibles";
  if (scheduled.length > 0) {
    dutyHint = opening
      ? `Próxima apertura ${describeOpening(opening)}`
      : "Según los horarios configurados";
  }

  return (
    <s-page heading="Resumen">
      {active.length === 0 && (
        <s-banner heading="Ningún vendedor activo" tone="warning">
          El botón de WhatsApp no aparecerá en tu tienda hasta que guardes al
          menos un vendedor activo.{" "}
          <s-link href="/app/vendedores">Ir a Vendedores</s-link>
        </s-banner>
      )}

      <s-section heading="Hoy">
        <div className="mvw-tiles">
          <StatTile
            label="Clics hoy"
            value={stats.today}
            hint={shopTime ? `Hora de tu tienda: ${shopTime}` : undefined}
          />
          <StatTile
            label={`Clics en ${OVERVIEW_DAYS} días`}
            value={stats.total}
            delta={{ percent: deltaPercent, label: `vs. ${OVERVIEW_DAYS} días anteriores` }}
          />
          <StatTile
            label="Atendiendo ahora"
            value={`${onDuty.length} de ${active.length}`}
            hint={dutyHint}
          />
          <StatTile
            label="Producto más consultado"
            value={topProduct ? topProduct.title : "—"}
            text
            hint={
              topProduct
                ? `${topProduct.count} clic(s) en ${OVERVIEW_DAYS} días`
                : "Aún sin clics"
            }
          />
        </div>
      </s-section>

      <s-section heading={`Últimos ${MINI_CHART_DAYS} días`}>
        {stats.total === 0 ? (
          <EmptyState title="Aún no hay clics">
            En cuanto un cliente pulse el botón en tu tienda, aquí verás la
            actividad día a día.
          </EmptyState>
        ) : (
          <BarChart
            items={lastWeek}
            labelEvery={1}
            height={110}
            ariaLabel={`Clics de los últimos ${MINI_CHART_DAYS} días`}
          />
        )}
        <s-stack direction="inline" gap="base">
          <s-button variant="tertiary" href="/app/actividad">
            Ver la actividad completa
          </s-button>
        </s-stack>
      </s-section>

      <SetupGuide
        hasVendors={active.length > 0}
        links={editorLinks}
        storefront={`https://${shop}/collections/all`}
        install={install}
        onRefresh={() => revalidator.revalidate()}
        refreshing={revalidator.state === "loading"}
      />

      <s-section slot="aside" heading="Accesos rápidos">
        <s-stack direction="block" gap="base">
          <s-button href="/app/vendedores">Vendedores y horarios</s-button>
          <s-button href="/app/mensajes">Mensajes de WhatsApp</s-button>
          <s-button href="/app/actividad">Actividad y reportes</s-button>
          <s-button
            variant="tertiary"
            href={`https://${shop}/collections/all`}
            target="_blank"
          >
            Ver mi tienda
          </s-button>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="¿Cómo funciona?">
        <s-unordered-list>
          <s-list-item>
            Cada clic en el botón abre WhatsApp con el siguiente vendedor en
            turno, por orden y según su prioridad.
          </s-list-item>
          <s-list-item>
            Un clic es una conversación abierta, no una venta: la venta se
            cierra en WhatsApp.
          </s-list-item>
          <s-list-item>
            Los horarios y las etiquetas de cada vendedor deciden quién recibe
            qué; se configuran en Vendedores.
          </s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
