import { authenticate } from "../shopify.server";
import db from "../db.server";

const MAX_NAME_LENGTH = 80;
const MAX_PHONE_LENGTH = 20;

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

  // Sin número no hay nada que atribuir; se ignora en silencio
  if (!vendorPhone) {
    return new Response(null, { status: 204 });
  }

  await db.vendorClick.create({
    data: { shop, vendorPhone, vendorName },
  });

  return new Response(null, { status: 204 });
};
