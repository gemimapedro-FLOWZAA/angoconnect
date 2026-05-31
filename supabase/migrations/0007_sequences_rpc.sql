-- ============================================================================
-- AngoConnect — Migration 0007 — RPCs de outreach (enrol/pause/unenrol)
-- ----------------------------------------------------------------------------
-- M2.3 introduz o motor de outreach. Esta migration entrega o lado SQL:
--   1. `public.enrol_contacts_into_sequence(p_sequence_id, p_contact_ids[])`
--        — valida workspace, filtra contactos elegíveis, calcula créditos
--          necessários, faz INSERT em `sequence_enrollments`, debita créditos
--          via `add_credits` (mesma transacção / lock pessimista no workspace).
--   2. `public.pause_enrolments(p_enrolment_ids[])`
--        — UPDATE status='paused' (apenas em rows 'active' do mesmo workspace).
--   3. `public.unenrol(p_enrolment_ids[])`
--        — UPDATE status='completed' + completed_at=now()
--          (preserva histórico para analytics; NÃO devolve créditos).
--   4. Índice parcial `sequence_enrollments_due_idx` para o varrimento global
--        do worker BullMQ (`status='active' AND next_action_at <= now()`).
--
-- DECISÕES (sem consultar):
--   * **Debit upfront, no enrolment** (não por cada email enviado).
--     Justificação: alinha com o CLAUDE.md ("1 crédito = 1 contacto exportado")
--     e dá previsibilidade de custo ao user — vê o que vai gastar antes de
--     mandar uma cadência de 5 emails.
--   * **Limite hard de 500 contactos por chamada de `enrol_contacts_into_sequence`.**
--     Justificação: cada call faz SELECT + INSERT + chamada a `add_credits` em
--     loop dentro de uma transacção. Acima de 500 começa a haver risco de
--     timeout no PostgREST (~30s) e o lock no workspace fica retido demasiado
--     tempo, bloqueando outras operações. O frontend deve dividir batches
--     maiores em múltiplas calls.
--   * **`unenrol` NÃO devolve créditos.**
--     Justificação: emails podem já ter sido enviados (worker pode ter
--     processado o passo 0 imediatamente). Refund automático abriria janela
--     para abuso (enrol → unenrol em loop). Casos legítimos vão por suporte
--     que faz `add_credits(reason='refund')` manualmente.
--   * **Só permite enrol em sequences `draft` ou `active`** (não `paused`/`archived`).
--     `draft` permite preview/teste antes de activar; `archived` está em
--     read-only conceptualmente; `paused` o user desligou conscientemente.
--   * **Filtra contactos sem `email`.** O outreach actual é só email; enrol
--     contactos sem email seria gastar crédito sem possibilidade de envio.
--     Quando adicionarmos WhatsApp (M3.4) revisitamos este filtro para aceitar
--     `email IS NOT NULL OR phone IS NOT NULL`.
--   * **Índice novo `sequence_enrollments_due_idx` em vez de reutilizar o
--     existente `idx_enrollments_workspace_status_next`** (definido em 0001).
--     O existente lidera por `workspace_id` — bom para queries do dashboard
--     ("dá-me os meus enrolments activos") mas péssimo para o worker global
--     que faz `SELECT ... WHERE status='active' AND next_action_at <= now()`
--     sem filtro de workspace. O novo é parcial (só `status='active'`) e
--     liderado por `next_action_at`, ideal para o varrimento do worker.
--     Custo: ~30-50 bytes/row extra; ganho: scan O(log n) vs O(n) por tick.
--   * **`enrol_contacts_into_sequence` chama `add_credits` por dentro mesmo
--     esta estando `revoke from authenticated`.** Como ambas são
--     `security definer`, a chamada interna corre com os privilégios do owner
--     da função externa (postgres) — não há violação de RLS nem de GRANT.
--     Mantém `add_credits` blindada contra chamadas directas do cliente, mas
--     permite reutilizá-la como bloco atómico no nosso wrapper.
--
-- Idempotência: `create or replace function`, `create index if not exists`.
-- ============================================================================


-- ============================================================================
-- 1) RPC — enrol_contacts_into_sequence
-- ============================================================================
-- Fluxo (tudo numa transacção):
--   a) Valida auth + sequence existe + user é membro do workspace + status ok.
--   b) Filtra contactos: existentes, visíveis ao user, com email, não
--      duplicados em `sequence_enrollments` para esta sequence.
--   c) Conta elegíveis. Se 0, devolve (0, total_pedido, 0, saldo_actual).
--   d) Verifica créditos suficientes; se não, raise insufficient_credits.
--   e) Lê o primeiro step (steps[0]) para calcular `next_action_at`.
--   f) INSERT loop em `sequence_enrollments`.
--   g) DEBIT via `add_credits(workspace_id, -elegíveis, 'sequence_enrollment',
--      auth.uid(), 'sequence', sequence_id)` — esta chamada faz o lock
--      pessimista no workspace e regista no `credits_log`.
--   h) Devolve resumo (enrolled, skipped, debitados, novo saldo).

create or replace function public.enrol_contacts_into_sequence(
  p_sequence_id   uuid,
  p_contact_ids   uuid[]
)
returns table (
  enrolled_count   int,
  skipped_count    int,
  credits_debited  int,
  new_balance      int
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id          uuid := auth.uid();
  v_workspace_id     uuid;
  v_sequence_status  text;
  v_steps            jsonb;
  v_first_step       jsonb;
  v_day_offset       int;
  v_input_count      int;
  v_eligible_count   int;
  v_skipped_count    int;
  v_new_balance      int;
  v_next_action_at   timestamptz;
begin
  -- ------------------------------------------------------------------
  -- 1) Autenticação obrigatória.
  --    SQLSTATE 42501 = insufficient_privilege.
  -- ------------------------------------------------------------------
  if v_user_id is null then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  -- ------------------------------------------------------------------
  -- 2) Validações de input.
  --    SQLSTATE 22023 = invalid_parameter_value.
  -- ------------------------------------------------------------------
  if p_sequence_id is null then
    raise exception 'sequence_id_required' using errcode = '22023';
  end if;

  if p_contact_ids is null or array_length(p_contact_ids, 1) is null then
    raise exception 'contact_ids_required' using errcode = '22023';
  end if;

  v_input_count := array_length(p_contact_ids, 1);

  if v_input_count > 500 then
    -- Hard limit por call. Acima disso o frontend deve dividir em batches.
    raise exception 'too_many_contacts'
      using errcode = '22023',
            detail  = jsonb_build_object(
              'requested', v_input_count,
              'max_per_call', 500
            )::text;
  end if;

  -- ------------------------------------------------------------------
  -- 3) Verifica sequence: existe, user é membro do workspace, status válido.
  -- ------------------------------------------------------------------
  select s.workspace_id, s.status, s.steps
    into v_workspace_id, v_sequence_status, v_steps
    from public.sequences s
   where s.id = p_sequence_id;

  if not found then
    raise exception 'sequence_not_found' using errcode = '22023';
  end if;

  if not public.is_workspace_member(v_workspace_id) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  if v_sequence_status not in ('active', 'draft') then
    raise exception 'sequence_not_enrollable'
      using errcode = '22023',
            detail  = jsonb_build_object(
              'sequence_id', p_sequence_id,
              'status', v_sequence_status
            )::text;
  end if;

  -- ------------------------------------------------------------------
  -- 4) Sequence precisa de pelo menos 1 step.
  -- ------------------------------------------------------------------
  if v_steps is null
     or jsonb_typeof(v_steps) <> 'array'
     or jsonb_array_length(v_steps) = 0
  then
    raise exception 'sequence_has_no_steps' using errcode = '22023';
  end if;

  v_first_step := v_steps -> 0;
  v_day_offset := coalesce((v_first_step ->> 'day_offset')::int, 0);

  -- Se day_offset = 0 ou null, executa imediatamente no próximo tick.
  if v_day_offset <= 0 then
    v_next_action_at := now();
  else
    v_next_action_at := now() + (v_day_offset * interval '1 day');
  end if;

  -- ------------------------------------------------------------------
  -- 5) Constrói lista de contactos elegíveis numa tabela temporária.
  --    Critérios:
  --      a) Existe em `contacts`.
  --      b) Visível ao user (workspace_id NULL = catálogo público
  --         OU is_workspace_member do workspace privado).
  --      c) Tem email (outreach actual é só email).
  --      d) Ainda NÃO está enrolled nesta sequence (constraint
  --         `sequence_enrollments_unique_pair` impediria, mas filtramos
  --         antes para reportar `skipped_count` correctamente).
  --
  --    `drop table if exists` defensivo: se esta função for chamada duas
  --    vezes dentro da mesma transacção (raro mas possível em testes ou
  --    batch processing), o `on commit drop` só remove ao fim da TX,
  --    pelo que a segunda chamada veria a tabela ainda lá.
  -- ------------------------------------------------------------------
  drop table if exists pg_temp.tmp_eligible_contacts;

  create temporary table tmp_eligible_contacts
    on commit drop
    as
    select c.id as contact_id
      from public.contacts c
     where c.id = any(p_contact_ids)
       and c.email is not null
       and (
         c.workspace_id is null
         or public.is_workspace_member(c.workspace_id)
       )
       and not exists (
         select 1
           from public.sequence_enrollments se
          where se.sequence_id = p_sequence_id
            and se.contact_id  = c.id
       );

  select count(*)::int into v_eligible_count from tmp_eligible_contacts;
  v_skipped_count := v_input_count - v_eligible_count;

  -- Se nada elegível, sai cedo sem mexer em créditos.
  if v_eligible_count = 0 then
    select w.credits_remaining
      into v_new_balance
      from public.workspaces w
     where w.id = v_workspace_id;

    enrolled_count  := 0;
    skipped_count   := v_skipped_count;
    credits_debited := 0;
    new_balance     := coalesce(v_new_balance, 0);
    return next;
    return;
  end if;

  -- ------------------------------------------------------------------
  -- 6) Verifica saldo de créditos ANTES de inserir.
  --    Lock só na leitura aqui é OK porque `add_credits` mais abaixo
  --    faz FOR UPDATE no mesmo workspace; entre estas duas leituras
  --    nenhuma outra transacção pode roubar créditos a este workspace
  --    sem passar por `add_credits`, que também serializa.
  --    Mesmo que houvesse uma race, o `add_credits` final detecta saldo
  --    negativo e levanta `insufficient_credits` (P0001), rollback total.
  -- ------------------------------------------------------------------
  select w.credits_remaining
    into v_new_balance
    from public.workspaces w
   where w.id = v_workspace_id;

  if v_new_balance < v_eligible_count then
    raise exception 'insufficient_credits'
      using errcode = 'P0001',
            detail  = jsonb_build_object(
              'required',  v_eligible_count,
              'available', v_new_balance
            )::text;
  end if;

  -- ------------------------------------------------------------------
  -- 7) INSERT em `sequence_enrollments` para cada contacto elegível.
  --    A constraint `sequence_enrollments_unique_pair` é um safety net
  --    extra contra race conditions (duas chamadas concorrentes com o
  --    mesmo contact_id em arrays diferentes).
  -- ------------------------------------------------------------------
  insert into public.sequence_enrollments (
    sequence_id,
    contact_id,
    workspace_id,
    current_step,
    status,
    enrolled_at,
    next_action_at
  )
  select
    p_sequence_id,
    tec.contact_id,
    v_workspace_id,
    0,
    'active',
    now(),
    v_next_action_at
  from tmp_eligible_contacts tec;

  -- ------------------------------------------------------------------
  -- 8) Débito de créditos atómico via `add_credits`.
  --    A chamada faz lock pessimista no workspace + INSERT no
  --    credits_log + UPDATE em credits_remaining, tudo na mesma
  --    transacção. Se algo falhar aqui, os INSERT em
  --    sequence_enrollments acima também são desfeitos (rollback
  --    transaccional implícito).
  -- ------------------------------------------------------------------
  v_new_balance := public.add_credits(
    p_workspace_id         := v_workspace_id,
    p_amount               := -v_eligible_count,
    p_reason               := 'sequence_enrollment',
    p_performed_by         := v_user_id,
    p_related_entity_type  := 'sequence',
    p_related_entity_id    := p_sequence_id
  );

  -- ------------------------------------------------------------------
  -- 9) Devolve resumo da operação.
  -- ------------------------------------------------------------------
  enrolled_count  := v_eligible_count;
  skipped_count   := v_skipped_count;
  credits_debited := v_eligible_count;
  new_balance     := v_new_balance;
  return next;
end;
$$;

comment on function public.enrol_contacts_into_sequence(uuid, uuid[]) is
  'Inscreve um lote de contactos numa sequence. Valida workspace, filtra contactos elegíveis (existem, visíveis, com email, não duplicados), debita créditos via add_credits (1 crédito = 1 enrolment), e regista enrolments com next_action_at calculado a partir de steps[0].day_offset. Hard limit de 500 contactos por chamada. Raises: unauthorized (42501), sequence_not_found / sequence_not_enrollable / sequence_has_no_steps / too_many_contacts (22023), insufficient_credits (P0001).';


-- ============================================================================
-- 2) RPC — pause_enrolments
-- ============================================================================
-- Pausa um lote de enrolments. Só actualiza rows:
--   * Pertencentes a um workspace do qual o user é membro.
--   * Actualmente em status 'active'.
-- Devolve o número de rows actualizados.

create or replace function public.pause_enrolments(
  p_enrolment_ids uuid[]
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id  uuid := auth.uid();
  v_updated  int;
begin
  if v_user_id is null then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  if p_enrolment_ids is null or array_length(p_enrolment_ids, 1) is null then
    return 0;
  end if;

  update public.sequence_enrollments se
     set status = 'paused'
   where se.id = any(p_enrolment_ids)
     and se.status = 'active'
     and public.is_workspace_member(se.workspace_id);

  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;

comment on function public.pause_enrolments(uuid[]) is
  'Pausa enrolments (status active → paused). Só afecta rows do workspace do user autenticado. Devolve count actualizado. Não toca em créditos.';


-- ============================================================================
-- 3) RPC — unenrol
-- ============================================================================
-- Marca enrolments como `completed` (mantém histórico para analytics).
-- NÃO devolve créditos — refunds são manuais via suporte (`add_credits`
-- com reason='refund').

create or replace function public.unenrol(
  p_enrolment_ids uuid[]
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id  uuid := auth.uid();
  v_updated  int;
begin
  if v_user_id is null then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  if p_enrolment_ids is null or array_length(p_enrolment_ids, 1) is null then
    return 0;
  end if;

  update public.sequence_enrollments se
     set status       = 'completed',
         completed_at = now(),
         next_action_at = null
   where se.id = any(p_enrolment_ids)
     and se.status in ('active', 'paused')
     and public.is_workspace_member(se.workspace_id);

  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;

comment on function public.unenrol(uuid[]) is
  'Desinscreve enrolments (status → completed + completed_at=now()). Não devolve créditos (decisão: refunds via support). Só afecta rows do workspace do user autenticado. Devolve count actualizado.';


-- ============================================================================
-- 4) ÍNDICE — varrimento global do worker BullMQ
-- ============================================================================
-- O worker corre globalmente (não por workspace) e a sua query principal é:
--
--   SELECT id, sequence_id, contact_id, workspace_id, current_step
--     FROM sequence_enrollments
--    WHERE status = 'active'
--      AND next_action_at IS NOT NULL
--      AND next_action_at <= now()
--    ORDER BY next_action_at
--    LIMIT 100;
--
-- O índice existente `idx_enrollments_workspace_status_next` (0001) lidera por
-- `workspace_id` — óptimo para queries de dashboard mas força full-scan para
-- o varrimento global. Este novo índice é parcial (só `status='active'`) e
-- liderado por `next_action_at`, devolvendo as próximas N rows directamente.

create index if not exists sequence_enrollments_due_idx
  on public.sequence_enrollments (next_action_at)
  where status = 'active' and next_action_at is not null;

comment on index public.sequence_enrollments_due_idx is
  'Índice parcial para o varrimento global do worker BullMQ: status=active AND next_action_at <= now(). Complementa idx_enrollments_workspace_status_next (definido em 0001) que serve queries por workspace.';


-- ============================================================================
-- 5) PERMISSÕES
-- ============================================================================
-- enrol/pause/unenrol são chamadas pelo cliente autenticado (via PostgREST).
-- Internamente todas validam workspace membership.
-- `add_credits` continua restrita a service_role; é invocada por dentro de
-- `enrol_contacts_into_sequence` (security definer) com privilégios do owner.

revoke all on function public.enrol_contacts_into_sequence(uuid, uuid[]) from public;
grant execute on function public.enrol_contacts_into_sequence(uuid, uuid[])
  to authenticated, service_role;

revoke all on function public.pause_enrolments(uuid[]) from public;
grant execute on function public.pause_enrolments(uuid[])
  to authenticated, service_role;

revoke all on function public.unenrol(uuid[]) from public;
grant execute on function public.unenrol(uuid[])
  to authenticated, service_role;


-- ============================================================================
-- FIM — 0007_sequences_rpc.sql
-- ============================================================================


-- ============================================================================
-- ROLLBACK (referência — NÃO executar):
-- ----------------------------------------------------------------------------
-- drop index if exists public.sequence_enrollments_due_idx;
-- drop function if exists public.unenrol(uuid[]);
-- drop function if exists public.pause_enrolments(uuid[]);
-- drop function if exists public.enrol_contacts_into_sequence(uuid, uuid[]);
-- ============================================================================
