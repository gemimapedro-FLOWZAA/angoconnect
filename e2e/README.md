# Testes E2E — AngoConnect

Suite Playwright que valida os 3 fluxos críticos da aplicação:

1. **`01-signup-to-search.spec.ts`** — Login → onboarding → search → reveal
   contacto → export para sequência.
2. **`02-builder-drag-drop.spec.ts`** — Outreach builder: reorder de steps,
   aplicar template, preview, activação.
3. **`03-crm-kanban.spec.ts`** — Drag entre colunas do Kanban + persistência
   no backend + abrir drawer com histórico.

## Pré-requisitos

Os testes correm a app real contra uma instância local do Supabase. Não
mockamos a base de dados — o objectivo é validar contratos ponta-a-ponta.

### 1. Supabase local a correr

```bash
supabase start
```

Anota o `service_role` key que o CLI devolve.

### 2. Aplicar migrations + seed

```bash
supabase migration up --local
psql "$(supabase status -o env | grep DB_URL)" -f supabase/seed.sql
```

### 3. Redis local (BullMQ)

```bash
docker run -d -p 6379:6379 redis:7-alpine
```

### 4. Worker BullMQ (opcional para os 3 testes actuais)

Os testes actuais não esperam por jobs do worker. Se mais tarde for adicionado
um teste que valide o pipeline outreach end-to-end, é necessário ter:

```bash
npm run worker
```

## Variáveis de ambiente

Adiciona ao `.env.local` (ou exporta no terminal antes de correr):

```bash
# Apontam para o Supabase local — NUNCA usar contra produção.
E2E_SUPABASE_URL=http://127.0.0.1:54321
E2E_SUPABASE_SERVICE_KEY=<service_role do `supabase status`>

# Opcional — default é http://localhost:3000.
E2E_BASE_URL=http://localhost:3000
```

> **Aviso**: a `E2E_SUPABASE_SERVICE_KEY` dá acesso admin total ao Supabase. O
> helper `e2e/helpers/db.ts` só é importado por ficheiros em `e2e/`. Nunca
> importes este módulo do código da app.

## Como rodar

```bash
# Suite completa (Playwright sobe o `npm run dev` automaticamente)
npm run e2e

# Um único teste
npm run e2e -- 01-signup

# Modo UI interactivo (debug visual)
npm run e2e:ui

# Modo headed + inspector
npx playwright test --debug 02-builder-drag-drop
```

Resultados ficam em `playwright-report/` (HTML) e `test-results/` (traces,
screenshots, vídeos quando falham).

## Estratégia de cleanup

Cada teste cria utilizadores e workspaces únicos (`e2e-<timestamp>-...`).
O hook `afterEach` apaga o utilizador via admin API; as FK em `workspaces`,
`deals`, etc. estão com `ON DELETE CASCADE`, então tudo o resto cai por
arrasto.

Se um teste crashar e deixar lixo, podes limpar manualmente:

```sql
delete from auth.users where email like 'e2e-%@example.test';
```

## Limitações conhecidas

- **Sem signup real via UI**: o fluxo de signup público requer email
  confirmation (Inbucket localmente, Mailgun em produção). Os testes saltam
  isto criando utilizadores com `email_confirm: true` via admin API. O
  fluxo UI de signup é validado por testes Vitest separados.
- **Sem testes mobile**: o Playwright config corre só Chromium desktop.
  Adicionar `Mobile Safari` quando o suporte mobile for declarado pronto.
- **Workers BullMQ**: testes que dependem de processamento assíncrono
  (envio real de emails, sync de eventos) ainda não estão no scope desta
  suite — ficam para M4.2.
