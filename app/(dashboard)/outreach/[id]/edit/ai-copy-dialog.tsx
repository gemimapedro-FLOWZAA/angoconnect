'use client';

import * as React from 'react';
import { Copy, Sparkles, Wand2, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Spinner } from '@/components/ui/spinner';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import type { StepChannel } from './sequence-builder';

// ---------------------------------------------------------------------------
// Tipos do contrato POST /api/ai/generate-copy
// ---------------------------------------------------------------------------

type Tone = 'profissional' | 'amistoso' | 'urgente';

interface AiContext {
  companyName?: string;
  sector?: string;
  provincia?: string;
  recipientName?: string;
  recipientTitle?: string;
  senderName?: string;
  senderCompany?: string;
  sequenceGoal: string;
  previousMessage?: string;
  tone?: Tone;
}

interface AiVariant {
  subject?: string;
  body: string;
}

interface GenerateCopyResponse {
  data?: { variants: AiVariant[] };
  error?: { code?: string; message?: string };
}

// Defaults passados pelo builder — todos opcionais.
export interface AiContextDefaults {
  companyName?: string;
  sector?: string;
  provincia?: string;
  recipientName?: string;
  recipientTitle?: string;
  senderName?: string;
  senderCompany?: string;
}

export interface AiCopyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  channel: StepChannel;
  /** Defaults para pré-preencher o formulário. */
  contextDefaults?: AiContextDefaults;
  /** Devolve a variante seleccionada ao builder para aplicar ao step. */
  onApply: (variant: AiVariant) => void;
}

const TONE_LABEL: Record<Tone, string> = {
  profissional: 'Profissional',
  amistoso: 'Amistoso',
  urgente: 'Urgente',
};

export function AiCopyDialog({
  open,
  onOpenChange,
  workspaceId,
  channel,
  contextDefaults,
  onApply,
}: AiCopyDialogProps) {
  const [sequenceGoal, setSequenceGoal] = React.useState('');
  const [recipientTitle, setRecipientTitle] = React.useState(
    contextDefaults?.recipientTitle ?? ''
  );
  const [senderName, setSenderName] = React.useState(
    contextDefaults?.senderName ?? ''
  );
  const [senderCompany, setSenderCompany] = React.useState(
    contextDefaults?.senderCompany ?? ''
  );
  const [tone, setTone] = React.useState<Tone>('profissional');
  const [previousMessage, setPreviousMessage] = React.useState('');

  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [variants, setVariants] = React.useState<AiVariant[]>([]);
  const [selectedVariantIdx, setSelectedVariantIdx] = React.useState<string>('0');
  const [copiedIdx, setCopiedIdx] = React.useState<number | null>(null);

  // Quando reabre, repõe defaults vindos do builder (caso o nome do
  // workspace tenha mudado entretanto).
  React.useEffect(() => {
    if (!open) return;
    setRecipientTitle(contextDefaults?.recipientTitle ?? '');
    setSenderName(contextDefaults?.senderName ?? '');
    setSenderCompany(contextDefaults?.senderCompany ?? '');
    setError(null);
    setCopiedIdx(null);
    // Mantemos variants/sequenceGoal entre aberturas para o utilizador
    // não perder o trabalho se fechar por engano.
  }, [open, contextDefaults]);

  async function handleGenerate() {
    if (loading) return;
    const goal = sequenceGoal.trim();
    if (goal.length < 4) {
      setError('Descreve o objectivo da sequência (mínimo 4 caracteres).');
      return;
    }
    setError(null);
    setLoading(true);

    const context: AiContext = {
      companyName: contextDefaults?.companyName,
      sector: contextDefaults?.sector,
      provincia: contextDefaults?.provincia,
      recipientName: contextDefaults?.recipientName,
      recipientTitle: recipientTitle.trim() || undefined,
      senderName: senderName.trim() || undefined,
      senderCompany: senderCompany.trim() || undefined,
      sequenceGoal: goal,
      previousMessage: previousMessage.trim() || undefined,
      tone,
    };

    try {
      const res = await fetch('/api/ai/generate-copy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          channel,
          context,
          variantCount: 3,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as GenerateCopyResponse;
      if (!res.ok || !body.data) {
        setError(
          body.error?.message ?? 'Não foi possível gerar copy. Tenta de novo.'
        );
        setLoading(false);
        return;
      }
      const list = body.data.variants ?? [];
      setVariants(list);
      setSelectedVariantIdx('0');
      setLoading(false);
    } catch {
      setError('Erro de rede. Verifica a tua ligação e tenta novamente.');
      setLoading(false);
    }
  }

  async function handleCopy(variant: AiVariant, idx: number) {
    const text = channel === 'email' && variant.subject
      ? `${variant.subject}\n\n${variant.body}`
      : variant.body;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIdx(idx);
      window.setTimeout(() => setCopiedIdx((cur) => (cur === idx ? null : cur)), 1500);
    } catch {
      // Silencioso — alguns browsers bloqueiam clipboard se a permissão falhar.
    }
  }

  function handleUseVariant(variant: AiVariant) {
    onApply(variant);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent widthClassName="w-full max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" aria-hidden="true" />
            Sugerir copy com IA
          </DialogTitle>
          <DialogDescription>
            Descreve o objectivo e a IA gera 3 variantes adaptadas ao mercado
            angolano. Canal:{' '}
            <Badge variant="outline" className="ml-1 align-middle">
              {channel === 'email' ? 'Email' : 'WhatsApp'}
            </Badge>
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 px-6 py-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ai-goal">
              Objectivo da sequência <span className="text-destructive">*</span>
            </Label>
            <Input
              id="ai-goal"
              placeholder='Ex: "agendar uma demo de 15 min"'
              value={sequenceGoal}
              onChange={(e) => setSequenceGoal(e.target.value)}
              autoFocus
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ai-recipient-title">Cargo do destinatário</Label>
              <Input
                id="ai-recipient-title"
                placeholder="Ex: Director Comercial"
                value={recipientTitle}
                onChange={(e) => setRecipientTitle(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ai-tone">Tom</Label>
              <Select
                id="ai-tone"
                value={tone}
                onChange={(e) => setTone(e.target.value as Tone)}
              >
                {(['profissional', 'amistoso', 'urgente'] as const).map((t) => (
                  <option key={t} value={t}>
                    {TONE_LABEL[t]}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ai-sender">Nome do remetente</Label>
              <Input
                id="ai-sender"
                placeholder="O teu nome"
                value={senderName}
                onChange={(e) => setSenderName(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ai-sender-company">Empresa do remetente</Label>
              <Input
                id="ai-sender-company"
                placeholder="Nome da tua empresa"
                value={senderCompany}
                onChange={(e) => setSenderCompany(e.target.value)}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ai-previous">
              Mensagem anterior (opcional, para follow-ups)
            </Label>
            <Textarea
              id="ai-previous"
              rows={3}
              placeholder="Cola aqui a última mensagem que enviaste, se for um follow-up."
              value={previousMessage}
              onChange={(e) => setPreviousMessage(e.target.value)}
            />
          </div>

          <div className="flex items-center justify-end">
            <Button onClick={handleGenerate} disabled={loading}>
              {loading ? <Spinner /> : <Wand2 className="h-3.5 w-3.5" aria-hidden="true" />}
              {loading ? 'A gerar…' : 'Gerar 3 variantes'}
            </Button>
          </div>

          {error ? (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
            >
              {error}
            </div>
          ) : null}

          {variants.length > 0 ? (
            <div className="border-t border-border pt-4">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Variantes geradas
              </p>
              <Tabs
                value={selectedVariantIdx}
                onValueChange={(v) => setSelectedVariantIdx(v)}
              >
                <TabsList>
                  {variants.map((_, i) => (
                    <TabsTrigger key={i} value={String(i)}>
                      Variante {i + 1}
                    </TabsTrigger>
                  ))}
                </TabsList>
                {variants.map((variant, i) => (
                  <TabsContent key={i} value={String(i)}>
                    <div className="flex flex-col gap-3 rounded-md border border-border bg-card p-4">
                      {channel === 'email' && variant.subject ? (
                        <div>
                          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                            Assunto
                          </p>
                          <p className="text-sm font-semibold">
                            {variant.subject}
                          </p>
                        </div>
                      ) : null}
                      <div>
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          Corpo
                        </p>
                        <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">
                          {variant.body}
                        </pre>
                      </div>
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleCopy(variant, i)}
                        >
                          {copiedIdx === i ? (
                            <Check className="h-3.5 w-3.5" aria-hidden="true" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                          )}
                          {copiedIdx === i ? 'Copiado' : 'Copiar'}
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => handleUseVariant(variant)}
                        >
                          Usar este
                        </Button>
                      </div>
                    </div>
                  </TabsContent>
                ))}
              </Tabs>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Fechar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
