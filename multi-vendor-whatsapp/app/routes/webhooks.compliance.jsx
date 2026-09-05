import { authenticate } from "../shopify.server";
import db from "../db.server";

/**
 * Webhooks de privacidad obligatorios para publicar en la Shopify App Store
 * (GDPR / CCPA). Shopify exige que existan y que verifiquen la firma HMAC;
 * `authenticate.webhook` responde 401 por sí solo si la firma no es válida.
 *
 * La app no guarda datos de clientes finales: solo los números de los
 * vendedores del comerciante (en metafields de Shopify) y clics anónimos en
 * nuestra base de datos. Por eso las solicitudes sobre clientes no tienen
 * nada que exportar ni borrar, y la eliminación de la tienda borra sus clics.
 */
export const action = async ({ request }) => {
  const { shop, topic } = await authenticate.webhook(request);

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST":
    case "CUSTOMERS_REDACT":
      // Sin información de clientes almacenada: no hay nada que hacer
      break;

    case "SHOP_REDACT":
      // Llega 48 h después de desinstalar: se elimina todo lo de la tienda.
      // No se hace al desinstalar para que, si reinstala, conserve su historial.
      await db.vendorClick.deleteMany({ where: { shop } });
      await db.session.deleteMany({ where: { shop } });
      break;

    default:
      break;
  }

  return new Response();
};
