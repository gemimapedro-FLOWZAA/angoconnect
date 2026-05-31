-- ============================================================================
-- AngoConnect — Suite de testes para email_templates (M3.2)
-- ----------------------------------------------------------------------------
-- Valida a migration `0009_email_templates.sql`:
--   1. SELECT do seed devolve exactamente 6 templates do sistema.
--   2. INSERT de um template custom popula `variables` automaticamente via
--      trigger `trg_email_templates_variables`.
--   3. UPDATE de um template do sistema (workspace_id IS NULL) por um user
--      `authenticated` falha por RLS — nenhuma row é afectada.
--
-- Como correr:
--
--   A) Local (CLI Supabase):
--      $ supabase db reset
--      $ psql "$(supabase status -o env | grep DB_URL | cut -d= -f2-)" \
--             -f supabase/tests/email_templates.sql
--
--   B) Supabase Studio:
--      Cola este ficheiro no SQL Editor.
--      Lê os NOTICE no painel de resultados para ver pass/fail.
--
-- IMPORTANTE: este script ASSUME base de dados limpa para os IDs aaaa/bbbb.
-- O bloco CLEANUP no fim pode ser descomentado para reaplicar.
--
-- Estratégia de autenticação: usamos `set local role authenticated` +
-- `set local request.jwt.claims` para simular um user autenticado a interagir
-- com as policies RLS.
-- ============================================================================


-- ============================================================================
-- SETUP — user + workspace + membership
-- ============================================================================
set local role postgres;  -- bypass RLS para setup

-- 1) User de teste
insert into auth.users (
  id, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, instance_id, aud, role
)
values (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'tpl-test@test.ao',
  crypt('test123', gen_salt('bf')),
  now(), now(), now(),
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated'
)
on conflict (id) do nothing;

-- (profile é criado automaticamente pelo trigger on_auth_user_created)

-- 2) Workspace + membership
insert into public.workspaces (id, name, slug, owner_id, plan, credits_remaining)
values (
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  'Template Test Co',
  'template-test-co',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'starter',
  100
)
on conflict (id) do nothing;

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'owner'
)
on conflict (workspace_id, user_id) do nothing;


-- ============================================================================
-- TESTE 1 — Seed contém exactamente 6 templates do sistema
-- ============================================================================
do $$
declare
  v_count int;
  v_intro_count int;
  v_followup_count int;
  v_break_up_count int;
  v_check_in_count int;
begin
  select count(*) into v_count
  from public.email_templates
  where is_system = true and workspace_id is null;

  if v_count <> 6 then
    raise exception 'TESTE 1 FAIL: esperava 6 templates do sistema, obtive %', v_count;
  end if;

  -- Distribuição por categoria (sanity check)
  select count(*) into v_intro_count
  from public.email_templates
  where is_system = true and category = 'intro';

  select count(*) into v_followup_count
  from public.email_templates
  where is_system = true and category = 'follow_up';

  select count(*) into v_break_up_count
  from public.email_templates
  where is_system = true and category = 'break_up';

  select count(*) into v_check_in_count
  from public.email_templates
  where is_system = true and category = 'check_in';

  if v_intro_count <> 2 then
    raise exception 'TESTE 1 FAIL: esperava 2 templates intro, obtive %', v_intro_count;
  end if;
  if v_followup_count <> 2 then
    raise exception 'TESTE 1 FAIL: esperava 2 templates follow_up, obtive %', v_followup_count;
  end if;
  if v_break_up_count <> 1 then
    raise exception 'TESTE 1 FAIL: esperava 1 template break_up, obtive %', v_break_up_count;
  end if;
  if v_check_in_count <> 1 then
    raise exception 'TESTE 1 FAIL: esperava 1 template check_in, obtive %', v_check_in_count;
  end if;

  raise notice 'TESTE 1 PASS: seed contém 6 templates do sistema (2 intro, 2 follow_up, 1 break_up, 1 check_in)';
end$$;


-- Sanity: o trigger populou `variables` no seed?
do $$
declare
  v_intro_vars jsonb;
begin
  select variables into v_intro_vars
  from public.email_templates
  where is_system = true and name = 'Intro — Conexão inicial';

  -- Esperamos: first_name, company_name, value_prop, sender_name
  if jsonb_array_length(v_intro_vars) < 4 then
    raise exception 'TESTE 1.b FAIL: esperava >= 4 variables no template Intro, obtive % (%)',
      jsonb_array_length(v_intro_vars), v_intro_vars;
  end if;

  if not (v_intro_vars ? 'first_name')
     or not (v_intro_vars ? 'company_name')
     or not (v_intro_vars ? 'sender_name')
     or not (v_intro_vars ? 'value_prop') then
    raise exception 'TESTE 1.b FAIL: variables do template Intro não contém todos os placeholders esperados: %', v_intro_vars;
  end if;

  raise notice 'TESTE 1.b PASS: trigger populou variables no seed correctamente (%)', v_intro_vars;
end$$;


-- ============================================================================
-- TESTE 2 — INSERT de template custom popula `variables` via trigger
-- ============================================================================
-- Autenticar como user owner do workspace
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}';

do $$
declare
  v_id uuid;
  v_vars jsonb;
begin
  insert into public.email_templates (
    workspace_id, name, category, subject, body, language, is_system
  ) values (
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    'Custom — Teste trigger',
    'custom',
    'Olá {{first_name}} da {{company_name}}',
    E'Bom dia {{first_name}},\n\nFalo da {{sender_company}}. {{custom_pitch}}\n\nAté já,\n{{sender_name}}',
    'pt-PT',
    false
  )
  returning id, variables into v_id, v_vars;

  -- Esperamos 5 placeholders distintos: first_name, company_name,
  -- sender_company, custom_pitch, sender_name
  if jsonb_array_length(v_vars) <> 5 then
    raise exception 'TESTE 2 FAIL: esperava 5 variables, obtive %: %',
      jsonb_array_length(v_vars), v_vars;
  end if;

  if not (v_vars ? 'first_name')
     or not (v_vars ? 'company_name')
     or not (v_vars ? 'sender_company')
     or not (v_vars ? 'custom_pitch')
     or not (v_vars ? 'sender_name') then
    raise exception 'TESTE 2 FAIL: variables não contém todos os placeholders esperados: %', v_vars;
  end if;

  raise notice 'TESTE 2 PASS: INSERT custom populou variables automaticamente (%)', v_vars;

  -- Cleanup local do teste 2 para não interferir com testes seguintes
  delete from public.email_templates where id = v_id;
end$$;


-- ============================================================================
-- TESTE 3 — UPDATE de template do sistema por user authenticated falha (RLS)
-- ============================================================================
-- Continuamos como `authenticated` com claim do user de teste.
do $$
declare
  v_affected int;
  v_original_name text;
  v_current_name text;
  v_target_id uuid;
begin
  -- Capturar id + nome original de um template do sistema
  set local role postgres;
  select id, name into v_target_id, v_original_name
  from public.email_templates
  where is_system = true and name = 'Break-up — Última mensagem'
  limit 1;

  if v_target_id is null then
    raise exception 'TESTE 3 PRE-FAIL: template Break-up não encontrado no seed';
  end if;

  -- Voltar para authenticated e tentar editar
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}';

  update public.email_templates
     set name = 'HACKED'
   where id = v_target_id;

  get diagnostics v_affected = row_count;

  -- Verificar (com role postgres) que nada mudou
  set local role postgres;
  select name into v_current_name
  from public.email_templates
  where id = v_target_id;

  if v_affected <> 0 then
    raise exception 'TESTE 3 FAIL: UPDATE afectou % rows (RLS deveria ter filtrado tudo)', v_affected;
  end if;

  if v_current_name <> v_original_name then
    raise exception 'TESTE 3 FAIL: nome do template mudou de "%" para "%" (RLS falhou)',
      v_original_name, v_current_name;
  end if;

  raise notice 'TESTE 3 PASS: UPDATE de template do sistema bloqueado por RLS (rows afectadas=0, nome inalterado)';
end$$;


-- Teste 3.b: DELETE de template do sistema também é bloqueado
do $$
declare
  v_affected int;
  v_count_before int;
  v_count_after int;
begin
  set local role postgres;
  select count(*) into v_count_before
  from public.email_templates
  where is_system = true;

  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}';

  delete from public.email_templates
  where is_system = true and name = 'Break-up — Última mensagem';

  get diagnostics v_affected = row_count;

  set local role postgres;
  select count(*) into v_count_after
  from public.email_templates
  where is_system = true;

  if v_affected <> 0 then
    raise exception 'TESTE 3.b FAIL: DELETE afectou % rows (RLS deveria ter filtrado)', v_affected;
  end if;

  if v_count_after <> v_count_before then
    raise exception 'TESTE 3.b FAIL: count de templates do sistema mudou (% → %)',
      v_count_before, v_count_after;
  end if;

  raise notice 'TESTE 3.b PASS: DELETE de template do sistema bloqueado por RLS (count inalterado: %)', v_count_after;
end$$;


-- Teste 3.c: INSERT com is_system=true por user authenticated é bloqueado
do $$
declare
  v_failed boolean := false;
begin
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}';

  begin
    insert into public.email_templates (
      workspace_id, name, category, subject, body, language, is_system
    ) values (
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      'Fake System Template',
      'custom',
      'Subject teste',
      'Body teste com placeholder {{x}}',
      'pt-PT',
      true  -- tentativa de criar template do sistema
    );
  exception when others then
    v_failed := true;
  end;

  if not v_failed then
    raise exception 'TESTE 3.c FAIL: INSERT com is_system=true deveria falhar mas passou';
  end if;

  raise notice 'TESTE 3.c PASS: INSERT com is_system=true bloqueado (RLS ou check constraint)';
end$$;


-- ============================================================================
-- CLEANUP (opcional — descomenta para re-correr a suite limpa)
-- ============================================================================
-- set local role postgres;
-- delete from public.workspace_members where workspace_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
-- delete from public.email_templates where workspace_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
-- delete from public.workspaces where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
-- delete from public.profiles where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
-- delete from auth.users where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';


-- ============================================================================
-- FIM — email_templates.sql
-- ============================================================================
