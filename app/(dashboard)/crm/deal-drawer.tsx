'use client';

import * as React from 'react';
import {
  Mail,
  Phone,
  Trash2,
  Send,
  CheckCheck,
  Eye,
  MousePointerClick,
  MessageSquare,
  AlertOctagon,
  Ban,
  Smartphone,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Spinner } from '@/components/ui/spinner';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar } from '@/components/ui/avatar';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import { Timeline, TimelineItem } from '@/components/ui/timeline';
import { formatAKZ, formatDate, formatDateTime, formatPhone } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { Stage } from './kanban-board';

// ---------------------------------------------------------------------------
// Tipos (espelham o contrato GET /api/deals)
// ---------------------------------------------------------------------------

export type DealStatus = 'open' | 'won' | 'lost' | string;

export interface DealContact {
  id: string;
  name: string | null;
  title: string | null;
  email: string | null;
  phone: string | null;
}

export interface DealCompany {
  id: string;
  name: string;
  sector: string | null;
  provincia: string | null;
}

export interface DealOwner {
  id: string;
  full_name: string | null;
  email: string;
}

export interface Deal {
  id: string;
  stage_id: string;
  value_akz: number | null;
  expected_close_date: string | null;
  status: DealStatus;
  source: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  contact: DealContact | null;
  company: DealCompany | null;
  owner: DealOwner | null;
}

interface UpdateResponse {
  data?: Deal;
  error?: { code?: string; message?: string };
}

// ---------------------------------------------------------------------------
// Histórico — espelha o contrato GET /api/deals/:id (resposta estendida).
// ---------------------------------------------------------------------------

export type EmailEventType =
  | 'sent'
  | 'delivered'
  | 'opened'
  | 'clicked'
  | 'replied'
  | 'bounced'
  | 'complained'
  | 'wa_sent'
  | 'wa_delivered'
  | 'wa_read'
  | 'wa_failed'
  | string;

export interface EmailEvent {
  id: string;
  type: EmailEventType;
  timestamp: string;
  enrollment_id?: string | null;
  sequence_name?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface DealDetailResponse {
  data?: { deal: Deal; history: EmailEvent[] };
  error?: { code?: string; message?: string };
}

interface EventStyle {
  label: string;
  icon: React.ReactNode;
  markerClassName: string;
}

const EVENT_STYLES: Record<string, EventStyle> = {
  sent: {
    label: 'Enviado',
    icon: <Send className="h-3 w-3" aria-hidden="true" />,
    markerClassName: 'bg-blue-100 text-blue-700',
  },
  delivered: {
    label: 'Entregue',
    icon: <CheckCheck className="h-3 w-3" aria-hidden="true" />,
    markerClassName: 'bg-sky-100 text-sky-700',
  },
  opened: {
    label: 'Aberto',
    icon: <Eye className="h-3 w-3" aria-hidden="true" />,
    markerClassName: 'bg-amber-100 text-amber-700',
  },
  clicked: {
    label: 'Clicado',
    icon: <MousePointerClick className="h-3 w-3" aria-hidden="true" />,
    markerClassName: 'bg-violet-100 text-violet-700',
  },
  replied: {
    label: 'Respondido',
    icon: <MessageSquare className="h-3 w-3" aria-hidden="true" />,
    markerClassName: 'bg-emerald-100 text-emerald-700',
  },
  bounced: {
    label: 'Devolvido',
    icon: <AlertOctagon className="h-3 w-3" aria-hidden="true" />,
    markerClassName: 'bg-orange-100 text-orange-700',
  },
  complained: {
    label: 'Spam reportado',
    icon: <Ban className="h-3 w-3" aria-hidden="true" />,
    markerClassName: 'bg-red-100 text-red-700',
  },
  wa_sent: {
    label: 'WhatsApp enviado',
    icon: <Smartphone className="h-3 w-3" aria-hidden="true" />,
    markerClassName: 'bg-emerald-100 text-emerald-700',
  },
  wa_delivered: {
    label: 'WhatsApp entregue',
    icon: <Smartphone className="h-3 w-3" aria-hidden="true" />,
    markerClassName: 'bg-emerald-100 text-emerald-700',
  },
  wa_read: {
    label: 'WhatsApp lido',
    icon: <Smartphone className="h-3 w-3" aria-hidden="true" />,
    markerClassName: 'bg-emerald-100 text-emerald-700',
  },
  wa_failed: {
    label: 'WhatsApp falhou',
    icon: <Smartphone className="h-3 w-3" aria-hidden="true" />,
    markerClassName: 'bg-red-100 text-red-700',
  },
};

function getEventStyle(type: EmailEventType): EventStyle {
  return (
    EVENT_STYLES[type] ?? {
      label: type,
      icon: <Send className="h-3 w-3" aria-hidden="true" />,
      markerClassName: 'bg-muted text-muted-foreground',
    }
  );
}

const STATUS_LABEL: Record<string, string> = {
  open: 'Em curso',
  won: 'Ganho',
  lost: 'Perdido',
};

const STATUS_VARIANT: Record<
  string,
  'default' | 'secondary' | 'success' | 'warning' | 'destructive' | 'outline'
> = {
  open: 'secondary',
  won: 'success',
  lost: 'destructive',
};

const SECTOR_LABELS: Record<string, string> = {
  oil_gas: 'Petróleo e Gás',
  construction: 'Construção',
  telecom: 'Telecom',
  banking: 'Banca',
  insurance: 'Seguros',
  retail: 'Retalho',
  agro: 'Agro',
  health: 'Saúde',
  education: 'Educação',
  logistics: 'Logística',
  tech: 'Tech',
  government: 'Governo',
};

export interface DealDrawerProps {
  workspaceId: string;
  /** Null = drawer fechado. */
  deal: Deal | null;
  stages: Stage[];
  onClose: () => void;
  onUpdated: (deal: Deal) => void;
  onDeleted: (dealId: string) => void;
}

export function DealDrawer({
  deal,
  stages,
  onClose,
  onUpdated,
  onDeleted,
}: DealDrawerProps) {
  const open = deal !== null;
  const [tab, setTab] = React.useState<'details' | 'history'>('details');

  // Form local — sincroniza quando o deal mudar.
  const [valueAkz, setValueAkz] = React.useState<string>('');
  const [expectedClose, setExpectedClose] = React.useState<string>('');
  const [notes, setNotes] = React.useState<string>('');
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

  // Histórico — carregado preguiçosamente quando o utilizador abre a tab.
  const [history, setHistory] = React.useState<EmailEvent[]>([]);
  const [historyLoading, setHistoryLoading] = React.useState(false);
  const [historyError, setHistoryError] = React.useState<string | null>(null);
  const [historyLoadedFor, setHistoryLoadedFor] = React.useState<string | null>(
    null
  );

  React.useEffect(() => {
    if (!deal) {
      setValueAkz('');
      setExpectedClose('');
      setNotes('');
      setSaveError(null);
      setConfirmDelete(false);
      setTab('details');
      setHistory([]);
      setHistoryError(null);
      setHistoryLoadedFor(null);
      return;
    }
    setValueAkz(deal.value_akz != null ? String(deal.value_akz) : '');
    setExpectedClose(deal.expected_close_date ?? '');
    setNotes(deal.notes ?? '');
    setSaveError(null);
    setConfirmDelete(false);
    // Resetar histórico se o deal mudou — só recarregamos se o utilizador
    // voltar a abrir a tab.
    if (historyLoadedFor !== deal.id) {
      setHistory([]);
      setHistoryError(null);
    }
  }, [deal, historyLoadedFor]);

  // Carrega o histórico quando a tab Histórico é aberta (e apenas uma vez por deal).
  React.useEffect(() => {
    if (!deal) return;
    if (tab !== 'history') return;
    if (historyLoadedFor === deal.id) return;
    let cancelled = false;
    async function load() {
      if (!deal) return;
      setHistoryLoading(true);
      setHistoryError(null);
      try {
        const res = await fetch(`/api/deals/${deal.id}`);
        const body = (await res.json().catch(() => ({}))) as DealDetailResponse;
        if (cancelled) return;
        if (!res.ok || !body.data) {
          setHistoryError(
            body.error?.message ?? 'Não foi possível carregar o histórico.'
          );
          setHistory([]);
        } else {
          setHistory(body.data.history ?? []);
          setHistoryLoadedFor(deal.id);
        }
      } catch {
        if (!cancelled) {
          setHistoryError('Erro de rede ao carregar histórico.');
          setHistory([]);
        }
      } finally {
        if (!cancelled) setHistoryLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [tab, deal, historyLoadedFor]);

  async function patchDeal(patch: Record<string, unknown>): Promise<Deal | null> {
    if (!deal) return null;
    setSaveError(null);
    try {
      const res = await fetch(`/api/deals/${deal.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const body = (await res.json().catch(() => ({}))) as UpdateResponse;
      if (!res.ok || !body.data) {
        setSaveError(
          body.error?.message ?? 'Não foi possível guardar as alterações.'
        );
        return null;
      }
      onUpdated(body.data);
      return body.data;
    } catch {
      setSaveError('Erro de rede. Tenta novamente.');
      return null;
    }
  }

  async function handleSave() {
    if (!deal) return;
    setSaving(true);

    const numericValue = valueAkz.trim() === '' ? null : Number(valueAkz);
    if (numericValue !== null && (Number.isNaN(numericValue) || numericValue < 0)) {
      setSaveError('Valor inválido. Usa um número não negativo.');
      setSaving(false);
      return;
    }

    await patchDeal({
      valueAkz: numericValue,
      expectedCloseDate: expectedClose.trim() === '' ? null : expectedClose,
      notes: notes.trim() === '' ? null : notes,
    });
    setSaving(false);
  }

  async function handleStageChange(newStageId: string) {
    if (!deal || newStageId === deal.stage_id) return;
    await patchDeal({ stageId: newStageId });
  }

  async function handleDelete() {
    if (!deal) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/deals/${deal.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        setSaveError(
          body.error?.message ?? 'Não foi possível apagar o deal.'
        );
        setDeleting(false);
        return;
      }
      onDeleted(deal.id);
    } catch {
      setSaveError('Erro de rede ao apagar.');
    } finally {
      setDeleting(false);
    }
  }

  // Quando não há deal seleccionado o Sheet fica fechado mas mantemos o
  // componente sempre montado (return abaixo) — o SheetContent só renderiza
  // o portal quando `open === true`.
  if (!deal) return null;

  const currentStage = stages.find((s) => s.id === deal.stage_id);
  const sectorLabel = deal.company?.sector
    ? (SECTOR_LABELS[deal.company.sector] ?? deal.company.sector)
    : null;

  return (
    <Sheet open={open} onOpenChange={(v) => (!v ? onClose() : null)}>
      <SheetContent widthClassName="w-full sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="truncate">
            {deal.contact?.name ?? 'Sem contacto'}
          </SheetTitle>
          {deal.contact?.title ? (
            <SheetDescription>{deal.contact.title}</SheetDescription>
          ) : null}
        </SheetHeader>

        {/* Sub-header: company + status + stage selector */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-6 py-3">
          {deal.company ? (
            <div className="flex flex-col">
              <span className="text-xs text-muted-foreground">Empresa</span>
              <span className="text-sm font-medium">{deal.company.name}</span>
            </div>
          ) : null}
          {sectorLabel ? (
            <Badge variant="outline">{sectorLabel}</Badge>
          ) : null}
          <Badge variant={STATUS_VARIANT[deal.status] ?? 'secondary'}>
            {STATUS_LABEL[deal.status] ?? deal.status}
          </Badge>
          <div className="ml-auto flex items-center gap-2">
            <Label
              htmlFor="deal-stage"
              className="text-xs uppercase tracking-wide text-muted-foreground"
            >
              Etapa
            </Label>
            <Select
              id="deal-stage"
              value={deal.stage_id}
              onChange={(e) => handleStageChange(e.target.value)}
              className="h-8 w-auto text-xs"
            >
              {stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <div className="flex flex-1 flex-col overflow-y-auto">
          <Tabs value={tab} onValueChange={(v) => setTab(v as 'details' | 'history')}>
            <div className="border-b border-border px-6 py-2">
              <TabsList>
                <TabsTrigger value="details">Detalhes</TabsTrigger>
                <TabsTrigger value="history">Histórico</TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="details" className="px-6 py-4">
              <div className="flex flex-col gap-4">
                {/* Contact info */}
                {deal.contact ? (
                  <div className="rounded-md border border-border p-3">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">
                      Contacto
                    </p>
                    <div className="mt-2 flex flex-col gap-1 text-sm">
                      {deal.contact.email ? (
                        <span className="flex items-center gap-2">
                          <Mail className="h-3 w-3 text-muted-foreground" />
                          <span className="font-mono text-xs">
                            {deal.contact.email}
                          </span>
                        </span>
                      ) : null}
                      {deal.contact.phone ? (
                        <span className="flex items-center gap-2">
                          <Phone className="h-3 w-3 text-muted-foreground" />
                          <span className="font-mono text-xs">
                            {formatPhone(deal.contact.phone)}
                          </span>
                        </span>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                {/* Owner */}
                {deal.owner ? (
                  <div className="flex items-center gap-3 rounded-md border border-border p-3">
                    <Avatar
                      name={deal.owner.full_name ?? deal.owner.email}
                      size={32}
                    />
                    <div className="flex flex-col">
                      <span className="text-xs text-muted-foreground">
                        Responsável
                      </span>
                      <span className="text-sm font-medium">
                        {deal.owner.full_name ?? deal.owner.email}
                      </span>
                    </div>
                  </div>
                ) : null}

                {/* Editable fields */}
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="deal-value">Valor (AKZ)</Label>
                    <Input
                      id="deal-value"
                      type="number"
                      min={0}
                      step={1000}
                      placeholder="0"
                      value={valueAkz}
                      onChange={(e) => setValueAkz(e.target.value)}
                    />
                    {valueAkz ? (
                      <p className="text-xs text-muted-foreground">
                        ≈ {formatAKZ(Number(valueAkz) || 0)}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="deal-close">Fecho esperado</Label>
                    <Input
                      id="deal-close"
                      type="date"
                      value={expectedClose}
                      onChange={(e) => setExpectedClose(e.target.value)}
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="deal-notes">Notas</Label>
                  <Textarea
                    id="deal-notes"
                    rows={6}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Adiciona contexto, próximos passos, decisões…"
                  />
                </div>

                <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                  <span>Criado em {formatDate(deal.created_at)}</span>
                  <span>Actualizado em {formatDate(deal.updated_at)}</span>
                  {currentStage ? (
                    <span>Etapa actual: {currentStage.name}</span>
                  ) : null}
                </div>

                {saveError ? (
                  <div
                    role="alert"
                    className={cn(
                      'rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive'
                    )}
                  >
                    {saveError}
                  </div>
                ) : null}
              </div>
            </TabsContent>

            <TabsContent value="history" className="px-6 py-4">
              {historyLoading ? (
                <div className="flex flex-col gap-3">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="flex items-start gap-3">
                      <Skeleton className="h-5 w-5 rounded-full" />
                      <div className="flex flex-1 flex-col gap-1.5">
                        <Skeleton className="h-4 w-1/3" />
                        <Skeleton className="h-3 w-1/2" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : historyError ? (
                <div
                  role="alert"
                  className={cn(
                    'rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive'
                  )}
                >
                  {historyError}
                </div>
              ) : history.length === 0 ? (
                <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                  Sem eventos ainda.
                  <br />
                  <span className="text-xs">
                    Assim que enviares emails ou mensagens WhatsApp a este
                    contacto, aparecem aqui.
                  </span>
                </div>
              ) : (
                <Timeline>
                  {history.map((event) => {
                    const style = getEventStyle(event.type);
                    const stepLabel =
                      event.metadata &&
                      typeof event.metadata.step === 'number'
                        ? `Passo ${(event.metadata.step as number) + 1}`
                        : null;
                    return (
                      <TimelineItem
                        key={event.id}
                        icon={style.icon}
                        markerClassName={style.markerClassName}
                        title={style.label}
                        timestamp={formatDateTime(event.timestamp)}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          {event.sequence_name ? (
                            <Badge variant="outline" className="text-[10px]">
                              {event.sequence_name}
                            </Badge>
                          ) : null}
                          {stepLabel ? (
                            <span className="text-[11px] text-muted-foreground">
                              {stepLabel}
                            </span>
                          ) : null}
                        </div>
                      </TimelineItem>
                    );
                  })}
                </Timeline>
              )}
            </TabsContent>
          </Tabs>
        </div>

        <SheetFooter>
          {confirmDelete ? (
            <div className="flex w-full flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-destructive">
                Tens a certeza? Esta acção não pode ser desfeita.
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirmDelete(false)}
                >
                  Cancelar
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleDelete}
                  disabled={deleting}
                >
                  {deleting ? <Spinner /> : null}
                  Apagar deal
                </Button>
              </div>
            </div>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirmDelete(true)}
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                Apagar
              </Button>
              <Button variant="outline" onClick={onClose}>
                Fechar
              </Button>
              <Button onClick={handleSave} disabled={saving}>
                {saving ? <Spinner /> : null}
                {saving ? 'A guardar…' : 'Guardar'}
              </Button>
            </>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
