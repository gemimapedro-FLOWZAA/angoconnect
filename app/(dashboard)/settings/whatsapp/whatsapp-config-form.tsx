'use client';

import * as React from 'react';
import { Copy, Check, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';

// View "safe" do config — sem access_token.
export interface WhatsAppConfigView {
  workspace_id: string;
  waba_id: string;
  phone_number_id: string;
  phone_number: string;
  webhook_url: string | null;
  webhook_verify_token: string | null;
  created_at?: string;
  updated_at?: string;
}

interface ConfigResponse {
  data?: WhatsAppConfigView;
  error?: { code?: string; message?: string };
}

interface ErrorResponse {
  error?: { code?: string; message?: string };
}

export interface WhatsAppConfigFormProps {
  workspaceId: string;
  initialConfig: WhatsAppConfigView | null;
}

export function WhatsAppConfigForm({
  workspaceId,
  initialConfig,
}: WhatsAppConfigFormProps) {
  const [config, setConfig] = React.useState<WhatsAppConfigView | null>(
    initialConfig
  );

  if (config) {
    return (
      <ConnectedView
        workspaceId={workspaceId}
        config={config}
        onDisconnected={() => setConfig(null)}
      />
    );
  }

  return (
    <OnboardingForm
      workspaceId={workspaceId}
      onConnected={(c) => setConfig(c)}
    />
  );
}

// ---------------------------------------------------------------------------
// Onboarding form
// ---------------------------------------------------------------------------

function OnboardingForm({
  workspaceId,
  onConnected,
}: {
  workspaceId: string;
  onConnected: (config: WhatsAppConfigView) => void;
}) {
  const [wabaId, setWabaId] = React.useState('');
  const [phoneNumberId, setPhoneNumberId] = React.useState('');
  const [phoneNumber, setPhoneNumber] = React.useState('');
  const [accessToken, setAccessToken] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    if (!wabaId.trim() || !phoneNumberId.trim() || !phoneNumber.trim() || !accessToken.trim()) {
      setError('Preenche todos os campos.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/whatsapp/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          waba_id: wabaId.trim(),
          phone_number_id: phoneNumberId.trim(),
          phone_number: phoneNumber.trim(),
          access_token: accessToken.trim(),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as ConfigResponse;
      if (!res.ok || !body.data) {
        setError(body.error?.message ?? 'Não foi possível guardar a configuração.');
        setSubmitting(false);
        return;
      }
      onConnected(body.data);
      setSubmitting(false);
    } catch {
      setError('Erro de rede. Tenta novamente.');
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-4 rounded-md border border-border bg-card p-5"
    >
      <p className="text-sm text-muted-foreground">
        Encontras estes valores no painel da Meta Business em{' '}
        <a
          href="https://business.facebook.com/wa/manage/"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-0.5 text-primary hover:underline"
        >
          WhatsApp Manager <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </a>
        .
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="wa-waba">WABA ID</Label>
          <Input
            id="wa-waba"
            value={wabaId}
            onChange={(e) => setWabaId(e.target.value)}
            placeholder="123456789012345"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="wa-phone-id">Phone Number ID</Label>
          <Input
            id="wa-phone-id"
            value={phoneNumberId}
            onChange={(e) => setPhoneNumberId(e.target.value)}
            placeholder="987654321098765"
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="wa-phone">Número de telefone</Label>
          <Input
            id="wa-phone"
            value={phoneNumber}
            onChange={(e) => setPhoneNumber(e.target.value)}
            placeholder="+244 923 000 000"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="wa-token">Access Token</Label>
          <Input
            id="wa-token"
            type="password"
            value={accessToken}
            onChange={(e) => setAccessToken(e.target.value)}
            placeholder="EAAB…"
            autoComplete="off"
          />
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

      <div className="flex items-center justify-end gap-2">
        <Button type="submit" disabled={submitting}>
          {submitting ? <Spinner /> : null}
          {submitting ? 'A conectar…' : 'Conectar'}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Connected view
// ---------------------------------------------------------------------------

function ConnectedView({
  workspaceId,
  config,
  onDisconnected,
}: {
  workspaceId: string;
  config: WhatsAppConfigView;
  onDisconnected: () => void;
}) {
  const [deleting, setDeleting] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function handleDisconnect() {
    if (deleting) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/whatsapp/config?workspaceId=${encodeURIComponent(workspaceId)}`,
        { method: 'DELETE' }
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as ErrorResponse;
        setError(body.error?.message ?? 'Não foi possível desconectar.');
        setDeleting(false);
        return;
      }
      onDisconnected();
      setDeleting(false);
    } catch {
      setError('Erro de rede.');
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 rounded-md border border-border bg-card p-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <FieldRow label="WABA ID" value={config.waba_id} mono />
        <FieldRow label="Phone Number ID" value={config.phone_number_id} mono />
        <FieldRow label="Número" value={config.phone_number} mono />
      </div>

      <div className="flex flex-col gap-3 rounded-md border border-border bg-muted/30 p-4">
        <p className="text-sm font-semibold">Configuração da Meta App</p>
        <p className="text-xs text-muted-foreground">
          Cola os valores abaixo no painel da Meta em Webhooks → WhatsApp para
          começares a receber eventos.
        </p>
        <CopyRow
          label="Webhook URL"
          value={config.webhook_url ?? '(em geração)'}
        />
        <CopyRow
          label="Verify Token"
          value={config.webhook_verify_token ?? '(em geração)'}
          isSecret
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

      <div className="flex items-center justify-end gap-2">
        {confirmDelete ? (
          <>
            <p className="mr-auto text-sm text-destructive">
              Tens a certeza? Os templates ficam, mas o envio fica suspenso.
            </p>
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
              onClick={handleDisconnect}
              disabled={deleting}
            >
              {deleting ? <Spinner /> : null}
              Confirmar desconexão
            </Button>
          </>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirmDelete(true)}
          >
            Desconectar
          </Button>
        )}
      </div>
    </div>
  );
}

function FieldRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className={mono ? 'font-mono text-sm' : 'text-sm'}>{value}</span>
    </div>
  );
}

function CopyRow({
  label,
  value,
  isSecret = false,
}: {
  label: string;
  value: string;
  isSecret?: boolean;
}) {
  const [copied, setCopied] = React.useState(false);
  const [revealed, setRevealed] = React.useState(!isSecret);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Silencioso.
    }
  }

  const display = revealed ? value : '•'.repeat(Math.min(24, value.length));

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-32 text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <code className="flex-1 truncate rounded bg-background px-2 py-1 font-mono text-xs">
        {display}
      </code>
      {isSecret ? (
        <button
          type="button"
          onClick={() => setRevealed((r) => !r)}
          className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
        >
          {revealed ? 'Ocultar' : 'Mostrar'}
        </button>
      ) : null}
      <button
        type="button"
        onClick={handleCopy}
        className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
      >
        {copied ? (
          <Check className="h-3 w-3" aria-hidden="true" />
        ) : (
          <Copy className="h-3 w-3" aria-hidden="true" />
        )}
        {copied ? 'Copiado' : 'Copiar'}
      </button>
    </div>
  );
}
