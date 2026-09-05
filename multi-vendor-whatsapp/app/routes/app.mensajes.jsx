import { useEffect, useMemo, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { loadConfig, saveConfig } from "../lib/config.server";
import {
  CART_PLACEHOLDERS,
  DEFAULT_CART_MESSAGE,
  DEFAULT_MESSAGE,
  MAX_MESSAGE_LENGTH,
  PRODUCT_PLACEHOLDERS,
  SAMPLE_CART,
  SAMPLE_PRICE,
  SAMPLE_PRODUCT,
  SAMPLE_QUANTITY,
  SAMPLE_SKU,
  SAMPLE_URL,
  formatPrice,
  renderMessage,
} from "../lib/vendors";
import { useSaveBar, useSaveShortcut } from "../lib/use-save-bar";
import { ResetConfigAction } from "../components/reset-config";

const SAVE_BAR_ID = "messages-save-bar";
const RESET_MODAL_ID = "messages-reset-modal";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const config = await loadConfig(admin);

  return {
    shop: session.shop,
    message: config.message,
    cartMessage: config.cartMessage,
    currencyCode: config.currencyCode,
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

  return saveConfig(admin, {
    message: payload?.message ?? "",
    cartMessage: payload?.cartMessage ?? "",
  });
};

// Chips "+ {producto}": el comerciante no tiene por qué saber la sintaxis
const appendPlaceholder = (current, key) => {
  const trimmed = current.replace(/\s+$/, "");
  return `${trimmed}${trimmed ? " " : ""}{${key}}`;
};

/**
 * Editor de una plantilla: aviso de marcadores que faltan, área de texto,
 * chips para insertarlos, botón de mensaje recomendado y vista previa.
 */
/* eslint-disable react/prop-types -- el proyecto es JavaScript y no usa
   prop-types; los props se documentan por su nombre */
function TemplateEditor({
  label,
  rows,
  value,
  onChange,
  placeholders,
  required,
  requiredHelp,
  defaultValue,
  error,
  previewTitle,
  preview,
  extraActions,
}) {
  const missing = required.filter((key) => !value.includes(`{${key}}`));
  return (
    <>
      {value.trim() && missing.length > 0 && (
        <s-banner
          heading={`Tu mensaje no incluye ${missing.map((k) => `{${k}}`).join(" ni ")}`}
          tone="warning"
        >
          {requiredHelp}
        </s-banner>
      )}

      <s-text-area
        label={label}
        rows={rows}
        maxLength={MAX_MESSAGE_LENGTH}
        value={value}
        {...(error ? { error } : {})}
        onInput={(e) => onChange(e.currentTarget.value)}
      ></s-text-area>

      <s-stack direction="inline" gap="base" alignItems="center">
        {placeholders.map((key) => (
          <s-button
            key={key}
            variant="tertiary"
            onClick={() => onChange(appendPlaceholder(value, key))}
            {...(value.includes(`{${key}}`) ? { disabled: true } : {})}
          >
            {`+ {${key}}`}
          </s-button>
        ))}
        {value.trim() !== defaultValue && (
          <s-button variant="tertiary" icon="undo" onClick={() => onChange(defaultValue)}>
            Usar mensaje recomendado
          </s-button>
        )}
        {extraActions}
      </s-stack>

      <s-box padding="base" background="subdued" borderRadius="base">
        <s-stack direction="block" gap="small-300">
          <s-text type="strong">{previewTitle}</s-text>
          <div className="mvw-pre">
            <s-text>{preview}</s-text>
          </div>
        </s-stack>
      </s-box>
    </>
  );
}
/* eslint-enable react/prop-types */

export default function Messages() {
  const {
    shop,
    message: messageOnLoad,
    cartMessage: cartMessageOnLoad,
    currencyCode,
  } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  const [savedMessage, setSavedMessage] = useState(messageOnLoad);
  const [message, setMessage] = useState(messageOnLoad);
  const [savedCartMessage, setSavedCartMessage] = useState(cartMessageOnLoad);
  const [cartMessage, setCartMessage] = useState(cartMessageOnLoad);

  // Producto real elegido para la vista previa (null = ejemplo genérico)
  const [previewProduct, setPreviewProduct] = useState(null);

  const isSaving =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";

  const messageError = !message.trim()
    ? "Escribe el mensaje que recibirá tu vendedor"
    : null;
  const cartMessageError = !cartMessage.trim()
    ? "Escribe el mensaje del pedido"
    : null;

  const isDirty =
    message.trim() !== savedMessage || cartMessage.trim() !== savedCartMessage;
  const isCustomized =
    message.trim() !== DEFAULT_MESSAGE || cartMessage.trim() !== DEFAULT_CART_MESSAGE;

  const previewMessage = useMemo(
    () =>
      renderMessage(message, {
        producto: previewProduct?.title ?? SAMPLE_PRODUCT,
        precio: previewProduct?.price ?? SAMPLE_PRICE,
        cantidad: SAMPLE_QUANTITY,
        sku: previewProduct?.sku ?? SAMPLE_SKU,
        url: previewProduct?.url ?? SAMPLE_URL,
      }),
    [message, previewProduct],
  );
  const previewCartMessage = useMemo(
    () => renderMessage(cartMessage, SAMPLE_CART),
    [cartMessage],
  );

  useSaveBar(shopify, SAVE_BAR_ID, isDirty);

  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.data.ok) {
      const { message: savedText, cartMessage: savedCartText } = fetcher.data.saved;
      setSavedMessage(savedText);
      setMessage(savedText);
      setSavedCartMessage(savedCartText);
      setCartMessage(savedCartText);
      shopify.toast.show("Mensajes guardados");
    } else {
      shopify.toast.show("No se pudo guardar", { isError: true });
    }
  }, [fetcher.data, shopify]);

  const handleSave = () => {
    if (messageError || cartMessageError) {
      shopify.toast.show("Corrige los campos marcados en rojo", { isError: true });
      return;
    }
    fetcher.submit(
      {
        payload: JSON.stringify({
          message: message.trim(),
          cartMessage: cartMessage.trim(),
        }),
      },
      { method: "POST" },
    );
  };

  const handleDiscard = () => {
    setMessage(savedMessage);
    setCartMessage(savedCartMessage);
  };

  const resetAll = () => {
    setMessage(DEFAULT_MESSAGE);
    setCartMessage(DEFAULT_CART_MESSAGE);
    shopify.toast.show("Mensajes recomendados aplicados. Guarda para confirmar.");
  };

  useSaveShortcut(isDirty ? handleSave : null);

  const pickPreviewProduct = async () => {
    try {
      const selection = await shopify.resourcePicker({
        type: "product",
        multiple: false,
      });
      const product = selection?.[0];
      if (!product) return;

      const variant = product.variants?.[0];
      const hasVariants =
        (product.variants?.length ?? 0) > 1 &&
        variant?.title &&
        variant.title !== "Default Title";
      const variantId = String(variant?.id ?? "").split("/").pop();

      setPreviewProduct({
        title: hasVariants ? `${product.title} (${variant.title})` : product.title,
        price: variant?.price ? formatPrice(variant.price, currencyCode) : SAMPLE_PRICE,
        sku: variant?.sku || SAMPLE_SKU,
        url: `https://${shop}/products/${product.handle}${hasVariants && variantId ? `?variant=${variantId}` : ""}`,
      });
    } catch {
      // El comerciante cerró el selector sin elegir
    }
  };

  return (
    <s-page heading="Mensajes">
      <ResetConfigAction
        id={RESET_MODAL_ID}
        visible={isCustomized}
        heading="Volver a los mensajes recomendados"
        items={["Mensaje de producto recomendado", "Mensaje de pedido (carrito) recomendado"]}
        onApply={resetAll}
      />

      {fetcher.data && !fetcher.data.ok && (
        <s-banner heading="No se pudo guardar" tone="critical">
          Shopify rechazó el guardado. Intenta de nuevo.
        </s-banner>
      )}

      <s-section heading="Mensaje al pulsar el botón de un producto">
        <s-paragraph>
          Es el texto que aparece escrito en WhatsApp cuando el cliente pulsa
          el botón de un producto. Se rellenan solos: {"{producto}"} (con su
          talla o color), {"{precio}"}, {"{cantidad}"} (la que elija el
          cliente), {"{sku}"} y {"{url}"}.
        </s-paragraph>
        <TemplateEditor
          label="Plantilla del mensaje"
          rows={4}
          value={message}
          onChange={setMessage}
          placeholders={PRODUCT_PLACEHOLDERS}
          required={["producto", "url"]}
          requiredHelp={`Sin {producto} el vendedor no sabrá qué producto le interesa al cliente; sin {url} no podrá abrirlo. Añádelos con los botones de abajo.`}
          defaultValue={DEFAULT_MESSAGE}
          error={messageError}
          previewTitle={
            previewProduct ? "Vista previa con tu producto" : "Vista previa (producto de ejemplo)"
          }
          preview={previewMessage}
          extraActions={
            <>
              <s-button variant="tertiary" icon="product" onClick={pickPreviewProduct}>
                {previewProduct
                  ? "Cambiar producto de ejemplo"
                  : "Previsualizar con un producto real"}
              </s-button>
              {previewProduct && (
                <s-button variant="tertiary" icon="x" onClick={() => setPreviewProduct(null)}>
                  Volver al ejemplo
                </s-button>
              )}
            </>
          }
        />
      </s-section>

      <s-section heading="Mensaje para pedidos del carrito">
        <s-paragraph>
          Cuando el cliente tiene varios productos en el carrito, el botón de
          la página del carrito (y el flotante, fuera de las fichas de
          producto) envía el pedido completo. Se rellenan solos: {"{pedido}"}{" "}
          (un renglón por artículo con cantidad, variante y precio),{" "}
          {"{total}"}, {"{cantidad}"} (artículos en total) y {"{url}"} (un
          enlace que recrea el carrito para el vendedor).
        </s-paragraph>
        <TemplateEditor
          label="Plantilla del pedido"
          rows={4}
          value={cartMessage}
          onChange={setCartMessage}
          placeholders={CART_PLACEHOLDERS}
          required={["pedido"]}
          requiredHelp="Sin {pedido} el vendedor no verá qué productos quiere el cliente. Añádelo con el botón de abajo."
          defaultValue={DEFAULT_CART_MESSAGE}
          error={cartMessageError}
          previewTitle="Vista previa (carrito de ejemplo)"
          preview={previewCartMessage}
        />
      </s-section>

      <s-section slot="aside" heading="Consejos">
        <s-unordered-list>
          <s-list-item>
            Un saludo corto y el producto con su enlace es lo que mejor
            funciona: el vendedor entiende de un vistazo y responde rápido.
          </s-list-item>
          <s-list-item>
            El enlace del pedido recrea el carrito en tu tienda: el vendedor
            puede abrirlo, revisar existencias y cerrar el pago por donde
            acuerden.
          </s-list-item>
          <s-list-item>
            Los textos del botón (&quot;Comprar por WhatsApp&quot;, el aviso
            de disponibilidad) se editan en el editor de temas, por bloque.
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
