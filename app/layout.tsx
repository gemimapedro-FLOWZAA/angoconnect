import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AngoConnect',
  description: 'Plataforma de prospecção comercial B2B para Angola',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt">
      <body>{children}</body>
    </html>
  );
}
