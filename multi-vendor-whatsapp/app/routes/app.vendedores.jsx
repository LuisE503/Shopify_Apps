import { useEffect, useMemo, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { loadConfig, saveConfig } from "../lib/config.server";
import { loadClickStats } from "../lib/stats.server";
import {
  SAMPLE_PRICE,
  SAMPLE_PRODUCT,
  SAMPLE_QUANTITY,
  SAMPLE_SKU,
  SAMPLE_URL,
  digitsOnly,
  formatClock,
  isOnDuty,
  isRowCustomized,
  makeRows,
  moveItem,
  renderMessage,
  resetRowConfig,
  savedSignature,
  shopClock,
  toHours,
  toWeight,
  validateVendorRows,
  visibleSignature,
} from "../lib/vendors";
import { useSaveBar, useSaveShortcut } from "../lib/use-save-bar";
import { VendorRow } from "../components/vendor-row";
import { ResetConfigAction } from "../components/reset-config";

const SAVE_BAR_ID = "vendors-save-bar";
const RESET_MODAL_ID = "vendors-reset-modal";
const STATS_DAYS = 30;

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const config = await loadConfig(admin);
  const stats = await loadClickStats(session.shop, config.timeZone, STATS_DAYS);

  return {
    vendors: config.vendors,
    message: config.message,
    timeZone: config.timeZone,
    clock: shopClock(config.timeZone),
    byPhone: stats.byPhone,
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

  return saveConfig(admin, { vendors: payload?.vendors ?? [] });
};

export default function Vendors() {
  const { vendors: vendorsOnLoad, message, timeZone, clock, byPhone } =
    useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  // `saved` refleja lo que está en Shopify; `rows` lo que se edita
  const [saved, setSaved] = useState(vendorsOnLoad);
  const [rows, setRows] = useState(() => makeRows(vendorsOnLoad));

  const isSaving =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";

  const validation = useMemo(() => validateVendorRows(rows), [rows]);

  // "Hay cambios" = lo que se ve en pantalla difiere de lo guardado en Shopify
  const isDirty = useMemo(
    () => visibleSignature(rows) !== savedSignature(saved),
    [rows, saved],
  );

  const previewMessage = useMemo(
    () =>
      renderMessage(message, {
        producto: SAMPLE_PRODUCT,
        precio: SAMPLE_PRICE,
        cantidad: SAMPLE_QUANTITY,
        sku: SAMPLE_SKU,
        url: SAMPLE_URL,
      }),
    [message],
  );

  const isCustomized = rows.some(
    (r) => (r.name.trim() || r.phone.trim()) && isRowCustomized(r),
  );

  // Reparto teórico entre los activos, según la prioridad de cada uno
  const totalWeight = rows
    .filter((r) => r.active && (r.name.trim() || r.phone.trim()))
    .reduce((sum, r) => sum + toWeight(r.weight), 0);

  const activeCount = saved.filter((v) => v.active).length;
  const scheduledCount = saved.filter((v) => v.active && v.hours).length;
  const shopTime = formatClock(clock);

  useSaveBar(shopify, SAVE_BAR_ID, isDirty);

  // Tras un guardado exitoso, sincroniza la UI con lo que quedó en Shopify
  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.data.ok) {
      const vendors = fetcher.data.saved.vendors;
      setSaved(vendors);
      setRows(makeRows(vendors));
      const activos = vendors.filter((v) => v.active).length;
      shopify.toast.show(`Guardado: ${activos} vendedor(es) activo(s)`);
    } else {
      shopify.toast.show("No se pudo guardar", { isError: true });
    }
  }, [fetcher.data, shopify]);

  const updateRow = (id, field, value) =>
    setRows((current) =>
      current.map((r) => (r.id === id ? { ...r, [field]: value } : r)),
    );

  const addRow = () =>
    setRows((current) => [
      ...current,
      ...makeRows([{ name: "", phone: "", active: true }]),
    ]);

  const removeRow = (id) =>
    setRows((current) => current.filter((r) => r.id !== id));

  const moveRow = (id, delta) =>
    setRows((current) => {
      const from = current.findIndex((r) => r.id === id);
      return moveItem(current, from, from + delta);
    });

  const resetRow = (id) =>
    setRows((current) =>
      current.map((r) => (r.id === id ? resetRowConfig(r) : r)),
    );

  const resetAll = () => {
    setRows((current) => current.map(resetRowConfig));
    shopify.toast.show("Configuración recomendada aplicada. Guarda para confirmar.");
  };

  const handleSave = () => {
    if (validation.errors.size > 0) {
      shopify.toast.show("Corrige los campos marcados en rojo", {
        isError: true,
      });
      return;
    }
    fetcher.submit(
      { payload: JSON.stringify({ vendors: validation.vendors }) },
      { method: "POST" },
    );
  };

  const handleDiscard = () => setRows(makeRows(saved));

  useSaveShortcut(isDirty ? handleSave : null);

  return (
    <s-page heading="Vendedores">
      <ResetConfigAction
        id={RESET_MODAL_ID}
        visible={isCustomized}
        heading="Volver a la configuración recomendada"
        items={[
          "Todos los vendedores activos",
          "Prioridad normal para todos (reparto por igual)",
          "Sin horarios ni etiquetas: todos atienden todo",
        ]}
        onApply={resetAll}
      />

      <s-section heading="Vendedores de WhatsApp">
        <s-paragraph>
          Agrega los números de tus vendedores. Los clics de tus clientes se
          reparten entre los vendedores activos que estén en su horario, según
          su prioridad y sus etiquetas.
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
                stats={byPhone[digitsOnly(row.phone)] ?? null}
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
            Etiquetas: si un vendedor solo atiende productos con cierta
            etiqueta (por ejemplo &quot;electrónica&quot;), esos productos van
            solo a él; el resto va a los vendedores sin etiquetas.
          </s-list-item>
          <s-list-item>
            Usa &quot;Probar en WhatsApp&quot; para confirmar que el número es
            correcto antes de publicarlo en tu tienda.
          </s-list-item>
          <s-list-item>
            Las flechas cambian el orden: el primero es el respaldo cuando el
            navegador no puede ejecutar el reparto.
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
