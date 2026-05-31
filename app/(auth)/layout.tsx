import Link from 'next/link';

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-muted/40 px-4 py-12 sm:px-6 lg:px-8">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <Link
            href="/"
            className="inline-block text-2xl font-bold tracking-tight text-foreground"
          >
            AngoConnect
          </Link>
          <p className="mt-2 text-sm text-muted-foreground">
            Prospecção comercial B2B em Angola
          </p>
        </div>
        {children}
      </div>
    </main>
  );
}
