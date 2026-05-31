/**
 * AngoConnect — BullMQ queues
 * ===========================================================================
 * Definição das filas BullMQ usadas pela aplicação. A conexão Redis vem de
 * `lib/redis.ts` (singleton ioredis).
 *
 * Em Vercel (serverless), enfileirar jobs é seguro mas o consumo só funciona
 * via um worker persistente — usamos o cron `/api/cron/process-sequences`
 * (drainer) + permitimos correr o worker standalone para self-host/dev
 * (ver `lib/queue/workers/sequence-runner.ts`).
 */

import { Queue, type ConnectionOptions } from 'bullmq';

/** Nome canónico da queue de envio de outreach. Single source of truth. */
export const SEQUENCE_QUEUE_NAME = 'sequence-runner';

/**
 * Conexão BullMQ — passamos URL+opts via objecto literal (não a instância
 * ioredis). Justificação: BullMQ traz a sua própria versão de ioredis em
 * `node_modules/bullmq/node_modules/ioredis` e o TypeScript considera-a
 * incompatível com a ioredis do projecto. Usar `ConnectionOptions` deixa o
 * BullMQ criar a sua própria conexão interna sem conflito de tipos.
 *
 * Em runtime, BullMQ aceita tanto uma URL como um objecto — preferimos o
 * objecto para podermos forçar `maxRetriesPerRequest: null` (obrigatório).
 *
 * NB: lemos `process.env.REDIS_URL` aqui no top-level mas como string
 * possivelmente vazia. Em runtime, BullMQ falha cedo no primeiro uso da
 * queue se o URL estiver vazio — preferimos isso a partir o build em
 * ambientes sem secret configurado.
 */
export function getQueueConnection(): ConnectionOptions {
  return {
    url: process.env.REDIS_URL ?? '',
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  } as ConnectionOptions;
}

/**
 * Payload da job de envio. O worker recebe `{ enrolmentId, stepIndex }` e
 * é responsável por verificar idempotência (current_step === stepIndex).
 *
 * Nota terminológica: a coluna DB chama-se `enrollment_id` (US spelling),
 * mas em código preferimos `enrolmentId` (UK, alinhado com o CLAUDE.md
 * e RPCs).
 */
export interface SendEmailJobData {
  enrolmentId: string;
  stepIndex: number;
}

/**
 * Default options: 3 tentativas com backoff exponencial (30s base), limpeza
 * automática de jobs completos/falhados para não inflar Redis.
 */
/**
 * Nomes de job aceites na queue `sequence-runner`. A queue é única (mesma
 * conexão Redis) mas o worker escolhe o handler com base no nome.
 *
 * - `send-email`    → processSendEmail (Resend)
 * - `send-whatsapp` → processSendWhatsApp (Meta Cloud API), M3.4
 *
 * O drainer cron (`/api/cron/process-sequences`) decide qual usar baseado
 * em `step.channel`. Os payloads são idênticos: `{ enrolmentId, stepIndex }`.
 */
export const SEND_EMAIL_JOB_NAME = 'send-email' as const;
export const SEND_WHATSAPP_JOB_NAME = 'send-whatsapp' as const;
export type SendEmailJobName = typeof SEND_EMAIL_JOB_NAME;
export type SendWhatsAppJobName = typeof SEND_WHATSAPP_JOB_NAME;
export type SequenceJobName = SendEmailJobName | SendWhatsAppJobName;

/**
 * Payload da job de WhatsApp — idêntico ao de email. Mantém-se um type-alias
 * separado para semântica e para evoluir independentemente se necessário.
 */
export interface SendWhatsAppJobData {
  enrolmentId: string;
  stepIndex: number;
}

export type SequenceJobData = SendEmailJobData | SendWhatsAppJobData;

export const sequenceQueue = new Queue<
  SequenceJobData,
  unknown,
  SequenceJobName
>(SEQUENCE_QUEUE_NAME, {
  connection: getQueueConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 86_400 },
  },
});

// Tipo de re-export para callers (mais ergonómico do que ir buscar à
// definição genérica).
export type SequenceQueue = typeof sequenceQueue;
