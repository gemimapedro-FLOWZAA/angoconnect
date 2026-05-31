-- ============================================================================
-- AngoConnect — Suite de testes para outreach RPCs (M2.3)
-- ----------------------------------------------------------------------------
-- Valida as RPCs introduzidas em `0007_sequences_rpc.sql`:
--   * `public.enrol_contacts_into_sequence(uuid, uuid[])`
--   * `public.pause_enrolments(uuid[])`
--   * `public.unenrol(uuid[])`
--
-- Como correr:
--
--   A) Local (CLI Supabase):
--      $ supabase db reset
--      $ psql "$(supabase status -o env | grep DB_URL | cut -d= -f2-)" \
--             -f supabase/tests/sequences_enrol.sql
--
--   B) Supabase Studio:
--      Cola este ficheiro no SQL Editor.
--      Lê os NOTICE no painel de resultados para ver pass/fail.
--
-- IMPORTANTE: este script ASSUME base de dados limpa para os IDs cccc/dddd/eeee.
-- O bloco CLEANUP no fim pode ser descomentado para reaplicar.
--
-- Estratégia de autenticação: usamos `set local role authenticated` +
-- `set local request.jwt.claims` para que `auth.uid()` devolva o user
-- correcto dentro das RPCs `security definer`.
-- ============================================================================


-- ============================================================================
-- SETUP — user, workspace, sequences, contactos
-- ============================================================================
set local role postgres;  -- bypass RLS para setup

-- 1) User de teste
insert into auth.users (
  id, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, instance_id, aud, role
)
values (
  'cccccccc-cccc-cccc-cccc-cccccccccccc',
  'enrol-test@test.ao',
  crypt('test123', gen_salt('bf')),
  now(), now(), now(),
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated'
)
on conflict (id) do nothing;

-- 2) Workspace com 3 créditos (suficiente para 3 enrolments, insuficiente p/ 5)
insert into public.workspaces (id, name, slug, owner_id, plan, credits_remaining)
values (
  'dddddddd-dddd-dddd-dddd-dddddddddddd',
  'Enrol Test Co',
  'enrol-test-co',
  'cccccccc-cccc-cccc-cccc-cccccccccccc',
  'starter',
  3
)
on conflict (id) do nothing;

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'dddddddd-dddd-dddd-dddd-dddddddddddd',
  'cccccccc-cccc-cccc-cccc-cccccccccccc',
  'owner'
)
on conflict (workspace_id, user_id) do nothing;

-- 3) Sequence ACTIVE com 2 steps (day_offset 0 e 3)
insert into public.sequences (id, workspace_id, name, status, steps, created_by)
values (
  'eeeeeeee-eeee-eeee-eeee-eeeeeeee0001',
  'dddddddd-dddd-dddd-dddd-dddddddddddd',
  'Test Sequence Active',
  'active',
  '[
    {"day_offset": 0, "channel": "email", "subject": "Olá", "body": "Body 1"},
    {"day_offset": 3, "channel": "email", "subject": "Follow-up", "body": "Body 2"}
  ]'::jsonb,
  'cccccccc-cccc-cccc-cccc-cccccccccccc'
)
on conflict (id) do nothing;

-- 4) Sequence PAUSED (para teste 4)
insert into public.sequences (id, workspace_id, name, status, steps, created_by)
values (
  'eeeeeeee-eeee-eeee-eeee-eeeeeeee0002',
  'dddddddd-dddd-dddd-dddd-dddddddddddd',
  'Test Sequence Paused',
  'paused',
  '[{"day_offset": 0, "channel": "email", "subject": "X", "body": "Y"}]'::jsonb,
  'cccccccc-cccc-cccc-cccc-cccccccccccc'
)
on conflict (id) do nothing;

-- 5) Company + 4 contactos (3 com email, 1 sem email)
insert into public.companies (id, workspace_id, name, provincia, sector)
values (
  'ffffffff-ffff-ffff-ffff-ffffffff0001',
  'dddddddd-dddd-dddd-dddd-dddddddddddd',
  'ACME Angola Lda',
  'Luanda',
  'tech'
)
on conflict (id) do nothing;

insert into public.contacts (id, company_id, workspace_id, full_name, email)
values
  ('ffffffff-ffff-ffff-ffff-ffffffff0011',
   'ffffffff-ffff-ffff-ffff-ffffffff0001',
   'dddddddd-dddd-dddd-dddd-dddddddddddd',
   'Alice Silva', 'alice@acme.ao'),
  ('ffffffff-ffff-ffff-ffff-ffffffff0012',
   'ffffffff-ffff-ffff-ffff-ffffffff0001',
   'dddddddd-dddd-dddd-dddd-dddddddddddd',
   'Bruno Mendes', 'bruno@acme.ao'),
  ('ffffffff-ffff-ffff-ffff-ffffffff0013',
   'ffffffff-ffff-ffff-ffff-ffffffff0001',
   'dddddddd-dddd-dddd-dddd-dddddddddddd',
   'Carla Lopes', 'carla@acme.ao'),
  ('ffffffff-ffff-ffff-ffff-ffffffff0014',
   'ffffffff-ffff-ffff-ffff-ffffffff0001',
   'dddddddd-dddd-dddd-dddd-dddddddddddd',
   'Daniel Sem-Email', null)
on conflict (id) do nothing;


-- ============================================================================
-- Autenticar como `cccccccc...` para que `auth.uid()` devolva esse id.
-- ============================================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}';


-- ============================================================================
-- TESTE 1 — Enrol de 3 contactos válidos
--   Cenário: 3 contactos com email, sequence active, saldo 3.
--   Esperado: enrolled=3, skipped=0 (apenas passamos os 3 com email),
--             credits_debited=3, new_balance=0.
--             credits_log tem entrada com amount=-3, reason='sequence_enrollment'.
-- ============================================================================
do $$
declare
  v_enrolled  int;
  v_skipped   int;
  v_debited   int;
  v_balance   int;
  v_log_count int;
begin
  select er.enrolled_count, er.skipped_count, er.credits_debited, er.new_balance
    into v_enrolled, v_skipped, v_debited, v_balance
    from public.enrol_contacts_into_sequence(
      'eeeeeeee-eeee-eeee-eeee-eeeeeeee0001',
      array[
        'ffffffff-ffff-ffff-ffff-ffffffff0011'::uuid,
        'ffffffff-ffff-ffff-ffff-ffffffff0012'::uuid,
        'ffffffff-ffff-ffff-ffff-ffffffff0013'::uuid
      ]
    ) er;

  if v_enrolled <> 3 then
    raise warning 'TESTE 1a FALHOU — enrolled_count = % (esperado 3)', v_enrolled;
    return;
  end if;
  if v_skipped <> 0 then
    raise warning 'TESTE 1b FALHOU — skipped_count = % (esperado 0)', v_skipped;
    return;
  end if;
  if v_debited <> 3 then
    raise warning 'TESTE 1c FALHOU — credits_debited = % (esperado 3)', v_debited;
    return;
  end if;
  if v_balance <> 0 then
    raise warning 'TESTE 1d FALHOU — new_balance = % (esperado 0)', v_balance;
    return;
  end if;

  -- Verificar ledger
  select count(*) into v_log_count
    from public.credits_log
   where workspace_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
     and reason       = 'sequence_enrollment'
     and amount       = -3
     and balance_after = 0;
  if v_log_count <> 1 then
    raise warning 'TESTE 1e FALHOU — credits_log matching = % (esperado 1)', v_log_count;
    return;
  end if;

  raise notice 'TESTE 1 OK — Enrol 3 contactos: enrolled=3, debited=3, balance=0, log criado';
end $$;


-- ============================================================================
-- TESTE 2 — Enrol com créditos insuficientes
--   Cenário: workspace agora tem 0 créditos. Tentamos enrolar mais contactos
--            (após recarregar 1 crédito apenas, para garantir saldo<requerido).
--   Esperado: raise insufficient_credits (P0001); saldo intacto; nada inserido.
-- ============================================================================
set local role postgres;
-- Reset: limpa enrolments + recoloca workspace a 1 crédito
delete from public.sequence_enrollments
 where sequence_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeee0001';
update public.workspaces set credits_remaining = 1
 where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

set local role authenticated;
set local request.jwt.claims to '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}';

do $$
declare
  v_balance_before int;
  v_balance_after  int;
  v_caught_state   text;
  v_caught         boolean := false;
  v_enrol_count    int;
begin
  -- Estamos como role `authenticated` (membro do workspace) → RLS permite read.
  select credits_remaining into v_balance_before
    from public.workspaces
   where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

  begin
    perform * from public.enrol_contacts_into_sequence(
      'eeeeeeee-eeee-eeee-eeee-eeeeeeee0001',
      array[
        'ffffffff-ffff-ffff-ffff-ffffffff0011'::uuid,
        'ffffffff-ffff-ffff-ffff-ffffffff0012'::uuid,
        'ffffffff-ffff-ffff-ffff-ffffffff0013'::uuid
      ]
    );
  exception
    when raise_exception then
      v_caught := true;
      get stacked diagnostics v_caught_state = returned_sqlstate;
  end;

  if not v_caught then
    raise warning 'TESTE 2a FALHOU — saldo insuficiente não lançou excepção';
    return;
  end if;
  if v_caught_state <> 'P0001' then
    raise warning 'TESTE 2b FALHOU — SQLSTATE = % (esperado P0001)', v_caught_state;
    return;
  end if;

  select credits_remaining into v_balance_after
    from public.workspaces
   where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  select count(*) into v_enrol_count
    from public.sequence_enrollments
   where sequence_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeee0001';

  if v_balance_after <> v_balance_before then
    raise warning 'TESTE 2c FALHOU — saldo mudou de % para %', v_balance_before, v_balance_after;
    return;
  end if;
  if v_enrol_count <> 0 then
    raise warning 'TESTE 2d FALHOU — % enrolments criados apesar da excepção', v_enrol_count;
    return;
  end if;

  raise notice 'TESTE 2 OK — Saldo insuficiente: P0001 raised, saldo intacto (=%), 0 enrolments', v_balance_after;
end $$;


-- ============================================================================
-- TESTE 3 — Enrol que duplica (skipped > 0)
--   Cenário: recarrega 3 créditos. Enrola Alice + Bruno + Carla (sucesso, 3).
--            Depois, com saldo 0, recarrega mais 5 e tenta enrolar os mesmos
--            3 + 1 novo sem email → todos skipped.
--   Esperado: enrolled=0, skipped=4, debited=0, balance inalterado (=5).
-- ============================================================================
set local role postgres;
update public.workspaces set credits_remaining = 3
 where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
set local role authenticated;
set local request.jwt.claims to '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}';

do $$
declare
  v_e int; v_s int; v_d int; v_b int;
begin
  -- Primeiro enrol (sucesso) — consome 3 créditos
  select er.enrolled_count, er.skipped_count, er.credits_debited, er.new_balance
    into v_e, v_s, v_d, v_b
    from public.enrol_contacts_into_sequence(
      'eeeeeeee-eeee-eeee-eeee-eeeeeeee0001',
      array[
        'ffffffff-ffff-ffff-ffff-ffffffff0011'::uuid,
        'ffffffff-ffff-ffff-ffff-ffffffff0012'::uuid,
        'ffffffff-ffff-ffff-ffff-ffffffff0013'::uuid
      ]
    ) er;
  if v_e <> 3 then
    raise warning 'TESTE 3 SETUP FALHOU — primeiro enrol devolveu %', v_e;
    return;
  end if;
end $$;

-- Recarrega 5 créditos para garantir que falha seria por skip e não por saldo
set local role postgres;
update public.workspaces set credits_remaining = 5
 where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
set local role authenticated;
set local request.jwt.claims to '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}';

do $$
declare
  v_e int; v_s int; v_d int; v_b int;
begin
  -- Segundo enrol: mesmos 3 + Daniel (sem email)
  select er.enrolled_count, er.skipped_count, er.credits_debited, er.new_balance
    into v_e, v_s, v_d, v_b
    from public.enrol_contacts_into_sequence(
      'eeeeeeee-eeee-eeee-eeee-eeeeeeee0001',
      array[
        'ffffffff-ffff-ffff-ffff-ffffffff0011'::uuid,
        'ffffffff-ffff-ffff-ffff-ffffffff0012'::uuid,
        'ffffffff-ffff-ffff-ffff-ffffffff0013'::uuid,
        'ffffffff-ffff-ffff-ffff-ffffffff0014'::uuid
      ]
    ) er;

  if v_e <> 0 then
    raise warning 'TESTE 3a FALHOU — enrolled = % (esperado 0)', v_e;
    return;
  end if;
  if v_s <> 4 then
    raise warning 'TESTE 3b FALHOU — skipped = % (esperado 4)', v_s;
    return;
  end if;
  if v_d <> 0 then
    raise warning 'TESTE 3c FALHOU — debited = % (esperado 0)', v_d;
    return;
  end if;
  if v_b <> 5 then
    raise warning 'TESTE 3d FALHOU — balance = % (esperado 5, sem mudança)', v_b;
    return;
  end if;

  raise notice 'TESTE 3 OK — Enrol duplicado: enrolled=0, skipped=4, debited=0, balance=5';
end $$;


-- ============================================================================
-- TESTE 4 — Enrol em sequence PAUSED
--   Cenário: tenta enrolar contacto na sequence paused.
--   Esperado: raise sequence_not_enrollable (SQLSTATE 22023).
-- ============================================================================
do $$
declare
  v_caught       boolean := false;
  v_caught_state text;
begin
  begin
    perform * from public.enrol_contacts_into_sequence(
      'eeeeeeee-eeee-eeee-eeee-eeeeeeee0002',
      array['ffffffff-ffff-ffff-ffff-ffffffff0011'::uuid]
    );
  exception
    when others then
      v_caught := true;
      get stacked diagnostics v_caught_state = returned_sqlstate;
  end;

  if not v_caught then
    raise warning 'TESTE 4a FALHOU — enrol em sequence paused não lançou excepção';
    return;
  end if;
  if v_caught_state <> '22023' then
    raise warning 'TESTE 4b FALHOU — SQLSTATE = % (esperado 22023)', v_caught_state;
    return;
  end if;

  raise notice 'TESTE 4 OK — Sequence paused: 22023 raised (sequence_not_enrollable)';
end $$;


-- ============================================================================
-- TESTE 5 — pause_enrolments + unenrol funcionam
--   Cenário: temos 3 enrolments active (do teste 3 setup).
--            Pause 2 deles → status='paused', returns 2.
--            Unenrol 1 do que estava active → status='completed', returns 1.
--   Esperado: counts correctos; status persistidos.
-- ============================================================================
do $$
declare
  v_paused_count    int;
  v_unenrol_count   int;
  v_enrolment_ids   uuid[];
  v_enrol_a uuid;
  v_enrol_b uuid;
  v_enrol_c uuid;
  v_status_a text;
  v_status_b text;
  v_status_c text;
begin
  -- Buscar os IDs dos 3 enrolments criados no teste 3.
  -- Estamos como role `authenticated` mas o user é membro do workspace,
  -- pelo que RLS permite o SELECT em sequence_enrollments.
  select array_agg(id order by enrolled_at)
    into v_enrolment_ids
    from public.sequence_enrollments
   where sequence_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeee0001'
     and workspace_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

  if array_length(v_enrolment_ids, 1) <> 3 then
    raise warning 'TESTE 5 SETUP FALHOU — esperava 3 enrolments, encontrei %',
                   array_length(v_enrolment_ids, 1);
    return;
  end if;

  v_enrol_a := v_enrolment_ids[1];
  v_enrol_b := v_enrolment_ids[2];
  v_enrol_c := v_enrolment_ids[3];

  -- 5.1 — Pause os primeiros 2
  v_paused_count := public.pause_enrolments(array[v_enrol_a, v_enrol_b]);

  if v_paused_count <> 2 then
    raise warning 'TESTE 5a FALHOU — pause returned % (esperado 2)', v_paused_count;
    return;
  end if;

  select status into v_status_a from public.sequence_enrollments where id = v_enrol_a;
  select status into v_status_b from public.sequence_enrollments where id = v_enrol_b;

  if v_status_a <> 'paused' or v_status_b <> 'paused' then
    raise warning 'TESTE 5b FALHOU — status A=%, B=% (esperado paused)', v_status_a, v_status_b;
    return;
  end if;

  -- 5.2 — Unenrol o C (ainda active) — devolve 1
  v_unenrol_count := public.unenrol(array[v_enrol_c]);

  if v_unenrol_count <> 1 then
    raise warning 'TESTE 5c FALHOU — unenrol returned % (esperado 1)', v_unenrol_count;
    return;
  end if;

  select status into v_status_c from public.sequence_enrollments where id = v_enrol_c;

  if v_status_c <> 'completed' then
    raise warning 'TESTE 5d FALHOU — status C = % (esperado completed)', v_status_c;
    return;
  end if;

  raise notice 'TESTE 5 OK — Pause 2 → paused, Unenrol 1 → completed';
end $$;


-- ============================================================================
-- CLEANUP (opcional — descomenta para reaplicar)
-- ----------------------------------------------------------------------------
-- set local role postgres;
-- delete from public.sequence_enrollments
--  where workspace_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
-- delete from public.credits_log
--  where workspace_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
-- delete from public.contacts
--  where company_id = 'ffffffff-ffff-ffff-ffff-ffffffff0001';
-- delete from public.companies
--  where id = 'ffffffff-ffff-ffff-ffff-ffffffff0001';
-- delete from public.sequences
--  where workspace_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
-- delete from public.workspace_members
--  where workspace_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
-- delete from public.workspaces
--  where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
-- delete from auth.users
--  where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
-- ============================================================================

reset role;
