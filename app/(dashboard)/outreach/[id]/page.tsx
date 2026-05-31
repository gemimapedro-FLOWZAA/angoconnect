import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PauseSequenceButton } from './pause-sequence-button';

export const metadata = {
  title: 'Detalhe de sequência — AngoConnect',
};

type SequenceStatus = 'draft' | 'active' | 'paused' | 'archived';

type SequenceStep = {
  day_offset?: number;
  channel?: 'email' | 'whatsapp';
  subject?: string;
  body?: string;
};

type SequenceRow = {
  id: string;
  name: string;
  status: SequenceStatus;
  steps: SequenceStep[] | null;
  created_at: string;
};

type EnrolmentRow = {
  contact_id: string;
  sequence_id: string;
  current_step: number;
  status: string;
  scheduled_at: string | null;
};

const PT_DATE = new Intl.DateTimeFormat('pt-PT', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

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

const PAGE_SIZE = 50;

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return PT_DATE.format(d);
}

export default async function SequenceDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: sequence } = await supabase
    .from('sequences')
    .select('id, name, status, steps, created_at')
    .eq('id', params.id)
    .maybeSingle()
    .overrideTypes<SequenceRow, { merge: false }>();

  if (!sequence) notFound();

  const { data: enrolmentsData } = await supabase
    .from('sequence_enrollments')
    .select('contact_id, sequence_id, current_step, status, scheduled_at')
    .eq('sequence_id', params.id)
    .order('scheduled_at', { ascending: true, nullsFirst: false })
    .limit(PAGE_SIZE)
    .overrideTypes<EnrolmentRow[], { merge: false }>();

  const enrolments: EnrolmentRow[] = enrolmentsData ?? [];

  // Métricas placeholder — agregação real fica para M3.3 Analytics.
  const metrics = {
    enrolled: enrolments.length,
    opened: 0,
    replied: 0,
  };

  const steps: SequenceStep[] = Array.isArray(sequence.steps)
    ? sequence.steps
    : [];

  const isActive = sequence.status === 'active';
  const isPaused = sequence.status === 'paused';

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Link
            href="/outreach"
            className="text-xs text-muted-foreground hover:underline"
          >
            ← Voltar a sequências
          </Link>
          <div className="mt-1 flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight truncate">
              {sequence.name}
            </h1>
            <Badge variant={STATUS_VARIANT[sequence.status]}>
              {STATUS_LABEL[sequence.status]}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Criada em {formatDate(sequence.created_at)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={`/outreach/${sequence.id}/edit`}>
            <Button variant="outline">Editar</Button>
          </Link>
          <Button variant="outline" disabled title="Em breve">
            Adicionar contactos
          </Button>
          {isActive ? (
            <PauseSequenceButton
              sequenceId={sequence.id}
              action="pause"
              size="default"
            />
          ) : null}
          {isPaused ? (
            <PauseSequenceButton
              sequenceId={sequence.id}
              action="activate"
              variant="default"
              size="default"
            />
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription>Inscritos</CardDescription>
            <CardTitle className="mt-1">{metrics.enrolled}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Aberturas</CardDescription>
            <CardTitle className="mt-1">{metrics.opened}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Respostas</CardDescription>
            <CardTitle className="mt-1">{metrics.replied}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <div className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold tracking-tight">Passos</h2>
        {steps.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Esta sequência ainda não tem passos.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {steps.map((step, index) => (
              <Card key={index}>
                <CardHeader>
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <CardDescription>
                        Passo {index + 1} · Dia {step.day_offset ?? 0}
                      </CardDescription>
                      <CardTitle className="mt-1 text-base">
                        {step.subject ?? '(sem assunto)'}
                      </CardTitle>
                    </div>
                    <Badge variant="outline">
                      {step.channel === 'whatsapp' ? 'WhatsApp' : 'Email'}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                    {step.body ?? ''}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold tracking-tight">Inscritos</h2>
        {enrolments.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Ainda não há contactos inscritos nesta sequência.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="min-w-full divide-y divide-border text-sm">
              <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Contacto</th>
                  <th className="px-3 py-2">Passo</th>
                  <th className="px-3 py-2">Estado</th>
                  <th className="px-3 py-2">Próximo envio</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {enrolments.map((e) => (
                  <tr key={e.contact_id}>
                    <td className="px-3 py-2 font-mono text-xs">
                      {e.contact_id.slice(0, 8)}…
                    </td>
                    <td className="px-3 py-2">{e.current_step}</td>
                    <td className="px-3 py-2">
                      <Badge variant="outline">{e.status}</Badge>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {formatDate(e.scheduled_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {enrolments.length === PAGE_SIZE ? (
              <p className="border-t border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                A mostrar os primeiros {PAGE_SIZE}. Paginação completa em M3.2.
              </p>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
