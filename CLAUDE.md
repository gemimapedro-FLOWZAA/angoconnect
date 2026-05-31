# AngoConnect — CLAUDE.md

## Divisão de poder

**Utilizador decide:**
- O quê construir (milestone, scope, prioridades)
- Regras de negócio (preços, planos, créditos, fluxos)
- Direcção estratégica (mercados, sectores, stack)
- Mudanças de plano (saltar fase, kill switch)

**Orquestrador decide:**
- Como decompor em sub-tarefas
- Qual agente invocar e em que ordem
- Contratos entre agentes (tipos partilhados, interfaces)
- Integração dos outputs dentro de um milestone aprovado
- Quando parar e perguntar vs continuar em modo autónomo

**Sub-agentes decidem:**
- Detalhes técnicos dentro do scope (selectors, libs, naming interno)
- Devolvem controlo ao orquestrador — nunca tomam decisões cross-agente

---

## Regra de operação

**Antes de cada milestone:** mostro o plano em 5-10 linhas (o que cada agente faz, dependências). O utilizador aprova ou ajusta. Só depois executo.

**Durante o milestone:** execução autónoma. Paro e pergunto apenas se aparecer algo fora do plano que afecte dados, segurança ou billing.

**No fim de cada milestone:** relatório inclui obrigatoriamente uma secção "decisões que tomei sem consultar" para rastreabilidade.

**Decisões irreversíveis ou que tocam produção:** paro sempre, mesmo a meio de um milestone.

---

## Stack (não negociável)

```
Frontend:  Next.js 14 (App Router) + TypeScript strict + Tailwind + shadcn/ui
Backend:   Next.js API Routes + Supabase (Postgres + Auth + RLS)
Dados:     Apify Platform (Actors Node.js/TypeScript)
Filas:     BullMQ + Redis (Upstash)
Email:     Resend
Billing:   Stripe (apiVersion: 2025-02-24)
Deploy:    Vercel + Supabase Cloud
IA:        Claude API (Anthropic) — copy generation
```

---

## Estrutura de pastas canónica

```
angoconnect/
├── app/
│   ├── (auth)/login/page.tsx
│   ├── (auth)/signup/page.tsx
│   ├── (dashboard)/
│   │   ├── layout.tsx
│   │   ├── search/page.tsx
│   │   ├── outreach/page.tsx
│   │   ├── crm/page.tsx
│   │   └── analytics/page.tsx
│   └── api/
│       ├── apify/webhook/route.ts
│       ├── apify/trigger/route.ts
│       ├── companies/route.ts
│       ├── contacts/route.ts
│       ├── sequences/route.ts
│       ├── billing/checkout/route.ts
│       └── billing/webhook/route.ts
├── apify-actors/
│   ├── irgc-scraper/
│   ├── linkedin-scraper/
│   ├── email-enricher/
│   ├── news-scraper/
│   └── bue-scraper/
├── lib/
│   ├── supabase/client.ts
│   ├── supabase/server.ts
│   ├── supabase/types.ts
│   ├── apify/client.ts
│   ├── apify/datasets.ts
│   ├── queue/workers/
│   ├── queue/jobs/
│   └── ai/copy-generator.ts
├── components/
│   ├── ui/
│   ├── companies/
│   ├── outreach/
│   └── crm/
└── supabase/
    ├── migrations/
    └── seed.sql
```

---

## Schema core do Supabase

```sql
-- Regra: sector, provincia, size são colunas nativas (não jsonb) porque são filtradas
-- jsonb apenas para dados ad-hoc sem query directa

workspaces        (id, name, plan, credits_remaining, created_at)
companies         (id, workspace_id NULLABLE, name, nif, sector, provincia,
                   size, website, source, extra jsonb, created_at)
contacts          (id, company_id, name, title, email, phone,
                   linkedin_url, confidence_score, created_at)
sequences         (id, workspace_id, name, status, steps jsonb[], created_at)
sequence_enrollments (contact_id, sequence_id, current_step,
                      status, scheduled_at)
email_events      (id, enrollment_id, type, timestamp)
credits_log       (id, workspace_id, amount, reason, timestamp)
subscriptions     (id, workspace_id, stripe_subscription_id,
                   plan, status, current_period_end)
```

`workspace_id` nullable em `companies` permite catálogo público partilhado.
Sectores válidos: oil_gas, construction, telecom, banking, insurance,
retail, agro, health, education, logistics, tech, government.

---

## Apify — convenções

- Cada Actor tem `package.json` próprio + `README.md` com instruções de deploy
- URL IRGC: **confirmar com utilizador antes de hardcodar** — não assumir
- Rate limit: máximo 1 req/segundo em sites angolanos
- Formato de output obrigatório de todos os Actors:

```typescript
interface IRGCDatasetItem {
  name: string
  nif: string | null
  sector: string | null
  provincia: string
  website: string | null
  source: 'irgc' | 'linkedin' | 'bue' | 'news' | 'manual'
  scraped_at: string  // ISO 8601
  raw: Record<string, unknown>  // dados originais sem transformação
}
```

- Erros de scraping guardados no Apify KeyValueStore, nunca silenciados
- Webhook para o backend após cada run com header `X-Apify-Secret`

---

## Segurança — regras não negociáveis

```typescript
// SEMPRE usar timingSafeEqual para comparar secrets de webhooks
import { timingSafeEqual } from 'crypto'

function verifyWebhookSecret(received: string, expected: string): boolean {
  const a = Buffer.from(received)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
```

- Nunca usar `===` para comparar secrets
- Nunca expor `SUPABASE_SERVICE_ROLE_KEY` no cliente
- Sempre validar `workspace_id` do JWT em cada API Route
- Validação com Zod em todos os endpoints que recebem input externo
- Sanitizar inputs antes de inserir no Postgres

---

## Convenções de código

- TypeScript strict sempre ligado — sem `any`
- Imports absolutos com `@` alias
- `async/await` — nunca `.then()` chains
- Respostas de API sempre em `{ data, error, meta }` format
- Commits em português: `"adiciona Actor IRGC com retry logic"`
- Cada novo módulo tem pelo menos 1 teste de integração

---

## Sub-agentes disponíveis

O orquestrador invoca estes agentes via Task tool. Podes invocar múltiplos em paralelo quando as tarefas são independentes.

---

### Agente 1 — Database Architect

```
És o Database Architect do AngoConnect.

Trabalhas exclusivamente com Supabase + Postgres.
Lê o CLAUDE.md antes de qualquer acção — o schema core e as
convenções estão definidos lá e não podes contradizê-los.

Responsabilidades:
- Criar e manter migrações SQL em supabase/migrations/ (numeradas: 001_, 002_)
- Implementar RLS policies para isolamento por workspace
- Gerar tipos TypeScript via: npx supabase gen types typescript
- Optimizar índices para queries de pesquisa (sector, provincia, name)
- Garantir que nenhuma migration quebra dados existentes

Regras:
- sector, provincia, size são colunas nativas — nunca mover para jsonb
- workspace_id nullable em companies é intencional (catálogo público)
- Testar RLS com dois utilizadores de workspaces diferentes antes de entregar
- Nunca fazer DROP sem migration de rollback documentada

Quando terminares, reporta ao orquestrador:
- Ficheiros criados/modificados
- Decisões que tomaste sem consultar
- O que precisas de outros agentes (se aplicável)

Tarefa actual:
[O ORQUESTRADOR PREENCHE AQUI]
```

---

### Agente 2 — Apify Data Engineer

```
És o Apify Data Engineer do AngoConnect.

Constróis e manténs todos os Actors de recolha de dados angolanos.
Lê o CLAUDE.md antes de qualquer acção — o formato de output
obrigatório e as convenções de rate limiting estão definidos lá.

Responsabilidades:
- Desenvolver Actors em Node.js/TypeScript para a Apify Platform
- Garantir output no formato IRGCDatasetItem definido no CLAUDE.md
- Implementar retry logic e error handling robusto
- Configurar webhooks para notificar o backend com X-Apify-Secret
- Respeitar rate limit de 1 req/segundo em sites angolanos
- Cada Actor tem package.json próprio e README.md com deploy instructions

Actors do projecto:
1. irgc-scraper      → registo comercial Angola (URL: confirmar antes)
2. linkedin-scraper  → decisores angolanos (filtro localização AO)
3. email-enricher    → padrões corporativos + verificação SMTP
4. news-scraper      → Jornal de Angola, Expansão AO
5. bue-scraper       → Balcão Único Empresas

Stack: Apify SDK v3, Playwright para JS-heavy sites,
Cheerio para sites estáticos.

Quando terminares, reporta ao orquestrador:
- Ficheiros criados/modificados
- Decisões que tomaste sem consultar (ex: URL assumida, mapeamentos)
- Dependências que o Backend Agent precisa de saber

Tarefa actual:
[O ORQUESTRADOR PREENCHE AQUI]
```

---

### Agente 3 — Backend API Engineer

```
És o Backend API Engineer do AngoConnect.

Constróis todas as API Routes Next.js e lógica de servidor.
Lê o CLAUDE.md antes de qualquer acção — as regras de segurança
(timingSafeEqual, workspace_id validation, Zod) são obrigatórias.

Responsabilidades:
- Criar API Routes RESTful em app/api/ com formato { data, error, meta }
- Implementar middleware de autenticação Supabase em cada route
- Sistema de créditos: dedução por contacto exportado, recarga via Stripe
- Stripe: checkout session, webhook (verificar assinatura), gestão de planos
- Resend: envio de emails de outreach com tracking de eventos
- BullMQ workers: jobs de outreach, enriquecimento assíncrono
- Processar webhooks Apify → sync Supabase (dedupe por nif ou lower(name)+provincia)
- Claude API: geração de copy de vendas personalizado

Segurança obrigatória:
- timingSafeEqual para todos os webhook secrets (ver CLAUDE.md)
- Nunca service_role key no cliente
- Sempre filtrar por workspace_id do JWT autenticado
- Zod em todos os endpoints com input externo

Dedupe de empresas: por NIF quando disponível,
fallback para (lower(name) + provincia).

Quando terminares, reporta ao orquestrador:
- Ficheiros criados/modificados
- Decisões que tomaste sem consultar
- Endpoints criados com método e path

Tarefa actual:
[O ORQUESTRADOR PREENCHE AQUI]
```

---

### Agente 4 — Frontend UI Engineer

```
És o Frontend UI Engineer do AngoConnect.

Constróis toda a interface da plataforma SaaS.
Inspiração visual: Apollo.io — limpo, profissional, denso em informação.
Lê o CLAUDE.md antes de qualquer acção.

Responsabilidades:
- Componentes React com shadcn/ui + Tailwind
- Server Components por defeito, Client Components só quando necessário
- Search & Discovery: filtros sidebar (sector, provincia, size, keyword)
  + tabela paginada + selecção múltipla + export para sequência
- Outreach Builder: drag-and-drop de steps, templates em PT, preview
- CRM Kanban: pipeline de deals com drag-and-drop
- Dashboard Analytics: métricas com Recharts (emails, aberturas, respostas)
- Header: barra de créditos restantes sempre visível
- WhatsApp Business: canal disponível no builder de sequências

Princípios:
- Português europeu/angolano em todos os textos da UI
- Loading states e error states em todos os componentes
- Mobile-first mas optimizado para desktop (a maioria usa desktop)
- Sem any types — usar tipos gerados pelo Supabase

Quando terminares, reporta ao orquestrador:
- Ficheiros criados/modificados
- Decisões de UX que tomaste sem consultar
- Componentes que dependem de endpoints do Backend Agent

Tarefa actual:
[O ORQUESTRADOR PREENCHE AQUI]
```

---

### Agente 5 — QA & Integration Tester

```
És o QA Engineer do AngoConnect.

Garantis que cada módulo funciona correctamente antes de avançar
para o milestone seguinte. Lê o CLAUDE.md antes de qualquer acção.

Responsabilidades:
- Testes de integração para API Routes (Vitest)
- Validar pipeline end-to-end: Actor Apify → webhook → Supabase
- Testar fluxo de outreach: enroll → send → track → follow-up
- Validar sistema de créditos: deduction, recarga, edge cases
- Testar isolamento por workspace (RLS — dois utilizadores distintos)
- Verificar assinatura de webhooks (Apify e Stripe)
- E2E com Playwright nos fluxos críticos: login, search, export, sequence

Checks obrigatórios antes de aprovar qualquer milestone:
- [ ] timingSafeEqual em uso em todos os webhook handlers
- [ ] workspace_id validado em todos os endpoints autenticados
- [ ] Nenhum any type no TypeScript (tsc --noEmit passa a zero erros)
- [ ] RLS impede acesso cross-workspace

Quando encontrares um problema, reporta ao orquestrador com:
- Descrição do bug
- Ficheiro e linha
- Solução proposta
- Agente responsável pela correcção

Tarefa actual:
[O ORQUESTRADOR PREENCHE AQUI]
```

---

## Plano de desenvolvimento

```
FASE 1 — Fundação de dados (Semanas 1-2)
  M1.1  Setup: Next.js + dependências + schema Supabase v1 + tipos TS
  M1.2  Actor IRGC + webhook handler + pipeline end-to-end
  M1.3  linkedin-scraper + email-enricher + API de enriquecimento

FASE 2 — Backend core (Semanas 3-4)
  M2.1  Auth + workspaces + RLS completo
  M2.2  Billing: Stripe checkout + webhook + gestão de planos
  M2.3  Motor de outreach: BullMQ + Resend + sequence engine

FASE 3 — Interface SaaS (Semanas 5-8)
  M3.1  Search & Discovery (filtros + tabela + export)
  M3.2  Outreach Builder (drag-and-drop + templates PT)
  M3.3  CRM Kanban + Dashboard Analytics
  M3.4  WhatsApp Business + Claude API copy generation

FASE 4 — Lançamento (Semanas 9-12)
  M4.1  QA completo + testes E2E
  M4.2  Deploy Vercel + Supabase Cloud + Sentry
```

---

## Estado do projecto

Última actualização: 2026-05-29
Fase actual: 4 — Lançamento
Milestone actual: M4.2 ✅ deploy-ready; deploy real depende do utilizador

**Concluído:**
- [x] M1.1 Setup inicial
- [x] M1.2 Actor IRGC + webhook
- [x] M1.0 Alinhamento ao CLAUDE.md (migration 0003, rename `apify-actors/`, shape flat, `timingSafeEqual`, header `X-Apify-Secret`, tabela `subscriptions`, `lib/supabase/types.ts`)
- [x] M1.3 LinkedIn + email enricher + trigger endpoint + webhook contact ingest + tabela `apify_runs`
- [x] M2.1 Auth + workspaces (RPC `create_workspace_with_owner` + middleware gate + páginas `(auth)/{login,signup,onboarding}` + `(dashboard)/search` placeholder + componentes UI mínimos + suite RLS isolation tests)
- [x] M2.2 Billing Stripe (migration 0006: RPC `add_credits` + `credits_for_plan` + trigger plan sync; endpoints `/api/billing/{checkout,portal,webhook}`; SSOT `lib/billing/plans.ts`; webhook handlers para `subscription.{created,updated,deleted}` + `invoice.payment_succeeded/failed`; página `(dashboard)/billing` com plan picker + portal)
- [x] M2.3 Motor de outreach (migration 0007: RPC `enrol_contacts_into_sequence` atómica com débito de créditos + `pause_enrolments` + `unenrol` + índice parcial `sequence_enrollments_due_idx`; BullMQ queue `sequence-runner` + worker standalone + cron drainer `/api/cron/process-sequences`; Resend integration com tracking + tags + webhook `/api/email/webhook` (svix HMAC); endpoints `/api/sequences/*` (POST create, PATCH update com lock se active+enrolled, POST enrol/pause/unenrol); páginas `(dashboard)/outreach/{,/new,/[id]}` com listagem + form de criação + detalhe placeholder)
- [x] M3.1 Search & Discovery (migration 0008: tabela `revealed_contacts` + RPC `reveal_contacts` que debita créditos; endpoints `GET /api/companies` com 9 filtros + paginação + sort; `GET /api/companies/:id` + `:id/contacts` com masking (`j***@s***.tld`, `+244 *** *** **`); `POST /api/companies/contacts-for-export` para preview de créditos; `POST /api/contacts/reveal`; `GET /api/sequences` listing; primitivos UI Checkbox/Sheet/Dialog/Pagination/MultiSelect/Table hand-rolled; feature components `companies/{filters-sidebar,companies-table,company-sheet,reveal-contact-button,export-to-sequence-dialog}`; página `(dashboard)/search` reescrita com URL state + debounced fetch + selecção multi-row + export modal)
- [x] M3.2 Outreach Builder (migration 0009: tabela `email_templates` com `workspace_id` nullable para system templates + função `extract_template_variables(text)` + trigger automático que popula `variables` jsonb no INSERT/UPDATE + 6 seeds PT-AO via INSERT ON CONFLICT idempotente (intro/follow_up/break_up/check_in); endpoints `/api/templates/*` (GET listing com `?includeSystem`, POST create, PATCH/DELETE com 403 SYSTEM_TEMPLATE, `/preview` sem auth com `DEFAULT_PREVIEW_SAMPLE_DATA`); `lib/templates/render.ts` partilhado; UI primitivos hand-rolled Tabs/DropdownMenu/Separator; builder drag-and-drop com `@dnd-kit/{core,sortable,utilities}` em `outreach/[id]/edit` (painel esquerdo sortable + tabs Editor/Preview à direita + template picker agrupado por categoria + preview debounced 400ms); `SelectedCompaniesProvider` no dashboard layout (sessionStorage) com `HeaderSelectionIndicator` (count + Limpar + Exportar via `?export=1` bridge); refactor `outreach/new` para criar draft + redirect ao builder)
- [x] M3.3 CRM Kanban + Analytics (migration 0010: tabela `deal_stages` com `workspace_id` NULLABLE para 7 system seeds (Novo/Contactado/Qualificado/Proposta/Negociação/Fechado-ganho/Fechado-perdido) com cores + CHECK `is_won XOR is_lost` + idempotência via UNIQUE parcial; tabela `deals` com UNIQUE (workspace,contact) + FK ON DELETE RESTRICT em stage_id; RPC `move_deal_to_stage` que actualiza status automaticamente conforme is_won/is_lost; trigger `handle_email_reply_create_deal` que cria deal automático em stage "Contactado" quando email_event 'replied' chega (com EXCEPTION handler para nunca quebrar o INSERT em email_events); endpoints `/api/deal-stages/*` + `/api/deals/*` (GET com nested contact/company/owner + filtros + paginação + sort) + `/api/analytics/overview` (9 queries em Promise.all: credits/contacts/emails com ratios/sequences/deals by_stage gap-filled/daily_email_series/top_sequences por reply_rate); UI Kanban com `@dnd-kit` cross-column drag + optimistic update + DragOverlay + busca client-side; DealDrawer com Sheet+Tabs Detalhes/Histórico (placeholder); NewDealDialog por UUID (sem search inline — M3.4); Analytics com Recharts LineChart/BarChart funil/BarChart top sequences/PieChart pipeline + 4 KPI cards com presets 7/30/90 dias; `Avatar`/`Skeleton` UI components; `formatAKZ` helper PT-PT com fallback `Kz X.XXX`)
- [x] M3.4 WhatsApp + IA copy (migration 0011: tabela `whatsapp_templates` (workspace_id NOT NULL + UNIQUE workspace+name+language) + `workspace_whatsapp_config` (PK por workspace, access_token sensitive) + view `workspace_whatsapp_config_safe` (sem access_token, com `access_token_status: '***'|NULL`) + ALTER `email_events.event_type` aceita 5 novos `wa_*` events + trigger `handle_email_reply_create_deal` actualizado para reagir a 'replied' OR 'wa_replied' + RPC `upsert_whatsapp_template` que força re-aprovação; `lib/whatsapp/client.ts` wrapper Meta Cloud API v20 + `lib/queue/jobs/send-whatsapp.ts` worker (template vs freeform com janela 24h) + cron drainer escolhe `send-email` vs `send-whatsapp` por step.channel; webhook `/api/whatsapp/webhook` GET handshake + POST com `x-hub-signature-256` HMAC SHA256; endpoints `/api/whatsapp/{config,templates,templates/:id}`; `lib/ai/copy-generator.ts` com Claude `claude-opus-4-5` + persona PT-AO + JSON parsing tolerante a fences; `/api/ai/generate-copy` (sem débito de créditos — benefício Pro); endpoints faltantes M3.3: `/api/contacts/search?q=` (ILIKE em name+email com escape de %_) e GET `/api/deals/:id` com `history: EmailEvent[]` (50 últimos eventos via enrolments do contact); UI: AI Copy Dialog com Tabs de 3 variantes (canal-aware: WhatsApp omite subject); canal WhatsApp activado no builder com contador 1024 chars + warning Meta 24h + dropdown templates aprovados; settings page `(dashboard)/settings/whatsapp` com onboarding form + connected view com webhook_url/verify_token copy buttons + tabela de templates locais; NewDealDialog reescrito com autocomplete debounced 300ms + navegação ↑↓Enter/Esc; DealDrawer tab Histórico lazy-load real via `/api/deals/:id`; `Timeline` UI primitivo novo; `+@anthropic-ai/sdk@^0.32.1`)
- [x] M4.1 QA completo (Vitest v2 + 33/33 testes verdes; Playwright config + 3 specs E2E; Sentry + bundle analyzer; RELEASE.md)
- [x] M4.2 Deploy-ready (build de produção verde: typecheck 0 erros + tests 33/33 + `next build` ✅; First Load JS shared 154kB; refactor de exports proibidos em route.ts → 3 novos helpers `lib/{crm,sequences,templates}/{shapes,schemas}.ts`; Stripe client com lazy init via Proxy; `app/api/health/route.ts`; `Dockerfile.worker` multi-stage alpine non-root + healthcheck; `railway.json`; `.github/workflows/ci.yml`; `RELEASE.md` ganhou Runbook 6-steps command-by-command — deploy real depende do user criar contas + credenciais externas)
- [ ] M4.2 Deploy produção

**Decisões pendentes de confirmação do utilizador:**
- Aplicar migrações 0003 + 0004 + 0005 + 0006 (`supabase db reset` ou `supabase migration up`)
- Stripe Dashboard: criar 3 products (Starter/Growth/Pro) + 3 prices recurring monthly; colar IDs em `STRIPE_PRICE_STARTER/GROWTH/PRO`
- Stripe Dashboard: activar Customer Portal em Settings → Billing → Customer portal (features: cancel, update payment, change plan)
- Stripe CLI para webhook local: `stripe listen --forward-to localhost:3000/api/billing/webhook` → copiar `whsec_...` para `STRIPE_WEBHOOK_SECRET`
- Redis local para BullMQ: `docker run -p 6379:6379 redis:7-alpine` (já em `.env.local` como `REDIS_URL=redis://localhost:6379`)
- Worker em paralelo ao dev: `npm run worker` noutro terminal (em prod Vercel, o cron `/api/cron/process-sequences` faz drainage minuto a minuto)
- Resend: domínio verificado em `RESEND_FROM_EMAIL` (senão Resend devolve 403); webhook via `npx svix listen --forward-to localhost:3000/api/email/webhook` ou ngrok
- `CRON_SECRET=$(openssl rand -hex 32)` em `.env.local` (e nas env vars do Vercel)
- Correr suite RLS: `supabase/tests/rls_isolation.sql` (com `psql`) para validar isolamento por workspace
- Activar provider Google OAuth no Supabase Dashboard + whitelist `http://localhost:3000/auth/callback` em Redirect URLs
- Gerar `APIFY_WEBHOOK_SECRET` (`openssl rand -hex 32`) e colocar em `.env.local` + Apify Console
- Confirmar selectors HTML do `guicheunico.gov.ao` (Apify Engineer marcou como "pendente validação")
- Configurar Actor IDs reais na env: `APIFY_ACTOR_IRGC`, `APIFY_ACTOR_LINKEDIN`, `APIFY_ACTOR_EMAIL_ENRICHER` (formato `username~actor-name`)
- LinkedIn Actor: configurar `LINKEDIN_COMPANY_ACTOR_ID` e `LINKEDIN_PEOPLE_ACTOR_ID` no Apify Console (defaults sugeridos no README: `dev_fusion/linkedin-company-scraper`, `apimaestro/linkedin-profile-scraper`)
- Email Enricher: validar que TCP 25 não está bloqueado no runner Apify (default em planos free)

**Hardening adiado para milestones futuros:**
- Rate limit do webhook + trigger endpoint (Upstash) — M2.3
- Idempotency-key via `resource.id` numa tabela `webhook_log` — M2.3
- Idempotency-key no trigger (dois POSTs idênticos disparam runs duplicados) — M2.3
- Batching dos selects de dedupe (companies + contacts) — quando volume crescer
- `companies.provincia` actualmente nullable na DB (sempre presente via Zod no insert) — endurecer para `NOT NULL` numa migration futura se desejado
- Regenerar `lib/supabase/types.ts` via `supabase gen types typescript --local` quando Supabase local estiver a correr (remover stubs manuais de `apify_runs`)

**Bloqueios actuais:**
- Nenhum

**Próximo passo:**
- Deploy real: seguir `RELEASE.md` secção "Runbook — comandos passo-a-passo". Tudo o que orquestrador podia preparar localmente está feito; criar contas externas (Supabase, Vercel, Stripe, Resend, Apify, Meta WhatsApp, Sentry, Railway), configurar env vars + webhooks, e correr smoke test fica do lado do utilizador (depende de credenciais de pagamento e acesso a Meta Business).
