# AngoConnect — Checklist de Release

Documento de referência para cada release pré-produção. Marca os passos à
medida que os concluis e mantém este ficheiro actualizado entre releases.

> **Regra**: nenhuma release vai para produção sem todos os checks da
> secção **Pré-deploy** verdes. Em caso de falha pós-deploy, executa a
> secção **Rollback**.

---

## Pré-deploy

### Base de dados

- [ ] Todas as migrations aplicadas (`supabase migration up --linked`)
- [ ] Suite RLS verde: `psql "$DATABASE_URL" -f supabase/tests/rls_isolation.sql`
- [ ] Backup do schema actual gerado: `supabase db dump --schema public > backup-$(date +%Y%m%d).sql`
- [ ] Tipos TS sincronizados: `npx supabase gen types typescript --linked > lib/supabase/types.ts`

### Variáveis de ambiente (Vercel + `.env.local`)

#### Supabase

- [ ] `NEXT_PUBLIC_SUPABASE_URL`
- [ ] `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- [ ] `SUPABASE_SERVICE_ROLE_KEY` (apenas server — nunca expor)

#### Stripe (production)

- [ ] `STRIPE_SECRET_KEY` (live mode)
- [ ] `STRIPE_WEBHOOK_SECRET` (do endpoint de produção)
- [ ] `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (live)
- [ ] `STRIPE_PRICE_STARTER`
- [ ] `STRIPE_PRICE_GROWTH`
- [ ] `STRIPE_PRICE_PRO`

#### Email (Resend)

- [ ] `RESEND_API_KEY`
- [ ] `RESEND_FROM_EMAIL` (domínio verificado no Resend dashboard)
- [ ] `RESEND_FROM_NAME`
- [ ] `RESEND_WEBHOOK_SECRET`

#### Apify

- [ ] `APIFY_TOKEN`
- [ ] `APIFY_WEBHOOK_SECRET` (mesmo valor configurado no Apify Console)
- [ ] `APIFY_ACTOR_IRGC`, `APIFY_ACTOR_LINKEDIN`, `APIFY_ACTOR_EMAIL_ENRICHER`

#### IA

- [ ] `ANTHROPIC_API_KEY`

#### WhatsApp (Meta)

- [ ] `META_APP_SECRET` (para verificação de webhook)
- [ ] `WHATSAPP_DEFAULT_LANGUAGE` (ex: `pt_BR` para fallback Meta)
- [ ] Webhook configurado no Meta App Dashboard

#### Infra

- [ ] `REDIS_URL` (Upstash production — `rediss://...`)
- [ ] `CRON_SECRET` (32 bytes random — `openssl rand -hex 32`)
- [ ] `NEXT_PUBLIC_APP_URL` (sem trailing slash)
- [ ] `WORKER_CONCURRENCY` (default 5)

#### Sentry

- [ ] `NEXT_PUBLIC_SENTRY_DSN` (DSN do projecto Production no Sentry)
- [ ] `SENTRY_ORG` e `SENTRY_PROJECT` (para upload de sourcemaps)
- [ ] `SENTRY_AUTH_TOKEN` (apenas no Vercel — não no `.env.local`)

### Integrações externas

- [ ] **Stripe**: webhook configurado para `${APP_URL}/api/billing/webhook`
  - Events: `customer.subscription.{created,updated,deleted}`,
    `invoice.payment_{succeeded,failed}`
- [ ] **Stripe Customer Portal**: activado em Settings → Billing → Customer
  portal (features: cancel, update payment, change plan)
- [ ] **Apify**: webhook configurado para `${APP_URL}/api/apify/webhook`
  com header `X-Apify-Secret`
- [ ] **Resend**: webhook configurado para `${APP_URL}/api/email/webhook`
  com signing secret
- [ ] **Meta WhatsApp**: webhook configurado para `${APP_URL}/api/whatsapp/webhook`
  com `META_APP_SECRET`
- [ ] **Google OAuth**: provider activado no Supabase Dashboard;
  redirect URIs incluem `${APP_URL}/auth/callback`
- [ ] **Sentry**: alertas configurados para erros novos (Slack, email)

### Testes

- [ ] `npm run typecheck` — 0 erros
- [ ] `npm test` — todos os testes Vitest passam (unit + integration)
- [ ] `npm run e2e` — todos os 3 fluxos críticos passam:
  - [ ] `01-signup-to-search`
  - [ ] `02-builder-drag-drop`
  - [ ] `03-crm-kanban`
- [ ] `npm run lint` — sem warnings novos
- [ ] Suite RLS isolation verde contra Supabase de staging

### Performance

- [ ] `npm run analyze` corrido — bundle First Load JS < 250kB por rota crítica
  - `/search`, `/outreach/*`, `/crm`, `/analytics`
- [ ] Bundle splitting verificado: `recharts` carregado apenas na rota
  `/analytics`, `@dnd-kit` apenas em `/outreach/edit` e `/crm`
- [ ] Lighthouse (production build local): performance ≥ 80
- [ ] Core Web Vitals nas rotas críticas:
  - [ ] LCP < 2.5s
  - [ ] INP < 200ms
  - [ ] CLS < 0.1

### Segurança

- [ ] `timingSafeEqual` em uso em todos os webhook handlers (Stripe, Apify,
  Resend, Meta)
- [ ] Nenhum `SUPABASE_SERVICE_ROLE_KEY` exposto em código cliente
  (grep `lib/` e `components/` antes do deploy)
- [ ] CSP headers configurados se aplicável
- [ ] Rate limits revistos para endpoints sensíveis (login, signup, reveal)

---

## Deploy

- [ ] PR aprovado e merged para `main`
- [ ] Vercel build verde (verificar tab Deployments)
- [ ] Migrations aplicadas em Supabase production:
  `supabase db push --linked`
- [ ] Cron job `/api/cron/process-sequences` activo (Vercel Cron, schedule
  `* * * * *`, header `Authorization: Bearer ${CRON_SECRET}`)
- [ ] Worker BullMQ deployado (Railway / Fly.io / Render com `npm run worker`)
- [ ] DNS `angoconnect.app` aponta para Vercel (CNAME ou A records)
- [ ] SSL cert válido (Vercel auto-provisioned)

---

## Pós-deploy (smoke test)

Validações manuais nas primeiras 30 minutos:

- [ ] **Auth**: signup novo → email de confirmação chega → login funciona
- [ ] **Workspace**: onboarding cria workspace e recebe créditos de bónus
- [ ] **Search**: filtros sector + provincia retornam resultados
- [ ] **Reveal**: revelar contacto debita 1 crédito (verifica `credits_log`)
- [ ] **Outreach**: criar sequência draft → activar
- [ ] **CRM**: drag de deal entre stages persiste (refresh confirma)
- [ ] **Billing**: checkout em test mode com cartão `4242 4242 4242 4242`
- [ ] **Sentry**: dispara um erro de teste e confirma chegada no dashboard
- [ ] **Stripe webhook**: verifica deliverability nas primeiras 24h
  (Dashboard → Developers → Webhooks → Attempts)
- [ ] **Logs Vercel**: sem erros 5xx ou crashes recorrentes
- [ ] **Métricas Supabase**: connection pool não saturado, query latency
  estável

---

## Monitorização contínua

- [ ] Sentry: rever issues novas semanalmente
- [ ] Stripe: deliverability de webhooks ≥ 99% (alertar em < 95%)
- [ ] Resend: bounce rate < 5%, spam rate < 0.1%
- [ ] Vercel Analytics: P95 TTFB nas API routes críticas
- [ ] Supabase Advisor: rever advisors mensalmente
  (`mcp__claude_ai_Supabase__get_advisors`)

---

## Rollback

Em caso de regressão grave:

1. **Vercel revert**: Dashboard → Deployments → escolher último deployment
   verde → Promote to Production. Confirma que o cron secret continua igual.
2. **Migration rollback**: cada `supabase/migrations/0XXX_*.sql` tem secção
   `-- ROLLBACK` comentada. Aplicar manualmente via `psql`. Confirmar com a
   equipa que não houve writes que dependam do schema novo antes de reverter.
3. **Worker rollback**: redeploy do worker para a tag anterior
   (Railway/Fly/Render mantêm histórico).
4. **Comunicação**: se o downtime exceder 5 minutos, mostrar banner aos
   utilizadores ou enviar status update via email/Twitter.
5. **Post-mortem**: documentar em `docs/postmortems/YYYY-MM-DD-<slug>.md`
   após o incidente — root cause, timeline, action items.

---

## Runbook — comandos passo-a-passo

Sequência completa para um primeiro deploy. Salta os passos que já tiveres
feito.

### 1) Supabase remoto

```bash
# Cria projecto em https://supabase.com/dashboard (escolhe região europeia
# mais próxima de Angola, ex: West Europe)
# Depois liga localmente:
supabase login
supabase link --project-ref <project-ref>

# Aplica todas as migrations 0001 → 0011 ao remoto.
supabase db push

# Corre suite RLS contra remoto.
DB_URL="$(supabase status -o env | grep DATABASE_URL | cut -d= -f2-)" \
  psql "$DB_URL" -f supabase/tests/rls_isolation.sql

# Regenera tipos TS (substitui stubs manuais).
supabase gen types typescript --linked > lib/supabase/types.ts

# Activa Google OAuth provider no Dashboard Supabase:
# Authentication > Providers > Google > Enable + colar Client ID/Secret.
# Em "Redirect URLs" adicionar: https://APP_URL/auth/callback
```

### 2) Vercel — frontend + cron

```bash
# Liga o repo a um projecto Vercel.
vercel link
# Sefa as 17+ env vars (CLI ou Dashboard > Settings > Environment Variables):
vercel env add NEXT_PUBLIC_SUPABASE_URL production
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY production
vercel env add SUPABASE_SERVICE_ROLE_KEY production
vercel env add STRIPE_SECRET_KEY production
vercel env add STRIPE_WEBHOOK_SECRET production
vercel env add NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY production
vercel env add STRIPE_PRICE_STARTER production
vercel env add STRIPE_PRICE_GROWTH production
vercel env add STRIPE_PRICE_PRO production
vercel env add RESEND_API_KEY production
vercel env add RESEND_FROM_EMAIL production
vercel env add RESEND_WEBHOOK_SECRET production
vercel env add APIFY_TOKEN production
vercel env add APIFY_WEBHOOK_SECRET production
vercel env add APIFY_ACTOR_IRGC production
vercel env add APIFY_ACTOR_LINKEDIN production
vercel env add APIFY_ACTOR_EMAIL_ENRICHER production
vercel env add REDIS_URL production
vercel env add ANTHROPIC_API_KEY production
vercel env add META_APP_SECRET production
vercel env add CRON_SECRET production
vercel env add NEXT_PUBLIC_SENTRY_DSN production
vercel env add SENTRY_AUTH_TOKEN production

# Deploy preview primeiro.
vercel deploy

# Smoke test do preview (ver secção pós-deploy abaixo). Depois promote:
vercel promote <preview-url>

# Confirma que o cron Vercel está activo (Dashboard > Settings > Crons):
# Deve mostrar GET /api/cron/process-sequences a cada minuto.
```

### 3) Worker BullMQ — Railway

```bash
# Cria projecto em https://railway.app
railway login
railway link
# Adiciona variáveis (subset das do Vercel):
railway variables set NEXT_PUBLIC_SUPABASE_URL=...
railway variables set SUPABASE_SERVICE_ROLE_KEY=...
railway variables set REDIS_URL=...
railway variables set RESEND_API_KEY=...
railway variables set RESEND_FROM_EMAIL=...
railway variables set RESEND_FROM_NAME=...
railway variables set APIFY_TOKEN=...
railway variables set WORKER_CONCURRENCY=5

# Deploy do worker (usa Dockerfile.worker via railway.json).
railway up

# Confirma logs:
railway logs --tail
# Deve mostrar: "Worker sequence-runner started"
```

### 4) Webhooks externos

```bash
# Stripe
# Dashboard > Developers > Webhooks > Add endpoint:
#   URL: https://APP_URL/api/billing/webhook
#   Events: customer.subscription.{created,updated,deleted}, invoice.payment_{succeeded,failed}
#   Copia o whsec_... para STRIPE_WEBHOOK_SECRET (Vercel).

# Apify
# Console > Webhooks > Create webhook:
#   URL: https://APP_URL/api/apify/webhook
#   Event: ACTOR.RUN.{SUCCEEDED,FAILED,ABORTED}
#   Headers: X-Apify-Secret: <APIFY_WEBHOOK_SECRET>

# Resend
# Dashboard > Webhooks > Add Endpoint:
#   URL: https://APP_URL/api/email/webhook
#   Events: email.{delivered,opened,clicked,bounced,complained}
#   Copia o whsec_... para RESEND_WEBHOOK_SECRET (Vercel).

# Meta WhatsApp
# Configurar webhook em Meta App > WhatsApp > Configuration:
#   URL: https://APP_URL/api/whatsapp/webhook
#   Verify Token: <gerado pelo nosso /api/whatsapp/config endpoint>
#   Subscribe field: messages
```

### 5) Sentry

```bash
# Cria projecto Next.js em https://sentry.io
# Copia DSN para NEXT_PUBLIC_SENTRY_DSN (Vercel).
# Gera auth token (User Settings > Auth Tokens > Create) com scope project:write
# e cola em SENTRY_AUTH_TOKEN (Vercel) — habilita source maps upload no build.
```

### 6) Smoke test pós-deploy

```bash
# Healthcheck básico (não toca em Supabase).
curl https://APP_URL/api/health
# Esperado: { "status": "ok", "version": "0.1.0", ... }

# Fluxo manual:
# 1) Visitar https://APP_URL/signup → criar conta com email real.
# 2) Confirmar email no Inbox (Supabase envia magic link).
# 3) Onboarding → criar workspace.
# 4) Search → confirmar que catálogo público mostra empresas (corre IRGC scraper primeiro).
# 5) Reveal contact → deve debitar 1 crédito.
# 6) Criar sequence draft → activar.
# 7) Enrol contacto → confirmar que cron + worker enviam email.
# 8) Verificar Sentry recebeu ping de teste (forçar erro com /404).

# Cron manual (testar drainer):
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://APP_URL/api/cron/process-sequences
```

---

## Histórico de releases

| Data | Versão | Notas | Responsável |
|------|--------|-------|-------------|
| _adicionar_ | _v0.1.0_ | _Lançamento inicial — M1 a M3 + M4.1_ | _–_ |
