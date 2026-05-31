import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { WhatsAppConfigForm, type WhatsAppConfigView } from './whatsapp-config-form';
import { WhatsAppTemplatesPanel, type WhatsAppTemplate } from './whatsapp-template-form';

export const metadata = {
  title: 'WhatsApp Business — AngoConnect',
};

interface WorkspaceRow {
  id: string;
  name: string;
}

interface ConfigResponse {
  data?: WhatsAppConfigView | null;
  error?: { code?: string; message?: string };
}

interface TemplatesResponse {
  data?: WhatsAppTemplate[];
  error?: { code?: string; message?: string };
}

// Server Components não têm acesso ao header request, mas o endpoint é
// chamado server-side a partir do mesmo runtime — fazemos fetch absoluto
// com a base URL recolhida do header (via Next.js convenções).
async function fetchConfig(
  baseUrl: string,
  workspaceId: string,
  cookie: string
): Promise<WhatsAppConfigView | null> {
  try {
    const res = await fetch(
      `${baseUrl}/api/whatsapp/config?workspaceId=${encodeURIComponent(workspaceId)}`,
      {
        cache: 'no-store',
        headers: { cookie },
      }
    );
    if (!res.ok) return null;
    const body = (await res.json()) as ConfigResponse;
    return body.data ?? null;
  } catch {
    return null;
  }
}

async function fetchTemplates(
  baseUrl: string,
  workspaceId: string,
  cookie: string
): Promise<WhatsAppTemplate[]> {
  try {
    const res = await fetch(
      `${baseUrl}/api/whatsapp/templates?workspaceId=${encodeURIComponent(workspaceId)}`,
      {
        cache: 'no-store',
        headers: { cookie },
      }
    );
    if (!res.ok) return [];
    const body = (await res.json()) as TemplatesResponse;
    return body.data ?? [];
  } catch {
    return [];
  }
}

export default async function WhatsAppSettingsPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: workspace } = await supabase
    .from('workspaces')
    .select('id, name')
    .limit(1)
    .maybeSingle()
    .overrideTypes<WorkspaceRow | null, { merge: false }>();

  if (!workspace) redirect('/onboarding');

  // Para chamar internamente as nossas próprias API Routes precisamos da
  // baseUrl + cookies do request. Em produção (Vercel) a env
  // NEXT_PUBLIC_APP_URL deve estar definida; em dev caímos no localhost.
  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const cookie = headers().get('cookie') ?? '';

  const [config, templates] = await Promise.all([
    fetchConfig(baseUrl, workspace.id, cookie),
    fetchTemplates(baseUrl, workspace.id, cookie),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight">WhatsApp Business</h1>
        <p className="text-sm text-muted-foreground">
          Liga a tua conta Meta WhatsApp Business e gere os templates aprovados
          para envio.
        </p>
      </header>

      {/* Estado da configuração */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Configuração</h2>
          {config ? (
            <Badge variant="success">Conectado</Badge>
          ) : (
            <Badge variant="secondary">Não configurado</Badge>
          )}
        </div>
        <WhatsAppConfigForm
          workspaceId={workspace.id}
          initialConfig={config}
        />
      </section>

      {/* Templates */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className="flex flex-col gap-0.5">
            <h2 className="text-lg font-semibold">Templates</h2>
            <p className="text-xs text-muted-foreground">
              Templates são necessários para iniciar conversas WhatsApp fora da
              janela de 24h.
            </p>
          </div>
          <WhatsAppTemplatesPanel.NewButton
            workspaceId={workspace.id}
            disabled={!config}
          />
        </div>

        {!config ? (
          <div className="rounded-md border border-dashed border-border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
            Configura primeiro a tua conta WhatsApp em cima para criar
            templates.
          </div>
        ) : templates.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            Ainda não tens templates. Cria o primeiro com o botão acima.
          </div>
        ) : (
          <div className="rounded-md border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nome (Meta)</TableHead>
                  <TableHead>Idioma</TableHead>
                  <TableHead>Categoria</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead className="text-right">Acções</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {templates.map((t) => (
                  <WhatsAppTemplatesPanel.Row
                    key={t.id}
                    workspaceId={workspace.id}
                    template={t}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}
