import { useState, useEffect } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

// Los números se guardan como app-data metafield (JSON) para que la
// Theme App Extension pueda leerlos desde Liquid sin llamadas al backend.
const METAFIELD_NAMESPACE = "whatsapp_router";
const METAFIELD_KEY = "vendors";

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

  // Normaliza: nombre sin espacios sobrantes, teléfono solo dígitos
  // (formato wa.me: código de país + número, sin "+" ni espacios)
  const cleanVendors = vendors
    .map((v) => ({
      name: String(v.name ?? "").trim(),
      phone: String(v.phone ?? "").replace(/\D/g, ""),
    }))
    .filter((v) => v.name && v.phone.length >= 8);

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
  const { vendors: initialVendors } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  // Cada fila lleva un id estable para que React no confunda filas al eliminar
  const [vendors, setVendors] = useState(() => {
    const rows = initialVendors.length > 0 ? initialVendors : [{}];
    return rows.map((v, i) => ({
      id: i + 1,
      name: v.name ?? "",
      phone: v.phone ?? "",
    }));
  });
  const isSaving =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";

  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.data.ok) {
      shopify.toast.show("Vendedores guardados");
    } else {
      shopify.toast.show("Error al guardar, revisa los datos", {
        isError: true,
      });
    }
  }, [fetcher.data, shopify]);

  const updateVendor = (id, field, value) => {
    setVendors((current) =>
      current.map((v) => (v.id === id ? { ...v, [field]: value } : v)),
    );
  };

  const addVendor = () =>
    setVendors((current) => [
      ...current,
      {
        id: Math.max(0, ...current.map((v) => v.id)) + 1,
        name: "",
        phone: "",
      },
    ]);

  const removeVendor = (id) =>
    setVendors((current) => current.filter((v) => v.id !== id));

  const saveVendors = () =>
    fetcher.submit(
      {
        vendors: JSON.stringify(
          vendors.map(({ name, phone }) => ({ name, phone })),
        ),
      },
      { method: "POST" },
    );

  return (
    <s-page heading="Multi-Vendor WhatsApp Router">
      <s-button
        slot="primary-action"
        onClick={saveVendors}
        {...(isSaving ? { loading: true } : {})}
      >
        Guardar
      </s-button>

      <s-section heading="Vendedores de WhatsApp">
        <s-paragraph>
          Agrega los números de tus vendedores. Los clics de tus clientes en el
          botón &quot;Comprar por WhatsApp&quot; se repartirán equitativamente
          entre ellos (round robin).
        </s-paragraph>

        {fetcher.data?.ok && (
          <s-banner
            heading={`Guardado: ${fetcher.data.saved.length} vendedor(es) activo(s)`}
            tone="success"
          >
            Los clics del botón de WhatsApp ya se reparten entre estos números.
          </s-banner>
        )}
        {fetcher.data && !fetcher.data.ok && (
          <s-banner heading="No se pudo guardar" tone="critical">
            Revisa que cada vendedor tenga nombre y un número válido (mínimo 8
            dígitos).
          </s-banner>
        )}

        <s-stack direction="block" gap="base">
          {vendors.map((vendor) => (
            <s-grid
              key={vendor.id}
              gridTemplateColumns="1fr 1fr auto"
              gap="base"
              alignItems="start"
            >
              <s-text-field
                label="Nombre"
                placeholder="Ej: María"
                value={vendor.name}
                onChange={(e) =>
                  updateVendor(vendor.id, "name", e.currentTarget.value)
                }
              ></s-text-field>
              <s-text-field
                label="Número de WhatsApp"
                placeholder="Ej: 50371234567"
                details="Código de país + número, solo dígitos"
                value={vendor.phone}
                onChange={(e) =>
                  updateVendor(vendor.id, "phone", e.currentTarget.value)
                }
              ></s-text-field>
              <s-box paddingBlockStart="large">
                <s-button
                  icon="delete"
                  variant="tertiary"
                  tone="critical"
                  accessibilityLabel={`Eliminar vendedor ${vendor.name || "sin nombre"}`}
                  onClick={() => removeVendor(vendor.id)}
                ></s-button>
              </s-box>
            </s-grid>
          ))}
        </s-stack>

        <s-stack direction="inline" gap="base">
          <s-button icon="plus" onClick={addVendor}>
            Agregar vendedor
          </s-button>
          <s-button
            variant="primary"
            onClick={saveVendors}
            {...(isSaving ? { loading: true } : {})}
          >
            Guardar
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
            Los cambios se aplican en tu tienda al instante después de guardar.
          </s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
