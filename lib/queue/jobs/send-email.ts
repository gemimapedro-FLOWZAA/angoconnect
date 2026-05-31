/**
 * AngoConnect — Job processor: envio de step de outreach
 * ===========================================================================
 * Processador da fila `sequence-runner`. Recebe `{ enrolmentId, stepIndex }`
 * e executa:
 *
 *   1. Lookup do enrolment + sequence + contact + workspace (admin client,
 *      bypass RLS — o worker corre fora de qualquer auth context).
 *   2. Verificação de idempotência:
 *        - status === 'active'
 *        - current_step === stepIndex
 *      Se não bater, no-op (já foi processado por outra tentativa, ou foi
 *      pausado/concluído manualmente).
 *   3. Lê `step = sequence.steps[stepIndex]` e substitui placeholders no
 *      subject/body.
 *   4. Envia via `sendOutreachEmail` (Resend). Falha → throw, BullMQ retry.
 *   5. INSERT em `email_events` (event_type='sent').
 *   6. UPDATE enrolment:
 *        - current_step += 1
 *        - se passa do último step → status='completed', completed_at=now()
 *        - senão → next_action_at = now() + sequence.steps[stepIndex+1].day_offset days
 *
 * NB: este worker corre em ambiente sem auth context (BullMQ worker ou cron
 * drainer), por isso usa o admin client para todas as operações.
 */

import type { Job } from 'bullmq';
import { sendOutreachEmail } from '@/lib/email/resend';
import type { SendEmailJobData } from '@/lib/queue/queues';
import { createAdminClient } from '@/lib/supabase/admin';
import type {
  Database,
  Json,
  SequenceStep,
} from '@/lib/supabase/types';

// ---------------------------------------------------------------------------
// Tipos auxiliares
// ---------------------------------------------------------------------------

type AdminClient = ReturnType<typeof createAdminClient>;

interface EnrolmentRow {
  id: string;
  sequence_id: string;
  contact_id: string;
  workspace_id: string;
  current_step: number;
  status: Database['public']['Tables']['sequence_enrollments']['Row']['status'];
}

interface SequenceRow {
  id: string;
  steps: Json;
}

interface ContactRow {
  id: string;
  name: string | null;
  title: string | null;
  email: string | null;
  company_id: string | null;
}

interface CompanyRow {
  id: string;
  name: string | null;
}

interface WorkspaceRow {
  id: string;
  name: string | null;
}

// ---------------------------------------------------------------------------
// Resultado público (útil para logs / testes)
// ---------------------------------------------------------------------------

export type ProcessSendEmailResult =
  | { status: 'sent'; resendId: string; nextStep: number | null }
  | { status: 'completed' }
  | {
      status: 'skipped';
      reason:
        | 'enrolment_not_found'
        | 'enrolment_not_active'
        | 'step_mismatch'
        | 'step_out_of_range'
        | 'contact_no_email'
        | 'invalid_step';
    };

// ---------------------------------------------------------------------------
// Placeholders
// ---------------------------------------------------------------------------

/**
 * Substitui placeholders `{{key}}` por valores do mapa fornecido. Chaves não
 * mapeadas ficam vazias. Implementação simples — sem escape HTML (o user
 * controla o template e o destinatário é confiável a este nível).
 */
function applyPlaceholders(
  template: string,
  values: Record<string, string | null | undefined>
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => {
    const val = values[key as keyof typeof values];
    return typeof val === 'string' ? val : '';
  });
}

/** Extrai primeiro nome de "Nome Completo" — fallback string vazia. */
function firstNameFrom(fullName: string | null): string {
  if (!fullName) return '';
  return fullName.trim().split(/\s+/)[0] ?? '';
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

async function fetchEnrolment(
  admin: AdminClient,
  enrolmentId: string
): Promise<EnrolmentRow | null> {
  const { data, error } = await admin
    .from('sequence_enrollments')
    .select('id, sequence_id, contact_id, workspace_id, current_step, status')
    .eq('id', enrolmentId)
    .maybeSingle();

  if (error) {
    throw new Error(
      `lookup enrolment ${enrolmentId} failed: ${error.message}`
    );
  }
  return (data as EnrolmentRow | null) ?? null;
}

async function fetchSequence(
  admin: AdminClient,
  sequenceId: string
): Promise<SequenceRow | null> {
  const { data, error } = await admin
    .from('sequences')
    .select('id, steps')
    .eq('id', sequenceId)
    .maybeSingle();

  if (error) {
    throw new Error(`lookup sequence ${sequenceId} failed: ${error.message}`);
  }
  return (data as SequenceRow | null) ?? null;
}

async function fetchContact(
  admin: AdminClient,
  contactId: string
): Promise<ContactRow | null> {
  // `contacts` ainda não está no Database type — usamos cast para evitar
  // partir o build até regenerarmos os tipos via supabase gen types.
  const { data, error } = await (admin as unknown as AdminClientUntyped)
    .from('contacts')
    .select('id, name, title, email, company_id')
    .eq('id', contactId)
    .maybeSingle();

  if (error) {
    throw new Error(`lookup contact ${contactId} failed: ${error.message}`);
  }
  return (data as ContactRow | null) ?? null;
}

async function fetchCompany(
  admin: AdminClient,
  companyId: string
): Promise<CompanyRow | null> {
  const { data, error } = await (admin as unknown as AdminClientUntyped)
    .from('companies')
    .select('id, name')
    .eq('id', companyId)
    .maybeSingle();

  if (error) {
    // Não rebenta o envio só por falhar lookup de empresa — usamos string vazia.
    console.warn(
      `[send-email] lookup company ${companyId} falhou`,
      error.message
    );
    return null;
  }
  return (data as CompanyRow | null) ?? null;
}

async function fetchWorkspace(
  admin: AdminClient,
  workspaceId: string
): Promise<WorkspaceRow | null> {
  const { data, error } = await admin
    .from('workspaces')
    .select('id, name')
    .eq('id', workspaceId)
    .maybeSingle();

  if (error) {
    throw new Error(`lookup workspace ${workspaceId} failed: ${error.message}`);
  }
  return (data as WorkspaceRow | null) ?? null;
}

// Untyped escape hatch para tabelas ainda não no stub (`contacts`,
// `companies`). Mantém-se restrito a este módulo.
interface AdminClientUntyped {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (
        col: string,
        val: unknown
      ) => {
        maybeSingle: () => Promise<{
          data: unknown | null;
          error: { message: string } | null;
        }>;
      };
    };
  };
}

// ---------------------------------------------------------------------------
// Helpers de steps
// ---------------------------------------------------------------------------

function parseSteps(stepsJson: Json): SequenceStep[] {
  if (!Array.isArray(stepsJson)) return [];
  // Confiamos no shape porque foi validado por Zod no INSERT. Aqui só fazemos
  // narrow defensivo — qualquer step malformado é filtrado.
  const out: SequenceStep[] = [];
  for (const raw of stepsJson) {
    if (
      raw &&
      typeof raw === 'object' &&
      !Array.isArray(raw) &&
      typeof (raw as { body?: unknown }).body === 'string' &&
      typeof (raw as { day_offset?: unknown }).day_offset === 'number'
    ) {
      out.push(raw as unknown as SequenceStep);
    }
  }
  return out;
}

function computeNextActionAt(dayOffset: number): string {
  const ms = Math.max(0, dayOffset) * 24 * 60 * 60 * 1000;
  return new Date(Date.now() + ms).toISOString();
}

// ---------------------------------------------------------------------------
// Processador
// ---------------------------------------------------------------------------

/**
 * Processa uma job da fila `sequence-runner`.
 *
 * - Throws excepção em qualquer falha transient (Resend, DB write) — BullMQ
 *   retenta com backoff exponencial (3 tentativas).
 * - Devolve `{ status: 'skipped' | 'sent' | 'completed' }` para chamadas
 *   programáticas (cron drainer, testes).
 */
export async function processSendEmail(
  job: Job<SendEmailJobData>
): Promise<ProcessSendEmailResult> {
  const { enrolmentId, stepIndex } = job.data;
  const admin = createAdminClient();

  // -----------------------------------------------------------------------
  // 1) Lookup enrolment + verificações de idempotência
  // -----------------------------------------------------------------------
  const enrolment = await fetchEnrolment(admin, enrolmentId);
  if (!enrolment) {
    console.warn('[send-email] enrolment não encontrado', { enrolmentId });
    return { status: 'skipped', reason: 'enrolment_not_found' };
  }
  if (enrolment.status !== 'active') {
    console.info('[send-email] enrolment não está active', {
      enrolmentId,
      status: enrolment.status,
    });
    return { status: 'skipped', reason: 'enrolment_not_active' };
  }
  if (enrolment.current_step !== stepIndex) {
    console.info('[send-email] step mismatch (já foi processado?)', {
      enrolmentId,
      current_step: enrolment.current_step,
      jobStep: stepIndex,
    });
    return { status: 'skipped', reason: 'step_mismatch' };
  }

  // -----------------------------------------------------------------------
  // 2) Lookup sequence + step
  // -----------------------------------------------------------------------
  const sequence = await fetchSequence(admin, enrolment.sequence_id);
  if (!sequence) {
    throw new Error(`sequence ${enrolment.sequence_id} not found`);
  }
  const steps = parseSteps(sequence.steps);
  if (stepIndex < 0 || stepIndex >= steps.length) {
    console.warn('[send-email] step out of range', {
      stepIndex,
      total: steps.length,
    });
    // Marca como completed para sair do scan loop.
    await markCompleted(admin, enrolment.id);
    return { status: 'skipped', reason: 'step_out_of_range' };
  }

  const step = steps[stepIndex];
  if (!step) {
    // Defensive (TS noUncheckedIndexedAccess) — já validado pelo range check.
    await markCompleted(admin, enrolment.id);
    return { status: 'skipped', reason: 'step_out_of_range' };
  }
  // Por agora só processamos channel='email'. WhatsApp (M3.4) virá depois.
  if (step.channel !== 'email' || !step.body || !step.subject) {
    console.warn('[send-email] step inválido para envio email', {
      stepIndex,
      channel: step.channel,
    });
    return { status: 'skipped', reason: 'invalid_step' };
  }
  const stepSubject = step.subject;
  const stepBody = step.body;

  // -----------------------------------------------------------------------
  // 3) Lookup contact + company + workspace (para placeholders)
  // -----------------------------------------------------------------------
  const contact = await fetchContact(admin, enrolment.contact_id);
  if (!contact || !contact.email) {
    console.warn('[send-email] contact sem email', {
      enrolmentId,
      contactId: enrolment.contact_id,
    });
    // Marca enrolment como bounced para sair do scan loop — não pode enviar.
    await admin
      .from('sequence_enrollments')
      .update({
        status: 'bounced',
        completed_at: new Date().toISOString(),
        next_action_at: null,
      })
      .eq('id', enrolment.id);
    return { status: 'skipped', reason: 'contact_no_email' };
  }

  const company = contact.company_id
    ? await fetchCompany(admin, contact.company_id)
    : null;
  const workspace = await fetchWorkspace(admin, enrolment.workspace_id);

  // -----------------------------------------------------------------------
  // 4) Substituição de placeholders
  // -----------------------------------------------------------------------
  const placeholders: Record<string, string> = {
    first_name: firstNameFrom(contact.name),
    full_name: contact.name ?? '',
    company_name: company?.name ?? '',
    title: contact.title ?? '',
    sender_name:
      workspace?.name ||
      process.env.RESEND_FROM_NAME ||
      'AngoConnect',
  };

  const subject = applyPlaceholders(stepSubject, placeholders);
  const html = applyPlaceholders(stepBody, placeholders);

  // -----------------------------------------------------------------------
  // 5) Envio via Resend
  // -----------------------------------------------------------------------
  const result = await sendOutreachEmail({
    to: contact.email,
    subject,
    html,
    senderName: workspace?.name ?? null,
    enrolmentId: enrolment.id,
    workspaceId: enrolment.workspace_id,
    stepIndex,
  });

  if (!result.ok) {
    // Throw → BullMQ retenta. Se for falha permanente (email_address_invalid),
    // 3 retries vão consumir-se e a job parte para failed.
    throw new Error(
      `Resend send failed for enrolment=${enrolment.id} step=${stepIndex}: ${result.message}`
    );
  }

  // -----------------------------------------------------------------------
  // 6) INSERT email_events (event_type='sent')
  // -----------------------------------------------------------------------
  const { error: eventErr } = await admin.from('email_events').insert({
    enrollment_id: enrolment.id,
    workspace_id: enrolment.workspace_id,
    event_type: 'sent',
    metadata: {
      resend_id: result.resendId,
      step: stepIndex,
      job_id: job.id ?? null,
    } as Json,
  });
  if (eventErr) {
    // Log mas não retenta — o email foi enviado, perder a row de event seria
    // pior do que silenciar este erro (duplicaria o envio).
    console.error('[send-email] insert email_events falhou', eventErr);
  }

  // -----------------------------------------------------------------------
  // 7) UPDATE enrolment — avança step ou completa
  // -----------------------------------------------------------------------
  const nextStepIndex = stepIndex + 1;
  if (nextStepIndex >= steps.length) {
    await markCompleted(admin, enrolment.id);
    return { status: 'completed' };
  }

  const nextStep = steps[nextStepIndex];
  if (!nextStep) {
    // Não devia acontecer (já validámos o range), mas TS exige o guard.
    await markCompleted(admin, enrolment.id);
    return { status: 'completed' };
  }
  const nextActionAt = computeNextActionAt(nextStep.day_offset);

  const { error: updErr } = await admin
    .from('sequence_enrollments')
    .update({
      current_step: nextStepIndex,
      next_action_at: nextActionAt,
    })
    .eq('id', enrolment.id);

  if (updErr) {
    // Aqui é grave: o email foi enviado mas o ponteiro do enrolment não
    // avançou — risco de reenvio se o cron acordar e re-enfileirar a mesma
    // step. Throw força retry; idempotência (`current_step === stepIndex`)
    // evita duplicação.
    throw new Error(
      `update enrolment ${enrolment.id} (advance step) failed: ${updErr.message}`
    );
  }

  return {
    status: 'sent',
    resendId: result.resendId,
    nextStep: nextStepIndex,
  };
}

async function markCompleted(
  admin: AdminClient,
  enrolmentId: string
): Promise<void> {
  const { error } = await admin
    .from('sequence_enrollments')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      next_action_at: null,
    })
    .eq('id', enrolmentId);
  if (error) {
    throw new Error(
      `mark completed ${enrolmentId} failed: ${error.message}`
    );
  }
}
