import Stripe from 'stripe';

// Lazy initialization — evita falhar no `next build` quando STRIPE_SECRET_KEY
// não está definida no ambiente (collect page data executa o módulo).
let _client: Stripe | null = null;

function getClient(): Stripe {
  if (!_client) {
    const apiKey = process.env.STRIPE_SECRET_KEY;
    if (!apiKey) {
      throw new Error(
        'STRIPE_SECRET_KEY não está configurada. Define-a em .env.local ou nas env vars do deployment.'
      );
    }
    _client = new Stripe(apiKey, {
      apiVersion: '2025-02-24.acacia',
      typescript: true,
      appInfo: { name: 'AngoConnect', version: '0.1.0' },
    });
  }
  return _client;
}

// Proxy mantém a API existente (`stripe.X.Y(...)`) intacta enquanto adia a
// criação do cliente real até à primeira utilização em runtime.
export const stripe = new Proxy({} as Stripe, {
  get(_target, prop) {
    return Reflect.get(getClient(), prop, getClient());
  },
});
