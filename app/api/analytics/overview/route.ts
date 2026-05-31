/**
 * AngoConnect — GET /api/analytics/overview
 * ===========================================================================
 * Dashboard analítico do workspace (M3.3).
 *
 * Query:
 *   workspaceId  uuid                        (obrigatório)
 *   from?        ISO date (YYYY-MM-DD)       (default = 30 dias atrás)
 *   to?          ISO date (YYYY-MM-DD)       (default = hoje)
 *
 * Resposta:
 *   {
 *     data: {
 *       range: { from, to },
 *       credits: { used, added, remaining },
 *       contacts: { revealed, total_revealed },
 *       emails: { sent, delivered, opened, clicked, replied, bounced,
 *                 complained, delivery_rate, open_rate, click_rate,
 *                 reply_rate, bounce_rate },
 *       sequences: { active, paused, total },
 *       deals: { total, open, won, lost, total_value_akz,
 *                by_stage: [{ stage_id, stage_name, count, value_akz }] },
 *       daily_email_series: [{ date, sent, opened, clicked, replied }],
 *       top_sequences: [{ id, name, sent, replied, reply_rate }]
 *     }
 *   }
 *
 * Implementação:
 *   - Promise.all com queries paralelas (overhead aceitável neste milestone).
 *   - daily_email_series e top_sequences são agregados em memória a partir
 *     dos raw events do range — o cliente Supabase não tem date_trunc nativo
 *     sem RPC, e queremos evitar criar uma RPC só para isto.
 *   - Em produção isto deve virar uma materialized view com refresh nightly
 *     (decisão pendente; documentada no CLAUDE.md "Hardening adiado").
 *
 * Erros:
 *   UNAUTHENTICATED       401
 *   INVALID_QUERY         400
 *   NOT_WORKSPACE_MEMBER  403
 *   DB_QUERY_FAILED       500
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiError, apiOk } from '@/lib/api-response';
import { createClient } from '@/lib/supabase/server';
import type {
  EmailEventType,
  SequenceStatus,
  DealStatus,
} from '@/lib/supabase/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TOP_SEQUENCES_LIMIT = 5;
const DAILY_SERIES_HARD_CAP = 10_000; // safety bound em raw events fetch

// ---------------------------------------------------------------------------
// Zod
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const overviewQuerySchema = z.object({
  workspaceId: z.string().uuid({ message: 'workspaceId tem de ser UUID' }),
  from: z
    .string()
    .regex(DATE_RE, 'from tem de ser YYYY-MM-DD')
    .optional(),
  to: z
    .string()
    .regex(DATE_RE, 'to tem de ser YYYY-MM-DD')
    .optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

// ---------------------------------------------------------------------------
// Tipos auxiliares (rows raw vindas do Supabase)
// ---------------------------------------------------------------------------

interface CreditsLogRow {
  amount: number;
}

interface WorkspaceCreditsRow {
  credits_remaining: number;
}

interface RevealedContactRow {
  id: string;
  revealed_at: string;
}

interface EmailEventRow {
  enrollment_id: string;
  event_type: EmailEventType;
  occurred_at: string;
}

interface SequenceCountRow {
  id: string;
  name: string;
  status: SequenceStatus;
}

interface DealRow {
  status: DealStatus;
  stage_id: string;
  value_akz: number | null;
  updated_at: string;
}

interface DealStageRow {
  id: string;
  name: string;
  position: number;
  workspace_id: string | null;
}

interface EnrollmentRow {
  id: string;
  sequence_id: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  // 1) Auth
  const supabase = createClient();
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) {
    return apiError('Não autenticado', 401, 'UNAUTHENTICATED');
  }

  // 2) Query Zod
  const sp = request.nextUrl.searchParams;
  const parsed = overviewQuerySchema.safeParse({
    workspaceId: sp.get('workspaceId') ?? undefined,
    from: sp.get('from') ?? undefined,
    to: sp.get('to') ?? undefined,
  });
  if (!parsed.success) {
    return apiError('Query inválida', 400, 'INVALID_QUERY', {
      issues: parsed.error.issues,
    });
  }
  const { workspaceId } = parsed.data;

  // 3) Resolve range
  const now = new Date();
  const defaultFrom = new Date(now);
  defaultFrom.setUTCDate(defaultFrom.getUTCDate() - 30);
  const fromDate = parsed.data.from ?? toDateOnly(defaultFrom);
  const toDate = parsed.data.to ?? toDateOnly(now);

  // Intervalos timestamp para queries (from 00:00 → to 23:59:59.999 inclusive)
  const fromIso = `${fromDate}T00:00:00.000Z`;
  const toIso = `${toDate}T23:59:59.999Z`;

  // 4) Membership
  const { data: member, error: memberErr } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('workspace_id', workspaceId)
    .eq('user_id', user.id)
    .maybeSingle()
    .overrideTypes<{ workspace_id: string } | null, { merge: false }>();

  if (memberErr) {
    console.error('[analytics/overview] erro a verificar workspace_members', memberErr);
    return apiError(
      'Falha a verificar permissões do workspace',
      500,
      'WORKSPACE_CHECK_FAILED'
    );
  }
  if (!member) {
    return apiError(
      'Não é membro deste workspace',
      403,
      'NOT_WORKSPACE_MEMBER'
    );
  }

  // 5) Queries paralelas
  const [
    creditsLogRes,
    workspaceRes,
    revealedRangeRes,
    revealedTotalRes,
    emailEventsRes,
    sequencesRes,
    dealsRes,
    stagesRes,
    enrollmentsRes,
  ] = await Promise.all([
    supabase
      .from('credits_log')
      .select('amount')
      .eq('workspace_id', workspaceId)
      .gte('created_at', fromIso)
      .lte('created_at', toIso)
      .overrideTypes<CreditsLogRow[], { merge: false }>(),
    supabase
      .from('workspaces')
      .select('credits_remaining')
      .eq('id', workspaceId)
      .maybeSingle()
      .overrideTypes<WorkspaceCreditsRow | null, { merge: false }>(),
    supabase
      .from('revealed_contacts')
      .select('id, revealed_at')
      .eq('workspace_id', workspaceId)
      .gte('revealed_at', fromIso)
      .lte('revealed_at', toIso)
      .overrideTypes<RevealedContactRow[], { merge: false }>(),
    supabase
      .from('revealed_contacts')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId),
    supabase
      .from('email_events')
      .select('enrollment_id, event_type, occurred_at')
      .eq('workspace_id', workspaceId)
      .gte('occurred_at', fromIso)
      .lte('occurred_at', toIso)
      .order('occurred_at', { ascending: true })
      .limit(DAILY_SERIES_HARD_CAP)
      .overrideTypes<EmailEventRow[], { merge: false }>(),
    supabase
      .from('sequences')
      .select('id, name, status')
      .eq('workspace_id', workspaceId)
      .overrideTypes<SequenceCountRow[], { merge: false }>(),
    supabase
      .from('deals')
      .select('status, stage_id, value_akz, updated_at')
      .eq('workspace_id', workspaceId)
      .overrideTypes<DealRow[], { merge: false }>(),
    supabase
      .from('deal_stages')
      .select('id, name, position, workspace_id')
      .or(`workspace_id.is.null,workspace_id.eq.${workspaceId}`)
      .order('position', { ascending: true })
      .overrideTypes<DealStageRow[], { merge: false }>(),
    supabase
      .from('sequence_enrollments')
      .select('id, sequence_id')
      .eq('workspace_id', workspaceId)
      .overrideTypes<EnrollmentRow[], { merge: false }>(),
  ]);

  // 5a) Erros — qualquer falha de query agregada devolve 500 com info.
  const failures: string[] = [];
  if (creditsLogRes.error) failures.push(`credits_log: ${creditsLogRes.error.message}`);
  if (workspaceRes.error) failures.push(`workspaces: ${workspaceRes.error.message}`);
  if (revealedRangeRes.error)
    failures.push(`revealed_contacts(range): ${revealedRangeRes.error.message}`);
  if (revealedTotalRes.error)
    failures.push(`revealed_contacts(total): ${revealedTotalRes.error.message}`);
  if (emailEventsRes.error)
    failures.push(`email_events: ${emailEventsRes.error.message}`);
  if (sequencesRes.error) failures.push(`sequences: ${sequencesRes.error.message}`);
  if (dealsRes.error) failures.push(`deals: ${dealsRes.error.message}`);
  if (stagesRes.error) failures.push(`deal_stages: ${stagesRes.error.message}`);
  if (enrollmentsRes.error)
    failures.push(`sequence_enrollments: ${enrollmentsRes.error.message}`);

  if (failures.length > 0) {
    console.error('[analytics/overview] queries falharam', failures);
    return apiError(
      'Falha a calcular overview',
      500,
      'DB_QUERY_FAILED',
      { failures }
    );
  }

  // 6) Credits
  let creditsUsed = 0;
  let creditsAdded = 0;
  for (const row of creditsLogRes.data ?? []) {
    if (row.amount < 0) creditsUsed += Math.abs(row.amount);
    else if (row.amount > 0) creditsAdded += row.amount;
  }
  const creditsRemaining = workspaceRes.data?.credits_remaining ?? 0;

  // 7) Contacts
  const contactsRevealed = (revealedRangeRes.data ?? []).length;
  const contactsTotalRevealed = revealedTotalRes.count ?? 0;

  // 8) Emails — counters + daily series
  const emailEvents = emailEventsRes.data ?? [];
  let sent = 0;
  let delivered = 0;
  let opened = 0;
  let clicked = 0;
  let replied = 0;
  let bounced = 0;
  let complained = 0;

  // Mapa date → counters
  type DailyBucket = { sent: number; opened: number; clicked: number; replied: number };
  const dailyMap = new Map<string, DailyBucket>();
  // Per-sequence email counts (via enrollment → sequence)
  const enrolToSeq = new Map<string, string>();
  for (const e of enrollmentsRes.data ?? []) enrolToSeq.set(e.id, e.sequence_id);
  const seqCounters = new Map<string, { sent: number; replied: number }>();

  for (const ev of emailEvents) {
    switch (ev.event_type) {
      case 'sent':
        sent += 1;
        break;
      case 'delivered':
        delivered += 1;
        break;
      case 'opened':
        opened += 1;
        break;
      case 'clicked':
        clicked += 1;
        break;
      case 'replied':
        replied += 1;
        break;
      case 'bounced':
        bounced += 1;
        break;
      case 'complained':
        complained += 1;
        break;
      default:
        break;
    }

    // Daily bucket — apenas para 4 séries-chave
    if (
      ev.event_type === 'sent' ||
      ev.event_type === 'opened' ||
      ev.event_type === 'clicked' ||
      ev.event_type === 'replied'
    ) {
      const day = ev.occurred_at.slice(0, 10);
      const bucket = dailyMap.get(day) ?? {
        sent: 0,
        opened: 0,
        clicked: 0,
        replied: 0,
      };
      bucket[ev.event_type] += 1;
      dailyMap.set(day, bucket);
    }

    // Per-sequence (sent + replied) para top_sequences
    if (ev.event_type === 'sent' || ev.event_type === 'replied') {
      const seqId = enrolToSeq.get(ev.enrollment_id);
      if (seqId) {
        const counter = seqCounters.get(seqId) ?? { sent: 0, replied: 0 };
        if (ev.event_type === 'sent') counter.sent += 1;
        else counter.replied += 1;
        seqCounters.set(seqId, counter);
      }
    }
  }

  // 9) Sequences (counts)
  let seqActive = 0;
  let seqPaused = 0;
  const seqList = sequencesRes.data ?? [];
  for (const s of seqList) {
    if (s.status === 'active') seqActive += 1;
    else if (s.status === 'paused') seqPaused += 1;
  }

  // Top sequences por reply_rate (limit 5)
  const seqNameById = new Map(seqList.map((s) => [s.id, s.name]));
  const topSequences = Array.from(seqCounters.entries())
    .map(([id, c]) => ({
      id,
      name: seqNameById.get(id) ?? '(sem nome)',
      sent: c.sent,
      replied: c.replied,
      reply_rate: ratio(c.replied, c.sent),
    }))
    .filter((s) => s.sent > 0)
    .sort((a, b) => b.reply_rate - a.reply_rate)
    .slice(0, TOP_SEQUENCES_LIMIT);

  // 10) Deals
  const dealRows = dealsRes.data ?? [];
  const stageRows = stagesRes.data ?? [];
  let dealsTotal = dealRows.length;
  let dealsOpen = 0;
  let dealsWon = 0;
  let dealsLost = 0;
  let totalValueWon = 0; // sum(value_akz) onde status='won' no range
  const byStageMap = new Map<
    string,
    { stage_id: string; stage_name: string; count: number; value_akz: number }
  >();
  // Pré-popular by_stage com todos os stages (para Kanban ter colunas vazias).
  for (const s of stageRows) {
    byStageMap.set(s.id, {
      stage_id: s.id,
      stage_name: s.name,
      count: 0,
      value_akz: 0,
    });
  }
  const stageOrder = new Map(stageRows.map((s, i) => [s.id, i]));

  for (const d of dealRows) {
    if (d.status === 'open') dealsOpen += 1;
    else if (d.status === 'won') dealsWon += 1;
    else if (d.status === 'lost') dealsLost += 1;

    // total_value_akz: deals won no range (usamos updated_at como proxy
    // do momento de fecho — coluna won_at não existe; trade-off documentado)
    if (
      d.status === 'won' &&
      d.updated_at >= fromIso &&
      d.updated_at <= toIso
    ) {
      totalValueWon += d.value_akz ?? 0;
    }

    const entry = byStageMap.get(d.stage_id);
    if (entry) {
      entry.count += 1;
      entry.value_akz += d.value_akz ?? 0;
    } else {
      // Defensivo: deal aponta para stage que não veio na query (RLS race);
      // ignora silenciosamente para não rebentar.
      dealsTotal -= 0;
    }
  }

  const byStage = Array.from(byStageMap.values()).sort((a, b) => {
    const oa = stageOrder.get(a.stage_id) ?? 999;
    const ob = stageOrder.get(b.stage_id) ?? 999;
    return oa - ob;
  });

  // 11) Daily series — fill gaps com zeros para gráficos contínuos.
  const series: Array<{
    date: string;
    sent: number;
    opened: number;
    clicked: number;
    replied: number;
  }> = [];
  const cursor = new Date(`${fromDate}T00:00:00.000Z`);
  const endCursor = new Date(`${toDate}T00:00:00.000Z`);
  while (cursor.getTime() <= endCursor.getTime()) {
    const day = toDateOnly(cursor);
    const bucket = dailyMap.get(day) ?? {
      sent: 0,
      opened: 0,
      clicked: 0,
      replied: 0,
    };
    series.push({ date: day, ...bucket });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  // 12) Resposta consolidada
  return apiOk({
    range: { from: fromDate, to: toDate },
    credits: {
      used: creditsUsed,
      added: creditsAdded,
      remaining: creditsRemaining,
    },
    contacts: {
      revealed: contactsRevealed,
      total_revealed: contactsTotalRevealed,
    },
    emails: {
      sent,
      delivered,
      opened,
      clicked,
      replied,
      bounced,
      complained,
      delivery_rate: ratio(delivered, sent),
      open_rate: ratio(opened, delivered),
      click_rate: ratio(clicked, opened),
      reply_rate: ratio(replied, sent),
      bounce_rate: ratio(bounced, sent),
    },
    sequences: {
      active: seqActive,
      paused: seqPaused,
      total: seqList.length,
    },
    deals: {
      total: dealsTotal,
      open: dealsOpen,
      won: dealsWon,
      lost: dealsLost,
      total_value_akz: totalValueWon,
      by_stage: byStage,
    },
    daily_email_series: series,
    top_sequences: topSequences,
  });
}
