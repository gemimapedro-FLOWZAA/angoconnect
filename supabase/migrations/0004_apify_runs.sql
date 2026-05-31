-- ============================================================================
-- AngoConnect — Migration 0004 — Tabela apify_runs (audit trail de Apify)
-- ----------------------------------------------------------------------------
-- Esta migration cria a tabela `public.apify_runs`, que serve como audit trail
-- de todos os runs de Actors da Apify disparados pela aplicação.
--
-- Fluxo de vida de uma linha:
--   1. O endpoint `POST /api/apify/trigger` (M1.3) valida o caller (JWT +
--      workspace_id + Zod input + whitelist de actor_id) e faz INSERT inicial
--      com status = 'queued' e input = payload enviado ao Actor.
--   2. Logo a seguir ao dispatch, o backend faz UPDATE para colocar
--      `apify_run_id` (devolvido pela Apify) e `started_at`. O status passa a
--      'running' assim que a Apify confirma o arranque.
--   3. O webhook (`POST /api/apify/webhook`, X-Apify-Secret + timingSafeEqual)
--      actualiza `dataset_id`, `status` final ('succeeded' | 'failed' |
--      'aborted' | 'timed_out'), `finished_at`, `ingested_items` (após o
--      pipeline de ingest sincronizar Supabase) e `error_message` se aplicável.
--
-- Princípios assumidos (sem consulta):
--   * `apify_run_id` é nullable porque o INSERT acontece antes do dispatch
--     completar; a UNIQUE constraint só é violada se houver colisão real
--     entre runs já registados — IDs nulos não colidem entre si em Postgres.
--   * `triggered_by` referencia `public.profiles(id)` com ON DELETE SET NULL
--     para preservar o histórico mesmo que o utilizador seja apagado.
--   * UPDATE/DELETE ficam reservados ao `service_role` (webhooks server-side).
--     Não criamos policies de write para utilizadores autenticados — o
--     service_role faz bypass de RLS por defeito.
--   * INSERT autenticado é permitido a membros do workspace porque o caller
--     do endpoint `trigger` precisa de criar o row antes do dispatch; o
--     endpoint volta a validar o `workspace_id` contra o JWT por segurança em
--     profundidade.
--
-- Idempotência: usa `create table if not exists`, `create index if not exists`,
-- `drop policy if exists` e `drop trigger if exists` em todos os pontos.
-- Pode ser reaplicada em ambientes com dados sem efeitos colaterais.
--
-- Rollback documentado no fim do ficheiro (apenas referência, não executar).
-- ============================================================================


-- ============================================================================
-- 1) TABELA — apify_runs
-- ============================================================================

create table if not exists public.apify_runs (
  id              uuid primary key default gen_random_uuid(),

  -- Tenant a que o run pertence. Cascade preserva consistência se o workspace
  -- for apagado (cenário raro, mas evita rows órfãs).
  workspace_id    uuid not null
                  references public.workspaces(id) on delete cascade,

  -- Identificador lógico do Actor. A whitelist canónica vive no backend
  -- (POST /api/apify/trigger). Não criamos check constraint aqui de propósito,
  -- porque a lista de Actors vai evoluir e queremos evitar migrations só para
  -- isso. Valores correntes: 'irgc-scraper', 'linkedin-scraper',
  -- 'email-enricher', 'news-scraper', 'bue-scraper'.
  actor_id        text not null,

  -- Run ID atribuído pela Apify. Nullable até o dispatch confirmar; populado
  -- imediatamente a seguir. UNIQUE garante que cada run da Apify só é
  -- registado uma vez (idempotência para webhooks que possam retentar).
  apify_run_id    text,

  -- defaultDatasetId do run. Só fica populado quando a Apify devolve o run
  -- completo (durante o webhook ou via polling no fim).
  dataset_id      text,

  -- Estado do run. 'queued' é o estado inicial após INSERT, antes do dispatch.
  status          text not null default 'queued'
                  constraint apify_runs_status_check
                  check (
                    status in (
                      'queued',
                      'running',
                      'succeeded',
                      'failed',
                      'aborted',
                      'timed_out'
                    )
                  ),

  -- Input enviado ao Actor (JSON serializado). Guardado para auditoria e
  -- para suportar replays manuais em caso de falha.
  input           jsonb not null default '{}'::jsonb,

  started_at      timestamptz,
  finished_at     timestamptz,

  -- Items efectivamente ingeridos no Supabase após o webhook processar o
  -- dataset (depois de dedupe). Default 0 para simplificar UPSERTs parciais.
  ingested_items  int default 0
                  constraint apify_runs_ingested_items_nonneg_check
                  check (ingested_items >= 0),

  -- Mensagem de erro normalizada (se status in ('failed','aborted')).
  error_message   text,

  -- Profile que disparou o run via UI. SET NULL preserva o histórico do
  -- run mesmo que o utilizador seja removido.
  triggered_by    uuid
                  references public.profiles(id) on delete set null,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.apify_runs is
  'Audit trail dos runs Apify disparados pela app. INSERT inicial via POST /api/apify/trigger (queued); UPDATE com apify_run_id e started_at após dispatch; UPDATE final via webhook com dataset_id, status, finished_at, ingested_items.';

comment on column public.apify_runs.actor_id is
  'Identificador lógico do Actor Apify. Whitelist canónica validada no backend (irgc-scraper, linkedin-scraper, email-enricher, news-scraper, bue-scraper).';

comment on column public.apify_runs.apify_run_id is
  'Run ID devolvido pela Apify Platform. Nullable até o dispatch confirmar. UNIQUE para idempotência de webhooks.';

comment on column public.apify_runs.dataset_id is
  'defaultDatasetId do run Apify. Populado quando o run termina e o webhook actualiza a linha.';

comment on column public.apify_runs.status is
  'Estado do run. Inicial: queued. Transições: queued -> running -> (succeeded|failed|aborted|timed_out).';

comment on column public.apify_runs.input is
  'Input passado ao Actor no dispatch. JSON serializado para auditoria e replay manual.';

comment on column public.apify_runs.ingested_items is
  'Items efectivamente ingeridos no Supabase após o webhook processar o dataset (já com dedupe aplicado).';

comment on column public.apify_runs.triggered_by is
  'Profile que disparou o run via UI. SET NULL para preservar histórico se o utilizador for apagado.';


-- ============================================================================
-- 2) ÍNDICES
-- ============================================================================

-- 2.1 Listagem do histórico de runs por workspace (UI /dashboard/apify-runs).
create index if not exists idx_apify_runs_workspace_created_at
  on public.apify_runs (workspace_id, created_at desc);

-- 2.2 Lookup por apify_run_id (usado pelo webhook para encontrar o row a
--     actualizar). UNIQUE parcial evita conflitos entre múltiplos rows com
--     apify_run_id = NULL (estado transitório antes do dispatch).
create unique index if not exists uniq_apify_runs_apify_run_id
  on public.apify_runs (apify_run_id)
  where apify_run_id is not null;

-- 2.3 Queries de runs activos (UI: "X runs em execução", BullMQ: cleanup
--     de runs presos). Índice parcial mantém-se pequeno mesmo com histórico
--     volumoso.
create index if not exists idx_apify_runs_status_active
  on public.apify_runs (status)
  where status in ('queued', 'running');


-- ============================================================================
-- 3) TRIGGER updated_at
-- ============================================================================
-- Reutiliza public.handle_updated_at() criado no 0001.

drop trigger if exists set_updated_at on public.apify_runs;
create trigger set_updated_at
  before update on public.apify_runs
  for each row execute function public.handle_updated_at();


-- ============================================================================
-- 4) RLS
-- ============================================================================
-- SELECT: membros do workspace dono do run.
-- INSERT: membros do workspace (o endpoint /api/apify/trigger volta a validar
--         workspace_id contra o JWT em profundidade).
-- UPDATE/DELETE: bloqueado para utilizadores autenticados — só service_role
--         (webhooks server-side) pode editar histórico. service_role já faz
--         bypass de RLS por defeito, logo basta NÃO criar policies de write.

alter table public.apify_runs enable row level security;

drop policy if exists "apify_runs_select_member" on public.apify_runs;
create policy "apify_runs_select_member"
  on public.apify_runs
  for select
  to authenticated
  using (public.is_workspace_member(workspace_id));

drop policy if exists "apify_runs_insert_member" on public.apify_runs;
create policy "apify_runs_insert_member"
  on public.apify_runs
  for insert
  to authenticated
  with check (public.is_workspace_member(workspace_id));


-- ============================================================================
-- FIM — 0004_apify_runs.sql
-- ============================================================================


-- ============================================================================
-- ROLLBACK (referência — NÃO executar)
-- ----------------------------------------------------------------------------
-- drop table public.apify_runs cascade;
-- ============================================================================
