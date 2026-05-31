-- ============================================================================
-- AngoConnect — Migration 0001 — Schema inicial
-- ----------------------------------------------------------------------------
-- Plataforma SaaS B2B de prospecção comercial para Angola (estilo Apollo.io).
-- Multi-tenant via workspaces, isolamento por RLS.
--
-- Convenção:
--   * 1 crédito  = 1 contacto exportado (email/telefone revelado).
--   * Planos    = starter (49$/500), growth (149$/2k), pro (399$/ilimitado).
--   * Catálogo de empresas/contactos pode ser PÚBLICO (workspace_id NULL) ou
--     PRIVADO (criado pelo workspace). Scrapers usam service_role para inserir
--     no catálogo público (bypass RLS).
--
-- Esta migration é idempotente (`if not exists` onde aplicável) e cria:
--   1. Extensões        (pg_trgm, pgcrypto)
--   2. Funções utilitárias (updated_at, handle_new_user, RLS helpers)
--   3. Tabelas + constraints + índices
--   4. Triggers
--   5. RLS policies
-- ============================================================================


-- ============================================================================
-- 1) EXTENSÕES
-- ============================================================================
-- pgcrypto: necessário para gen_random_uuid() (alternativa ao uuid-ossp).
create extension if not exists "pgcrypto";

-- pg_trgm: para search fuzzy em nomes de empresas (índice GIN trigram).
create extension if not exists "pg_trgm";


-- ============================================================================
-- 2) FUNÇÕES UTILITÁRIAS
-- ============================================================================

-- ----------------------------------------------------------------------------
-- handle_updated_at(): genérico para colunas updated_at.
-- ----------------------------------------------------------------------------
create or replace function public.handle_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

comment on function public.handle_updated_at() is
  'Trigger function genérica para manter a coluna updated_at sincronizada em qualquer UPDATE.';


-- ----------------------------------------------------------------------------
-- handle_new_user(): cria automaticamente o profile quando auth.users insert.
-- ----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

comment on function public.handle_new_user() is
  'Trigger function que cria automaticamente um row em public.profiles quando auth.users recebe INSERT.';


-- ----------------------------------------------------------------------------
-- is_workspace_member(ws_id): helper para RLS.
-- Devolve TRUE se auth.uid() é membro do workspace dado.
-- ----------------------------------------------------------------------------
create or replace function public.is_workspace_member(ws_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = ws_id
      and wm.user_id = auth.uid()
  );
$$;

comment on function public.is_workspace_member(uuid) is
  'Helper RLS: verifica se o utilizador autenticado é membro do workspace indicado.';


-- ----------------------------------------------------------------------------
-- current_workspace_role(ws_id): devolve o role do user actual no workspace,
-- ou NULL se não for membro.
-- ----------------------------------------------------------------------------
create or replace function public.current_workspace_role(ws_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select wm.role
  from public.workspace_members wm
  where wm.workspace_id = ws_id
    and wm.user_id = auth.uid()
  limit 1;
$$;

comment on function public.current_workspace_role(uuid) is
  'Helper RLS: devolve o role (owner/admin/member) do utilizador autenticado no workspace, ou NULL.';


-- ============================================================================
-- 3) TABELAS
-- ============================================================================

-- ----------------------------------------------------------------------------
-- profiles — extensão de auth.users
-- ----------------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  full_name   text,
  avatar_url  text,
  created_at  timestamptz not null default now(),

  constraint profiles_email_unique unique (email)
);

comment on table public.profiles is
  'Perfis dos utilizadores. Estende auth.users; criado automaticamente via trigger on_auth_user_created.';


-- ----------------------------------------------------------------------------
-- workspaces — tenant principal (cada cliente = 1 workspace)
-- ----------------------------------------------------------------------------
create table if not exists public.workspaces (
  id                     uuid primary key default gen_random_uuid(),
  name                   text not null,
  slug                   text not null,
  plan                   text not null default 'starter',
  credits_remaining      int  not null default 0,
  stripe_customer_id     text,
  stripe_subscription_id text,
  subscription_status    text,
  owner_id               uuid not null references public.profiles(id),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint workspaces_slug_unique
    unique (slug),
  constraint workspaces_stripe_customer_unique
    unique (stripe_customer_id),
  constraint workspaces_stripe_subscription_unique
    unique (stripe_subscription_id),
  constraint workspaces_plan_check
    check (plan in ('starter', 'growth', 'pro')),
  constraint workspaces_subscription_status_check
    check (
      subscription_status is null
      or subscription_status in ('active', 'past_due', 'canceled', 'trialing')
    ),
  constraint workspaces_credits_nonneg_check
    check (credits_remaining >= 0)
);

comment on table public.workspaces is
  'Tenants da plataforma. Isolamento total via RLS através de workspace_members.';


-- ----------------------------------------------------------------------------
-- workspace_members — junção many-to-many com role
-- ----------------------------------------------------------------------------
create table if not exists public.workspace_members (
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  user_id       uuid not null references public.profiles(id)   on delete cascade,
  role          text not null default 'member',
  joined_at     timestamptz not null default now(),

  constraint workspace_members_pkey
    primary key (workspace_id, user_id),
  constraint workspace_members_role_check
    check (role in ('owner', 'admin', 'member'))
);

comment on table public.workspace_members is
  'Associação utilizador↔workspace com role. Cada workspace tem 1 owner (auto-criado), N admins/members.';


-- ----------------------------------------------------------------------------
-- companies — catálogo de empresas angolanas
-- DECISÃO DE DESIGN: workspace_id é NULLABLE.
--   * NULL  → catálogo público (importado por scrapers via service_role).
--   * NOT NULL → cópia/empresa criada manualmente por um workspace (privada).
-- Permite a vários workspaces consumirem o mesmo catálogo sem duplicação,
-- mas também permite a um workspace ter empresas privadas suas.
-- ----------------------------------------------------------------------------
create table if not exists public.companies (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid references public.workspaces(id) on delete cascade,
  name          text not null,
  nif           text,
  sector        text,
  provincia     text,
  size          text,
  website       text,
  description   text,
  logo_url      text,
  source        text,
  source_url    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint companies_size_check
    check (
      size is null
      or size in ('micro', 'small', 'medium', 'large', 'enterprise')
    ),
  constraint companies_sector_check
    check (
      sector is null
      or sector in (
        'oil_gas',
        'banking',
        'telecom',
        'construction',
        'retail',
        'agro',
        'healthcare',
        'education',
        'logistics',
        'tech',
        'government',
        'other'
      )
    ),
  constraint companies_provincia_check
    check (
      provincia is null
      or provincia in (
        'Bengo', 'Benguela', 'Bié', 'Cabinda', 'Cuando Cubango',
        'Cuanza Norte', 'Cuanza Sul', 'Cunene', 'Huambo', 'Huíla',
        'Luanda', 'Lunda Norte', 'Lunda Sul', 'Malanje', 'Moxico',
        'Namibe', 'Uíge', 'Zaire'
      )
    )
);

comment on table public.companies is
  'Catálogo de empresas. workspace_id NULL = catálogo público (scrapers). NOT NULL = empresa privada do workspace.';

comment on column public.companies.workspace_id is
  'NULL → catálogo público partilhado. NOT NULL → empresa privada de um workspace específico.';


-- ----------------------------------------------------------------------------
-- contacts — pessoas dentro das empresas
-- Mesmo padrão: workspace_id nullable (sincronizado com company_id).
-- ----------------------------------------------------------------------------
create table if not exists public.contacts (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  workspace_id      uuid references public.workspaces(id) on delete cascade,
  full_name         text not null,
  title             text,
  email             text,
  phone             text,
  linkedin_url      text,
  confidence_score  numeric(3, 2),
  email_verified    boolean not null default false,
  source            text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint contacts_confidence_range_check
    check (
      confidence_score is null
      or (confidence_score >= 0 and confidence_score <= 1)
    )
);

comment on table public.contacts is
  'Contactos (pessoas) ligados a empresas. workspace_id segue mesma lógica de companies.';


-- ----------------------------------------------------------------------------
-- sequences — automação de outreach (cadências de email)
-- ----------------------------------------------------------------------------
create table if not exists public.sequences (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  name          text not null,
  status        text not null default 'draft',
  steps         jsonb not null default '[]'::jsonb,
  created_by    uuid references public.profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint sequences_status_check
    check (status in ('draft', 'active', 'paused', 'archived'))
);

comment on table public.sequences is
  'Cadências de outreach. `steps` é jsonb array de { day_offset, channel, template_id, subject, body }.';


-- ----------------------------------------------------------------------------
-- sequence_enrollments — contactos inscritos numa cadência
-- ----------------------------------------------------------------------------
create table if not exists public.sequence_enrollments (
  id              uuid primary key default gen_random_uuid(),
  sequence_id     uuid not null references public.sequences(id) on delete cascade,
  contact_id      uuid not null references public.contacts(id)  on delete cascade,
  workspace_id    uuid not null references public.workspaces(id) on delete cascade,
  current_step    int  not null default 0,
  status          text not null default 'active',
  enrolled_at     timestamptz not null default now(),
  next_action_at  timestamptz,
  completed_at    timestamptz,

  constraint sequence_enrollments_unique_pair
    unique (sequence_id, contact_id),
  constraint sequence_enrollments_status_check
    check (
      status in ('active', 'paused', 'completed', 'replied', 'bounced', 'unsubscribed')
    ),
  constraint sequence_enrollments_current_step_nonneg_check
    check (current_step >= 0)
);

comment on table public.sequence_enrollments is
  'Cada par (sequence, contact). O worker BullMQ poll next_action_at para disparar próximos passos.';


-- ----------------------------------------------------------------------------
-- email_events — eventos do Resend/SES (webhooks)
-- ----------------------------------------------------------------------------
create table if not exists public.email_events (
  id            uuid primary key default gen_random_uuid(),
  enrollment_id uuid not null references public.sequence_enrollments(id) on delete cascade,
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  event_type    text not null,
  metadata      jsonb not null default '{}'::jsonb,
  occurred_at   timestamptz not null default now(),

  constraint email_events_type_check
    check (
      event_type in (
        'sent',
        'delivered',
        'opened',
        'clicked',
        'replied',
        'bounced',
        'complained',
        'unsubscribed'
      )
    )
);

comment on table public.email_events is
  'Eventos de email vindos de webhooks (Resend/SES). Append-only.';


-- ----------------------------------------------------------------------------
-- credits_log — ledger imutável de créditos
-- ----------------------------------------------------------------------------
create table if not exists public.credits_log (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null references public.workspaces(id) on delete cascade,
  amount               int  not null,
  reason               text not null,
  related_entity_type  text,
  related_entity_id    uuid,
  balance_after        int  not null,
  performed_by         uuid references public.profiles(id),
  created_at           timestamptz not null default now(),

  constraint credits_log_amount_nonzero_check
    check (amount <> 0),
  constraint credits_log_balance_nonneg_check
    check (balance_after >= 0),
  constraint credits_log_reason_check
    check (
      reason in (
        'contact_export',
        'sequence_enrollment',
        'plan_renewal',
        'manual_adjust',
        'refund',
        'signup_bonus'
      )
    )
);

comment on table public.credits_log is
  'Ledger imutável de movimentos de créditos. amount positivo = recarga, negativo = consumo.';


-- ============================================================================
-- 4) ÍNDICES (críticos para search e workers)
-- ============================================================================

-- companies ----------------------------------------------------------------
create index if not exists idx_companies_sector_provincia
  on public.companies (sector, provincia);

create index if not exists idx_companies_name_trgm
  on public.companies using gin (name gin_trgm_ops);

create index if not exists idx_companies_workspace_id
  on public.companies (workspace_id)
  where workspace_id is not null;

create unique index if not exists uq_companies_nif
  on public.companies (nif)
  where nif is not null;

-- contacts -----------------------------------------------------------------
create index if not exists idx_contacts_company_id
  on public.contacts (company_id);

create index if not exists idx_contacts_workspace_id
  on public.contacts (workspace_id)
  where workspace_id is not null;

create index if not exists idx_contacts_email
  on public.contacts (email)
  where email is not null;

-- sequence_enrollments -----------------------------------------------------
-- usado pelo worker BullMQ para polling de próximas acções
create index if not exists idx_enrollments_workspace_status_next
  on public.sequence_enrollments (workspace_id, status, next_action_at);

-- email_events -------------------------------------------------------------
create index if not exists idx_email_events_workspace_time
  on public.email_events (workspace_id, occurred_at desc);

-- credits_log --------------------------------------------------------------
create index if not exists idx_credits_log_workspace_time
  on public.credits_log (workspace_id, created_at desc);

-- workspace_members --------------------------------------------------------
create index if not exists idx_workspace_members_user
  on public.workspace_members (user_id);


-- ============================================================================
-- 5) TRIGGERS
-- ============================================================================

-- ----------------------------------------------------------------------------
-- on_auth_user_created — cria profile automaticamente
-- ----------------------------------------------------------------------------
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();


-- ----------------------------------------------------------------------------
-- updated_at — aplicado a todas as tabelas com essa coluna
-- ----------------------------------------------------------------------------
drop trigger if exists set_updated_at on public.workspaces;
create trigger set_updated_at
  before update on public.workspaces
  for each row execute function public.handle_updated_at();

drop trigger if exists set_updated_at on public.companies;
create trigger set_updated_at
  before update on public.companies
  for each row execute function public.handle_updated_at();

drop trigger if exists set_updated_at on public.contacts;
create trigger set_updated_at
  before update on public.contacts
  for each row execute function public.handle_updated_at();

drop trigger if exists set_updated_at on public.sequences;
create trigger set_updated_at
  before update on public.sequences
  for each row execute function public.handle_updated_at();


-- ============================================================================
-- 6) ROW-LEVEL SECURITY
-- ============================================================================

-- Activar RLS em todas as tabelas de domínio
alter table public.profiles             enable row level security;
alter table public.workspaces           enable row level security;
alter table public.workspace_members    enable row level security;
alter table public.companies            enable row level security;
alter table public.contacts             enable row level security;
alter table public.sequences            enable row level security;
alter table public.sequence_enrollments enable row level security;
alter table public.email_events         enable row level security;
alter table public.credits_log          enable row level security;


-- ----------------------------------------------------------------------------
-- profiles
-- SELECT: próprio profile + profiles de quem partilha workspaces.
-- UPDATE: só próprio.
-- ----------------------------------------------------------------------------
drop policy if exists "profiles_select_self_or_coworker" on public.profiles;
create policy "profiles_select_self_or_coworker"
  on public.profiles
  for select
  to authenticated
  using (
    id = auth.uid()
    or exists (
      select 1
      from public.workspace_members wm_self
      join public.workspace_members wm_other
        on wm_self.workspace_id = wm_other.workspace_id
      where wm_self.user_id = auth.uid()
        and wm_other.user_id = public.profiles.id
    )
  );

drop policy if exists "profiles_update_self" on public.profiles;
create policy "profiles_update_self"
  on public.profiles
  for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());


-- ----------------------------------------------------------------------------
-- workspaces
-- SELECT: membros.
-- INSERT: qualquer authenticated; owner_id deve ser = auth.uid().
--         (membership de owner é criada via função RPC do backend ou trigger
--          subsequente; aqui garantimos apenas que o INSERT pertence ao user.)
-- UPDATE: owner ou admin.
-- DELETE: owner.
-- ----------------------------------------------------------------------------
drop policy if exists "workspaces_select_member" on public.workspaces;
create policy "workspaces_select_member"
  on public.workspaces
  for select
  to authenticated
  using (public.is_workspace_member(id));

drop policy if exists "workspaces_insert_self_owner" on public.workspaces;
create policy "workspaces_insert_self_owner"
  on public.workspaces
  for insert
  to authenticated
  with check (owner_id = auth.uid());

drop policy if exists "workspaces_update_owner_admin" on public.workspaces;
create policy "workspaces_update_owner_admin"
  on public.workspaces
  for update
  to authenticated
  using (public.current_workspace_role(id) in ('owner', 'admin'))
  with check (public.current_workspace_role(id) in ('owner', 'admin'));

drop policy if exists "workspaces_delete_owner" on public.workspaces;
create policy "workspaces_delete_owner"
  on public.workspaces
  for delete
  to authenticated
  using (public.current_workspace_role(id) = 'owner');


-- ----------------------------------------------------------------------------
-- workspace_members
-- SELECT: membros do mesmo workspace.
-- INSERT/DELETE: owner ou admin.
-- UPDATE: owner ou admin, mas não pode promover-se a si próprio (anti-escalada).
-- ----------------------------------------------------------------------------
drop policy if exists "workspace_members_select_same_ws" on public.workspace_members;
create policy "workspace_members_select_same_ws"
  on public.workspace_members
  for select
  to authenticated
  using (public.is_workspace_member(workspace_id));

drop policy if exists "workspace_members_insert_owner_admin" on public.workspace_members;
create policy "workspace_members_insert_owner_admin"
  on public.workspace_members
  for insert
  to authenticated
  with check (
    public.current_workspace_role(workspace_id) in ('owner', 'admin')
    -- excepção: permitir auto-inserção do owner na criação inicial
    or user_id = auth.uid()
  );

drop policy if exists "workspace_members_update_owner_admin" on public.workspace_members;
create policy "workspace_members_update_owner_admin"
  on public.workspace_members
  for update
  to authenticated
  using (
    public.current_workspace_role(workspace_id) in ('owner', 'admin')
    -- evitar auto-promote
    and user_id <> auth.uid()
  )
  with check (
    public.current_workspace_role(workspace_id) in ('owner', 'admin')
    and user_id <> auth.uid()
  );

drop policy if exists "workspace_members_delete_owner_admin" on public.workspace_members;
create policy "workspace_members_delete_owner_admin"
  on public.workspace_members
  for delete
  to authenticated
  using (
    public.current_workspace_role(workspace_id) in ('owner', 'admin')
  );


-- ----------------------------------------------------------------------------
-- companies
-- SELECT: catálogo público (workspace_id IS NULL) OU membro do workspace.
-- INSERT/UPDATE/DELETE: só membros do workspace, e apenas em rows do seu ws.
-- Scrapers usam service_role para inserir no catálogo público (bypass RLS).
-- ----------------------------------------------------------------------------
drop policy if exists "companies_select_public_or_member" on public.companies;
create policy "companies_select_public_or_member"
  on public.companies
  for select
  to authenticated
  using (
    workspace_id is null
    or public.is_workspace_member(workspace_id)
  );

drop policy if exists "companies_insert_member" on public.companies;
create policy "companies_insert_member"
  on public.companies
  for insert
  to authenticated
  with check (
    workspace_id is not null
    and public.is_workspace_member(workspace_id)
  );

drop policy if exists "companies_update_member" on public.companies;
create policy "companies_update_member"
  on public.companies
  for update
  to authenticated
  using (
    workspace_id is not null
    and public.is_workspace_member(workspace_id)
  )
  with check (
    workspace_id is not null
    and public.is_workspace_member(workspace_id)
  );

drop policy if exists "companies_delete_member" on public.companies;
create policy "companies_delete_member"
  on public.companies
  for delete
  to authenticated
  using (
    workspace_id is not null
    and public.is_workspace_member(workspace_id)
  );


-- ----------------------------------------------------------------------------
-- contacts (mesma lógica de companies)
-- ----------------------------------------------------------------------------
drop policy if exists "contacts_select_public_or_member" on public.contacts;
create policy "contacts_select_public_or_member"
  on public.contacts
  for select
  to authenticated
  using (
    workspace_id is null
    or public.is_workspace_member(workspace_id)
  );

drop policy if exists "contacts_insert_member" on public.contacts;
create policy "contacts_insert_member"
  on public.contacts
  for insert
  to authenticated
  with check (
    workspace_id is not null
    and public.is_workspace_member(workspace_id)
  );

drop policy if exists "contacts_update_member" on public.contacts;
create policy "contacts_update_member"
  on public.contacts
  for update
  to authenticated
  using (
    workspace_id is not null
    and public.is_workspace_member(workspace_id)
  )
  with check (
    workspace_id is not null
    and public.is_workspace_member(workspace_id)
  );

drop policy if exists "contacts_delete_member" on public.contacts;
create policy "contacts_delete_member"
  on public.contacts
  for delete
  to authenticated
  using (
    workspace_id is not null
    and public.is_workspace_member(workspace_id)
  );


-- ----------------------------------------------------------------------------
-- sequences — totalmente privadas ao workspace
-- ----------------------------------------------------------------------------
drop policy if exists "sequences_select_member" on public.sequences;
create policy "sequences_select_member"
  on public.sequences
  for select
  to authenticated
  using (public.is_workspace_member(workspace_id));

drop policy if exists "sequences_insert_member" on public.sequences;
create policy "sequences_insert_member"
  on public.sequences
  for insert
  to authenticated
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "sequences_update_member" on public.sequences;
create policy "sequences_update_member"
  on public.sequences
  for update
  to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "sequences_delete_member" on public.sequences;
create policy "sequences_delete_member"
  on public.sequences
  for delete
  to authenticated
  using (public.is_workspace_member(workspace_id));


-- ----------------------------------------------------------------------------
-- sequence_enrollments
-- ----------------------------------------------------------------------------
drop policy if exists "enrollments_select_member" on public.sequence_enrollments;
create policy "enrollments_select_member"
  on public.sequence_enrollments
  for select
  to authenticated
  using (public.is_workspace_member(workspace_id));

drop policy if exists "enrollments_insert_member" on public.sequence_enrollments;
create policy "enrollments_insert_member"
  on public.sequence_enrollments
  for insert
  to authenticated
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "enrollments_update_member" on public.sequence_enrollments;
create policy "enrollments_update_member"
  on public.sequence_enrollments
  for update
  to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "enrollments_delete_member" on public.sequence_enrollments;
create policy "enrollments_delete_member"
  on public.sequence_enrollments
  for delete
  to authenticated
  using (public.is_workspace_member(workspace_id));


-- ----------------------------------------------------------------------------
-- email_events — append-only (sem UPDATE/DELETE para utilizadores)
-- ----------------------------------------------------------------------------
drop policy if exists "email_events_select_member" on public.email_events;
create policy "email_events_select_member"
  on public.email_events
  for select
  to authenticated
  using (public.is_workspace_member(workspace_id));

drop policy if exists "email_events_insert_member" on public.email_events;
create policy "email_events_insert_member"
  on public.email_events
  for insert
  to authenticated
  with check (public.is_workspace_member(workspace_id));


-- ----------------------------------------------------------------------------
-- credits_log — ledger imutável (sem UPDATE/DELETE para utilizadores)
-- ----------------------------------------------------------------------------
drop policy if exists "credits_log_select_member" on public.credits_log;
create policy "credits_log_select_member"
  on public.credits_log
  for select
  to authenticated
  using (public.is_workspace_member(workspace_id));

drop policy if exists "credits_log_insert_member" on public.credits_log;
create policy "credits_log_insert_member"
  on public.credits_log
  for insert
  to authenticated
  with check (public.is_workspace_member(workspace_id));


-- ============================================================================
-- FIM — 0001_initial_schema.sql
-- ============================================================================
