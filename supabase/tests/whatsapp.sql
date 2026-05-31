-- ============================================================================
-- AngoConnect — Suite de testes para WhatsApp (M3.4)
-- ----------------------------------------------------------------------------
-- Valida a migration `0011_whatsapp.sql`:
--   1. INSERT de whatsapp_template + UNIQUE (workspace, name, language).
--   2. INSERT email_events com event_type='wa_delivered' passa o CHECK.
--   3. INSERT email_events com event_type='wa_replied' dispara o trigger
--      handle_email_reply_create_deal (cria deal automático).
--
-- Como correr:
--
--   A) Local (CLI Supabase):
--      $ supabase db reset
--      $ psql "$(supabase status -o env | grep DB_URL | cut -d= -f2-)" \
--             -f supabase/tests/whatsapp.sql
--
--   B) Supabase Studio: cola no SQL Editor.
--
-- IMPORTANTE: usa IDs estáveis (cccc/dddd/eeee/ffff) para não chocar com
-- as suites email_templates (aaaa/bbbb) e rls_isolation.
-- ============================================================================


-- ============================================================================
-- SETUP — user + workspace + membership + company + contact
-- ============================================================================
set local role postgres;  -- bypass RLS para setup

-- 1) User de teste
insert into auth.users (
  id, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, instance_id, aud, role
)
values (
  'cccccccc-cccc-cccc-cccc-cccccccccccc',
  'wa-test@test.ao',
  crypt('test123', gen_salt('bf')),
  now(), now(), now(),
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated'
)
on conflict (id) do nothing;

-- 2) Workspace + membership (owner)
insert into public.workspaces (id, name, slug, owner_id, plan, credits_remaining)
values (
  'dddddddd-dddd-dddd-dddd-dddddddddddd',
  'WA Test Co',
  'wa-test-co',
  'cccccccc-cccc-cccc-cccc-cccccccccccc',
  'starter',
  100
)
on conflict (id) do nothing;

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'dddddddd-dddd-dddd-dddd-dddddddddddd',
  'cccccccc-cccc-cccc-cccc-cccccccccccc',
  'owner'
)
on conflict (workspace_id, user_id) do nothing;

-- 3) Company + contact (para o teste 3 do deal automático)
insert into public.companies (id, workspace_id, name, provincia, sector)
values (
  'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
  'dddddddd-dddd-dddd-dddd-dddddddddddd',
  'WA Target Lda',
  'Luanda',
  'tech'
)
on conflict (id) do nothing;

insert into public.contacts (id, workspace_id, company_id, full_name, email, phone)
values (
  'ffffffff-ffff-ffff-ffff-ffffffffffff',
  'dddddddd-dddd-dddd-dddd-dddddddddddd',
  'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
  'João Cliente',
  'joao@watarget.ao',
  '+244912000111'
)
on conflict (id) do nothing;

-- 4) Sequence + enrolment (necessário para o trigger conseguir mapear o evento)
insert into public.sequences (id, workspace_id, name, status, steps, created_by)
values (
  '11111111-1111-1111-1111-111111111111',
  'dddddddd-dddd-dddd-dddd-dddddddddddd',
  'WA Test Sequence',
  'active',
  '[{"day_offset":0,"channel":"whatsapp"}]'::jsonb,
  'cccccccc-cccc-cccc-cccc-cccccccccccc'
)
on conflict (id) do nothing;

insert into public.sequence_enrollments (id, sequence_id, contact_id, workspace_id, status)
values (
  '22222222-2222-2222-2222-222222222222',
  '11111111-1111-1111-1111-111111111111',
  'ffffffff-ffff-ffff-ffff-ffffffffffff',
  'dddddddd-dddd-dddd-dddd-dddddddddddd',
  'active'
)
on conflict (sequence_id, contact_id) do nothing;


-- ============================================================================
-- TESTE 1 — INSERT whatsapp_template + UNIQUE (workspace, name, language)
-- ============================================================================
set local role authenticated;
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}';

do $$
declare
  v_id_a uuid;
  v_id_b uuid;
  v_failed boolean := false;
begin
  -- 1.a — Insert inicial passa
  insert into public.whatsapp_templates (
    workspace_id, meta_template_name, language, category, body
  ) values (
    'dddddddd-dddd-dddd-dddd-dddddddddddd',
    'intro_b2b_pt',
    'pt_PT',
    'MARKETING',
    'Olá {{1}}, gostávamos de falar consigo sobre a {{2}}.'
  )
  returning id into v_id_a;

  if v_id_a is null then
    raise exception 'TESTE 1.a FAIL: INSERT inicial não devolveu id';
  end if;

  -- 1.b — Insert de outra linguagem com o mesmo nome PASSA (UNIQUE inclui language)
  insert into public.whatsapp_templates (
    workspace_id, meta_template_name, language, category, body
  ) values (
    'dddddddd-dddd-dddd-dddd-dddddddddddd',
    'intro_b2b_pt',
    'pt_AO',
    'MARKETING',
    'Olá {{1}}, queríamos falar consigo sobre a {{2}}.'
  )
  returning id into v_id_b;

  if v_id_b is null or v_id_a = v_id_b then
    raise exception 'TESTE 1.b FAIL: INSERT mesma name+language diferente não devolveu novo id';
  end if;

  -- 1.c — Insert duplicado (mesma workspace+name+language) DEVE falhar
  begin
    insert into public.whatsapp_templates (
      workspace_id, meta_template_name, language, category, body
    ) values (
      'dddddddd-dddd-dddd-dddd-dddddddddddd',
      'intro_b2b_pt',
      'pt_PT',  -- mesmo que 1.a
      'UTILITY',
      'Tentativa duplicada'
    );
  exception when unique_violation then
    v_failed := true;
  end;

  if not v_failed then
    raise exception 'TESTE 1.c FAIL: INSERT duplicado deveria ter violado UNIQUE';
  end if;

  raise notice 'TESTE 1 PASS: insert + segundo idioma + UNIQUE constraint a funcionar';

  -- Cleanup local
  delete from public.whatsapp_templates where id in (v_id_a, v_id_b);
end$$;


-- ============================================================================
-- TESTE 2 — INSERT email_events com 'wa_delivered' passa CHECK
-- ============================================================================
-- Inserimos via role authenticated (membro do workspace) e validamos que o
-- CHECK constraint actualizado aceita o prefixo wa_*.

do $$
declare
  v_id uuid;
begin
  insert into public.email_events (
    enrollment_id, workspace_id, event_type, metadata
  ) values (
    '22222222-2222-2222-2222-222222222222',
    'dddddddd-dddd-dddd-dddd-dddddddddddd',
    'wa_delivered',
    '{"wamid":"wamid.test.001","timestamp":"2026-05-28T10:00:00Z"}'::jsonb
  )
  returning id into v_id;

  if v_id is null then
    raise exception 'TESTE 2 FAIL: INSERT com wa_delivered não devolveu id';
  end if;

  raise notice 'TESTE 2 PASS: INSERT com event_type=wa_delivered aceite pelo CHECK';

  -- Cleanup
  set local role postgres;
  delete from public.email_events where id = v_id;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}';
end$$;


-- Teste 2.b — event_type inválido continua a falhar o CHECK
do $$
declare
  v_failed boolean := false;
begin
  begin
    insert into public.email_events (
      enrollment_id, workspace_id, event_type
    ) values (
      '22222222-2222-2222-2222-222222222222',
      'dddddddd-dddd-dddd-dddd-dddddddddddd',
      'wa_unknown_event'
    );
  exception when check_violation then
    v_failed := true;
  end;

  if not v_failed then
    raise exception 'TESTE 2.b FAIL: event_type inválido deveria ter sido rejeitado';
  end if;

  raise notice 'TESTE 2.b PASS: CHECK continua a rejeitar event_types fora do whitelist';
end$$;


-- ============================================================================
-- TESTE 3 — INSERT email_events com 'wa_replied' dispara trigger create_deal
-- ============================================================================
do $$
declare
  v_deal_count_before int;
  v_deal_count_after  int;
  v_deal_source       text;
  v_deal_stage_name   text;
  v_enrolment_status  text;
  v_event_id          uuid;
begin
  set local role postgres;  -- contagem fiável sem RLS

  select count(*) into v_deal_count_before
  from public.deals
  where workspace_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
    and contact_id  = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

  if v_deal_count_before <> 0 then
    -- Limpa estado deixado por execuções anteriores
    delete from public.deals
    where workspace_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
      and contact_id  = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  end if;

  -- Inserir o evento como authenticated (simula webhook path normal)
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}';

  insert into public.email_events (
    enrollment_id, workspace_id, event_type, metadata
  ) values (
    '22222222-2222-2222-2222-222222222222',
    'dddddddd-dddd-dddd-dddd-dddddddddddd',
    'wa_replied',
    '{"wamid":"wamid.test.reply","from":"+244912000111"}'::jsonb
  )
  returning id into v_event_id;

  -- Verificar o lado do trigger com role postgres
  set local role postgres;

  select count(*) into v_deal_count_after
  from public.deals
  where workspace_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
    and contact_id  = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

  if v_deal_count_after <> 1 then
    raise exception 'TESTE 3 FAIL: esperava 1 deal criado pelo trigger, obtive %', v_deal_count_after;
  end if;

  select d.source, s.name into v_deal_source, v_deal_stage_name
  from public.deals d
  join public.deal_stages s on s.id = d.stage_id
  where d.workspace_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
    and d.contact_id  = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

  if v_deal_source <> 'auto_reply' then
    raise exception 'TESTE 3 FAIL: deal.source esperava auto_reply, obtive %', v_deal_source;
  end if;

  if v_deal_stage_name <> 'Contactado' then
    raise exception 'TESTE 3 FAIL: deal.stage esperava Contactado, obtive %', v_deal_stage_name;
  end if;

  -- Verifica que o enrolment também passou a replied
  select status into v_enrolment_status
  from public.sequence_enrollments
  where id = '22222222-2222-2222-2222-222222222222';

  if v_enrolment_status <> 'replied' then
    raise exception 'TESTE 3 FAIL: enrolment.status esperava replied, obtive %', v_enrolment_status;
  end if;

  raise notice 'TESTE 3 PASS: wa_replied criou deal em Contactado (source=auto_reply) e marcou enrolment como replied';

  -- Cleanup local para idempotência
  delete from public.email_events where id = v_event_id;
  delete from public.deals
  where workspace_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
    and contact_id  = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  update public.sequence_enrollments
     set status = 'active'
   where id = '22222222-2222-2222-2222-222222222222';
end$$;


-- ============================================================================
-- CLEANUP (opcional — descomenta para re-correr a suite limpa)
-- ============================================================================
-- set local role postgres;
-- delete from public.sequence_enrollments where id = '22222222-2222-2222-2222-222222222222';
-- delete from public.sequences            where id = '11111111-1111-1111-1111-111111111111';
-- delete from public.contacts             where id = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
-- delete from public.companies            where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
-- delete from public.workspace_members    where workspace_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
-- delete from public.workspaces           where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
-- delete from public.profiles             where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
-- delete from auth.users                  where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';


-- ============================================================================
-- FIM — whatsapp.sql
-- ============================================================================
