import { useEffect, useMemo, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

// Los números se guardan como app-data metafield (JSON) para que la
// Theme App Extension pueda leerlos desde Liquid sin llamadas al backend.
const METAFIELD_NAMESPACE = "whatsapp_router";
const METAFIELD_KEY = "vendors";
const SAVE_BAR_ID = "vendors-save-bar";
const MIN_PHONE_DIGITS = 8;

const digitsOnly = (value) => String(value ?? "").replace(/\D/g, "");

// Se aceptan separadores comunes al escribir: +503 6860-2600, (503) 686 02600.
// Cualquier otro carácter (letras, símbolos) se marca como error visible.
const ALLOWED_PHONE_CHARS = /^[\d\s+().-]*$/;

// Contador módulo-level: garantiza ids de fila únicos y estables para React.
// savedName/savedPhone guardan lo que está en Shopify para marcar qué fila cambió.
let rowIdCounter = 0;
const makeRows = (list) =>
  (list.length > 0 ? list : [{ name: "", phone: "" }]).map((v) => ({
    id: ++rowIdCounter,
    name: v.name ?? "",
    phone: v.phone ?? "",
    savedName: v.name ?? "",
    savedPhone: v.phone ?? "",
  }));

const isRowDirty = (row) =>
  row.name.trim() !== row.savedName || row.phone.trim() !== row.savedPhone;

// Firma de lo visible en pantalla, ignorando filas totalmente vacías
const visibleSignature = (rows) =>
  JSON.stringify(
    rows
      .map((r) => [r.name.trim(), r.phone.trim()])
      .filter(([name, phone]) => name || phone),
  );

const savedSignature = (saved) =>
  JSON.stringify(saved.map((v) => [v.name, v.phone]));

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const response = await admin.graphql(
    `#graphql
      query getVendors($namespace: String!, $key: String!) {
        currentAppInstallation {
          vendors: metafield(namespace: $namespace, key: $key) {
            jsonValue
          }
        }
      }`,
    { variables: { namespace: METAFIELD_NAMESPACE, key: METAFIELD_KEY } },
  );
  const responseJson = await response.json();

  return {
    vendors: responseJson.data.currentAppInstallation.vendors?.jsonValue ?? [],
  };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();

  let vendors;
  try {
    vendors = JSON.parse(formData.get("vendors"));
  } catch {
    return { ok: false, errors: [{ message: "Datos inválidos" }] };
  }

  // Red de seguridad del servidor: normaliza, valida y elimina duplicados.
  // La validación principal (con mensajes por campo) ocurre en el cliente.
  const seenPhones = new Set();
  const cleanVendors = vendors
    .map((v) => ({
      name: String(v.name ?? "").trim(),
      phone: digitsOnly(v.phone),
    }))
    .filter((v) => {
      if (!v.name || v.phone.length < MIN_PHONE_DIGITS) return false;
      if (seenPhones.has(v.phone)) return false;
      seenPhones.add(v.phone);
      return true;
    });

  const installResponse = await admin.graphql(
    `#graphql
      query {
        currentAppInstallation {
          id
        }
      }`,
  );
  const installId = (await installResponse.json()).data.currentAppInstallation
    .id;

  const response = await admin.graphql(
    `#graphql
      mutation saveVendors($metafields: [MetafieldsSetInput!]!) {
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
            key: METAFIELD_KEY,
            type: "json",
            value: JSON.stringify(cleanVendors),
          },
        ],
      },
    },
  );
  const responseJson = await response.json();
  const errors = responseJson.data?.metafieldsSet?.userErrors ?? [
    { message: "Respuesta inesperada de la API de Shopify" },
  ];

  return { ok: errors.length === 0, errors, saved: cleanVendors };
};

export default function Index() {
  const { vendors: vendorsOnLoad } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  // `saved` refleja lo que está en Shopify; `rows` lo que se está editando
  const [saved, setSaved] = useState(vendorsOnLoad);
  const [rows, setRows] = useState(() => makeRows(vendorsOnLoad));

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

      if (rowErrors.name || rowErrors.phone) {
        errors.set(row.id, rowErrors);
      }
    }

    const cleanList = filledRows.map((r) => ({
      name: r.name.trim(),
      phone: digitsOnly(r.phone),
    }));

    return { errors, cleanList, hasErrors: errors.size > 0 };
  }, [rows]);

  // "Hay cambios" = lo que se ve en pantalla difiere de lo guardado en Shopify
  const isDirty = useMemo(
    () => visibleSignature(rows) !== savedSignature(saved),
    [rows, saved],
  );

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
      setSaved(fetcher.data.saved);
      setRows(makeRows(fetcher.data.saved));
      shopify.toast.show(
        `Guardado: ${fetcher.data.saved.length} vendedor(es) activo(s)`,
      );
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
    setRows((current) => [...current, ...makeRows([{ name: "", phone: "" }])]);

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
      { vendors: JSON.stringify(validation.cleanList) },
      { method: "POST" },
    );
  };

  const handleDiscard = () => setRows(makeRows(saved));

  return (
    <s-page heading="Multi-Vendor WhatsApp Router">
      <s-section heading="Vendedores de WhatsApp">
        <s-paragraph>
          Agrega los números de tus vendedores. Los clics de tus clientes en el
          botón &quot;Comprar por WhatsApp&quot; se repartirán equitativamente
          entre ellos (round robin).
        </s-paragraph>

        <s-stack direction="inline" gap="base" alignItems="center">
          <s-badge tone={saved.length > 0 ? "success" : "auto"}>
            {`${saved.length} vendedor(es) activo(s)`}
          </s-badge>
          {isDirty && <s-badge tone="warning">Cambios sin guardar</s-badge>}
        </s-stack>

        {saved.length === 0 && (
          <s-banner heading="Aún no hay vendedores activos" tone="info">
            El botón de WhatsApp no aparecerá en tu tienda hasta que guardes al
            menos un vendedor.
          </s-banner>
        )}
        {fetcher.data && !fetcher.data.ok && (
          <s-banner heading="No se pudo guardar" tone="critical">
            Shopify rechazó el guardado. Intenta de nuevo; si el problema
            persiste, revisa los números ingresados.
          </s-banner>
        )}

        <s-stack direction="block" gap="base">
          {rows.map((row) => {
            const rowErrors = validation.errors.get(row.id) ?? {};
            return (
              <s-grid
                key={row.id}
                gridTemplateColumns="1fr 1fr 150px"
                gap="base"
                alignItems="start"
              >
                <s-text-field
                  label="Nombre"
                  placeholder="Ej: María"
                  value={row.name}
                  {...(rowErrors.name ? { error: rowErrors.name } : {})}
                  onInput={(e) =>
                    updateRow(row.id, "name", e.currentTarget.value)
                  }
                ></s-text-field>
                <s-text-field
                  label="Número de WhatsApp"
                  placeholder="Ej: 50371234567"
                  details="Código de país + número, solo dígitos"
                  value={row.phone}
                  {...(rowErrors.phone ? { error: rowErrors.phone } : {})}
                  onInput={(e) =>
                    updateRow(row.id, "phone", e.currentTarget.value)
                  }
                ></s-text-field>
                <s-box paddingBlockStart="large">
                  <s-stack direction="inline" gap="base" alignItems="center">
                    {isRowDirty(row) && (
                      <s-badge tone="warning">Sin guardar</s-badge>
                    )}
                    <s-button
                      icon="delete"
                      variant="tertiary"
                      tone="critical"
                      accessibilityLabel={`Eliminar vendedor ${row.name || "sin nombre"}`}
                      onClick={() => removeRow(row.id)}
                    ></s-button>
                  </s-stack>
                </s-box>
              </s-grid>
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
            Cada vendedor recibe los clics por turnos, de forma secuencial y
            equitativa.
          </s-list-item>
          <s-list-item>
            El número debe incluir el código de país, sin el signo +. Ejemplo
            para El Salvador: 50371234567.
          </s-list-item>
          <s-list-item>
            Al editar aparecerá la barra &quot;Guardar / Descartar&quot; arriba.
            Los cambios se aplican en tu tienda al instante después de guardar.
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
