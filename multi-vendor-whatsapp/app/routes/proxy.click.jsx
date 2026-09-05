import { authenticate } from "../shopify.server";
import db from "../db.server";

const MAX_NAME_LENGTH = 80;
const MAX_PHONE_LENGTH = 20;
const MAX_PRODUCT_LENGTH = 160;

// Los clics de hace más de medio año no aportan al panel (muestra 30 días)
const RETENTION_DAYS = 180;
const PRUNE_PROBABILITY = 0.02;

/**
 * Registra un clic en el botón de WhatsApp.
 *
 * La tienda lo llama vía App Proxy (/apps/whatsapp-router/click), así que
 * Shopify firma la petición y `authenticate.public.appProxy` la verifica.
 * Responde 204 sin cuerpo: el navegador la envía con sendBeacon y no espera
 * respuesta, y nada en la tienda debe romperse si esto falla.
 */
export const action = async ({ request }) => {
  await authenticate.public.appProxy(request);

  const shop = new URL(request.url).searchParams.get("shop");
  if (!shop) {
    return new Response(null, { status: 400 });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return new Response(null, { status: 400 });
  }

  const vendorPhone = String(payload?.phone ?? "")
    .replace(/\D/g, "")
    .slice(0, MAX_PHONE_LENGTH);
  const vendorName = String(payload?.name ?? "")
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  const productTitle =
    String(payload?.product ?? "")
      .trim()
      .slice(0, MAX_PRODUCT_LENGTH) || null;

  // Sin número no hay nada que atribuir; se ignora en silencio
  if (!vendorPhone) {
    return new Response(null, { status: 204 });
  }

  await db.vendorClick.create({
    data: { shop, vendorPhone, vendorName, productTitle },
  });

  // Higiene de datos: de vez en cuando se borran los clics antiguos de esta
  // tienda. Va sin esperar y sin fallar: nunca debe retrasar la respuesta.
  if (Math.random() < PRUNE_PROBABILITY) {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    db.vendorClick
      .deleteMany({ where: { shop, createdAt: { lt: cutoff } } })
      .catch(() => {});
  }

  return new Response(null, { status: 204 });
};

// El proxy solo acepta POST; a un GET se le responde sin contenido
export const loader = () => new Response(null, { status: 405 });
