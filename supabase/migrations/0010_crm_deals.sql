-- =========================================================================
-- AngoConnect — Migration 0010: CRM (deal_stages + deals + RPC + trigger)
-- =========================================================================
-- Cria o schema do CRM Kanban:
--   • `deal_stages` — estados da pipeline (NULLABLE workspace_id para system)
--   • `deals` — oportunidades de venda (1 deal por (workspace, contact))
--   • RPC `move_deal_to_stage` — actualiza stage + status conforme is_won/is_lost
--   • Trigger `handle_email_reply_create_deal` — cria deal automaticamente
--     quando um `email_events` row chega com event_type='replied' e ainda
--     não há deal aberto para o (workspace, contact).
-- =========================================================================

begin;

-- -------------------------------------------------------------------------
-- 1) Tabela `deal_stages`
-- -------------------------------------------------------------------------
create table if not exists public.deal_stages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  name text not null constraint deal_stages_name_len check (length(trim(name)) >= 2 and length(name) <= 40),
  position int not null,
  color text not null default 'slate' constraint deal_stages_color_check
    check (color in ('slate','blue','sky','green','amber','red','violet','rose','emerald')),
  is_won boolean not null default false,
  is_lost boolean not null default false,
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint deal_stages_won_xor_lost check (not (is_won and is_lost)),
  constraint deal_stages_system_consistency check (
    (is_system = false) or (is_system = true and workspace_id is null)
  )
);

-- Idempotência para o seed dos system stages.
create unique index if not exists uq_deal_stages_system_name
  on public.deal_stages (name) where workspace_id is null;

create index if not exists idx_deal_stages_workspace_position
  on public.deal_stages (workspace_id, position) where workspace_id is not null;
create index if not exists idx_deal_stages_system
  on public.deal_stages (position) where is_system = true;

drop trigger if exists trg_deal_stages_updated_at on public.deal_stages;
create trigger trg_deal_stages_updated_at
before update on public.deal_stages
for each row execute function public.handle_updated_at();

-- -------------------------------------------------------------------------
-- 2) Tabela `deals`
-- -------------------------------------------------------------------------
create table if not exists public.deals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  company_id uuid references public.companies(id) on delete set null,
  stage_id uuid not null references public.deal_stages(id) on delete restrict,
  value_akz numeric(14,2),
  expected_close_date date,
  owner_id uuid references public.profiles(id) on delete set null,
  status text not null default 'open' constraint deals_status_check
    check (status in ('open','won','lost')),
  notes text,
  source text not null default 'manual' constraint deals_source_check
    check (source in ('manual','auto_reply','imported','api')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Um workspace tem no máximo um deal por contacto (qualquer status).
  -- Para reabrir, o user pode mover de "Fechado-perdido" para "Novo".
  constraint uq_deals_workspace_contact unique (workspace_id, contact_id)
);

create index if not exists idx_deals_workspace_stage
  on public.deals (workspace_id, stage_id, updated_at desc);
create index if not exists idx_deals_workspace_status
  on public.deals (workspace_id, status, created_at desc);
create index if not exists idx_deals_workspace_owner
  on public.deals (workspace_id, owner_id) where owner_id is not null;
create index if not exists idx_deals_contact
  on public.deals (contact_id);

drop trigger if exists trg_deals_updated_at on public.deals;
create trigger trg_deals_updated_at
before update on public.deals
for each row execute function public.handle_updated_at();

-- -------------------------------------------------------------------------
-- 3) RLS
-- -------------------------------------------------------------------------
alter table public.deal_stages enable row level security;
alter table public.deals enable row level security;

-- deal_stages: SELECT system OU membro
drop policy if exists deal_stages_select on public.deal_stages;
create policy deal_stages_select on public.deal_stages
  for select using (
    workspace_id is null
    or public.is_workspace_member(workspace_id)
  );

drop policy if exists deal_stages_insert on public.deal_stages;
create policy deal_stages_insert on public.deal_stages
  for insert with check (
    workspace_id is not null
    and public.is_workspace_member(workspace_id)
    and is_system = false
  );

drop policy if exists deal_stages_update on public.deal_stages;
create policy deal_stages_update on public.deal_stages
  for update using (
    workspace_id is not null
    and public.is_workspace_member(workspace_id)
    and is_system = false
  );

drop policy if exists deal_stages_delete on public.deal_stages;
create policy deal_stages_delete on public.deal_stages
  for delete using (
    workspace_id is not null
    and public.is_workspace_member(workspace_id)
    and is_system = false
  );

-- deals: tudo restrito a membros do workspace
drop policy if exists deals_select on public.deals;
create policy deals_select on public.deals
  for select using (public.is_workspace_member(workspace_id));

drop policy if exists deals_insert on public.deals;
create policy deals_insert on public.deals
  for insert with check (public.is_workspace_member(workspace_id));

drop policy if exists deals_update on public.deals;
create policy deals_update on public.deals
  for update using (public.is_workspace_member(workspace_id));

drop policy if exists deals_delete on public.deals;
create policy deals_delete on public.deals
  for delete using (public.is_workspace_member(workspace_id));

-- -------------------------------------------------------------------------
-- 4) Seed dos 7 system stages
-- -------------------------------------------------------------------------
insert into public.deal_stages (workspace_id, name, position, color, is_won, is_lost, is_system)
values
  (null, 'Novo',              0, 'slate',   false, false, true),
  (null, 'Contactado',        1, 'blue',    false, false, true),
  (null, 'Qualificado',       2, 'sky',     false, false, true),
  (null, 'Proposta',          3, 'violet',  false, false, true),
  (null, 'Negociação',        4, 'amber',   false, false, true),
  (null, 'Fechado-ganho',     5, 'emerald', true,  false, true),
  (null, 'Fechado-perdido',   6, 'rose',    false, true,  true)
on conflict (name) where workspace_id is null do nothing;

-- -------------------------------------------------------------------------
-- 5) RPC `move_deal_to_stage`
-- -------------------------------------------------------------------------
create or replace function public.move_deal_to_stage(
  p_deal_id uuid,
  p_stage_id uuid
)
returns table (
  id uuid,
  stage_id uuid,
  status text,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid;
  v_workspace_id uuid;
  v_stage_workspace uuid;
  v_is_won boolean;
  v_is_lost boolean;
  v_new_status text;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  -- Obtém workspace do deal + valida acesso
  select d.workspace_id into v_workspace_id
  from public.deals d
  where d.id = p_deal_id;

  if v_workspace_id is null then
    raise exception 'deal_not_found' using errcode = '22023';
  end if;
  if not public.is_workspace_member(v_workspace_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Valida que o stage existe e pertence ao mesmo workspace (ou é system)
  select s.workspace_id, s.is_won, s.is_lost
    into v_stage_workspace, v_is_won, v_is_lost
  from public.deal_stages s
  where s.id = p_stage_id;

  if v_stage_workspace is distinct from null and v_stage_workspace <> v_workspace_id then
    raise exception 'stage_workspace_mismatch' using errcode = '22023';
  end if;
  if v_is_won is null then
    raise exception 'stage_not_found' using errcode = '22023';
  end if;

  v_new_status := case
    when v_is_won then 'won'
    when v_is_lost then 'lost'
    else 'open'
  end;

  update public.deals d
     set stage_id = p_stage_id,
         status = v_new_status,
         updated_at = now()
   where d.id = p_deal_id;

  return query
    select d.id, d.stage_id, d.status, d.updated_at
    from public.deals d
    where d.id = p_deal_id;
end;
$$;

revoke all on function public.move_deal_to_stage(uuid, uuid) from public;
grant execute on function public.move_deal_to_stage(uuid, uuid) to authenticated;

comment on function public.move_deal_to_stage(uuid, uuid) is
  'Move um deal para outro stage e ajusta automaticamente o status conforme is_won/is_lost. Valida membership.';

-- -------------------------------------------------------------------------
-- 6) Trigger `handle_email_reply_create_deal`
-- -------------------------------------------------------------------------
create or replace function public.handle_email_reply_create_deal()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_contact_id uuid;
  v_workspace_id uuid;
  v_company_id uuid;
  v_stage_id uuid;
  v_existing_deal uuid;
begin
  -- Só reage a respostas
  if new.event_type <> 'replied' then
    return new;
  end if;

  -- Obter enrolment + contact + company
  select se.contact_id, se.workspace_id, c.company_id
    into v_contact_id, v_workspace_id, v_company_id
  from public.sequence_enrollments se
  join public.contacts c on c.id = se.contact_id
  where se.id = new.enrollment_id;

  if v_contact_id is null or v_workspace_id is null then
    return new; -- enrolment órfão ou já apagado
  end if;

  -- Já existe deal? (qualquer status — não duplicamos)
  select id into v_existing_deal
  from public.deals
  where workspace_id = v_workspace_id and contact_id = v_contact_id
  limit 1;
  if v_existing_deal is not null then
    return new;
  end if;

  -- Encontra o stage "Contactado" (private do workspace > system)
  select id into v_stage_id
  from public.deal_stages
  where name = 'Contactado'
    and (workspace_id = v_workspace_id or workspace_id is null)
  order by workspace_id nulls last
  limit 1;

  if v_stage_id is null then
    return new; -- falha silenciosa
  end if;

  insert into public.deals (workspace_id, contact_id, company_id, stage_id, status, source)
  values (v_workspace_id, v_contact_id, v_company_id, v_stage_id, 'open', 'auto_reply');

  return new;
exception when others then
  -- Nunca quebrar o INSERT em email_events por causa do trigger
  raise warning 'handle_email_reply_create_deal falhou: %', SQLERRM;
  return new;
end;
$$;

drop trigger if exists trg_email_reply_create_deal on public.email_events;
create trigger trg_email_reply_create_deal
after insert on public.email_events
for each row execute function public.handle_email_reply_create_deal();

commit;

-- =========================================================================
-- ROLLBACK (referência — não executar):
-- =========================================================================
-- begin;
-- drop trigger if exists trg_email_reply_create_deal on public.email_events;
-- drop function if exists public.handle_email_reply_create_deal();
-- drop function if exists public.move_deal_to_stage(uuid, uuid);
-- drop table if exists public.deals cascade;
-- drop table if exists public.deal_stages cascade;
-- commit;
