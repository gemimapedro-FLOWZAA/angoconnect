-- ============================================================================
-- AngoConnect — Migration 0003 — Alinhamento ao CLAUDE.md canónico
-- ----------------------------------------------------------------------------
-- Esta migration corrige desvios estruturais entre o estado real do schema
-- (após 0001 + 0002) e a definição canónica que vive em CLAUDE.md.
--
-- Deltas tratados:
--   1. Sectores em `companies`:
--        - renomear `healthcare` → `health`
--        - adicionar `insurance`
--        - remover `other` (linhas existentes ficam com sector NULL)
--        - actualizar `companies_sector_check` para a lista canónica
--   2. `contacts.full_name` → `contacts.name` (rename de coluna)
--   3. Separar billing de `workspaces` para uma nova tabela `subscriptions`
--      (CLAUDE.md trata workspaces.plan/credits como estado actual da app
--       e subscriptions como espelho de estado Stripe / histórico).
--
-- Política assumida (sem consulta):
--   * `sector = 'other'` é considerado lixo de scrapers e cai para NULL.
--   * `workspaces.plan` mantém-se (fonte de verdade para o produto);
--     `subscriptions.plan` é o que o Stripe diz neste momento. Sync via webhook.
--
-- Idempotência: usa `if exists` / `if not exists` / `drop policy if exists`
-- em todos os pontos relevantes. Pode ser reaplicada sem partir nada.
--
-- Rollback documentado no fim do ficheiro (apenas referência, não executar).
-- ============================================================================


-- ============================================================================
-- 1) SECTORES — normalizar valores antes de mexer no check constraint
-- ============================================================================

-- 1.1 Linhas com `sector = 'other'` perdem o sector (vai para NULL).
--     Decisão: o CLAUDE.md não prevê `other`; manter equivale a desalinhar.
--     Como ainda não há dados em produção, o impacto é nulo, mas escreve-se
--     idempotente para suportar futuros reapply em ambientes com dados.
update public.companies
   set sector = null
 where sector = 'other';

-- 1.2 `healthcare` → `health` (rename do valor, sem perda).
update public.companies
   set sector = 'health'
 where sector = 'healthcare';


-- ============================================================================
-- 2) SECTORES — actualizar a check constraint para a lista canónica
-- ============================================================================
-- Lista canónica (CLAUDE.md):
--   oil_gas, construction, telecom, banking, insurance, retail,
--   agro, health, education, logistics, tech, government
-- (sem `other`, com `insurance`, `health` em vez de `healthcare`)

alter table public.companies
  drop constraint if exists companies_sector_check;

alter table public.companies
  add constraint companies_sector_check
  check (
    sector is null
    or sector in (
      'oil_gas',
      'construction',
      'telecom',
      'banking',
      'insurance',
      'retail',
      'agro',
      'health',
      'education',
      'logistics',
      'tech',
      'government'
    )
  );


-- ============================================================================
-- 3) CONTACTS — renomear `full_name` para `name`
-- ============================================================================
-- CLAUDE.md define o schema com `name`. O 0001 usou `full_name`.
-- Rename é cheap (sem rewrite de tabela). Idempotente via guard no catalog.

do $$
begin
  if exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'contacts'
       and column_name  = 'full_name'
  )
  and not exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'contacts'
       and column_name  = 'name'
  ) then
    execute 'alter table public.contacts rename column full_name to name';
  end if;
end
$$;


-- ============================================================================
-- 4) SUBSCRIPTIONS — nova tabela (separar billing de workspaces)
-- ============================================================================
-- CLAUDE.md:
--   subscriptions (id, workspace_id, stripe_subscription_id,
--                  plan, status, current_period_end)
-- Adicionamos created_at/updated_at + stripe_customer_id (mudou de workspaces).

create table if not exists public.subscriptions (
  id                      uuid primary key default gen_random_uuid(),
  workspace_id            uuid not null references public.workspaces(id) on delete cascade,
  stripe_customer_id      text,
  stripe_subscription_id  text not null,
  plan                    text not null,
  status                  text not null,
  current_period_end      timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint subscriptions_stripe_customer_unique
    unique (stripe_customer_id),
  constraint subscriptions_stripe_subscription_unique
    unique (stripe_subscription_id),
  constraint subscriptions_plan_check
    check (plan in ('starter', 'growth', 'pro')),
  constraint subscriptions_status_check
    check (
      status in (
        'active',
        'past_due',
        'canceled',
        'trialing',
        'incomplete',
        'unpaid'
      )
    )
);

comment on table public.subscriptions is
  'Espelho de subscriptions Stripe por workspace. Actualizada via webhook server-side; workspace.plan é a fonte de verdade aplicacional.';

comment on column public.subscriptions.stripe_customer_id is
  'ID do customer no Stripe. Movido de workspaces.stripe_customer_id em 0003.';


-- ============================================================================
-- 5) MIGRAR DADOS de workspaces → subscriptions antes de dropar colunas
-- ============================================================================
-- Em prática a base está vazia, mas escrevemos a query para suportar reapply
-- em ambientes onde 0001 já tenha dados. Só migra workspaces com sub Stripe.

do $$
begin
  if exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'workspaces'
       and column_name  = 'stripe_subscription_id'
  ) then
    insert into public.subscriptions (
      workspace_id,
      stripe_customer_id,
      stripe_subscription_id,
      plan,
      status,
      current_period_end,
      created_at,
      updated_at
    )
    select
      w.id,
      w.stripe_customer_id,
      w.stripe_subscription_id,
      w.plan,
      coalesce(w.subscription_status, 'active'),
      null::timestamptz,
      w.created_at,
      w.updated_at
    from public.workspaces w
    where w.stripe_subscription_id is not null
    on conflict (stripe_subscription_id) do nothing;
  end if;
end
$$;


-- ============================================================================
-- 6) WORKSPACES — remover colunas de billing (agora vivem em subscriptions)
-- ============================================================================
-- As constraints de unicidade caem junto com as colunas.
-- Mantém-se `plan` e `credits_remaining`.

alter table public.workspaces
  drop constraint if exists workspaces_stripe_customer_unique;

alter table public.workspaces
  drop constraint if exists workspaces_stripe_subscription_unique;

alter table public.workspaces
  drop constraint if exists workspaces_subscription_status_check;

alter table public.workspaces
  drop column if exists stripe_customer_id;

alter table public.workspaces
  drop column if exists stripe_subscription_id;

alter table public.workspaces
  drop column if exists subscription_status;


-- ============================================================================
-- 7) SUBSCRIPTIONS — índices
-- ============================================================================

create index if not exists idx_subscriptions_workspace_id
  on public.subscriptions (workspace_id);

create index if not exists idx_subscriptions_stripe_customer_id
  on public.subscriptions (stripe_customer_id)
  where stripe_customer_id is not null;


-- ============================================================================
-- 8) SUBSCRIPTIONS — trigger updated_at
-- ============================================================================
-- Reutiliza public.handle_updated_at() criado no 0001.

drop trigger if exists set_updated_at on public.subscriptions;
create trigger set_updated_at
  before update on public.subscriptions
  for each row execute function public.handle_updated_at();


-- ============================================================================
-- 9) SUBSCRIPTIONS — RLS
-- ============================================================================
-- SELECT: só membros do workspace dono da subscription.
-- INSERT/UPDATE/DELETE: bloqueado para utilizadores autenticados — só o
-- service_role (Stripe webhook server-side) pode escrever. service_role
-- já faz bypass de RLS por defeito, logo basta NÃO criar policies de write.

alter table public.subscriptions enable row level security;

drop policy if exists "subscriptions_select_member" on public.subscriptions;
create policy "subscriptions_select_member"
  on public.subscriptions
  for select
  to authenticated
  using (public.is_workspace_member(workspace_id));


-- ============================================================================
-- FIM — 0003_align_claude_md.sql
-- ============================================================================


-- ============================================================================
-- ROLLBACK (referência — NÃO executar)
-- ----------------------------------------------------------------------------
-- Repor billing em workspaces:
--   alter table public.workspaces
--     add column if not exists stripe_customer_id     text,
--     add column if not exists stripe_subscription_id text,
--     add column if not exists subscription_status    text;
--   alter table public.workspaces
--     add constraint workspaces_stripe_customer_unique unique (stripe_customer_id),
--     add constraint workspaces_stripe_subscription_unique unique (stripe_subscription_id),
--     add constraint workspaces_subscription_status_check
--       check (subscription_status is null
--              or subscription_status in ('active','past_due','canceled','trialing'));
--
--   update public.workspaces w
--      set stripe_customer_id     = s.stripe_customer_id,
--          stripe_subscription_id = s.stripe_subscription_id,
--          subscription_status    = s.status
--     from public.subscriptions s
--    where s.workspace_id = w.id;
--
--   drop table if exists public.subscriptions;
--
-- Reverter rename de contacts:
--   alter table public.contacts rename column name to full_name;
--
-- Reverter check constraint de sector (lista antiga):
--   alter table public.companies drop constraint if exists companies_sector_check;
--   alter table public.companies
--     add constraint companies_sector_check
--     check (sector is null or sector in (
--       'oil_gas','banking','telecom','construction','retail','agro',
--       'healthcare','education','logistics','tech','government','other'
--     ));
--   update public.companies set sector = 'healthcare' where sector = 'health';
--   -- linhas com sector NULL que originalmente eram 'other' não podem
--   -- ser recuperadas sem snapshot — assumir perda aceitável.
-- ============================================================================
