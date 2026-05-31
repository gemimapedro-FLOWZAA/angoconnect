'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

type NavItem = {
  label: string;
  href: string;
  /** Se `false`, o item aparece como "em breve" e não navega. */
  enabled: boolean;
};

const NAV_ITEMS: readonly NavItem[] = [
  { label: 'Pesquisar', href: '/search', enabled: true },
  { label: 'Outreach', href: '/outreach', enabled: true },
  { label: 'CRM', href: '/crm', enabled: true },
  { label: 'Analytics', href: '/analytics', enabled: true },
  { label: 'Faturação', href: '/billing', enabled: true },
  { label: 'Definições', href: '/settings/whatsapp', enabled: true },
];

export function DashboardNav() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-1">
      {NAV_ITEMS.map((item) => {
        const isActive =
          item.enabled &&
          (pathname === item.href || pathname.startsWith(`${item.href}/`));

        if (!item.enabled) {
          return (
            <span
              key={item.href}
              aria-disabled="true"
              className="cursor-not-allowed rounded-md px-3 py-2 text-sm font-medium text-muted-foreground/60"
            >
              {item.label}
              <span className="ml-2 text-[10px] uppercase">em breve</span>
            </span>
          );
        }

        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'rounded-md px-3 py-2 text-sm font-medium transition-colors',
              isActive
                ? 'bg-accent text-accent-foreground'
                : 'text-foreground hover:bg-accent hover:text-accent-foreground'
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
