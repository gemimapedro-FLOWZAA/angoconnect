/**
 * AngoConnect — Job processor: envio de step de outreach via WhatsApp
 * ===========================================================================
 * Espelho de `send-email.ts` para o canal WhatsApp Business (Meta Cloud API).
 *
 * Mesma queue (`sequence-runner`), payload idêntico (`{ enrolmentId, stepIndex }`).
 * O nome da job (`send-whatsapp` vs `send-email`) é o que diferencia o handler
 * a invocar. Quem decide é o drainer (`/api/cron/process-sequences`).
 *
 * Diferenças vs send-email:
 *   - Lookup adicional em `workspace_whatsapp_config` (sem essa, marca como
 *     bounced — não há canal configurado).
 *   - Suporta dois modos:
 *       (a) template-based (step.template_id apontando para
 *           `whatsapp_templates` aprovado) — funciona sempre.
 *       (b) freeform (sem template_id, só step.body) — apenas se a janela
 *           de 24h está aberta para o contacto (verifica último `wa_replied`
 *           recebido).
 *   - Eventos registados como `wa_sent` (não `sent`).
 *   - `wa_message_id` (wamid retornado pela Meta) guardado em metadata para
 *     posterior correlação com webhook de statuses.
 */

import type { Job } from 'bullmq';
import type { SendWhatsAppJobData } from '@/lib/queue/queues';
import { createAdminClient } from '@/lib/supabase/admin';
import type {
  Database,
  Json,
  SequenceStep,
} from '@/lib/supabase/types';
import {
  WhatsAppApiError,
  WhatsAppClient,
  type WhatsAppTemplateComponent,
} from '@/lib/whatsapp/client';

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
  full_name: string | null;
  title: string | null;
  phone: string | null;
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

interface WhatsAppConfigRow {
  workspace_id: string;
  waba_id: string | null;
  phone_number_id: string;
  phone_number: string | null;
  access_token: string;
  is_active: boolean;
}

interface WhatsAppTemplateRow {
  id: string;
  meta_template_name: string;
  language: string;
  body: string;
  header_format: string | null;
  header_text: string | null;
  footer: string | null;
  status: string;
}

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
        order?: (
          col: string,
          opts?: { ascending: boolean }
        ) => {
          limit: (n: number) => {
            maybeSingle: () => Promise<{
              data: unknown | null;
              error: { message: string } | null;
            }>;
          };
        };
      };
    };
  };
}

// ---------------------------------------------------------------------------
// Resultado público
// ---------------------------------------------------------------------------

export type ProcessSendWhatsAppResult =
  | { status: 'sent'; messageId: string; nextStep: number | null }
  | { status: 'completed' }
  | {
      status: 'skipped';
      reason:
        | 'enrolment_not_found'
        | 'enrolment_not_active'
        | 'step_mismatch'
        | 'step_out_of_range'
        | 'contact_no_phone'
        | 'no_whatsapp_config'
        | 'invalid_step'
        | 'window_closed'
        | 'template_not_found';
    };

// ---------------------------------------------------------------------------
// Placeholders
// ---------------------------------------------------------------------------

function applyPlaceholders(
  template: string,
  values: Record<string, string | null | undefined>
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => {
    const val = values[key as keyof typeof values];
    return typeof val === 'string' ? val : '';
  });
}

function firstNameFrom(fullName: string | null): string {
  if (!fullName) return '';
  return fullName.trim().split(/\s+/)[0] ?? '';
}

/**
 * Substitui placeholders posicionais {{1}}, {{2}}, ... usando um array de
 * valores. Templates da Meta usam este formato (em vez de nomeados).
 */
function applyPositionalPlaceholders(
  template: string,
  values: string[]
): string {
  return template.replace(/\{\{\s*(\d+)\s*\}\}/g, (_match, idx) => {
    const i = Number.parseInt(String(idx), 10) - 1;
    if (i < 0 || i >= values.length) return '';
    const v = values[i];
    return typeof v === 'string' ? v : '';
  });
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
  const { data, error } = await (admin as unknown as AdminClientUntyped)
    .from('contacts')
    .select('id, full_name, title, phone, company_id')
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
    console.warn(
      `[send-whatsapp] lookup company ${companyId} falhou`,
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

async function fetchWhatsAppConfig(
  admin: AdminClient,
  workspaceId: string
): Promise<WhatsAppConfigRow | null> {
  // Tabela ainda fora dos stubs tipados — usamos escape hatch.
  const { data, error } = await (admin as unknown as AdminClientUntyped)
    .from('workspace_whatsapp_config')
    .select(
      'workspace_id, waba_id, phone_number_id, phone_number, access_token, is_active'
    )
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  if (error) {
    throw new Error(
      `lookup workspace_whatsapp_config ${workspaceId} failed: ${error.message}`
    );
  }
  return (data as WhatsAppConfigRow | null) ?? null;
}

async function fetchWhatsAppTemplate(
  admin: AdminClient,
  templateId: string
): Promise<WhatsAppTemplateRow | null> {
  const { data, error } = await (admin as unknown as AdminClientUntyped)
    .from('whatsapp_templates')
    .select(
      'id, meta_template_name, language, body, header_format, header_text, footer, status'
    )
    .eq('id', templateId)
    .maybeSingle();

  if (error) {
    throw new Error(
      `lookup whatsapp_templates ${templateId} failed: ${error.message}`
    );
  }
  return (data as WhatsAppTemplateRow | null) ?? null;
}

/**
 * Verifica se há um `wa_replied` event do contacto nas últimas 24h. Se sim,
 * a janela freeform está aberta. Procuramos por enrolments deste contacto
 * — qualquer um deles satisfaz a janela (Meta calcula por phone number,
 * não por sequence).
 */
async function isWindowOpen(
  admin: AdminClient,
  workspaceId: string,
  contactId: string
): Promise<boolean> {
  const twentyFourHoursAgoIso = new Date(
    Date.now() - 24 * 60 * 60 * 1000
  ).toISOString();

  // Vamos buscar enrolment ids do contacto + ws e procurar wa_replied recente.
  // Fazemos via join no email_events seleccionando pela `enrollment.contact_id`
  // — não suportado directamente em PostgREST; preferimos sub-query manual.
  const { data: enrolments, error: enrolErr } = await admin
    .from('sequence_enrollments')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('contact_id', contactId);

  if (enrolErr) {
    console.warn(
      '[send-whatsapp] lookup enrolments para window check falhou',
      enrolErr.message
    );
    return false;
  }

  const enrolIds = (enrolments ?? []).map((r) => (r as { id: string }).id);
  if (enrolIds.length === 0) return false;

  const { data: replies, error: repliesErr } = await admin
    .from('email_events')
    .select('id, occurred_at')
    .eq('event_type', 'wa_replied')
    .in('enrollment_id', enrolIds)
    .gte('occurred_at', twentyFourHoursAgoIso)
    .limit(1);

  if (repliesErr) {
    console.warn(
      '[send-whatsapp] lookup wa_replied falhou',
      repliesErr.message
    );
    return false;
  }
  return (replies ?? []).length > 0;
}

// ---------------------------------------------------------------------------
// Steps helpers
// ---------------------------------------------------------------------------

function parseSteps(stepsJson: Json): SequenceStep[] {
  if (!Array.isArray(stepsJson)) return [];
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

export async function processSendWhatsApp(
  job: Job<SendWhatsAppJobData>
): Promise<ProcessSendWhatsAppResult> {
  const { enrolmentId, stepIndex } = job.data;
  const admin = createAdminClient();

  // 1) Lookup enrolment + idempotência
  const enrolment = await fetchEnrolment(admin, enrolmentId);
  if (!enrolment) {
    console.warn('[send-whatsapp] enrolment não encontrado', { enrolmentId });
    return { status: 'skipped', reason: 'enrolment_not_found' };
  }
  if (enrolment.status !== 'active') {
    console.info('[send-whatsapp] enrolment não está active', {
      enrolmentId,
      status: enrolment.status,
    });
    return { status: 'skipped', reason: 'enrolment_not_active' };
  }
  if (enrolment.current_step !== stepIndex) {
    console.info('[send-whatsapp] step mismatch (já processado?)', {
      enrolmentId,
      current_step: enrolment.current_step,
      jobStep: stepIndex,
    });
    return { status: 'skipped', reason: 'step_mismatch' };
  }

  // 2) Lookup sequence + step
  const sequence = await fetchSequence(admin, enrolment.sequence_id);
  if (!sequence) {
    throw new Error(`sequence ${enrolment.sequence_id} not found`);
  }
  const steps = parseSteps(sequence.steps);
  if (stepIndex < 0 || stepIndex >= steps.length) {
    console.warn('[send-whatsapp] step out of range', {
      stepIndex,
      total: steps.length,
    });
    await markCompleted(admin, enrolment.id);
    return { status: 'skipped', reason: 'step_out_of_range' };
  }

  const step = steps[stepIndex];
  if (!step || step.channel !== 'whatsapp' || !step.body) {
    console.warn('[send-whatsapp] step inválido para WhatsApp', {
      stepIndex,
      channel: step?.channel,
    });
    return { status: 'skipped', reason: 'invalid_step' };
  }

  // 3) Lookup config WhatsApp do workspace
  const config = await fetchWhatsAppConfig(admin, enrolment.workspace_id);
  if (!config || !config.is_active || !config.access_token) {
    console.warn('[send-whatsapp] workspace sem config WhatsApp activa', {
      workspaceId: enrolment.workspace_id,
    });
    // Marca enrolment como bounced — sem canal não pode prosseguir.
    await admin
      .from('sequence_enrollments')
      .update({
        status: 'bounced',
        completed_at: new Date().toISOString(),
        next_action_at: null,
      })
      .eq('id', enrolment.id);
    await admin.from('email_events').insert({
      enrollment_id: enrolment.id,
      workspace_id: enrolment.workspace_id,
      // wa_failed só é aceite após migration 0011 — antes disso o INSERT
      // dá erro de CHECK. Loggamos warn em caso de falha.
      event_type: 'wa_failed' as never,
      metadata: {
        step: stepIndex,
        reason: 'no_whatsapp_config',
      } as Json,
    });
    return { status: 'skipped', reason: 'no_whatsapp_config' };
  }

  // 4) Lookup contact + company + workspace
  const contact = await fetchContact(admin, enrolment.contact_id);
  if (!contact || !contact.phone) {
    console.warn('[send-whatsapp] contact sem phone', {
      enrolmentId,
      contactId: enrolment.contact_id,
    });
    await admin
      .from('sequence_enrollments')
      .update({
        status: 'bounced',
        completed_at: new Date().toISOString(),
        next_action_at: null,
      })
      .eq('id', enrolment.id);
    return { status: 'skipped', reason: 'contact_no_phone' };
  }

  const company = contact.company_id
    ? await fetchCompany(admin, contact.company_id)
    : null;
  const workspace = await fetchWorkspace(admin, enrolment.workspace_id);

  // Placeholders nomeados (mesmo conjunto que o email)
  const namedPlaceholders: Record<string, string> = {
    first_name: firstNameFrom(contact.full_name),
    full_name: contact.full_name ?? '',
    company_name: company?.name ?? '',
    title: contact.title ?? '',
    sender_name:
      workspace?.name ||
      process.env.RESEND_FROM_NAME ||
      'AngoConnect',
  };

  // Também montamos o array para placeholders posicionais (Meta usa {{1}})
  const positionalValues = (step.template_variables ?? []).map((token) => {
    // Token pode ser uma referência nomeada (`{{first_name}}`) ou texto literal.
    return applyPlaceholders(token, namedPlaceholders);
  });

  const client = new WhatsAppClient(
    config.access_token,
    config.phone_number_id
  );

  // 5) Envio: template-based vs freeform
  let messageId: string;
  try {
    if (step.template_id) {
      const template = await fetchWhatsAppTemplate(admin, step.template_id);
      if (!template) {
        return { status: 'skipped', reason: 'template_not_found' };
      }
      if (template.status !== 'approved') {
        console.warn(
          '[send-whatsapp] template não aprovado — skip',
          { templateId: step.template_id, status: template.status }
        );
        return { status: 'skipped', reason: 'template_not_found' };
      }

      // Componentes Meta — apenas o body por agora. Header/footer requerem
      // estrutura mais complexa e ficam para iterações futuras.
      const components: WhatsAppTemplateComponent[] = [];
      if (positionalValues.length > 0) {
        components.push({
          type: 'body',
          parameters: positionalValues.map((text) => ({ type: 'text', text })),
        });
      }

      const result = await client.sendTemplate({
        to: contact.phone,
        templateName: template.meta_template_name,
        languageCode: template.language,
        components,
      });
      messageId = result.messageId;
    } else {
      // Freeform — exige janela de 24h aberta.
      const open = await isWindowOpen(
        admin,
        enrolment.workspace_id,
        enrolment.contact_id
      );
      if (!open) {
        console.warn('[send-whatsapp] janela 24h fechada — skip', {
          enrolmentId,
          contactId: enrolment.contact_id,
        });
        await admin.from('email_events').insert({
          enrollment_id: enrolment.id,
          workspace_id: enrolment.workspace_id,
          event_type: 'wa_failed' as never,
          metadata: {
            step: stepIndex,
            reason: 'window_closed',
          } as Json,
        });
        return { status: 'skipped', reason: 'window_closed' };
      }

      // Substitui placeholders nomeados no body
      const body = applyPlaceholders(step.body, namedPlaceholders);
      const result = await client.sendText({
        to: contact.phone,
        body,
      });
      messageId = result.messageId;
    }
  } catch (err) {
    if (err instanceof WhatsAppApiError) {
      console.error('[send-whatsapp] Meta API erro', {
        status: err.status,
        message: err.message,
        meta: err.meta,
      });
      // Regista wa_failed e re-throw para retry da BullMQ.
      await admin.from('email_events').insert({
        enrollment_id: enrolment.id,
        workspace_id: enrolment.workspace_id,
        event_type: 'wa_failed' as never,
        metadata: {
          step: stepIndex,
          status: err.status,
          error: err.message,
        } as Json,
      });
    }
    throw err;
  }

  // 6) INSERT email_events com wa_sent
  const { error: eventErr } = await admin.from('email_events').insert({
    enrollment_id: enrolment.id,
    workspace_id: enrolment.workspace_id,
    event_type: 'wa_sent' as never,
    metadata: {
      wa_message_id: messageId,
      step: stepIndex,
      job_id: job.id ?? null,
    } as Json,
  });
  if (eventErr) {
    console.error('[send-whatsapp] insert email_events falhou', eventErr);
  }

  // 7) UPDATE enrolment
  const nextStepIndex = stepIndex + 1;
  if (nextStepIndex >= steps.length) {
    await markCompleted(admin, enrolment.id);
    return { status: 'completed' };
  }

  const nextStep = steps[nextStepIndex];
  if (!nextStep) {
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
    throw new Error(
      `update enrolment ${enrolment.id} (advance step) failed: ${updErr.message}`
    );
  }

  return {
    status: 'sent',
    messageId,
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
