import { useEffect, useMemo, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

// La configuración vive en app-data metafields para que la Theme App Extension
// la lea desde Liquid (app.metafields.whatsapp_router.*) sin tocar el backend.
const METAFIELD_NAMESPACE = "whatsapp_router";
const VENDORS_KEY = "vendors";
const MESSAGE_KEY = "message";
const SAVE_BAR_ID = "vendors-save-bar";
const MIN_PHONE_DIGITS = 8;
const MAX_MESSAGE_LENGTH = 500;

const DEFAULT_MESSAGE = "Hola, me interesa este producto: {producto} - {url}";

// Ejemplo usado para previsualizar el mensaje y probar los números
const SAMPLE_PRODUCT = "Camiseta Azul";
const SAMPLE_URL = "https://tu-tienda.com/products/camiseta-azul";

const digitsOnly = (value) => String(value ?? "").replace(/\D/g, "");

// Se aceptan separadores comunes al escribir: +503 6860-2600, (503) 686 02600.
// Cualquier otro carácter (letras, símbolos) se marca como error visible.
const ALLOWED_PHONE_CHARS = /^[\d\s+().-]*$/;

const renderMessage = (template, product, url) =>
  String(template ?? "")
    .replaceAll("{producto}", product)
    .replaceAll("{url}", url);

// Normaliza un vendedor venido de la API (active ausente = activo)
const toVendor = (v) => ({
  name: String(v?.name ?? ""),
  phone: String(v?.phone ?? ""),
  active: v?.active !== false,
});

// Contador módulo-level: garantiza ids de fila únicos y estables para React.
// Los campos saved* guardan lo que está en Shopify para marcar qué fila cambió.
let rowIdCounter = 0;
const makeRows = (list) =>
  (list.length > 0 ? list : [{ name: "", phone: "", active: true }]).map(
    (v) => ({
      id: ++rowIdCounter,
      name: v.name ?? "",
      phone: v.phone ?? "",
      active: v.active !== false,
      savedName: v.name ?? "",
      savedPhone: v.phone ?? "",
      savedActive: v.active !== false,
    }),
  );

const isRowDirty = (row) =>
  row.name.trim() !== row.savedName ||
  row.phone.trim() !== row.savedPhone ||
  row.active !== row.savedActive;

// Firma de lo visible en pantalla, ignorando filas totalmente vacías
const visibleSignature = (rows) =>
  JSON.stringify(
    rows
      .map((r) => [r.name.trim(), r.phone.trim(), r.active])
      .filter(([name, phone]) => name || phone),
  );

const savedSignature = (saved) =>
  JSON.stringify(saved.map((v) => [v.name, v.phone, v.active]));

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const response = await admin.graphql(
    `#graphql
      query getWhatsappConfig($namespace: String!) {
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
  );
  const responseJson = await response.json();
  const installation = responseJson.data?.currentAppInstallation;
  const storedVendors = installation?.vendors?.jsonValue;

  return {
    vendors: Array.isArray(storedVendors) ? storedVendors.map(toVendor) : [],
    message: installation?.message?.value || DEFAULT_MESSAGE,
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
  const cleanVendors = (
    Array.isArray(payload?.vendors) ? payload.vendors : []
  )
    .map((v) => ({
      name: String(v?.name ?? "").trim(),
      phone: digitsOnly(v?.phone),
      active: v?.active !== false,
    }))
    .filter((v) => {
      if (!v.name || v.phone.length < MIN_PHONE_DIGITS) return false;
      if (seenPhones.has(v.phone)) return false;
      seenPhones.add(v.phone);
      return true;
    });

  const cleanMessage =
    String(payload?.message ?? "").trim().slice(0, MAX_MESSAGE_LENGTH) ||
    DEFAULT_MESSAGE;

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

export default function Index() {
  const { vendors: vendorsOnLoad, message: messageOnLoad } = useLoaderData();
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

      if (rowErrors.name || rowErrors.phone) {
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
    () => renderMessage(message, SAMPLE_PRODUCT, SAMPLE_URL),
    [message],
  );

  const activeCount = saved.filter((v) => v.active).length;

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
      <s-section heading="Vendedores de WhatsApp">
        <s-paragraph>
          Agrega los números de tus vendedores. Los clics de tus clientes en el
          botón &quot;Comprar por WhatsApp&quot; se repartirán equitativamente
          entre los vendedores activos (round robin).
        </s-paragraph>

        <s-stack direction="inline" gap="base" alignItems="center">
          <s-badge tone={activeCount > 0 ? "success" : "auto"}>
            {`${activeCount} activo(s) de ${saved.length} guardado(s)`}
          </s-badge>
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
            const rowErrors = validation.errors.get(row.id) ?? {};
            const phoneDigits = digitsOnly(row.phone);
            const canTest = !rowErrors.phone && phoneDigits.length >= MIN_PHONE_DIGITS;
            const testUrl = `https://wa.me/${phoneDigits}?text=${encodeURIComponent(previewMessage)}`;

            return (
              <s-box
                key={row.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack direction="block" gap="base">
                  <s-grid gridTemplateColumns="1fr 1fr" gap="base">
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
                      details="Código de país + número"
                      value={row.phone}
                      {...(rowErrors.phone ? { error: rowErrors.phone } : {})}
                      onInput={(e) =>
                        updateRow(row.id, "phone", e.currentTarget.value)
                      }
                    ></s-text-field>
                  </s-grid>

                  <s-stack direction="inline" gap="base" alignItems="center">
                    <s-switch
                      label="Activo"
                      checked={row.active}
                      onChange={(e) =>
                        updateRow(row.id, "active", e.currentTarget.checked)
                      }
                    ></s-switch>
                    {isRowDirty(row) && (
                      <s-badge tone="warning">Sin guardar</s-badge>
                    )}
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
                      onClick={() => removeRow(row.id)}
                    ></s-button>
                  </s-stack>
                </s-stack>
              </s-box>
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
          pulse el botón. Usa {"{producto}"} y {"{url}"} para insertar
          automáticamente el nombre del producto y su enlace.
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

        <s-box
          padding="base"
          background="subdued"
          borderRadius="base"
        >
          <s-stack direction="block" gap="small-300">
            <s-text type="strong">Vista previa</s-text>
            <s-text>{previewMessage}</s-text>
          </s-stack>
        </s-box>
      </s-section>

      <s-section slot="aside" heading="¿Cómo funciona?">
        <s-unordered-list>
          <s-list-item>
            Cada vendedor activo recibe los clics por turnos, de forma
            secuencial y equitativa.
          </s-list-item>
          <s-list-item>
            El número debe incluir el código de país, sin el signo +. Ejemplo
            para El Salvador: 50371234567.
          </s-list-item>
          <s-list-item>
            Usa &quot;Probar en WhatsApp&quot; para confirmar que el número es
            correcto antes de publicarlo en tu tienda.
          </s-list-item>
          <s-list-item>
            Desactiva a un vendedor cuando no esté disponible: deja de recibir
            clics sin perder su número.
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
