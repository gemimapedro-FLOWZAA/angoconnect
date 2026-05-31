'use client';

import * as React from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Plus, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { formatAKZ, formatDate, formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import { DealDrawer, type Deal } from './deal-drawer';
import { NewDealDialog } from './new-deal-dialog';

// ---------------------------------------------------------------------------
// Tipos partilhados — coincidem com os contratos do backend definidos no brief.
// ---------------------------------------------------------------------------

export interface Stage {
  id: string;
  workspace_id: string;
  name: string;
  position: number;
  color: string;
  is_won: boolean;
  is_lost: boolean;
  is_system: boolean;
  created_at: string;
}

interface StagesResponse {
  data?: Stage[];
  error?: { code?: string; message?: string };
}

interface DealsResponse {
  data?: Deal[];
  meta?: { total: number; page: number; pageSize: number; totalPages: number };
  error?: { code?: string; message?: string };
}

// Página grande porque o Kanban mostra todos os deals abertos por coluna.
const DEALS_PAGE_SIZE = 200;

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

// ---------------------------------------------------------------------------
// DealCard — card individual arrastável
// ---------------------------------------------------------------------------

interface DealCardProps {
  deal: Deal;
  onOpen: () => void;
}

function DealCard({ deal, onOpen }: DealCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: deal.id,
    data: { type: 'deal', stageId: deal.stage_id },
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : 1,
  };

  const sector = deal.company?.sector
    ? (SECTOR_LABELS[deal.company.sector] ?? deal.company.sector)
    : null;

  function handleClick(e: React.MouseEvent) {
    // Evita abrir o drawer quando o utilizador está a arrastar.
    if (isDragging) return;
    e.stopPropagation();
    onOpen();
  }

  return (
    <div
      ref={setNodeRef}
      // Inline style obrigatório para @dnd-kit (transform/transition dinâmicos).
      // eslint-disable-next-line react/forbid-dom-props
      style={style}
      {...attributes}
      {...listeners}
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        'group relative flex cursor-grab flex-col gap-2 rounded-md border border-border bg-card p-3 text-left shadow-sm transition-shadow',
        'hover:border-muted-foreground/40 hover:shadow-md',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing'
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium leading-tight">
            {deal.contact?.name ?? 'Sem contacto'}
          </span>
          {deal.contact?.title ? (
            <span className="truncate text-xs text-muted-foreground">
              {deal.contact.title}
            </span>
          ) : null}
        </div>
      </div>

      {deal.company ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-xs font-medium text-foreground">
            {deal.company.name}
          </span>
          {sector ? (
            <Badge variant="outline" className="text-[10px]">
              {sector}
            </Badge>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-end justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5 text-xs text-muted-foreground">
          {deal.value_akz != null ? (
            <span className="font-semibold text-foreground">
              {formatAKZ(deal.value_akz)}
            </span>
          ) : null}
          {deal.expected_close_date ? (
            <span>Fecho: {formatDate(deal.expected_close_date)}</span>
          ) : null}
        </div>
        {deal.owner ? (
          <Avatar name={deal.owner.full_name ?? deal.owner.email} size={24} />
        ) : null}
      </div>
    </div>
  );
}

/**
 * Versão estática (sem hooks de sortable) usada dentro de `DragOverlay`. O
 * `DragOverlay` está fora do `SortableContext`, por isso usar `useSortable`
 * lá dentro disparava transformações duplicadas.
 */
function DealCardPreview({ deal }: { deal: Deal }) {
  const sector = deal.company?.sector
    ? (SECTOR_LABELS[deal.company.sector] ?? deal.company.sector)
    : null;

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-card p-3 shadow-lg ring-2 ring-primary/30">
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium leading-tight">
          {deal.contact?.name ?? 'Sem contacto'}
        </span>
        {deal.contact?.title ? (
          <span className="truncate text-xs text-muted-foreground">
            {deal.contact.title}
          </span>
        ) : null}
      </div>
      {deal.company ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-xs font-medium text-foreground">
            {deal.company.name}
          </span>
          {sector ? (
            <Badge variant="outline" className="text-[10px]">
              {sector}
            </Badge>
          ) : null}
        </div>
      ) : null}
      <div className="flex items-end justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5 text-xs text-muted-foreground">
          {deal.value_akz != null ? (
            <span className="font-semibold text-foreground">
              {formatAKZ(deal.value_akz)}
            </span>
          ) : null}
          {deal.expected_close_date ? (
            <span>Fecho: {formatDate(deal.expected_close_date)}</span>
          ) : null}
        </div>
        {deal.owner ? (
          <Avatar name={deal.owner.full_name ?? deal.owner.email} size={24} />
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// KanbanColumn — uma coluna por stage
// ---------------------------------------------------------------------------

interface KanbanColumnProps {
  stage: Stage;
  deals: Deal[];
  onOpenDeal: (deal: Deal) => void;
  onQuickAdd: (stageId: string) => void;
}

function KanbanColumn({
  stage,
  deals,
  onOpenDeal,
  onQuickAdd,
}: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: stage.id,
    data: { type: 'column', stageId: stage.id },
  });

  const openDealsValue = deals
    .filter((d) => d.status === 'open' || d.status == null)
    .reduce((acc, d) => acc + (d.value_akz ?? 0), 0);

  return (
    <div
      className={cn(
        'flex w-72 shrink-0 flex-col rounded-lg border border-border bg-muted/30',
        isOver ? 'ring-2 ring-primary/40' : null
      )}
    >
      {/* Header da coluna */}
      <div className="flex items-start justify-between gap-2 border-b border-border p-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              // Cor dinâmica vinda do servidor — único caso onde precisamos
              // de style inline para color de stage.
              // eslint-disable-next-line react/forbid-dom-props
              style={{ backgroundColor: stage.color }}
              className="h-2.5 w-2.5 shrink-0 rounded-full"
            />
            <span className="truncate text-sm font-semibold">{stage.name}</span>
            <span className="ml-auto text-xs text-muted-foreground">
              {formatNumber(deals.length)}
            </span>
          </div>
          {openDealsValue > 0 ? (
            <span className="text-xs text-muted-foreground">
              {formatAKZ(openDealsValue)}
            </span>
          ) : null}
        </div>
      </div>

      {/* Lista de cards */}
      <div
        ref={setNodeRef}
        className="flex max-h-[calc(100vh-280px)] min-h-[160px] flex-1 flex-col gap-2 overflow-y-auto p-2"
      >
        <SortableContext
          items={deals.map((d) => d.id)}
          strategy={verticalListSortingStrategy}
        >
          {deals.map((deal) => (
            <DealCard
              key={deal.id}
              deal={deal}
              onOpen={() => onOpenDeal(deal)}
            />
          ))}
        </SortableContext>

        {deals.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border/60 px-3 py-6 text-center text-xs text-muted-foreground">
            <span>Sem deals</span>
            <button
              type="button"
              onClick={() => onQuickAdd(stage.id)}
              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              <Plus className="h-3 w-3" aria-hidden="true" />
              Adicionar
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// KanbanBoard — orquestra os dados e o DnD
// ---------------------------------------------------------------------------

export interface KanbanBoardProps {
  workspaceId: string;
}

interface DealsByStage {
  [stageId: string]: Deal[];
}

function groupDealsByStage(deals: Deal[], stages: Stage[]): DealsByStage {
  const grouped: DealsByStage = {};
  for (const stage of stages) grouped[stage.id] = [];
  for (const deal of deals) {
    const bucket = grouped[deal.stage_id];
    if (bucket) bucket.push(deal);
    // deals com stage_id desconhecido são silenciosamente ignorados — o
    // backend é a source of truth.
  }
  return grouped;
}

function filterDealsBySearch(deals: Deal[], query: string): Deal[] {
  const q = query.trim().toLowerCase();
  if (!q) return deals;
  return deals.filter((d) => {
    const contactName = d.contact?.name?.toLowerCase() ?? '';
    const companyName = d.company?.name?.toLowerCase() ?? '';
    const notes = d.notes?.toLowerCase() ?? '';
    return (
      contactName.includes(q) ||
      companyName.includes(q) ||
      notes.includes(q)
    );
  });
}

export function KanbanBoard({ workspaceId }: KanbanBoardProps) {
  const [stages, setStages] = React.useState<Stage[]>([]);
  const [deals, setDeals] = React.useState<Deal[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const [search, setSearch] = React.useState('');
  const debouncedSearch = useDebouncedValue(search, 200);

  const [newDealOpen, setNewDealOpen] = React.useState(false);
  const [newDealDefaultStageId, setNewDealDefaultStageId] = React.useState<
    string | null
  >(null);

  const [openDealId, setOpenDealId] = React.useState<string | null>(null);

  // Para DragOverlay (snapshot do card durante o drag)
  const [activeDealId, setActiveDealId] = React.useState<string | null>(null);

  // Fetch inicial: stages + deals em paralelo.
  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [stagesRes, dealsRes] = await Promise.all([
          fetch(
            `/api/deal-stages?workspaceId=${encodeURIComponent(workspaceId)}`
          ),
          fetch(
            `/api/deals?workspaceId=${encodeURIComponent(
              workspaceId
            )}&pageSize=${DEALS_PAGE_SIZE}&status=open`
          ),
        ]);

        const stagesBody = (await stagesRes
          .json()
          .catch(() => ({}))) as StagesResponse;
        const dealsBody = (await dealsRes
          .json()
          .catch(() => ({}))) as DealsResponse;

        if (cancelled) return;

        if (!stagesRes.ok || !stagesBody.data) {
          setError(
            stagesBody.error?.message ?? 'Não foi possível carregar etapas.'
          );
          setStages([]);
        } else {
          const sorted = [...stagesBody.data].sort(
            (a, b) => a.position - b.position
          );
          setStages(sorted);
        }

        if (!dealsRes.ok) {
          // Não bloquear se deals falharem — colunas mostram-se vazias.
          setDeals([]);
        } else {
          setDeals(dealsBody.data ?? []);
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
  }, [workspaceId]);

  // dnd-kit sensors
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  function findDealById(id: string): Deal | undefined {
    return deals.find((d) => d.id === id);
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveDealId(String(event.active.id));
  }

  function handleDragOver(_event: DragOverEvent) {
    // No-op — actualização ao soltar (onDragEnd). Mantemos o handler para
    // futuras melhorias de UX (preview da posição final).
  }

  async function handleDragEnd(event: DragEndEvent) {
    setActiveDealId(null);
    const { active, over } = event;
    if (!over) return;

    const activeDeal = findDealById(String(active.id));
    if (!activeDeal) return;

    // O `over.id` pode ser: (a) o id de outra deal (drag para cima de outro
    // card na mesma coluna ou diferente), ou (b) o id do stage (drag para
    // área vazia da coluna). Resolvemos para o stageId destino.
    const overId = String(over.id);
    const overData = over.data.current as
      | { type?: 'deal' | 'column'; stageId?: string }
      | undefined;
    const targetStageId =
      overData?.type === 'column'
        ? (overData.stageId ?? overId)
        : (overData?.stageId ?? findDealById(overId)?.stage_id);

    if (!targetStageId || targetStageId === activeDeal.stage_id) return;

    // Optimistic update
    const previousDeals = deals;
    const newStage = stages.find((s) => s.id === targetStageId);
    const newStatus: Deal['status'] = newStage?.is_won
      ? 'won'
      : newStage?.is_lost
        ? 'lost'
        : 'open';

    setDeals((prev) =>
      prev.map((d) =>
        d.id === activeDeal.id
          ? { ...d, stage_id: targetStageId, status: newStatus }
          : d
      )
    );

    try {
      const res = await fetch(`/api/deals/${activeDeal.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stageId: targetStageId }),
      });
      if (!res.ok) {
        // Rollback
        setDeals(previousDeals);
        const body = (await res.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        setError(
          body.error?.message ?? 'Não foi possível mover o deal. Tenta de novo.'
        );
      }
    } catch {
      setDeals(previousDeals);
      setError('Erro de rede ao mover o deal.');
    }
  }

  function handleDealCreated(deal: Deal) {
    setDeals((prev) => [deal, ...prev]);
    setNewDealOpen(false);
  }

  function handleDealUpdated(updated: Deal) {
    setDeals((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
  }

  function handleDealDeleted(dealId: string) {
    setDeals((prev) => prev.filter((d) => d.id !== dealId));
    setOpenDealId(null);
  }

  function openQuickAdd(stageId: string) {
    setNewDealDefaultStageId(stageId);
    setNewDealOpen(true);
  }

  // Agrupar e filtrar
  const filteredDeals = React.useMemo(
    () => filterDealsBySearch(deals, debouncedSearch),
    [deals, debouncedSearch]
  );
  const dealsByStage = React.useMemo(
    () => groupDealsByStage(filteredDeals, stages),
    [filteredDeals, stages]
  );

  const activeDeal = activeDealId ? findDealById(activeDealId) : null;
  const openDeal = openDealId ? deals.find((d) => d.id === openDealId) : null;

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Pipeline</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Acompanha os teus deals em curso, arrasta para mudar de etapa.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Pesquisar deals…"
                aria-label="Pesquisar deals"
                className="h-9 w-56 pl-8 text-sm"
              />
            </div>
            <Button
              size="sm"
              onClick={() => {
                setNewDealDefaultStageId(null);
                setNewDealOpen(true);
              }}
            >
              <Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
              Novo deal
            </Button>
          </div>
        </div>

        {error ? (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
          >
            {error}
            <button
              type="button"
              onClick={() => setError(null)}
              className="ml-2 text-xs underline-offset-2 hover:underline"
            >
              Fechar
            </button>
          </div>
        ) : null}
      </div>

      {/* Board */}
      {loading ? (
        <div className="flex gap-3 overflow-x-auto pb-3">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-[420px] w-72 shrink-0" />
          ))}
        </div>
      ) : stages.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
          Sem etapas configuradas. Contacta o administrador do workspace.
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
        >
          <div className="flex gap-3 overflow-x-auto pb-3">
            {stages.map((stage) => (
              <KanbanColumn
                key={stage.id}
                stage={stage}
                deals={dealsByStage[stage.id] ?? []}
                onOpenDeal={(d) => setOpenDealId(d.id)}
                onQuickAdd={openQuickAdd}
              />
            ))}
          </div>

          <DragOverlay>
            {activeDeal ? (
              <div className="w-[16rem] rotate-1 cursor-grabbing">
                <DealCardPreview deal={activeDeal} />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      )}

      {/* Drawer */}
      <DealDrawer
        workspaceId={workspaceId}
        deal={openDeal ?? null}
        stages={stages}
        onClose={() => setOpenDealId(null)}
        onUpdated={handleDealUpdated}
        onDeleted={handleDealDeleted}
      />

      {/* New deal dialog */}
      <NewDealDialog
        open={newDealOpen}
        onClose={() => setNewDealOpen(false)}
        workspaceId={workspaceId}
        stages={stages}
        defaultStageId={newDealDefaultStageId}
        onCreated={handleDealCreated}
      />
    </div>
  );
}
