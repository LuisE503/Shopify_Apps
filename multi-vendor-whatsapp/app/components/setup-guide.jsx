import { useState } from "react";

/**
 * Guía de puesta en marcha con enlaces que abren el editor de temas con el
 * bloque ya seleccionado, y comprobación automática de si ya está colocado.
 * Es lo que más dudas genera al instalar la app ("no veo el botón").
 *
 * @param hasVendors   ya hay al menos un vendedor activo guardado
 * @param links        { addProductBlock, addCartBlock, activateFloat } o null
 * @param storefront   URL de la tienda para probar
 * @param install      resultado de detectInstallation, o null si no se pudo leer
 * @param onRefresh    vuelve a comprobar el tema
 * @param refreshing   true mientras se comprueba
 */
/* eslint-disable react/prop-types -- el proyecto es JavaScript y no usa
   prop-types; los props quedan documentados arriba */
export function SetupGuide({
  hasVendors,
  links,
  storefront,
  install,
  onRefresh,
  refreshing,
}) {
  // Sin datos del tema no se afirma nada: mejor callar que equivocarse
  const placement = (found) => {
    if (!install) return null;
    if (!found) return <s-badge tone="warning">Pendiente</s-badge>;
    return (
      <s-badge tone="success">
        {found.published
          ? `Instalado en «${found.theme}»`
          : `Instalado en «${found.theme}» (tema no publicado)`}
      </s-badge>
    );
  };

  // Lo imprescindible: vendedores y el botón de producto. El resto es opcional.
  const essentialsDone = hasVendors && Boolean(install?.productBlock);

  // Con lo esencial hecho, la guía se aparta: una línea y un enlace para verla
  const [showStepsAnyway, setShowStepsAnyway] = useState(false);

  if (essentialsDone && !showStepsAnyway) {
    const extras = [
      install?.floatEmbed ? "flotante activo" : null,
      install?.cartBlock ? "pedido en el carrito activo" : null,
    ].filter(Boolean);
    return (
      <s-section heading="Puesta en marcha">
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-badge tone="success">Todo listo</s-badge>
          <s-text>
            {`Vendedores guardados y botón colocado en tu tema${extras.length ? ` (${extras.join(", ")})` : ""}. Tus clientes ya pueden escribirte.`}
          </s-text>
          <s-button variant="tertiary" onClick={() => setShowStepsAnyway(true)}>
            Ver los pasos
          </s-button>
        </s-stack>
      </s-section>
    );
  }

  const step = (number, done, text, badge, action) => (
    <s-stack direction="inline" gap="base" alignItems="center">
      <s-badge tone={done ? "success" : "info"}>{number}</s-badge>
      <s-text>{text}</s-text>
      {badge}
      {action}
    </s-stack>
  );

  const openEditor = (href, label) =>
    links && href ? (
      <s-button variant="secondary" href={href} target="_blank">
        {label}
      </s-button>
    ) : null;

  return (
    <s-section heading="Puesta en marcha">
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-badge tone={hasVendors ? "success" : "warning"}>1</s-badge>
          <s-text>
            {hasVendors
              ? "Vendedores guardados."
              : "Guarda al menos un vendedor activo."}
          </s-text>
          {!hasVendors && (
            <s-button variant="secondary" href="/app/vendedores">
              Ir a Vendedores
            </s-button>
          )}
        </s-stack>

        {step(
          2,
          Boolean(install?.productBlock),
          "Coloca el botón en la página de producto.",
          placement(install?.productBlock),
          !install?.productBlock &&
            openEditor(links?.addProductBlock, "Abrir el editor con el bloque"),
        )}

        {step(
          3,
          Boolean(install?.floatEmbed),
          "Opcional: activa el botón flotante en toda la tienda.",
          placement(install?.floatEmbed),
          !install?.floatEmbed &&
            openEditor(links?.activateFloat, "Activar botón flotante"),
        )}

        {step(
          4,
          Boolean(install?.cartBlock),
          "Opcional: botón de pedido en la página del carrito (envía todos los productos de una vez).",
          placement(install?.cartBlock),
          !install?.cartBlock &&
            openEditor(links?.addCartBlock, "Abrir el editor con el bloque"),
        )}

        <s-stack direction="inline" gap="base" alignItems="center">
          <s-badge tone="info">5</s-badge>
          <s-text>Pruébalo en tu tienda como lo vería un cliente.</s-text>
          <s-button variant="tertiary" href={storefront} target="_blank">
            Ver mi tienda
          </s-button>
        </s-stack>

        <s-stack direction="inline" gap="base" alignItems="center">
          <s-button
            variant="tertiary"
            icon="refresh"
            onClick={onRefresh}
            {...(refreshing ? { loading: true } : {})}
          >
            Volver a comprobar
          </s-button>
          <s-text tone="neutral">
            {install
              ? "Recuerda pulsar Guardar en el editor de temas: sin guardar, el bloque no queda colocado."
              : "En el editor de temas: página de producto → Agregar bloque → Aplicaciones → Botón de WhatsApp. El flotante está en Incrustaciones de aplicación."}
          </s-text>
        </s-stack>
      </s-stack>
    </s-section>
  );
}
/* eslint-enable react/prop-types */
