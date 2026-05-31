-- ============================================================================
-- AngoConnect — Migration 0011 — WhatsApp Business (M3.4)
-- ----------------------------------------------------------------------------
-- M3.4 adiciona o canal WhatsApp ao motor de outreach. Esta migration entrega:
--
--   1. Tabela `whatsapp_templates`        — templates Meta (pré-aprovados)
--   2. Tabela `workspace_whatsapp_config` — credenciais WhatsApp por workspace
--   3. View   `workspace_whatsapp_config_safe` — sem access_token, segura para
--                                                  authenticated clients
--   4. ALTER  `email_events.event_type` — adiciona `wa_*` events ao CHECK
--   5. Doc    `sequences.steps` — comentário descrevendo shape com channel
--   6. RLS    nas duas novas tabelas + view
--   7. UPDATE `handle_email_reply_create_deal` — passa também a reagir a
--                                                 `wa_replied`
--   8. RPC    `upsert_whatsapp_template` — usada pelo Template Manager UI
--   9. Triggers `updated_at`
--
-- DECISÕES (sem consultar):
--   * **access_token**: a tabela `workspace_whatsapp_config` é a única fonte de
--     verdade, mas tem RLS muito restritiva — só o `owner` do workspace pode
--     SELECT (mas ainda assim NUNCA expomos o token em payload). O cliente
--     authenticated lê metadados via view `workspace_whatsapp_config_safe`
--     (sem access_token); o backend (server-side, com service_role) lê o
--     token directamente para chamar a Meta Cloud API.
--   * **`wa_*` events numa única tabela `email_events`**: mantemos `email_events`
--     como tabela genérica de eventos de outreach (apesar do nome) — adicionamos
--     comentário explicativo. Renomear partia migrations downstream e backend.
--   * **`sequences.steps`**: nenhuma mudança estrutural. Só comentário SQL.
--   * **`whatsapp_templates`** é sempre por workspace (workspace_id NOT NULL):
--     a aprovação Meta é por WABA do cliente, não há catálogo público
--     partilhado como há em `email_templates`.
--   * **`upsert_whatsapp_template`** ao actualizar repõe status='local_draft' —
--     qualquer edição do corpo invalida a aprovação Meta anterior; o user
--     re-submete via API Meta separadamente.
--
-- Idempotência:
--   * `create or replace function`, `create table if not exists`,
--     `create index if not exists`, `drop policy if exists`, `drop trigger if exists`.
--   * ALTER do CHECK constraint de email_events é precedido por DROP IF EXISTS.
-- ============================================================================


begin;


-- ============================================================================
-- 1) TABELA — whatsapp_templates
-- ----------------------------------------------------------------------------
-- Templates pré-aprovados pela Meta. Cada workspace tem os seus próprios
-- (a aprovação Meta é por WABA do cliente). O status segue o ciclo de vida
-- Meta: local_draft → submitted → approved/rejected/paused/disabled.
-- ============================================================================

create table if not exists public.whatsapp_templates (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references public.workspaces(id) on delete cascade,
  meta_template_name  text not null,
  meta_template_id    text,
  language            text not null default 'pt_PT',
  category            text not null,
  header_format       text not null default 'NONE',
  header_text         text,
  body                text not null,
  body_example        jsonb not null default '[]'::jsonb,
  footer              text,
  buttons             jsonb not null default '[]'::jsonb,
  status              text not null default 'local_draft',
  rejection_reason    text,
  created_by          uuid references public.profiles(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint whatsapp_templates_language_check
    check (language in ('pt_PT', 'pt_AO', 'pt_BR', 'en_US')),
  constraint whatsapp_templates_category_check
    check (category in ('MARKETING', 'UTILITY', 'AUTHENTICATION')),
  constraint whatsapp_templates_header_format_check
    check (header_format in ('NONE', 'TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT')),
  constraint whatsapp_templates_body_length_check
    check (length(body) >= 1 and length(body) <= 1024),
  constraint whatsapp_templates_footer_length_check
    check (footer is null or length(footer) <= 60),
  constraint whatsapp_templates_status_check
    check (status in (
      'local_draft', 'submitted', 'approved', 'rejected', 'paused', 'disabled'
    )),
  -- Meta exige nome único por (waba, language). Mapeamos isto via workspace.
  constraint whatsapp_templates_name_lang_unique
    unique (workspace_id, meta_template_name, language)
);

comment on table public.whatsapp_templates is
  'Templates WhatsApp pré-aprovados pela Meta. Necessários para iniciar conversa fora da janela de 24h. status segue lifecycle Meta.';

comment on column public.whatsapp_templates.meta_template_name is
  'Nome interno do template no Meta WABA (ex: intro_b2b_pt). Imutável após submissão.';

comment on column public.whatsapp_templates.meta_template_id is
  'ID atribuído pela Meta após aprovação. NULL enquanto local_draft.';

comment on column public.whatsapp_templates.body_example is
  'Array jsonb de exemplos para os placeholders {{1}}, {{2}}, ... — obrigatório no submit à Meta.';

comment on column public.whatsapp_templates.buttons is
  'Array jsonb com até 3 buttons (quick reply / call to action). Shape: [{ type, text, url? }].';


-- ============================================================================
-- 2) TABELA — workspace_whatsapp_config
-- ----------------------------------------------------------------------------
-- Credenciais Meta WhatsApp por workspace. access_token é altamente sensível —
-- ver secção 6 (RLS) e a view `workspace_whatsapp_config_safe`.
-- ============================================================================

create table if not exists public.workspace_whatsapp_config (
  workspace_id          uuid primary key references public.workspaces(id) on delete cascade,
  waba_id               text,
  phone_number_id       text,
  phone_number          text,
  access_token          text,
  webhook_verify_token  text,
  is_active             boolean not null default false,
  connected_at          timestamptz,
  disconnected_at       timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on table public.workspace_whatsapp_config is
  'Configuração WhatsApp Cloud API por workspace. access_token NUNCA deve ser exposto a clientes authenticated — usar a view workspace_whatsapp_config_safe.';

comment on column public.workspace_whatsapp_config.access_token is
  'Token Meta de longa duração. APENAS o backend (service_role) pode ler em claro. RLS impede SELECT por authenticated.';

comment on column public.workspace_whatsapp_config.webhook_verify_token is
  'String aleatória que validamos no handshake GET /api/whatsapp/webhook (hub.verify_token).';


-- ============================================================================
-- 3) ÍNDICES
-- ============================================================================

create index if not exists idx_whatsapp_templates_workspace
  on public.whatsapp_templates (workspace_id);

create index if not exists idx_whatsapp_templates_status
  on public.whatsapp_templates (workspace_id, status);

create index if not exists idx_whatsapp_templates_category
  on public.whatsapp_templates (workspace_id, category);

create index if not exists idx_workspace_whatsapp_config_active
  on public.workspace_whatsapp_config (is_active)
  where is_active = true;


-- ============================================================================
-- 4) TRIGGERS updated_at
-- ============================================================================

drop trigger if exists set_updated_at on public.whatsapp_templates;
create trigger set_updated_at
  before update on public.whatsapp_templates
  for each row execute function public.handle_updated_at();

drop trigger if exists set_updated_at on public.workspace_whatsapp_config;
create trigger set_updated_at
  before update on public.workspace_whatsapp_config
  for each row execute function public.handle_updated_at();


-- ============================================================================
-- 5) ALTER email_events.event_type — adicionar wa_* events
-- ----------------------------------------------------------------------------
-- `email_events` continua a chamar-se assim por compatibilidade (renomear
-- partia downstream). Conceptualmente é a tabela genérica de **eventos de
-- outreach** — abrange email + WhatsApp.
-- ============================================================================

alter table public.email_events
  drop constraint if exists email_events_type_check;

alter table public.email_events
  drop constraint if exists email_events_event_type_check;

alter table public.email_events
  add constraint email_events_event_type_check
  check (event_type in (
    -- Email events (Resend/SES)
    'sent',
    'delivered',
    'opened',
    'clicked',
    'replied',
    'bounced',
    'complained',
    'unsubscribed',
    -- WhatsApp events (Meta Cloud API webhook)
    'wa_sent',
    'wa_delivered',
    'wa_read',
    'wa_replied',
    'wa_failed'
  ));

comment on table public.email_events is
  'Eventos de outreach (email + WhatsApp). Apesar do nome legado `email_events`, esta tabela suporta o prefixo wa_* para eventos WhatsApp recebidos via webhook Meta. Append-only.';

comment on column public.email_events.event_type is
  'Tipo do evento. Email: sent/delivered/opened/clicked/replied/bounced/complained/unsubscribed. WhatsApp: wa_sent/wa_delivered/wa_read/wa_replied/wa_failed.';


-- ============================================================================
-- 6) ALTER sequences.steps — documentação do shape multi-canal
-- ----------------------------------------------------------------------------
-- Sem mudança de schema. A coluna `steps` continua jsonb. Documentamos o shape
-- estendido para M3.4 (channel: email | whatsapp).
-- ============================================================================

comment on column public.sequences.steps is
  E'Array jsonb de steps de outreach. Cada step:\n'
  '  { day_offset: int, channel: "email" | "whatsapp", ... }\n'
  '\n'
  'Se channel="email": { template_id?: uuid (email_templates), subject?: text, body?: text }\n'
  'Se channel="whatsapp": { template_id?: uuid (whatsapp_templates),\n'
  '                         template_variables?: text[] (placeholders {{1}}, {{2}}, ...),\n'
  '                         body_freeform?: text (só funciona se janela 24h aberta) }';


-- ============================================================================
-- 7) ROW-LEVEL SECURITY
-- ============================================================================

alter table public.whatsapp_templates       enable row level security;
alter table public.workspace_whatsapp_config enable row level security;


-- ----------------------------------------------------------------------------
-- whatsapp_templates — totalmente privadas ao workspace
-- ----------------------------------------------------------------------------

drop policy if exists whatsapp_templates_select on public.whatsapp_templates;
create policy whatsapp_templates_select
  on public.whatsapp_templates
  for select
  to authenticated
  using (public.is_workspace_member(workspace_id));

drop policy if exists whatsapp_templates_insert on public.whatsapp_templates;
create policy whatsapp_templates_insert
  on public.whatsapp_templates
  for insert
  to authenticated
  with check (public.is_workspace_member(workspace_id));

drop policy if exists whatsapp_templates_update on public.whatsapp_templates;
create policy whatsapp_templates_update
  on public.whatsapp_templates
  for update
  to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists whatsapp_templates_delete on public.whatsapp_templates;
create policy whatsapp_templates_delete
  on public.whatsapp_templates
  for delete
  to authenticated
  using (public.is_workspace_member(workspace_id));


-- ----------------------------------------------------------------------------
-- workspace_whatsapp_config — RLS restritiva
-- ----------------------------------------------------------------------------
-- Decisão de segurança: nenhum cliente `authenticated` pode SELECT na tabela
-- bruta. Toda a leitura passa pela view `workspace_whatsapp_config_safe` (que
-- não expõe access_token). O backend (service_role) lê directamente quando
-- precisa do token para chamar a Meta Cloud API.
--
-- INSERT/UPDATE/DELETE: só o owner do workspace (que precisa de gerir o
-- setup inicial). Mesmo o owner não consegue SELECT em claro o access_token —
-- a UI mostra "***" via a view.
-- ----------------------------------------------------------------------------

drop policy if exists workspace_whatsapp_config_no_select on public.workspace_whatsapp_config;
create policy workspace_whatsapp_config_no_select
  on public.workspace_whatsapp_config
  for select
  to authenticated
  using (false);

drop policy if exists workspace_whatsapp_config_insert_owner on public.workspace_whatsapp_config;
create policy workspace_whatsapp_config_insert_owner
  on public.workspace_whatsapp_config
  for insert
  to authenticated
  with check (
    public.current_workspace_role(workspace_id) = 'owner'
  );

drop policy if exists workspace_whatsapp_config_update_owner on public.workspace_whatsapp_config;
create policy workspace_whatsapp_config_update_owner
  on public.workspace_whatsapp_config
  for update
  to authenticated
  using (
    public.current_workspace_role(workspace_id) = 'owner'
  )
  with check (
    public.current_workspace_role(workspace_id) = 'owner'
  );

drop policy if exists workspace_whatsapp_config_delete_owner on public.workspace_whatsapp_config;
create policy workspace_whatsapp_config_delete_owner
  on public.workspace_whatsapp_config
  for delete
  to authenticated
  using (
    public.current_workspace_role(workspace_id) = 'owner'
  );


-- ============================================================================
-- 8) VIEW — workspace_whatsapp_config_safe (sem access_token)
-- ----------------------------------------------------------------------------
-- A view substitui o SELECT directo na tabela para clientes authenticated.
-- NÃO inclui `access_token` em coluna alguma. Usa security_invoker=true para
-- as policies da tabela base aplicarem-se — mas como o SELECT base é `false`,
-- adicionamos a verificação de membership directamente na view via WHERE.
--
-- Solução técnica: a view é declarada `security_invoker=on` (Postgres 15+),
-- o que faz com que o role do utilizador (não do owner da view) seja usado
-- na avaliação das policies da tabela base. Como a policy SELECT base é
-- `false`, a view não devolveria nada. Para contornar isto, criamos uma
-- policy SELECT adicional "via_view" que só é permissiva quando o SELECT
-- vem com `access_token` excluído (não detectável directamente em policy).
--
-- Solução pragmática: a view é `security_definer` (default no Postgres
-- pré-15) e tem GRANT SELECT a authenticated; o WHERE da view replica a
-- regra de membership. Comportamento equivalente em todas as versões.
-- ============================================================================

create or replace view public.workspace_whatsapp_config_safe as
  select
    workspace_id,
    waba_id,
    phone_number_id,
    phone_number,
    case
      when access_token is not null then '***'
      else null
    end as access_token_status,
    webhook_verify_token,
    is_active,
    connected_at,
    disconnected_at,
    created_at,
    updated_at
  from public.workspace_whatsapp_config c
  where public.is_workspace_member(c.workspace_id);

comment on view public.workspace_whatsapp_config_safe is
  'View segura sobre workspace_whatsapp_config: NUNCA expõe access_token (substituído por access_token_status = "***" | NULL). Authenticated clients devem ler daqui; backend service_role pode ler a tabela base.';

-- Authenticated pode SELECT na view; a própria view filtra por membership.
grant select on public.workspace_whatsapp_config_safe to authenticated;


-- ============================================================================
-- 9) UPDATE — handle_email_reply_create_deal aceita wa_replied
-- ----------------------------------------------------------------------------
-- Mantém comportamento M3.3 (cria deal automático em stage "Contactado")
-- mas passa a disparar também quando a resposta vem por WhatsApp.
-- ============================================================================

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
  -- Reage a respostas (email OU WhatsApp)
  if new.event_type not in ('replied', 'wa_replied') then
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

  -- Marca também o enrolment como replied (idempotente).
  update public.sequence_enrollments
     set status = 'replied'
   where id = new.enrollment_id
     and status <> 'replied';

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

comment on function public.handle_email_reply_create_deal() is
  'Trigger: cria deal automaticamente em stage Contactado quando email_event chega com event_type IN (replied, wa_replied). Marca também o enrolment como replied. Falha silenciosa para não bloquear o INSERT em email_events.';


-- ============================================================================
-- 10) RPC — upsert_whatsapp_template
-- ----------------------------------------------------------------------------
-- Helper para o builder/template manager. Faz INSERT ON CONFLICT pelo
-- triplo UNIQUE (workspace_id, meta_template_name, language).
-- Qualquer UPDATE repõe status='local_draft' — qualquer edição do corpo
-- invalida a aprovação Meta anterior, o user re-submete via API Meta.
-- ============================================================================

create or replace function public.upsert_whatsapp_template(
  p_workspace_id        uuid,
  p_meta_template_name  text,
  p_language            text,
  p_category            text,
  p_body                text,
  p_header_format       text default 'NONE',
  p_header_text         text default null,
  p_footer              text default null,
  p_buttons             jsonb default '[]'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid;
  v_id uuid;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  if not public.is_workspace_member(p_workspace_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  insert into public.whatsapp_templates (
    workspace_id, meta_template_name, language, category, body,
    header_format, header_text, footer, buttons,
    status, created_by
  )
  values (
    p_workspace_id, p_meta_template_name, p_language, p_category, p_body,
    coalesce(p_header_format, 'NONE'), p_header_text, p_footer, coalesce(p_buttons, '[]'::jsonb),
    'local_draft', v_user_id
  )
  on conflict (workspace_id, meta_template_name, language) do update
    set category        = excluded.category,
        body            = excluded.body,
        header_format   = excluded.header_format,
        header_text     = excluded.header_text,
        footer          = excluded.footer,
        buttons         = excluded.buttons,
        -- Qualquer edição invalida aprovação Meta — re-submete.
        status          = 'local_draft',
        rejection_reason = null,
        meta_template_id = null,
        updated_at      = now()
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.upsert_whatsapp_template(uuid, text, text, text, text, text, text, text, jsonb) from public;
grant execute on function public.upsert_whatsapp_template(uuid, text, text, text, text, text, text, text, jsonb) to authenticated;

comment on function public.upsert_whatsapp_template(uuid, text, text, text, text, text, text, text, jsonb) is
  'Cria ou actualiza um whatsapp_template. Em update, repõe status=local_draft (qualquer edição invalida aprovação Meta). Valida auth + workspace membership.';


commit;


-- ============================================================================
-- ROLLBACK (referência — não executar no apply normal)
-- ----------------------------------------------------------------------------
-- begin;
--   -- 1) Reverter trigger function (volta a aceitar só 'replied')
--   create or replace function public.handle_email_reply_create_deal()
--   ... (versão da migration 0010) ...
--
--   -- 2) Reverter CHECK constraint de email_events
--   alter table public.email_events drop constraint if exists email_events_event_type_check;
--   alter table public.email_events add constraint email_events_type_check
--     check (event_type in ('sent','delivered','opened','clicked','replied',
--                           'bounced','complained','unsubscribed'));
--
--   -- 3) Apagar view + RPC + policies + triggers + tabelas
--   drop view if exists public.workspace_whatsapp_config_safe;
--   drop function if exists public.upsert_whatsapp_template(uuid, text, text, text, text, text, text, text, jsonb);
--   drop trigger if exists set_updated_at on public.workspace_whatsapp_config;
--   drop trigger if exists set_updated_at on public.whatsapp_templates;
--   drop table if exists public.workspace_whatsapp_config cascade;
--   drop table if exists public.whatsapp_templates cascade;
-- commit;
-- ============================================================================


-- ============================================================================
-- FIM — 0011_whatsapp.sql
-- ============================================================================
