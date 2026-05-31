import Link from 'next/link';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
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

export const metadata = {
  title: 'Biblioteca de templates — AngoConnect',
};

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
  meta?: unknown;
  error?: { code?: string; message?: string };
}

const CATEGORY_LABEL: Record<string, string> = {
  intro: 'Intro',
  follow_up: 'Follow-up',
  break_up: 'Break-up',
  meeting: 'Reunião',
  outros: 'Outros',
};

async function fetchTemplates(workspaceId: string): Promise<{
  data: Template[];
  error: string | null;
}> {
  try {
    const h = headers();
    const host = h.get('host');
    const proto = h.get('x-forwarded-proto') ?? 'http';
    const origin = host ? `${proto}://${host}` : '';
    const url = `${origin}/api/templates?workspaceId=${encodeURIComponent(
      workspaceId
    )}&includeSystem=true`;
    const res = await fetch(url, {
      // Reencaminha cookies para a API (server-to-server precisa do JWT).
      headers: {
        cookie: h.get('cookie') ?? '',
      },
      cache: 'no-store',
    });
    const body = (await res.json().catch(() => ({}))) as TemplatesResponse;
    if (!res.ok || !body.data) {
      return {
        data: [],
        error: body.error?.message ?? 'Não foi possível carregar templates.',
      };
    }
    return { data: body.data, error: null };
  } catch {
    return { data: [], error: 'Erro de rede a carregar templates.' };
  }
}

export default async function TemplatesPage() {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: workspace } = await supabase
    .from('workspaces')
    .select('id')
    .limit(1)
    .maybeSingle()
    .overrideTypes<{ id: string } | null, { merge: false }>();

  if (!workspace) redirect('/onboarding');

  const { data: templates, error } = await fetchTemplates(workspace.id);

  // Agrupa por categoria para apresentação.
  const grouped = templates.reduce<Record<string, Template[]>>((acc, t) => {
    const key = t.category || 'outros';
    if (!acc[key]) acc[key] = [];
    acc[key].push(t);
    return acc;
  }, {});

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link
            href="/outreach"
            className="text-xs text-muted-foreground hover:underline"
          >
            ← Voltar a sequências
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            Biblioteca de templates
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Templates de email pré-prontos em PT-AO. Aplica-os a partir do
            Outreach Builder em qualquer passo.
          </p>
        </div>
        <Button disabled title="Em breve">
          Criar template
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

      {templates.length === 0 && !error ? (
        <div className="rounded-lg border border-dashed border-border bg-card p-10 text-center">
          <h2 className="text-base font-semibold">
            Ainda não há templates
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Quando o sistema disponibilizar templates de fábrica, vão aparecer
            aqui. Também poderás criar os teus.
          </p>
        </div>
      ) : null}

      {Object.entries(grouped).map(([category, items]) => (
        <section key={category} className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold tracking-tight">
            {CATEGORY_LABEL[category] ?? category}
          </h2>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {items.map((t) => (
              <Card key={t.id}>
                <CardHeader>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <CardDescription>
                        {t.language.toUpperCase()}
                        {t.is_system ? ' · Sistema' : ''}
                      </CardDescription>
                      <CardTitle className="mt-1 truncate text-base">
                        {t.name}
                      </CardTitle>
                    </div>
                    {t.is_system ? (
                      <Badge variant="outline">Padrão</Badge>
                    ) : (
                      <Badge variant="secondary">Workspace</Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Assunto
                  </p>
                  <p className="line-clamp-1 text-sm">{t.subject}</p>
                  <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Corpo
                  </p>
                  <p className="line-clamp-3 whitespace-pre-wrap text-sm text-muted-foreground">
                    {t.body}
                  </p>
                  {t.variables.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {t.variables.slice(0, 6).map((v) => (
                        <Badge
                          key={v}
                          variant="outline"
                          className="font-mono text-[10px]"
                        >
                          {`{{${v}}}`}
                        </Badge>
                      ))}
                      {t.variables.length > 6 ? (
                        <Badge variant="outline" className="text-[10px]">
                          +{t.variables.length - 6}
                        </Badge>
                      ) : null}
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
