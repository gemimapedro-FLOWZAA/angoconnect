/**
 * AngoConnect — Worker BullMQ standalone (self-host / dev)
 * ===========================================================================
 * Consome a fila `sequence-runner` e executa `processSendEmail` em cada job.
 *
 * Dois modos de operação:
 *   1. **Vercel (produção SaaS)**: este ficheiro NÃO é executado. Os jobs
 *      são enfileirados pelo endpoint de enrol + drainados pelo cron
 *      `/api/cron/process-sequences`.
 *   2. **Self-host / dev**: invocar `npm run worker` arranca este processo,
 *      que mantém conexão Redis aberta e processa jobs em paralelo
 *      (concurrency=5).
 *
 * Activação: o módulo só faz `new Worker(...)` quando carregado directamente
 * via `tsx` (`require.main === module`) — assim podemos importá-lo de
 * testes/manifesto sem efeitos colaterais.
 *
 * Sinais: trata SIGTERM/SIGINT para shutdown graceful (drena jobs em curso).
 */

import { Worker, type Job, type WorkerOptions } from 'bullmq';
import { processSendEmail } from '@/lib/queue/jobs/send-email';
import { processSendWhatsApp } from '@/lib/queue/jobs/send-whatsapp';
import {
  SEND_EMAIL_JOB_NAME,
  SEND_WHATSAPP_JOB_NAME,
  SEQUENCE_QUEUE_NAME,
  getQueueConnection,
  type SendEmailJobData,
  type SendWhatsAppJobData,
  type SequenceJobData,
  type SequenceJobName,
} from '@/lib/queue/queues';

const DEFAULT_CONCURRENCY = 5;

/**
 * Dispatcher: a queue `sequence-runner` aceita dois job names. O nome decide
 * qual handler corre. Payloads são iguais (`{ enrolmentId, stepIndex }`) por
 * isso o cast é seguro.
 */
async function processSequenceJob(
  job: Job<SequenceJobData, unknown, SequenceJobName>
): Promise<unknown> {
  if (job.name === SEND_WHATSAPP_JOB_NAME) {
    return processSendWhatsApp(job as Job<SendWhatsAppJobData>);
  }
  if (job.name === SEND_EMAIL_JOB_NAME) {
    return processSendEmail(job as Job<SendEmailJobData>);
  }
  throw new Error(`[worker] job name desconhecido: ${String(job.name)}`);
}

export function startSequenceWorker(
  options: Partial<WorkerOptions> = {}
): Worker<SequenceJobData, unknown, SequenceJobName> {
  const concurrency =
    Number.parseInt(process.env.WORKER_CONCURRENCY ?? '', 10) ||
    DEFAULT_CONCURRENCY;

  const worker = new Worker<SequenceJobData, unknown, SequenceJobName>(
    SEQUENCE_QUEUE_NAME,
    processSequenceJob,
    {
      connection: getQueueConnection(),
      concurrency,
      ...options,
    }
  );

  worker.on('completed', (job) => {
    console.log(`[worker] job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    console.error(`[worker] job ${job?.id ?? '<no-id>'} failed: ${err.message}`);
  });

  worker.on('error', (err) => {
    console.error('[worker] error', err);
  });

  return worker;
}

// ---------------------------------------------------------------------------
// Entry point — só corre quando o ficheiro é executado directamente.
// ---------------------------------------------------------------------------

if (require.main === module) {
  const worker = startSequenceWorker();
  console.log(
    `[worker] sequence-runner started (concurrency=${
      Number.parseInt(process.env.WORKER_CONCURRENCY ?? '', 10) ||
      DEFAULT_CONCURRENCY
    })`
  );

  const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal} received — closing...`);
    try {
      await worker.close();
      console.log('[worker] closed cleanly');
      process.exit(0);
    } catch (err) {
      console.error('[worker] erro a fechar', err);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
