import Link from 'next/link';
import { redirect } from 'next/navigation';
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
import { PauseSequenceButton } from './[id]/pause-sequence-button';

export const metadata = {
  title: 'Outreach — AngoConnect',
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

const PT_DATE = new Intl.DateTimeFormat('pt-PT', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
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

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return PT_DATE.format(d);
}

function stepsCount(steps: SequenceStep[] | null): number {
  if (!steps || !Array.isArray(steps)) return 0;
  return steps.length;
}

export default async function OutreachPage() {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // Cast via overrideTypes porque a tabela `sequences` ainda não está nos
  // tipos gerados (regeneração pendente — ver Decisões em aberto no CLAUDE.md).
  const { data: sequences } = await supabase
    .from('sequences')
    .select('id, name, status, steps, created_at')
    .order('created_at', { ascending: false })
    .overrideTypes<SequenceRow[], { merge: false }>();

  const rows: SequenceRow[] = sequences ?? [];

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Sequências de outreach
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Cria e gere campanhas de email e WhatsApp para os teus contactos.
          </p>
        </div>
        <Link href="/outreach/new">
          <Button>Nova sequência</Button>
        </Link>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-card p-10 text-center">
          <h2 className="text-base font-semibold">
            Ainda não tens sequências
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Cria a tua primeira sequência para começar a contactar leads de
            forma automatizada.
          </p>
          <div className="mt-6 flex justify-center">
            <Link href="/outreach/new">
              <Button>Criar primeira sequência</Button>
            </Link>
          </div>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {rows.map((seq) => {
            const total = stepsCount(seq.steps);
            return (
              <Card key={seq.id}>
                <CardHeader>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <CardDescription>
                        Criada em {formatDate(seq.created_at)}
                      </CardDescription>
                      <CardTitle className="mt-1 truncate">
                        {seq.name}
                      </CardTitle>
                    </div>
                    <Badge variant={STATUS_VARIANT[seq.status]}>
                      {STATUS_LABEL[seq.status]}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  <p className="text-sm text-muted-foreground">
                    {total} {total === 1 ? 'passo' : 'passos'}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Link href={`/outreach/${seq.id}`}>
                      <Button variant="outline" size="sm">
                        Ver
                      </Button>
                    </Link>
                    <Link href={`/outreach/${seq.id}/edit`}>
                      <Button variant="outline" size="sm">
                        Editar
                      </Button>
                    </Link>
                    {seq.status === 'active' ? (
                      <PauseSequenceButton sequenceId={seq.id} />
                    ) : null}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
