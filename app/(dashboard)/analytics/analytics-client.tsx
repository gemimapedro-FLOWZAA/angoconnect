'use client';

import * as React from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatAKZ, formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Tipos (espelham GET /api/analytics/overview)
// ---------------------------------------------------------------------------

interface DailyEmailPoint {
  date: string; // ISO YYYY-MM-DD
  sent: number;
  delivered?: number;
  opened: number;
  clicked: number;
  replied: number;
}

interface TopSequence {
  id: string;
  name: string;
  enrolled: number;
  sent: number;
  reply_rate: number; // 0-1
}

interface DealsByStage {
  stage_id: string;
  stage_name: string;
  stage_color: string;
  count: number;
  value_akz: number;
}

interface OverviewData {
  range: { from: string; to: string };
  credits: {
    used: number;
    used_previous?: number;
    remaining?: number;
  };
  contacts: {
    revealed: number;
    revealed_previous?: number;
  };
  emails: {
    sent: number;
    delivered: number;
    opened: number;
    clicked: number;
    replied: number;
    reply_rate: number; // 0-1
    reply_rate_previous?: number;
  };
  sequences: {
    active: number;
    total: number;
  };
  deals: {
    open: number;
    won: number;
    lost: number;
    pipeline_value_akz: number;
    by_stage: DealsByStage[];
  };
  daily_email_series: DailyEmailPoint[];
  top_sequences: TopSequence[];
}

interface OverviewResponse {
  data?: OverviewData;
  error?: { code?: string; message?: string };
}

// ---------------------------------------------------------------------------
// Date range helpers
// ---------------------------------------------------------------------------

type RangeKey = '7d' | '30d' | '90d' | 'custom';

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function todayIso(): string {
  return isoDate(new Date());
}

function daysAgoIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return isoDate(d);
}

const RANGE_PRESETS: { key: Exclude<RangeKey, 'custom'>; label: string; days: number }[] = [
  { key: '7d', label: 'Últimos 7 dias', days: 7 },
  { key: '30d', label: 'Últimos 30 dias', days: 30 },
  { key: '90d', label: 'Últimos 90 dias', days: 90 },
];

const PT_SHORT_DATE = new Intl.DateTimeFormat('pt-PT', {
  day: '2-digit',
  month: '2-digit',
});

function formatShortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return PT_SHORT_DATE.format(d);
}

// ---------------------------------------------------------------------------
// Helpers de derivação
// ---------------------------------------------------------------------------

/**
 * Calcula delta percentual entre dois valores. Devolve null quando não há
 * baseline suficiente para fazer comparação significativa.
 */
function pctDelta(current: number, previous: number | undefined): number | null {
  if (previous === undefined || previous === null) return null;
  if (previous === 0) {
    if (current === 0) return 0;
    return null; // evita +Infinity%
  }
  return ((current - previous) / previous) * 100;
}

function DeltaBadge({ delta }: { delta: number | null }) {
  if (delta === null) return null;
  const rounded = Math.round(delta * 10) / 10;
  const sign = rounded > 0 ? '+' : '';
  const isUp = rounded >= 0;
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium',
        isUp
          ? 'bg-emerald-100 text-emerald-800'
          : 'bg-rose-100 text-rose-800'
      )}
    >
      {sign}
      {rounded}%
    </span>
  );
}

// ---------------------------------------------------------------------------
// KPI Card
// ---------------------------------------------------------------------------

interface KpiCardProps {
  label: string;
  value: string;
  helper?: string;
  delta?: number | null;
  loading?: boolean;
}

function KpiCard({ label, value, helper, delta, loading }: KpiCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <div className="mt-1 flex items-baseline gap-2">
          {loading ? (
            <Skeleton className="h-8 w-24" />
          ) : (
            <CardTitle className="text-2xl">{value}</CardTitle>
          )}
          {!loading ? <DeltaBadge delta={delta ?? null} /> : null}
        </div>
      </CardHeader>
      {helper ? (
        <CardContent className="pt-0">
          <p className="text-xs text-muted-foreground">{helper}</p>
        </CardContent>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Tooltips PT
// ---------------------------------------------------------------------------

interface RechartsTooltipPayload {
  name?: string | number;
  value?: number | string;
  color?: string;
  dataKey?: string | number;
}

interface CustomTooltipProps {
  active?: boolean;
  label?: string | number;
  payload?: RechartsTooltipPayload[];
  /** Quando true, formata o `label` como data PT. */
  isDate?: boolean;
}

function ChartTooltip({ active, payload, label, isDate }: CustomTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const displayLabel = isDate && typeof label === 'string' ? formatShortDate(label) : label;
  return (
    <div className="rounded-md border border-border bg-card p-2 text-xs shadow-md">
      {displayLabel !== undefined ? (
        <p className="mb-1 font-medium">{displayLabel}</p>
      ) : null}
      <ul className="flex flex-col gap-0.5">
        {payload.map((entry, i) => (
          <li key={i} className="flex items-center gap-2">
            <span
              aria-hidden="true"
              // Cor dinâmica vinda da série Recharts.
              // eslint-disable-next-line react/forbid-dom-props
              style={{ backgroundColor: entry.color ?? 'currentColor' }}
              className="h-2 w-2 rounded-full"
            />
            <span className="text-muted-foreground">{entry.name}:</span>
            <span className="font-medium">
              {typeof entry.value === 'number'
                ? formatNumber(entry.value)
                : entry.value}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Cores das séries de email — alinhadas com o resto do design system.
const SERIES_COLORS = {
  sent: '#3b82f6', // blue-500
  delivered: '#06b6d4', // cyan-500
  opened: '#10b981', // emerald-500
  clicked: '#f59e0b', // amber-500
  replied: '#8b5cf6', // violet-500
};

// ---------------------------------------------------------------------------
// AnalyticsClient
// ---------------------------------------------------------------------------

export interface AnalyticsClientProps {
  workspaceId: string;
}

export function AnalyticsClient({ workspaceId }: AnalyticsClientProps) {
  const [rangeKey, setRangeKey] = React.useState<RangeKey>('30d');
  const [from, setFrom] = React.useState<string>(() => daysAgoIso(30));
  const [to, setTo] = React.useState<string>(() => todayIso());

  const [data, setData] = React.useState<OverviewData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  function applyPreset(key: Exclude<RangeKey, 'custom'>) {
    const preset = RANGE_PRESETS.find((p) => p.key === key);
    if (!preset) return;
    setRangeKey(key);
    setFrom(daysAgoIso(preset.days));
    setTo(todayIso());
  }

  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const url = `/api/analytics/overview?workspaceId=${encodeURIComponent(
          workspaceId
        )}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
        const res = await fetch(url);
        const body = (await res.json().catch(() => ({}))) as OverviewResponse;
        if (cancelled) return;
        if (!res.ok || !body.data) {
          setError(
            body.error?.message ?? 'Não foi possível carregar métricas.'
          );
          setData(null);
        } else {
          setData(body.data);
        }
      } catch {
        if (!cancelled) {
          setError('Erro de rede. Verifica a tua ligação.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, from, to]);

  // Funnel data derivado dos KPIs de email.
  const funnelData = React.useMemo(() => {
    if (!data) return [];
    const e = data.emails;
    const base = e.sent || 1; // evita divisão por zero
    return [
      { step: 'Enviados', value: e.sent, pct: 100 },
      {
        step: 'Entregues',
        value: e.delivered,
        pct: Math.round((e.delivered / base) * 100),
      },
      {
        step: 'Abertos',
        value: e.opened,
        pct: Math.round((e.opened / base) * 100),
      },
      {
        step: 'Cliques',
        value: e.clicked,
        pct: Math.round((e.clicked / base) * 100),
      },
      {
        step: 'Respostas',
        value: e.replied,
        pct: Math.round((e.replied / base) * 100),
      },
    ];
  }, [data]);

  const topSequencesData = React.useMemo(() => {
    if (!data) return [];
    return [...data.top_sequences]
      .sort((a, b) => b.reply_rate - a.reply_rate)
      .slice(0, 5)
      .map((s) => ({
        ...s,
        reply_rate_pct: Math.round(s.reply_rate * 100),
      }));
  }, [data]);

  const pipelineData = React.useMemo(() => {
    if (!data) return [];
    return data.deals.by_stage.filter((s) => s.count > 0);
  }, [data]);

  return (
    <div className="flex flex-col gap-6">
      {/* Header + range picker */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Métricas de envios, sequências e pipeline.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {RANGE_PRESETS.map((preset) => (
            <Button
              key={preset.key}
              variant={rangeKey === preset.key ? 'default' : 'outline'}
              size="sm"
              onClick={() => applyPreset(preset.key)}
            >
              {preset.label}
            </Button>
          ))}
          <div className="ml-auto flex items-center gap-2 text-xs">
            <label className="flex items-center gap-1">
              <span className="text-muted-foreground">De</span>
              <input
                type="date"
                value={from}
                max={to}
                onChange={(e) => {
                  setFrom(e.target.value);
                  setRangeKey('custom');
                }}
                className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              />
            </label>
            <label className="flex items-center gap-1">
              <span className="text-muted-foreground">a</span>
              <input
                type="date"
                value={to}
                min={from}
                max={todayIso()}
                onChange={(e) => {
                  setTo(e.target.value);
                  setRangeKey('custom');
                }}
                className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              />
            </label>
          </div>
        </div>

        {error ? (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
          >
            {error}
          </div>
        ) : null}
      </div>

      {/* KPI cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Créditos usados"
          value={data ? formatNumber(data.credits.used) : '—'}
          delta={
            data ? pctDelta(data.credits.used, data.credits.used_previous) : null
          }
          loading={loading}
          helper={
            data?.credits.remaining != null
              ? `${formatNumber(data.credits.remaining)} restantes`
              : undefined
          }
        />
        <KpiCard
          label="Contactos revelados"
          value={data ? formatNumber(data.contacts.revealed) : '—'}
          delta={
            data
              ? pctDelta(
                  data.contacts.revealed,
                  data.contacts.revealed_previous
                )
              : null
          }
          loading={loading}
        />
        <KpiCard
          label="Emails enviados"
          value={data ? formatNumber(data.emails.sent) : '—'}
          loading={loading}
          helper={
            data
              ? `${formatNumber(data.emails.delivered)} entregues`
              : undefined
          }
        />
        <KpiCard
          label="Taxa de resposta"
          value={
            data
              ? `${(data.emails.reply_rate * 100).toFixed(1)}%`
              : '—'
          }
          delta={
            data
              ? pctDelta(
                  data.emails.reply_rate * 100,
                  data.emails.reply_rate_previous != null
                    ? data.emails.reply_rate_previous * 100
                    : undefined
                )
              : null
          }
          loading={loading}
          helper={
            data ? `${formatNumber(data.emails.replied)} respostas` : undefined
          }
        />
      </div>

      {/* Email series — LineChart */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Envios ao longo do tempo</CardTitle>
          <CardDescription>
            Envios, aberturas, cliques e respostas por dia.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-72 w-full" />
          ) : !data || data.daily_email_series.length === 0 ? (
            <div className="flex h-72 items-center justify-center text-sm text-muted-foreground">
              Sem dados para o período seleccionado.
            </div>
          ) : (
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={data.daily_email_series}
                  margin={{ top: 8, right: 8, left: -16, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis
                    dataKey="date"
                    tickFormatter={formatShortDate}
                    tick={{ fontSize: 11 }}
                  />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                  <Tooltip content={<ChartTooltip isDate />} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line
                    type="monotone"
                    dataKey="sent"
                    name="Enviados"
                    stroke={SERIES_COLORS.sent}
                    strokeWidth={2}
                    dot={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="opened"
                    name="Abertos"
                    stroke={SERIES_COLORS.opened}
                    strokeWidth={2}
                    dot={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="clicked"
                    name="Cliques"
                    stroke={SERIES_COLORS.clicked}
                    strokeWidth={2}
                    dot={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="replied"
                    name="Respostas"
                    stroke={SERIES_COLORS.replied}
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Funnel BarChart */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Funil de email</CardTitle>
            <CardDescription>
              Conversão entre passos. Percentagens relativas ao total de envios.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-64 w-full" />
            ) : !data || funnelData.every((f) => f.value === 0) ? (
              <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
                Sem dados de email.
              </div>
            ) : (
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={funnelData}
                    layout="vertical"
                    margin={{ top: 8, right: 36, left: 16, bottom: 0 }}
                  >
                    <CartesianGrid
                      strokeDasharray="3 3"
                      className="stroke-border"
                      horizontal={false}
                    />
                    <XAxis type="number" tick={{ fontSize: 11 }} />
                    <YAxis
                      type="category"
                      dataKey="step"
                      tick={{ fontSize: 12 }}
                      width={80}
                    />
                    <Tooltip content={<ChartTooltip />} />
                    <Bar
                      dataKey="value"
                      name="Total"
                      fill={SERIES_COLORS.sent}
                      radius={[0, 4, 4, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {data && funnelData.some((f) => f.value > 0) ? (
              <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-3">
                {funnelData.map((f) => (
                  <li key={f.step} className="flex items-center justify-between gap-2">
                    <span>{f.step}</span>
                    <span className="font-medium text-foreground">
                      {f.pct}%
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </CardContent>
        </Card>

        {/* Top sequences */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Top sequências</CardTitle>
            <CardDescription>
              5 sequências com maior taxa de resposta no período.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-64 w-full" />
            ) : topSequencesData.length === 0 ? (
              <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
                Sem sequências activas no período.
              </div>
            ) : (
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={topSequencesData}
                    layout="vertical"
                    margin={{ top: 8, right: 36, left: 16, bottom: 0 }}
                  >
                    <CartesianGrid
                      strokeDasharray="3 3"
                      className="stroke-border"
                      horizontal={false}
                    />
                    <XAxis
                      type="number"
                      tick={{ fontSize: 11 }}
                      tickFormatter={(v: number) => `${v}%`}
                      domain={[0, 100]}
                    />
                    <YAxis
                      type="category"
                      dataKey="name"
                      tick={{ fontSize: 11 }}
                      width={120}
                    />
                    <Tooltip
                      content={({ active, payload }: CustomTooltipProps) => {
                        if (!active || !payload || payload.length === 0) {
                          return null;
                        }
                        const entry = payload[0];
                        const name = entry?.name ?? 'Sequência';
                        const value = entry?.value;
                        return (
                          <div className="rounded-md border border-border bg-card p-2 text-xs shadow-md">
                            <p className="font-medium">{String(name)}</p>
                            <p className="text-muted-foreground">
                              Taxa de resposta:{' '}
                              <span className="font-medium text-foreground">
                                {typeof value === 'number' ? `${value}%` : '—'}
                              </span>
                            </p>
                          </div>
                        );
                      }}
                    />
                    <Bar
                      dataKey="reply_rate_pct"
                      name="Taxa de resposta"
                      fill={SERIES_COLORS.replied}
                      radius={[0, 4, 4, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Pipeline pie */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle className="text-base">Pipeline por etapa</CardTitle>
              <CardDescription>
                Distribuição de deals abertos por etapa.
              </CardDescription>
            </div>
            {data ? (
              <div className="text-right">
                <p className="text-xs text-muted-foreground">Valor total</p>
                <p className="text-lg font-semibold">
                  {formatAKZ(data.deals.pipeline_value_akz)}
                </p>
              </div>
            ) : null}
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-72 w-full" />
          ) : pipelineData.length === 0 ? (
            <div className="flex h-72 items-center justify-center text-sm text-muted-foreground">
              Sem deals abertos.
            </div>
          ) : (
            <div className="grid gap-4 lg:grid-cols-[1fr_auto]">
              <div className="h-72 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={pipelineData}
                      dataKey="count"
                      nameKey="stage_name"
                      cx="50%"
                      cy="50%"
                      innerRadius={50}
                      outerRadius={100}
                      paddingAngle={2}
                    >
                      {pipelineData.map((entry) => (
                        <Cell
                          key={entry.stage_id}
                          fill={entry.stage_color || '#94a3b8'}
                        />
                      ))}
                    </Pie>
                    <Tooltip
                      content={({ active, payload }: CustomTooltipProps) => {
                        if (!active || !payload || payload.length === 0) {
                          return null;
                        }
                        const entry = payload[0];
                        return (
                          <div className="rounded-md border border-border bg-card p-2 text-xs shadow-md">
                            <p className="font-medium">{String(entry?.name)}</p>
                            <p className="text-muted-foreground">
                              {typeof entry?.value === 'number'
                                ? `${formatNumber(entry.value)} deals`
                                : '—'}
                            </p>
                          </div>
                        );
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>

              <ul className="flex flex-col gap-2 self-center text-sm">
                {pipelineData.map((entry) => (
                  <li
                    key={entry.stage_id}
                    className="flex items-center gap-2"
                  >
                    <span
                      aria-hidden="true"
                      // Cor dinâmica do stage.
                      // eslint-disable-next-line react/forbid-dom-props
                      style={{ backgroundColor: entry.stage_color }}
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                    />
                    <span className="truncate">{entry.stage_name}</span>
                    <span className="ml-auto font-medium">
                      {formatNumber(entry.count)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      ({formatAKZ(entry.value_akz)})
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
