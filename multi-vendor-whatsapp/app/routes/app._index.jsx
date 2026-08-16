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
  const errors = responseJson.data.metafieldsSet.userErrors;

  return { ok: errors.length === 0, errors, saved: cleanVendors };
};

export default function Index() {
  const { vendors: initialVendors } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const [vendors, setVendors] = useState(
    initialVendors.length > 0 ? initialVendors : [{ name: "", phone: "" }],
  );
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

  const updateVendor = (index, field, value) => {
    setVendors((current) =>
      current.map((v, i) => (i === index ? { ...v, [field]: value } : v)),
    );
  };

  const addVendor = () =>
    setVendors((current) => [...current, { name: "", phone: "" }]);

  const removeVendor = (index) =>
    setVendors((current) => current.filter((_, i) => i !== index));

  const saveVendors = () =>
    fetcher.submit({ vendors: JSON.stringify(vendors) }, { method: "POST" });

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

        <s-stack direction="block" gap="base">
          {vendors.map((vendor, index) => (
            <s-stack
              key={index}
              direction="inline"
              gap="base"
              alignItems="end"
            >
              <s-text-field
                label="Nombre"
                placeholder="Ej: María"
                value={vendor.name}
                onChange={(e) => updateVendor(index, "name", e.currentTarget.value)}
              ></s-text-field>
              <s-text-field
                label="Número de WhatsApp"
                placeholder="Ej: 50371234567"
                details="Código de país + número, solo dígitos"
                value={vendor.phone}
                onChange={(e) => updateVendor(index, "phone", e.currentTarget.value)}
              ></s-text-field>
              <s-button
                icon="delete"
                variant="tertiary"
                tone="critical"
                accessibilityLabel={`Eliminar vendedor ${index + 1}`}
                onClick={() => removeVendor(index)}
              ></s-button>
            </s-stack>
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
