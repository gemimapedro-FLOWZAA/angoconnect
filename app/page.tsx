import Link from 'next/link';

const valueBullets = [
  {
    title: 'Catálogo de empresas verificadas',
    description:
      'Acesso a dados actualizados de empresas angolanas — sector, província, dimensão e decisores.',
  },
  {
    title: 'Outreach automatizado',
    description:
      'Sequências multi-canal com email e WhatsApp Business, templates em português e tracking completo.',
  },
  {
    title: 'CRM integrado',
    description:
      'Pipeline visual de oportunidades, follow-ups e analytics — tudo num só lugar.',
  },
];

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col bg-background">
      <header className="border-b border-border">
        <div className="container flex h-16 items-center justify-between">
          <Link href="/" className="text-lg font-bold tracking-tight">
            AngoConnect
          </Link>
          <nav className="flex items-center gap-3">
            <Link
              href="/login"
              className="rounded-md px-3 py-2 text-sm font-medium text-foreground hover:bg-accent"
            >
              Entrar
            </Link>
            <Link
              href="/signup"
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Criar conta grátis
            </Link>
          </nav>
        </div>
      </header>

      <section className="container flex flex-1 flex-col items-center justify-center py-16 text-center">
        <h1 className="max-w-3xl text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl">
          A tua plataforma de prospecção B2B em Angola
        </h1>
        <p className="mt-6 max-w-2xl text-base text-muted-foreground sm:text-lg">
          Descobre empresas angolanas, contacta os decisores certos e fecha mais
          negócios — com dados verificados e outreach automatizado.
        </p>

        <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row">
          <Link
            href="/signup"
            className="inline-flex h-11 items-center justify-center rounded-md bg-primary px-8 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Criar conta grátis
          </Link>
          <Link
            href="/login"
            className="inline-flex h-11 items-center justify-center rounded-md border border-input bg-background px-8 text-sm font-medium hover:bg-accent"
          >
            Entrar
          </Link>
        </div>

        <ul className="mt-16 grid w-full max-w-5xl gap-6 text-left sm:grid-cols-3">
          {valueBullets.map((bullet) => (
            <li
              key={bullet.title}
              className="rounded-lg border border-border bg-card p-6 shadow-sm"
            >
              <h2 className="text-base font-semibold">{bullet.title}</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                {bullet.description}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <footer className="border-t border-border">
        <div className="container flex h-14 items-center justify-between text-xs text-muted-foreground">
          <span>© {new Date().getFullYear()} AngoConnect</span>
          <span>Luanda, Angola</span>
        </div>
      </footer>
    </main>
  );
}
