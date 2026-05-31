'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Trash2, Send, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { TableCell, TableRow } from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export type WhatsAppTemplateStatus =
  | 'draft'
  | 'pending'
  | 'approved'
  | 'rejected'
  | string;

export interface WhatsAppTemplate {
  id: string;
  workspace_id: string;
  meta_template_name: string;
  language: string;
  category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION' | string;
  status: WhatsAppTemplateStatus;
  body: string;
  header_format?: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | null;
  header_text?: string | null;
  footer?: string | null;
  buttons?: unknown;
  created_at?: string;
}

interface CreateOrUpdateResponse {
  data?: WhatsAppTemplate;
  error?: { code?: string; message?: string };
}

interface ErrorResponse {
  error?: { code?: string; message?: string };
}

const STATUS_VARIANT: Record<
  string,
  'default' | 'secondary' | 'success' | 'warning' | 'destructive' | 'outline'
> = {
  draft: 'secondary',
  pending: 'warning',
  approved: 'success',
  rejected: 'destructive',
};

const STATUS_LABEL: Record<string, string> = {
  draft: 'Rascunho',
  pending: 'Pendente Meta',
  approved: 'Aprovado',
  rejected: 'Rejeitado',
};

const CATEGORY_LABEL: Record<string, string> = {
  MARKETING: 'Marketing',
  UTILITY: 'Utilitário',
  AUTHENTICATION: 'Autenticação',
};

// ---------------------------------------------------------------------------
// Panel namespace (NewButton + Row)
// ---------------------------------------------------------------------------

interface NewButtonProps {
  workspaceId: string;
  disabled?: boolean;
}

function NewButton({ workspaceId, disabled }: NewButtonProps) {
  const [open, setOpen] = React.useState(false);
  const router = useRouter();

  return (
    <>
      <Button
        size="sm"
        onClick={() => setOpen(true)}
        disabled={disabled}
        title={disabled ? 'Configura primeiro a tua conta WhatsApp' : undefined}
      >
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        Novo template
      </Button>
      <TemplateFormDialog
        open={open}
        onOpenChange={setOpen}
        workspaceId={workspaceId}
        template={null}
        onSaved={() => {
          setOpen(false);
          router.refresh();
        }}
      />
    </>
  );
}

interface RowProps {
  workspaceId: string;
  template: WhatsAppTemplate;
}

function Row({ workspaceId, template }: RowProps) {
  const router = useRouter();
  const [editing, setEditing] = React.useState(false);
  const [submitting, setSubmitting] = React.useState<null | 'submit' | 'delete'>(
    null
  );
  const [error, setError] = React.useState<string | null>(null);

  async function submitToMeta() {
    if (submitting) return;
    setSubmitting('submit');
    setError(null);
    try {
      const res = await fetch(`/api/whatsapp/templates/${template.id}/submit`, {
        method: 'POST',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as ErrorResponse;
        setError(body.error?.message ?? 'Não foi possível enviar para a Meta.');
        setSubmitting(null);
        return;
      }
      setSubmitting(null);
      router.refresh();
    } catch {
      setError('Erro de rede.');
      setSubmitting(null);
    }
  }

  async function deleteTemplate() {
    if (submitting) return;
    setSubmitting('delete');
    setError(null);
    try {
      const res = await fetch(`/api/whatsapp/templates/${template.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as ErrorResponse;
        setError(body.error?.message ?? 'Não foi possível apagar.');
        setSubmitting(null);
        return;
      }
      setSubmitting(null);
      router.refresh();
    } catch {
      setError('Erro de rede.');
      setSubmitting(null);
    }
  }

  return (
    <>
      <TableRow>
        <TableCell className="font-medium">
          {template.meta_template_name}
        </TableCell>
        <TableCell>
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
            {template.language}
          </code>
        </TableCell>
        <TableCell>
          {CATEGORY_LABEL[template.category] ?? template.category}
        </TableCell>
        <TableCell>
          <Badge variant={STATUS_VARIANT[template.status] ?? 'secondary'}>
            {STATUS_LABEL[template.status] ?? template.status}
          </Badge>
        </TableCell>
        <TableCell className="text-right">
          <div className="flex items-center justify-end gap-1">
            {template.status === 'draft' ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setEditing(true)}
                  aria-label="Editar template"
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={submitToMeta}
                  disabled={submitting !== null}
                >
                  {submitting === 'submit' ? (
                    <Spinner />
                  ) : (
                    <Send className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  Submeter
                </Button>
              </>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              onClick={deleteTemplate}
              disabled={submitting !== null}
              aria-label="Apagar template"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              {submitting === 'delete' ? (
                <Spinner />
              ) : (
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              )}
            </Button>
          </div>
          {error ? (
            <p className="mt-1 text-right text-xs text-destructive">{error}</p>
          ) : null}
        </TableCell>
      </TableRow>

      <TemplateFormDialog
        open={editing}
        onOpenChange={setEditing}
        workspaceId={workspaceId}
        template={template}
        onSaved={() => {
          setEditing(false);
          router.refresh();
        }}
      />
    </>
  );
}

export const WhatsAppTemplatesPanel = {
  NewButton,
  Row,
};

// ---------------------------------------------------------------------------
// TemplateFormDialog — criar/editar
// ---------------------------------------------------------------------------

interface TemplateFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  template: WhatsAppTemplate | null;
  onSaved: () => void;
}

function TemplateFormDialog({
  open,
  onOpenChange,
  workspaceId,
  template,
  onSaved,
}: TemplateFormDialogProps) {
  const isEditing = template !== null;

  const [name, setName] = React.useState(template?.meta_template_name ?? '');
  const [language, setLanguage] = React.useState(template?.language ?? 'pt_PT');
  const [category, setCategory] = React.useState<string>(
    template?.category ?? 'MARKETING'
  );
  const [body, setBody] = React.useState(template?.body ?? '');
  const [headerFormat, setHeaderFormat] = React.useState<string>(
    template?.header_format ?? 'NONE'
  );
  const [headerText, setHeaderText] = React.useState(template?.header_text ?? '');
  const [footer, setFooter] = React.useState(template?.footer ?? '');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Sincroniza quando o template mudar (editar diferente row).
  React.useEffect(() => {
    if (!open) return;
    setName(template?.meta_template_name ?? '');
    setLanguage(template?.language ?? 'pt_PT');
    setCategory(template?.category ?? 'MARKETING');
    setBody(template?.body ?? '');
    setHeaderFormat(template?.header_format ?? 'NONE');
    setHeaderText(template?.header_text ?? '');
    setFooter(template?.footer ?? '');
    setError(null);
  }, [open, template]);

  function validate(): string | null {
    if (name.trim().length < 3) return 'Nome tem de ter pelo menos 3 caracteres.';
    if (!/^[a-z0-9_]+$/.test(name.trim())) {
      return 'Nome só pode ter letras minúsculas, números e underscores.';
    }
    if (body.trim().length < 5) return 'O corpo tem de ter pelo menos 5 caracteres.';
    if (body.length > 1024) return 'O corpo excede 1024 caracteres.';
    if (headerFormat === 'TEXT' && headerText.length > 60) {
      return 'Cabeçalho de texto limitado a 60 caracteres.';
    }
    if (footer.length > 60) return 'Rodapé limitado a 60 caracteres.';
    return null;
  }

  async function handleSubmit(e?: React.FormEvent | React.MouseEvent) {
    e?.preventDefault();
    if (submitting) return;
    const err = validate();
    if (err) {
      setError(err);
      return;
    }
    setSubmitting(true);
    setError(null);

    try {
      const payload: Record<string, unknown> = {
        workspaceId,
        meta_template_name: name.trim(),
        language,
        category,
        body,
      };
      if (headerFormat !== 'NONE') {
        payload.header_format = headerFormat;
        if (headerFormat === 'TEXT' && headerText.trim()) {
          payload.header_text = headerText.trim();
        }
      }
      if (footer.trim()) payload.footer = footer.trim();

      const url = isEditing
        ? `/api/whatsapp/templates/${template?.id}`
        : '/api/whatsapp/templates';
      const method = isEditing ? 'PATCH' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await res
        .json()
        .catch(() => ({}))) as CreateOrUpdateResponse;
      if (!res.ok || !data.data) {
        setError(data.error?.message ?? 'Não foi possível guardar o template.');
        setSubmitting(false);
        return;
      }
      onSaved();
      setSubmitting(false);
    } catch {
      setError('Erro de rede.');
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent widthClassName="w-full max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? 'Editar template' : 'Novo template WhatsApp'}
          </DialogTitle>
          <DialogDescription>
            O template fica em estado <strong>Rascunho</strong> até o submeteres
            para aprovação da Meta. Usa <code className="rounded bg-muted px-1">{'{{1}}'}</code>,{' '}
            <code className="rounded bg-muted px-1">{'{{2}}'}</code> para
            variáveis posicionais.
          </DialogDescription>
        </DialogHeader>

        <form className="flex flex-col gap-4 px-6 py-4" onSubmit={handleSubmit}>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="wat-name">
                Nome (Meta) <span className="text-destructive">*</span>
              </Label>
              <Input
                id="wat-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="welcome_intro_v1"
                disabled={isEditing}
              />
              <p className="text-[11px] text-muted-foreground">
                Apenas minúsculas, dígitos e underscores. Imutável após
                aprovação.
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="wat-lang">Idioma</Label>
              <Select
                id="wat-lang"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
              >
                <option value="pt_PT">Português (PT)</option>
                <option value="pt_BR">Português (BR)</option>
                <option value="en_US">Inglês (US)</option>
                <option value="es_ES">Espanhol (ES)</option>
              </Select>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="wat-category">Categoria</Label>
            <Select
              id="wat-category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="MARKETING">Marketing</option>
              <option value="UTILITY">Utilitário</option>
              <option value="AUTHENTICATION">Autenticação</option>
            </Select>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="wat-header-format">Cabeçalho</Label>
              <Select
                id="wat-header-format"
                value={headerFormat}
                onChange={(e) => setHeaderFormat(e.target.value)}
              >
                <option value="NONE">Sem cabeçalho</option>
                <option value="TEXT">Texto</option>
                <option value="IMAGE">Imagem</option>
                <option value="VIDEO">Vídeo</option>
                <option value="DOCUMENT">Documento</option>
              </Select>
            </div>
            {headerFormat === 'TEXT' ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="wat-header-text">Texto do cabeçalho</Label>
                <Input
                  id="wat-header-text"
                  value={headerText}
                  onChange={(e) => setHeaderText(e.target.value)}
                  maxLength={60}
                  placeholder="Olá {{1}}!"
                />
                <p className="text-[11px] text-muted-foreground">
                  {headerText.length}/60
                </p>
              </div>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="wat-body">
              Corpo <span className="text-destructive">*</span>
            </Label>
            <Textarea
              id="wat-body"
              rows={6}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              maxLength={1024}
              placeholder="Olá {{1}}, obrigado pelo teu contacto. Em {{2}} a nossa equipa entra em contacto."
            />
            <p className="text-[11px] text-muted-foreground">
              {body.length}/1024
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="wat-footer">Rodapé (opcional)</Label>
            <Input
              id="wat-footer"
              value={footer}
              onChange={(e) => setFooter(e.target.value)}
              maxLength={60}
              placeholder="AngoConnect"
            />
          </div>

          {error ? (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
            >
              {error}
            </div>
          ) : null}
        </form>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancelar
          </Button>
          <Button onClick={(e) => handleSubmit(e)} disabled={submitting}>
            {submitting ? <Spinner /> : null}
            {submitting ? 'A guardar…' : isEditing ? 'Guardar' : 'Criar rascunho'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
