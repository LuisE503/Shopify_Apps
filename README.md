# Shopify Apps

Monorepo de apps de Shopify.

## Apps

| App | Descripción | Estado |
|-----|-------------|--------|
| [multi-vendor-whatsapp](multi-vendor-whatsapp/) | Multi-Vendor WhatsApp Order Router — reemplaza el botón "Añadir al carrito" por "Comprar por WhatsApp" y distribuye los clics entre varios vendedores con round robin. Suscripción de $19.99/mes vía Shopify Billing API. | En desarrollo |

## Desarrollo

Cada app es un proyecto independiente de Shopify CLI (plantilla React Router + Prisma). Para trabajar en una app:

```bash
cd multi-vendor-whatsapp
npm install
npm run dev
```

Requisitos: Node >= 20.19, Shopify CLI (`npm i -g @shopify/cli`), una organización en el [Dev Dashboard](https://dev.shopify.com/dashboard) y una tienda de desarrollo.
