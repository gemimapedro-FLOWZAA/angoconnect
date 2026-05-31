/**
 * AngoConnect — Resend client + helper de envio de outreach
 * ===========================================================================
 * Singleton do `Resend` SDK + wrapper `sendOutreachEmail` que normaliza
 * `from`, adiciona tags de tracking (enrolment_id, workspace_id, step) e
 * lida com erros do SDK devolvendo um shape estável.
 *
 * Substitui o antigo `lib/resend.ts` (que era só o `new Resend(...)`). Este
 * ficheiro é o ponto de entrada canónico para qualquer envio de email da
 * aplicação a partir de M2.3.
 *
 * Variáveis env:
 *   RESEND_API_KEY      — obrigatório
 *   RESEND_FROM_EMAIL   — obrigatório (ex: onboarding@angoconnect.app)
 *   RESEND_FROM_NAME    — opcional (default "AngoConnect")
 *   RESEND_REPLY_TO     — opcional (ex: replies@angoconnect.app)
 *
 * Tags do Resend são metadata pesquisável e propagam para os webhooks —
 * são a forma como o webhook handler liga um `email_event` a um enrolment.
 */

import { Resend, type CreateEmailResponse } from 'resend';

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line no-var
  var __angoconnect_resend__: Resend | undefined;
}

function buildClient(): Resend {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    // Não fazemos throw no import — só quando for usado em runtime.
    // Permite que a build/typecheck passem em ambientes sem secrets.
    return new Resend('re_missing_api_key_placeholder');
  }
  return new Resend(apiKey);
}

export const resend: Resend =
  global.__angoconnect_resend__ ?? buildClient();

if (process.env.NODE_ENV !== 'production') {
  global.__angoconnect_resend__ = resend;
}

// ---------------------------------------------------------------------------
// Defaults derivados do ambiente
// ---------------------------------------------------------------------------

const DEFAULT_FROM_NAME = 'AngoConnect';

/**
 * Constrói o header `From` no formato `Name <email>`. Aceita nome
 * customizado (e.g. nome do workspace) e cai para o default da env.
 */
function buildFromHeader(senderName?: string | null): string {
  const email = process.env.RESEND_FROM_EMAIL;
  if (!email) {
    throw new Error(
      'RESEND_FROM_EMAIL is not defined — defina no .env.local'
    );
  }
  const name =
    senderName?.trim() ||
    process.env.RESEND_FROM_NAME?.trim() ||
    DEFAULT_FROM_NAME;
  return `${name} <${email}>`;
}

// ---------------------------------------------------------------------------
// Tipos públicos
// ---------------------------------------------------------------------------

export interface SendOutreachEmailInput {
  /** Endereço destinatário (já validado a montante). */
  to: string;
  /** Subject final, com placeholders já substituídos. */
  subject: string;
  /** Corpo HTML final, com placeholders já substituídos. */
  html: string;
  /** Override do nome no `From` (e.g. nome do workspace). */
  senderName?: string | null;
  /** ID do enrolment — vai como tag para rastreio no webhook. */
  enrolmentId: string;
  /** Workspace id — vai como tag. */
  workspaceId: string;
  /** Índice do step actual (0-based). Tag. */
  stepIndex: number;
  /** Reply-To opcional. Default lê de RESEND_REPLY_TO. */
  replyTo?: string;
}

export interface SendOutreachEmailSuccess {
  ok: true;
  /** ID retornado pelo Resend (`re_*`). */
  resendId: string;
}

export interface SendOutreachEmailFailure {
  ok: false;
  /** Mensagem humana. */
  message: string;
  /** Nome do erro do SDK (e.g. `validation_error`, `rate_limit_exceeded`). */
  name?: string;
}

export type SendOutreachEmailResult =
  | SendOutreachEmailSuccess
  | SendOutreachEmailFailure;

// ---------------------------------------------------------------------------
// Tag sanitisation
// ---------------------------------------------------------------------------
//
// O Resend aceita apenas chars [a-zA-Z0-9_-] nos values das tags. UUIDs já
// passam (têm hífens), mas qualquer outro identificador externo pode partir
// — sanitizamos para evitar 422.

function sanitizeTagValue(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 256);
}

// ---------------------------------------------------------------------------
// Wrapper principal
// ---------------------------------------------------------------------------

/**
 * Envia um email de outreach através do Resend.
 *
 * - Constrói `from` a partir de RESEND_FROM_EMAIL + senderName/RESEND_FROM_NAME.
 * - Adiciona tags `enrolment_id`, `workspace_id`, `step` para o webhook ligar
 *   eventos posteriores ao enrolment.
 * - Activa tracking de open/click.
 * - Captura excepções e devolve um shape `{ ok, ... }` estável.
 *
 * O caller é responsável por lançar excepção para forçar retry no BullMQ
 * (ver `lib/queue/jobs/send-email.ts`).
 */
export async function sendOutreachEmail(
  input: SendOutreachEmailInput
): Promise<SendOutreachEmailResult> {
  const from = buildFromHeader(input.senderName);
  const replyTo = input.replyTo ?? process.env.RESEND_REPLY_TO;

  let response: CreateEmailResponse;
  try {
    response = await resend.emails.send({
      from,
      to: input.to,
      subject: input.subject,
      html: input.html,
      ...(replyTo ? { replyTo } : {}),
      tags: [
        { name: 'enrolment_id', value: sanitizeTagValue(input.enrolmentId) },
        { name: 'workspace_id', value: sanitizeTagValue(input.workspaceId) },
        { name: 'step', value: String(input.stepIndex) },
      ],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const name = err instanceof Error ? err.name : undefined;
    console.error('[email/resend] excepção em emails.send', { message, name });
    return { ok: false, message, name };
  }

  if (response.error) {
    console.error('[email/resend] resend respondeu com erro', response.error);
    return {
      ok: false,
      message: response.error.message ?? 'unknown Resend error',
      name: response.error.name,
    };
  }

  if (!response.data?.id) {
    return {
      ok: false,
      message: 'Resend devolveu resposta sem id',
    };
  }

  return { ok: true, resendId: response.data.id };
}

// ---------------------------------------------------------------------------
// Backwards-compat — manter export do client original.
// ---------------------------------------------------------------------------
//
// O M2.3 substitui o antigo `lib/resend.ts`. Para evitar partir imports
// existentes, este módulo expõe `resend` (acima) e também a string
// `RESEND_FROM_EMAIL` resolvida.

export const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL ?? null;
