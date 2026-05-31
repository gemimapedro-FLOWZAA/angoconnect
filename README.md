# AngoConnect

Plataforma SaaS B2B de prospecção comercial para Angola. Permite a equipas de vendas (Sonangol, BAI, Unitel e outras) encontrar, qualificar e contactar empresas e decisores no mercado angolano.

## Stack

Next.js 14 (App Router) - TypeScript strict - Supabase (Auth + Postgres + RLS) - Stripe - Resend - BullMQ + Redis - Tailwind CSS + shadcn/ui.

## Correr localmente

```bash
cp .env.local.example .env.local
# preencher as variáveis de ambiente
npm install
npm run dev
```

A aplicação fica disponível em `http://localhost:3000`.

## Scripts

| Comando            | Descrição                              |
| ------------------ | -------------------------------------- |
| `npm run dev`      | Servidor de desenvolvimento (Next.js). |
| `npm run build`    | Build de produção.                     |
| `npm run start`    | Servidor de produção.                  |
| `npm run lint`     | ESLint.                                |
| `npm run typecheck`| Verificação de tipos TypeScript.       |

## Estrutura

```
app/                  Rotas (App Router)
  layout.tsx
  page.tsx
  globals.css
components/
  ui/                 Componentes shadcn/ui
lib/
  supabase/           Clientes browser, server, middleware e admin
  stripe.ts           Cliente Stripe
  resend.ts           Cliente Resend
  redis.ts            Connection partilhada para BullMQ
  api-response.ts     Helpers de resposta { data, error, meta }
  utils.ts            cn() helper
middleware.ts         Refresh de sessão Supabase em SSR
```

A pasta `supabase/` (migrations, seed) e o ficheiro `lib/supabase/types.ts` são geridos pelo Database Architect.

## Convenções

- Todas as respostas de API seguem o formato `{ data, error, meta }` via `lib/api-response.ts`.
- TypeScript em modo `strict` — sem `any`.
- Service-role do Supabase apenas em `lib/supabase/admin.ts` (server-side).
- Idioma do produto: português europeu/angolano.

## Próximos passos

1. Definir schema e RLS (Database Architect → `supabase/`).
2. Implementar autenticação (Supabase Auth + organizações multi-tenant).
3. Integrar Stripe (planos, checkout, webhooks).
4. Workers BullMQ para enrichment, scraping (Apify) e envio de emails (Resend).
