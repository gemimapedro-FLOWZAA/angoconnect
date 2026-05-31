'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  GripVertical,
  Mail,
  MessageCircle,
  Plus,
  Trash2,
  Eye,
  AlertTriangle,
  FileText,
  Sparkles,
  Info,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { Separator } from '@/components/ui/separator';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { AiCopyDialog, type AiContextDefaults } from './ai-copy-dialog';

// ---------------------------------------------------------------------------
// Tipos partilhados
// ---------------------------------------------------------------------------

export type SequenceStatus = 'draft' | 'active' | 'paused' | 'archived';
export type StepChannel = 'email' | 'whatsapp';

export interface SequenceStep {
  day_offset: number;
  channel: StepChannel;
  subject?: string;
  body: string;
  template_id?: string;
}

export interface SequenceDTO {
  id: string;
  name: string;
  status: SequenceStatus;
  steps: SequenceStep[];
}

interface Template {
  id: string;
  workspace_id: string | null;
  name: string;
  category: string;
  subject: string;
  body: string;
  language: string;
  is_system: boolean;
  variables: string[];
}

interface TemplatesResponse {
  data?: Template[];
  error?: { code?: string; message?: string };
}

interface WhatsAppTemplate {
  id: string;
  meta_template_name: string;
  language: string;
  category: string;
  status: 'draft' | 'pending' | 'approved' | 'rejected' | string;
  body: string;
}

interface WhatsAppTemplatesResponse {
  data?: WhatsAppTemplate[];
  error?: { code?: string; message?: string };
}

const WHATSAPP_MAX_BODY = 1024;

interface PreviewResponse {
  data?: {
    subject: { rendered: string; missingVars: string[] };
    body: { rendered: string; missingVars: string[] };
    allVariables: string[];
    isValid: boolean;
  };
  error?: { code?: string; message?: string };
}

interface UpdateResponse {
  data?: { id: string };
  error?: { code?: string; message?: string };
}

// ---------------------------------------------------------------------------
// Helpers locais — cada step recebe um clientId estável para keys do React e
// para o @dnd-kit (não usamos índice porque os itens reordenam-se).
// ---------------------------------------------------------------------------

interface InternalStep extends SequenceStep {
  clientId: string;
}

function withClientIds(steps: SequenceStep[]): InternalStep[] {
  return steps.map((s, i) => ({
    ...s,
    clientId:
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `step-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`,
  }));
}

function stripClientIds(steps: InternalStep[]): SequenceStep[] {
  return steps.map(({ clientId: _clientId, ...rest }) => rest);
}

const STATUS_LABEL: Record<SequenceStatus, string> = {
  draft: 'Rascunho',
  active: 'Activa',
  paused: 'Em pausa',
  archived: 'Arquivada',
};

const STATUS_VARIANT: Record<
  SequenceStatus,
  'secondary' | 'success' | 'warning' | 'outline'
> = {
  draft: 'secondary',
  active: 'success',
  paused: 'warning',
  archived: 'outline',
};

// ---------------------------------------------------------------------------
// SortableStepCard — cada step na lista esquerda
// ---------------------------------------------------------------------------

interface SortableStepCardProps {
  step: InternalStep;
  index: number;
  isSelected: boolean;
  canDelete: boolean;
  onSelect: () => void;
  onDelete: () => void;
}

function SortableStepCard({
  step,
  index,
  isSelected,
  canDelete,
  onSelect,
  onDelete,
}: SortableStepCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: step.clientId });

  const [confirmingDelete, setConfirmingDelete] = React.useState(false);

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };

  const subjectPreview = step.subject?.trim() || step.body.slice(0, 60) || '(sem conteúdo)';

  return (
    <div
      ref={setNodeRef}
      // Inline style obrigatório para @dnd-kit (transform/transition são
      // valores dinâmicos calculados durante o drag).
      // eslint-disable-next-line react/forbid-dom-props
      style={style}
      className={cn(
        'group relative flex items-start gap-2 rounded-md border bg-card p-3 transition-colors',
        isSelected
          ? 'border-primary ring-2 ring-primary/30'
          : 'border-border hover:border-muted-foreground/40'
      )}
    >
      <button
        type="button"
        aria-label={`Arrastar passo ${index + 1}`}
        {...attributes}
        {...listeners}
        className="mt-1 cursor-grab touch-none text-muted-foreground hover:text-foreground active:cursor-grabbing"
      >
        <GripVertical className="h-4 w-4" aria-hidden="true" />
      </button>

      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 flex-col items-start text-left"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Passo {index + 1}
          </span>
          <Badge variant="outline" className="gap-1 text-[10px]">
            {step.channel === 'email' ? (
              <Mail className="h-3 w-3" aria-hidden="true" />
            ) : (
              <MessageCircle className="h-3 w-3" aria-hidden="true" />
            )}
            Dia {step.day_offset}
          </Badge>
        </div>
        <p className="mt-1 line-clamp-1 text-sm font-medium">{subjectPreview}</p>
      </button>

      {canDelete ? (
        confirmingDelete ? (
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => {
                setConfirmingDelete(false);
                onDelete();
              }}
              className="rounded-md bg-destructive px-2 py-1 text-xs font-medium text-destructive-foreground hover:bg-destructive/90"
            >
              Confirmar
            </button>
            <button
              type="button"
              onClick={() => setConfirmingDelete(false)}
              className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
            >
              Cancelar
            </button>
          </div>
        ) : (
          <button
            type="button"
            aria-label={`Eliminar passo ${index + 1}`}
            onClick={() => setConfirmingDelete(true)}
            className="shrink-0 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </button>
        )
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// StepEditor — formulário do step seleccionado (painel direito, tab Editor)
// ---------------------------------------------------------------------------

interface StepEditorProps {
  step: InternalStep;
  stepIndex: number;
  templates: Template[];
  templatesLoading: boolean;
  whatsappTemplates: WhatsAppTemplate[];
  whatsappTemplatesLoading: boolean;
  onPatch: (patch: Partial<SequenceStep>) => void;
  onApplyTemplate: (template: Template) => void;
  onApplyWhatsAppTemplate: (template: WhatsAppTemplate) => void;
  onOpenAiDialog: () => void;
}

function groupTemplatesByCategory(templates: Template[]): Record<string, Template[]> {
  const grouped: Record<string, Template[]> = {};
  for (const t of templates) {
    const key = t.category || 'outros';
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(t);
  }
  return grouped;
}

const CATEGORY_LABEL: Record<string, string> = {
  intro: 'Intro',
  follow_up: 'Follow-up',
  break_up: 'Break-up',
  meeting: 'Reunião',
  outros: 'Outros',
};

function StepEditor({
  step,
  stepIndex,
  templates,
  templatesLoading,
  whatsappTemplates,
  whatsappTemplatesLoading,
  onPatch,
  onApplyTemplate,
  onApplyWhatsAppTemplate,
  onOpenAiDialog,
}: StepEditorProps) {
  const isEmail = step.channel === 'email';
  const isWhatsApp = step.channel === 'whatsapp';
  const grouped = React.useMemo(
    () => groupTemplatesByCategory(templates),
    [templates]
  );

  const approvedWhatsApp = React.useMemo(
    () => whatsappTemplates.filter((t) => t.status === 'approved'),
    [whatsappTemplates]
  );

  const bodyLength = step.body.length;
  const bodyOverLimit = isWhatsApp && bodyLength > WHATSAPP_MAX_BODY;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-base font-semibold">
          Passo {stepIndex + 1}
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          {isEmail ? (
            <DropdownMenu>
              <DropdownMenuTrigger>
                <Button variant="outline" size="sm">
                  <FileText className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                  Aplicar template
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="max-h-[420px] w-72 overflow-y-auto"
              >
                {templatesLoading ? (
                  <div className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground">
                    <Spinner /> A carregar templates…
                  </div>
                ) : templates.length === 0 ? (
                  <div className="px-2 py-3 text-sm text-muted-foreground">
                    Sem templates disponíveis.
                  </div>
                ) : (
                  <>
                    {Object.entries(grouped).map(([category, items], idx) => (
                      <React.Fragment key={category}>
                        {idx > 0 ? <DropdownMenuSeparator /> : null}
                        <DropdownMenuLabel>
                          {CATEGORY_LABEL[category] ?? category}
                        </DropdownMenuLabel>
                        {items.map((t) => (
                          <DropdownMenuItem
                            key={t.id}
                            onClick={() => onApplyTemplate(t)}
                          >
                            <div className="flex flex-col">
                              <span className="font-medium">{t.name}</span>
                              <span className="line-clamp-1 text-xs text-muted-foreground">
                                {t.subject}
                              </span>
                            </div>
                          </DropdownMenuItem>
                        ))}
                      </React.Fragment>
                    ))}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => {
                        window.location.href = '/outreach/templates';
                      }}
                    >
                      <span className="text-xs text-primary">
                        Ver biblioteca completa →
                      </span>
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}

          {isWhatsApp ? (
            <DropdownMenu>
              <DropdownMenuTrigger>
                <Button variant="outline" size="sm">
                  <MessageCircle className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                  Aplicar template WhatsApp
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="max-h-[420px] w-80 overflow-y-auto"
              >
                {whatsappTemplatesLoading ? (
                  <div className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground">
                    <Spinner /> A carregar templates…
                  </div>
                ) : approvedWhatsApp.length === 0 ? (
                  <div className="flex flex-col gap-1 px-2 py-3 text-sm">
                    <span className="text-muted-foreground">
                      Não tens templates aprovados.
                    </span>
                    <a
                      href="/settings/whatsapp"
                      className="text-xs text-primary hover:underline"
                    >
                      Configurar WhatsApp →
                    </a>
                  </div>
                ) : (
                  <>
                    <DropdownMenuLabel>Templates aprovados</DropdownMenuLabel>
                    {approvedWhatsApp.map((t) => (
                      <DropdownMenuItem
                        key={t.id}
                        onClick={() => onApplyWhatsAppTemplate(t)}
                      >
                        <div className="flex flex-col">
                          <span className="font-medium">
                            {t.meta_template_name}
                          </span>
                          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                            {t.category} · {t.language}
                          </span>
                          <span className="line-clamp-2 text-xs text-muted-foreground">
                            {t.body}
                          </span>
                        </div>
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => {
                        window.location.href = '/settings/whatsapp';
                      }}
                    >
                      <span className="text-xs text-primary">
                        Gerir templates →
                      </span>
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}

          <Button
            variant="outline"
            size="sm"
            onClick={onOpenAiDialog}
            title="Gerar copy com IA"
          >
            <Sparkles className="mr-1 h-3.5 w-3.5 text-primary" aria-hidden="true" />
            Sugerir copy com IA
          </Button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="step-channel">Canal</Label>
          <Select
            id="step-channel"
            value={step.channel}
            onChange={(e) =>
              onPatch({ channel: e.target.value as StepChannel })
            }
          >
            <option value="email">Email</option>
            <option value="whatsapp">WhatsApp</option>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="step-day">Dia (offset)</Label>
          <Input
            id="step-day"
            type="number"
            min={0}
            max={90}
            value={step.day_offset}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              onPatch({ day_offset: Number.isFinite(n) ? n : 0 });
            }}
          />
        </div>
      </div>

      {isWhatsApp ? (
        <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div className="flex flex-col gap-0.5">
            <p className="font-medium">
              Regras WhatsApp Business
            </p>
            <p>
              Requer um template aprovado pela Meta para iniciar conversa. Se a
              janela de 24h após a última resposta do destinatário estiver
              fechada, esta mensagem irá falhar.
            </p>
          </div>
        </div>
      ) : null}

      {isEmail ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="step-subject">Assunto</Label>
          <Input
            id="step-subject"
            placeholder="Ex: Sobre o crescimento da {{company_name}}"
            value={step.subject ?? ''}
            onChange={(e) => onPatch({ subject: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            Usa <code className="rounded bg-muted px-1">{'{{first_name}}'}</code>,{' '}
            <code className="rounded bg-muted px-1">{'{{company_name}}'}</code> e
            outras variáveis.
          </p>
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor="step-body">Mensagem</Label>
          {isWhatsApp ? (
            <span
              className={cn(
                'text-xs',
                bodyOverLimit
                  ? 'font-medium text-destructive'
                  : 'text-muted-foreground'
              )}
            >
              {bodyLength}/{WHATSAPP_MAX_BODY}
            </span>
          ) : null}
        </div>
        <Textarea
          id="step-body"
          rows={12}
          maxLength={isWhatsApp ? WHATSAPP_MAX_BODY : undefined}
          placeholder={
            isEmail
              ? 'Olá {{first_name}}, …'
              : 'Olá {{first_name}}, mensagem WhatsApp…'
          }
          value={step.body}
          onChange={(e) => onPatch({ body: e.target.value })}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// StepPreview — render via /api/templates/preview (debounced)
// ---------------------------------------------------------------------------

interface StepPreviewProps {
  step: InternalStep;
}

function StepPreview({ step }: StepPreviewProps) {
  // Debounce cada string separadamente — passar um objecto literal a
  // `useDebouncedValue` quebrava-o (referência nova a cada render).
  const debouncedSubject = useDebouncedValue(step.subject ?? '', 400);
  const debouncedBody = useDebouncedValue(step.body, 400);
  const debouncedChannel = useDebouncedValue(step.channel, 400);

  const [data, setData] = React.useState<PreviewResponse['data'] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch('/api/templates/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            subject: debouncedSubject,
            body: debouncedBody,
          }),
        });
        const json = (await res.json().catch(() => ({}))) as PreviewResponse;
        if (cancelled) return;
        if (!res.ok || !json.data) {
          setError(
            json.error?.message ?? 'Não foi possível gerar pré-visualização.'
          );
        } else {
          setData(json.data);
        }
      } catch {
        if (!cancelled) setError('Erro de rede. Tenta novamente.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [debouncedSubject, debouncedBody, debouncedChannel]);

  if (loading && !data) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/20 p-6 text-sm text-muted-foreground">
        <Spinner /> A gerar pré-visualização…
      </div>
    );
  }

  if (error) {
    return (
      <div
        role="alert"
        className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive"
      >
        {error}
      </div>
    );
  }

  if (!data) return null;

  const allMissing = [
    ...data.subject.missingVars,
    ...data.body.missingVars,
  ];
  const uniqueMissing = Array.from(new Set(allMissing));

  return (
    <div className="flex flex-col gap-3">
      {uniqueMissing.length > 0 ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div className="flex flex-col gap-0.5">
            <p className="font-medium">Variáveis sem valor:</p>
            <p>
              {uniqueMissing.map((v) => `{{${v}}}`).join(', ')}
            </p>
            <p className="text-amber-700/80">
              Vão chegar ao destinatário como literais — confirma que estás a
              usar variáveis válidas.
            </p>
          </div>
        </div>
      ) : null}

      <div className="rounded-md border border-border bg-background">
        <div className="border-b border-border bg-muted/30 px-4 py-2">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
            De
          </p>
          <p className="text-sm font-medium">
            {'{{sender_name}}'} &lt;noreply@angoconnect.ao&gt;
          </p>
        </div>
        {step.channel === 'email' ? (
          <div className="border-b border-border px-4 py-2">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Assunto
            </p>
            <p className="text-sm font-semibold">
              {data.subject.rendered || (
                <span className="text-muted-foreground">(sem assunto)</span>
              )}
            </p>
          </div>
        ) : null}
        <div className="px-4 py-4">
          <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">
            {data.body.rendered || (
              <span className="text-muted-foreground">(sem corpo)</span>
            )}
          </pre>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Pré-visualização gerada com dados de exemplo. O envio real usa os dados
        do contacto inscrito.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SequenceBuilder principal
// ---------------------------------------------------------------------------

export interface SequenceBuilderProps {
  sequence: SequenceDTO;
  workspaceId: string;
  /** Defaults para o AI Copy Dialog (vindos do workspace ou perfil). */
  aiContextDefaults?: AiContextDefaults;
}

export function SequenceBuilder({
  sequence,
  workspaceId,
  aiContextDefaults,
}: SequenceBuilderProps) {
  const router = useRouter();

  const [name, setName] = React.useState(sequence.name);
  const [status, setStatus] = React.useState<SequenceStatus>(sequence.status);
  const [steps, setSteps] = React.useState<InternalStep[]>(() =>
    withClientIds(
      sequence.steps.length > 0
        ? sequence.steps
        : [{ day_offset: 0, channel: 'email', subject: '', body: '' }]
    )
  );
  const [selectedClientId, setSelectedClientId] = React.useState<string>(
    () => steps[0]?.clientId ?? ''
  );
  const [activeTab, setActiveTab] = React.useState<'editor' | 'preview'>(
    'editor'
  );

  const [saving, setSaving] = React.useState<null | 'draft' | 'active'>(null);
  const [saveError, setSaveError] = React.useState<string | null>(null);

  // Templates email
  const [templates, setTemplates] = React.useState<Template[]>([]);
  const [templatesLoading, setTemplatesLoading] = React.useState(false);

  // Templates WhatsApp
  const [whatsappTemplates, setWhatsappTemplates] = React.useState<
    WhatsAppTemplate[]
  >([]);
  const [whatsappTemplatesLoading, setWhatsappTemplatesLoading] =
    React.useState(false);

  // AI Copy Dialog
  const [aiDialogOpen, setAiDialogOpen] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    async function loadTemplates() {
      setTemplatesLoading(true);
      try {
        const url = `/api/templates?workspaceId=${encodeURIComponent(
          workspaceId
        )}&includeSystem=true`;
        const res = await fetch(url);
        const body = (await res.json().catch(() => ({}))) as TemplatesResponse;
        if (cancelled) return;
        if (res.ok && body.data) {
          // Preferir PT-AO, fallback para PT-PT, manter ordem do servidor.
          const sorted = [...body.data].sort((a, b) => {
            const langScore = (lang: string) =>
              lang === 'pt-AO' ? 0 : lang === 'pt-PT' ? 1 : 2;
            return langScore(a.language) - langScore(b.language);
          });
          setTemplates(sorted);
        }
      } catch {
        // Silenciar — UI mostra "sem templates" no dropdown.
      } finally {
        if (!cancelled) setTemplatesLoading(false);
      }
    }
    loadTemplates();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // WhatsApp templates — carregamos apenas se algum step usar WhatsApp ou se
  // o utilizador mudar para esse canal mais tarde. Simplificamos: carregamos
  // sempre uma vez ao montar — o endpoint é leve e cabe na cache do browser.
  React.useEffect(() => {
    let cancelled = false;
    async function loadWhatsApp() {
      setWhatsappTemplatesLoading(true);
      try {
        const url = `/api/whatsapp/templates?workspaceId=${encodeURIComponent(
          workspaceId
        )}`;
        const res = await fetch(url);
        const body = (await res.json().catch(() => ({}))) as WhatsAppTemplatesResponse;
        if (cancelled) return;
        if (res.ok && body.data) {
          setWhatsappTemplates(body.data);
        }
      } catch {
        // Silencioso — UI cai no fallback "sem templates aprovados".
      } finally {
        if (!cancelled) setWhatsappTemplatesLoading(false);
      }
    }
    loadWhatsApp();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // dnd-kit sensors
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setSteps((prev) => {
      const oldIndex = prev.findIndex((s) => s.clientId === active.id);
      const newIndex = prev.findIndex((s) => s.clientId === over.id);
      if (oldIndex === -1 || newIndex === -1) return prev;
      // Mantemos day_offsets absolutos — o utilizador ajusta dias se quiser.
      return arrayMove(prev, oldIndex, newIndex);
    });
  }

  const selectedIndex = steps.findIndex((s) => s.clientId === selectedClientId);
  const selectedStep =
    selectedIndex >= 0 ? steps[selectedIndex] : steps[0] ?? null;

  function patchSelectedStep(patch: Partial<SequenceStep>) {
    if (!selectedStep) return;
    setSteps((prev) =>
      prev.map((s) =>
        s.clientId === selectedStep.clientId ? { ...s, ...patch } : s
      )
    );
  }

  function applyTemplateToSelected(template: Template) {
    if (!selectedStep) return;
    setSteps((prev) =>
      prev.map((s) =>
        s.clientId === selectedStep.clientId
          ? {
              ...s,
              subject: template.subject,
              body: template.body,
              template_id: template.id,
            }
          : s
      )
    );
  }

  function applyWhatsAppTemplateToSelected(template: WhatsAppTemplate) {
    if (!selectedStep) return;
    // O body do template Meta pode exceder o limite? Não — a Meta limita os
    // próprios templates ao mesmo 1024. Truncamos por segurança.
    const body = template.body.slice(0, WHATSAPP_MAX_BODY);
    setSteps((prev) =>
      prev.map((s) =>
        s.clientId === selectedStep.clientId
          ? {
              ...s,
              channel: 'whatsapp',
              subject: undefined,
              body,
              template_id: template.id,
            }
          : s
      )
    );
  }

  function applyAiVariantToSelected(variant: {
    subject?: string;
    body: string;
  }) {
    if (!selectedStep) return;
    setSteps((prev) =>
      prev.map((s) => {
        if (s.clientId !== selectedStep.clientId) return s;
        if (s.channel === 'whatsapp') {
          return {
            ...s,
            subject: undefined,
            body: variant.body.slice(0, WHATSAPP_MAX_BODY),
            // Limpa o template ID — agora o conteúdo é IA, não corresponde
            // ao template original.
            template_id: undefined,
          };
        }
        return {
          ...s,
          subject: variant.subject ?? s.subject ?? '',
          body: variant.body,
          template_id: undefined,
        };
      })
    );
    setActiveTab('editor');
  }

  function addStep() {
    const last = steps[steps.length - 1];
    const lastDay = last ? last.day_offset : -3;
    const nextStep: InternalStep = {
      clientId:
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      day_offset: Math.min(90, lastDay + 3),
      channel: 'email',
      subject: '',
      body: '',
    };
    setSteps((prev) => [...prev, nextStep]);
    setSelectedClientId(nextStep.clientId);
    setActiveTab('editor');
  }

  function deleteStep(clientId: string) {
    setSteps((prev) => {
      if (prev.length <= 1) return prev; // proteger sempre 1 step mínimo
      const next = prev.filter((s) => s.clientId !== clientId);
      // Se o seleccionado foi removido, escolher o primeiro disponível.
      const first = next[0];
      if (clientId === selectedClientId && first) {
        setSelectedClientId(first.clientId);
      }
      return next;
    });
  }

  function validate(): string | null {
    if (name.trim().length < 2) return 'O nome tem de ter pelo menos 2 caracteres.';
    if (steps.length === 0) return 'Adiciona pelo menos um passo.';
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (!s) continue;
      if (s.body.trim().length === 0) {
        return `Passo ${i + 1}: a mensagem é obrigatória.`;
      }
      if (
        s.channel === 'email' &&
        (!s.subject || s.subject.trim().length === 0)
      ) {
        return `Passo ${i + 1}: o assunto é obrigatório em passos de email.`;
      }
      if (s.channel === 'whatsapp' && s.body.length > WHATSAPP_MAX_BODY) {
        return `Passo ${i + 1}: o corpo WhatsApp excede ${WHATSAPP_MAX_BODY} caracteres.`;
      }
      if (s.day_offset < 0 || s.day_offset > 90) {
        return `Passo ${i + 1}: dia inválido (0-90).`;
      }
    }
    return null;
  }

  async function save(nextStatus: 'draft' | 'active') {
    const err = validate();
    if (err) {
      setSaveError(err);
      return;
    }
    setSaving(nextStatus);
    setSaveError(null);

    try {
      const res = await fetch(`/api/sequences/${sequence.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          status: nextStatus,
          steps: stripClientIds(steps),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as UpdateResponse;

      if (res.status === 409) {
        setSaveError(
          'Esta sequência está activa e já tem contactos inscritos — não podes alterar os passos. Pausa primeiro.'
        );
        setSaving(null);
        return;
      }
      if (!res.ok || !body.data) {
        setSaveError(
          body.error?.message ?? 'Não foi possível guardar a sequência.'
        );
        setSaving(null);
        return;
      }

      setStatus(nextStatus);
      setSaving(null);
      router.push(`/outreach/${sequence.id}`);
      router.refresh();
    } catch {
      setSaveError('Erro de rede. Verifica a tua ligação e tenta novamente.');
      setSaving(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-col gap-3">
        <Link
          href="/outreach"
          className="text-xs text-muted-foreground hover:underline"
        >
          ← Voltar a sequências
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex items-center gap-2">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Nome interno da sequência"
                className="max-w-md text-lg font-semibold"
                aria-label="Nome da sequência"
              />
              <Badge variant={STATUS_VARIANT[status]}>
                {STATUS_LABEL[status]}
              </Badge>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/outreach/${sequence.id}`}>
              <Button variant="ghost" size="sm">
                Cancelar
              </Button>
            </Link>
            <Button
              variant="outline"
              size="sm"
              onClick={() => save('draft')}
              disabled={saving !== null}
            >
              {saving === 'draft' ? <Spinner /> : null}
              {saving === 'draft' ? 'A guardar…' : 'Guardar rascunho'}
            </Button>
            <Button
              size="sm"
              onClick={() => save('active')}
              disabled={saving !== null}
            >
              {saving === 'active' ? <Spinner /> : null}
              {saving === 'active' ? 'A activar…' : 'Guardar e activar'}
            </Button>
          </div>
        </div>
        {saveError ? (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
          >
            {saveError}
          </div>
        ) : null}
      </div>

      <Separator />

      {/* Body: 2-column layout */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        {/* Left: steps list with DnD */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Passos
            </h2>
            <span className="text-xs text-muted-foreground">
              {steps.length} {steps.length === 1 ? 'passo' : 'passos'}
            </span>
          </div>

          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={steps.map((s) => s.clientId)}
              strategy={verticalListSortingStrategy}
            >
              <div className="flex flex-col gap-2">
                {steps.map((step, index) => (
                  <SortableStepCard
                    key={step.clientId}
                    step={step}
                    index={index}
                    isSelected={step.clientId === selectedClientId}
                    canDelete={steps.length > 1}
                    onSelect={() => {
                      setSelectedClientId(step.clientId);
                      setActiveTab('editor');
                    }}
                    onDelete={() => deleteStep(step.clientId)}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>

          <Button
            variant="outline"
            size="sm"
            onClick={addStep}
            className="self-start"
          >
            <Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            Adicionar passo
          </Button>
        </div>

        {/* Right: editor / preview tabs */}
        <div className="flex flex-col gap-3">
          {selectedStep ? (
            <Tabs
              value={activeTab}
              onValueChange={(v) =>
                setActiveTab(v === 'preview' ? 'preview' : 'editor')
              }
            >
              <TabsList>
                <TabsTrigger value="editor">Editor</TabsTrigger>
                <TabsTrigger value="preview">
                  <Eye className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                  Pré-visualizar
                </TabsTrigger>
              </TabsList>
              <TabsContent value="editor">
                <StepEditor
                  step={selectedStep}
                  stepIndex={selectedIndex >= 0 ? selectedIndex : 0}
                  templates={templates}
                  templatesLoading={templatesLoading}
                  whatsappTemplates={whatsappTemplates}
                  whatsappTemplatesLoading={whatsappTemplatesLoading}
                  onPatch={patchSelectedStep}
                  onApplyTemplate={applyTemplateToSelected}
                  onApplyWhatsAppTemplate={applyWhatsAppTemplateToSelected}
                  onOpenAiDialog={() => setAiDialogOpen(true)}
                />
              </TabsContent>
              <TabsContent value="preview">
                <StepPreview step={selectedStep} />
              </TabsContent>
            </Tabs>
          ) : (
            <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              Selecciona um passo para o editar.
            </div>
          )}
        </div>
      </div>

      {selectedStep ? (
        <AiCopyDialog
          open={aiDialogOpen}
          onOpenChange={setAiDialogOpen}
          workspaceId={workspaceId}
          channel={selectedStep.channel}
          contextDefaults={aiContextDefaults}
          onApply={applyAiVariantToSelected}
        />
      ) : null}
    </div>
  );
}
