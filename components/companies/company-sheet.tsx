'use client';

import * as React from 'react';
import {
  Building2,
  ExternalLink,
  Globe,
  Linkedin,
  Mail,
  Phone,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { RevealContactButton } from './reveal-contact-button';
import {
  formatDate,
  formatPhone,
  initials,
  maskEmail,
  maskPhone,
} from '@/lib/format';
import { cn } from '@/lib/utils';

type Tab = 'contacts' | 'details';

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

const SOURCE_LABELS: Record<string, string> = {
  irgc: 'IRGC',
  linkedin: 'LinkedIn',
  bue: 'BUE',
  news: 'Notícias',
  manual: 'Manual',
};

const SOURCE_CLASSES: Record<string, string> = {
  irgc: 'bg-blue-100 text-blue-800 border-blue-200',
  linkedin: 'bg-sky-100 text-sky-800 border-sky-200',
  bue: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  news: 'bg-amber-100 text-amber-800 border-amber-200',
  manual: 'bg-zinc-100 text-zinc-700 border-zinc-200',
};

export interface SheetCompany {
  id: string;
  name: string;
  nif: string | null;
  sector: string | null;
  provincia: string | null;
  size: string | null;
  website: string | null;
  source: string;
  created_at?: string;
  extra?: Record<string, unknown> | null;
  workspace_id?: string | null;
}

export interface SheetContact {
  id: string;
  name: string | null;
  title: string | null;
  email: string | null;
  phone: string | null;
  linkedin_url: string | null;
  confidence_score: number | null;
  is_revealed: boolean;
  reveal_cost?: number;
  /** Marca contactos que vieram do workspace privado (não custam revelar). */
  is_private?: boolean;
}

interface CompanyDetailsResponse {
  data?: {
    company: SheetCompany;
    contacts_count: number;
    revealed_count: number;
    is_in_catalog: boolean;
  };
  error?: { code?: string; message?: string };
}

interface ContactsResponse {
  data?: SheetContact[];
  meta?: { total: number; page: number; pageSize: number; totalPages: number };
  error?: { code?: string; message?: string };
}

export interface CompanySheetProps {
  workspaceId: string;
  /** Quando null, o sheet está fechado. */
  companyId: string | null;
  onClose: () => void;
  /** Abre o dialog de export para sequência com o id desta empresa. */
  onAddToSequence: (companyId: string) => void;
  /** Propagar mudança de saldo para o header (opcional). */
  onBalanceChange?: (newBalance: number) => void;
}

function SourceBadge({ source }: { source: string }) {
  const label = SOURCE_LABELS[source] ?? source;
  const classes = SOURCE_CLASSES[source] ?? SOURCE_CLASSES.manual;
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
        classes
      )}
    >
      {label}
    </span>
  );
}

export function CompanySheet({
  workspaceId,
  companyId,
  onClose,
  onAddToSequence,
  onBalanceChange,
}: CompanySheetProps) {
  const [tab, setTab] = React.useState<Tab>('contacts');
  const [details, setDetails] =
    React.useState<CompanyDetailsResponse['data'] | null>(null);
  const [contacts, setContacts] = React.useState<SheetContact[]>([]);
  const [loadingDetails, setLoadingDetails] = React.useState(false);
  const [loadingContacts, setLoadingContacts] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const open = companyId !== null;

  // Reset quando muda o companyId
  React.useEffect(() => {
    if (!companyId) {
      setDetails(null);
      setContacts([]);
      setTab('contacts');
      setError(null);
      return;
    }

    let cancelled = false;

    async function loadAll() {
      setLoadingDetails(true);
      setLoadingContacts(true);
      setError(null);

      try {
        const [detailsRes, contactsRes] = await Promise.all([
          fetch(
            `/api/companies/${companyId}?workspaceId=${encodeURIComponent(workspaceId)}`
          ),
          fetch(
            `/api/companies/${companyId}/contacts?workspaceId=${encodeURIComponent(workspaceId)}&page=1&pageSize=50`
          ),
        ]);

        const detailsBody = (await detailsRes
          .json()
          .catch(() => ({}))) as CompanyDetailsResponse;
        const contactsBody = (await contactsRes
          .json()
          .catch(() => ({}))) as ContactsResponse;

        if (cancelled) return;

        if (!detailsRes.ok || !detailsBody.data) {
          setError(
            detailsBody.error?.message ?? 'Não foi possível carregar a empresa.'
          );
        } else {
          setDetails(detailsBody.data);
        }

        if (!contactsRes.ok) {
          // Erro de contactos é menos crítico — empresa pode ainda mostrar-se.
          setContacts([]);
        } else {
          setContacts(contactsBody.data ?? []);
        }
      } catch {
        if (!cancelled) {
          setError('Erro de rede. Tenta novamente.');
        }
      } finally {
        if (!cancelled) {
          setLoadingDetails(false);
          setLoadingContacts(false);
        }
      }
    }

    loadAll();
    return () => {
      cancelled = true;
    };
  }, [companyId, workspaceId]);

  function applyRevealed(contactId: string) {
    setContacts((prev) =>
      prev.map((c) => (c.id === contactId ? { ...c, is_revealed: true } : c))
    );
  }

  const company = details?.company;
  const isPublic = company?.workspace_id == null;

  return (
    <Sheet open={open} onOpenChange={(v) => (!v ? onClose() : null)}>
      <SheetContent widthClassName="w-full sm:max-w-xl">
        <SheetHeader>
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <SheetTitle className="truncate">
                {loadingDetails && !company
                  ? 'A carregar...'
                  : (company?.name ?? 'Empresa')}
              </SheetTitle>
              {company ? <SourceBadge source={company.source} /> : null}
              {company ? (
                <Badge variant={isPublic ? 'outline' : 'secondary'}>
                  {isPublic ? 'Catálogo público' : 'Privada do workspace'}
                </Badge>
              ) : null}
            </div>
            {company ? (
              <SheetDescription>
                {[
                  company.sector
                    ? (SECTOR_LABELS[company.sector] ?? company.sector)
                    : null,
                  company.provincia,
                  company.size,
                ]
                  .filter(Boolean)
                  .join(' · ') || '—'}
              </SheetDescription>
            ) : null}
          </div>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto">
          {error ? (
            <div className="px-6 py-6 text-sm text-destructive" role="alert">
              {error}
            </div>
          ) : null}

          {company ? (
            <>
              {/* Sub-header com NIF + website */}
              <div className="grid gap-3 border-b border-border bg-muted/30 px-6 py-3 text-xs sm:grid-cols-2">
                <div className="flex flex-col gap-0.5">
                  <span className="text-muted-foreground">NIF</span>
                  <span className="font-mono">{company.nif ?? '—'}</span>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-muted-foreground">Website</span>
                  {company.website ? (
                    <a
                      href={
                        company.website.startsWith('http')
                          ? company.website
                          : `https://${company.website}`
                      }
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex items-center gap-1 truncate text-primary hover:underline"
                    >
                      <Globe className="h-3 w-3" />
                      {company.website}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  ) : (
                    <span>—</span>
                  )}
                </div>
                {details ? (
                  <>
                    <div className="flex flex-col gap-0.5">
                      <span className="text-muted-foreground">Contactos</span>
                      <span>{details.contacts_count}</span>
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <span className="text-muted-foreground">Revelados</span>
                      <span>{details.revealed_count}</span>
                    </div>
                  </>
                ) : null}
                {company.created_at ? (
                  <div className="flex flex-col gap-0.5 sm:col-span-2">
                    <span className="text-muted-foreground">Adicionada em</span>
                    <span>{formatDate(company.created_at)}</span>
                  </div>
                ) : null}
              </div>

              {/* Tabs */}
              <div className="flex border-b border-border bg-card">
                <button
                  type="button"
                  onClick={() => setTab('contacts')}
                  className={cn(
                    'border-b-2 px-6 py-2 text-sm font-medium transition-colors',
                    tab === 'contacts'
                      ? 'border-primary text-foreground'
                      : 'border-transparent text-muted-foreground hover:text-foreground'
                  )}
                >
                  Contactos
                </button>
                <button
                  type="button"
                  onClick={() => setTab('details')}
                  className={cn(
                    'border-b-2 px-6 py-2 text-sm font-medium transition-colors',
                    tab === 'details'
                      ? 'border-primary text-foreground'
                      : 'border-transparent text-muted-foreground hover:text-foreground'
                  )}
                >
                  Detalhes
                </button>
              </div>

              {tab === 'contacts' ? (
                <div className="flex flex-col">
                  {loadingContacts && contacts.length === 0 ? (
                    <div className="flex items-center justify-center gap-2 px-6 py-10 text-sm text-muted-foreground">
                      <Spinner /> A carregar contactos…
                    </div>
                  ) : contacts.length === 0 ? (
                    <div className="px-6 py-10 text-center text-sm text-muted-foreground">
                      <Building2 className="mx-auto mb-2 h-6 w-6 opacity-60" />
                      Esta empresa ainda não tem contactos.
                    </div>
                  ) : (
                    <ul className="divide-y divide-border">
                      {contacts.map((contact) => (
                        <li
                          key={contact.id}
                          className="flex flex-col gap-2 px-6 py-3"
                        >
                          <div className="flex items-start gap-3">
                            <span
                              aria-hidden="true"
                              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground"
                            >
                              {initials(contact.name)}
                            </span>
                            <div className="flex flex-1 flex-col gap-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-medium leading-tight">
                                  {contact.name ?? 'Sem nome'}
                                </span>
                                {contact.is_revealed ? (
                                  <Badge variant="success">Revelado</Badge>
                                ) : contact.is_private ? (
                                  <Badge variant="secondary">Privado</Badge>
                                ) : (
                                  <Badge variant="outline">Catálogo</Badge>
                                )}
                                {typeof contact.confidence_score ===
                                'number' ? (
                                  <span className="text-xs text-muted-foreground">
                                    Confiança{' '}
                                    {Math.round(contact.confidence_score * 100)}%
                                  </span>
                                ) : null}
                              </div>
                              {contact.title ? (
                                <span className="text-xs text-muted-foreground">
                                  {contact.title}
                                </span>
                              ) : null}

                              <div className="mt-1 flex flex-col gap-1 text-xs">
                                <div className="flex items-center gap-2">
                                  <Mail className="h-3 w-3 text-muted-foreground" />
                                  <span
                                    className={cn(
                                      'font-mono',
                                      !contact.is_revealed &&
                                        'text-muted-foreground'
                                    )}
                                  >
                                    {contact.is_revealed
                                      ? (contact.email ?? '—')
                                      : maskEmail(contact.email)}
                                  </span>
                                </div>
                                <div className="flex items-center gap-2">
                                  <Phone className="h-3 w-3 text-muted-foreground" />
                                  <span
                                    className={cn(
                                      'font-mono',
                                      !contact.is_revealed &&
                                        'text-muted-foreground'
                                    )}
                                  >
                                    {contact.is_revealed
                                      ? formatPhone(contact.phone)
                                      : maskPhone(contact.phone)}
                                  </span>
                                </div>
                                {contact.linkedin_url ? (
                                  <a
                                    href={contact.linkedin_url}
                                    target="_blank"
                                    rel="noreferrer noopener"
                                    className="inline-flex items-center gap-1 text-primary hover:underline"
                                  >
                                    <Linkedin className="h-3 w-3" />
                                    LinkedIn
                                    <ExternalLink className="h-3 w-3" />
                                  </a>
                                ) : null}
                              </div>
                            </div>

                            <div className="shrink-0">
                              {contact.is_revealed ? (
                                <Badge variant="success">Revelado</Badge>
                              ) : (
                                <RevealContactButton
                                  workspaceId={workspaceId}
                                  contactId={contact.id}
                                  cost={contact.reveal_cost ?? 1}
                                  onRevealed={() => applyRevealed(contact.id)}
                                  onBalanceChange={onBalanceChange}
                                />
                              )}
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : null}

              {tab === 'details' ? (
                <div className="px-6 py-4">
                  <p className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
                    Dados brutos (debug)
                  </p>
                  <pre className="max-h-[60vh] overflow-auto rounded-md bg-muted/40 p-3 text-[11px] leading-relaxed">
                    {JSON.stringify(company.extra ?? {}, null, 2)}
                  </pre>
                </div>
              ) : null}
            </>
          ) : loadingDetails ? (
            <div className="flex items-center justify-center gap-2 px-6 py-10 text-sm text-muted-foreground">
              <Spinner /> A carregar empresa…
            </div>
          ) : null}
        </div>

        <SheetFooter>
          <Button variant="outline" onClick={onClose}>
            Fechar
          </Button>
          <Button
            disabled={!company}
            onClick={() => company && onAddToSequence(company.id)}
          >
            Adicionar à sequência
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
