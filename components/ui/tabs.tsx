'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Tabs hand-rolled (sem Radix). API minimalista controlled-only — o pai
 * mantém o `value` em state e responde a `onValueChange`. Suporte de teclado
 * básico: setas esquerda/direita movem entre triggers.
 */

interface TabsContextValue {
  value: string;
  onValueChange: (value: string) => void;
  /**
   * Registo de triggers para navegação por teclado. O valor é a ordem em que
   * o trigger foi montado. Permite que ArrowRight/ArrowLeft saltem para o
   * próximo trigger sem dependerem do DOM real (mais robusto que querySelector).
   */
  registerTrigger: (value: string) => void;
  triggers: string[];
}

const TabsContext = React.createContext<TabsContextValue | null>(null);

function useTabsContext(): TabsContextValue {
  const ctx = React.useContext(TabsContext);
  if (!ctx) throw new Error('Componente Tabs usado fora de <Tabs>.');
  return ctx;
}

export interface TabsProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string;
  onValueChange: (value: string) => void;
  children: React.ReactNode;
}

function Tabs({
  value,
  onValueChange,
  className,
  children,
  ...props
}: TabsProps) {
  const [triggers, setTriggers] = React.useState<string[]>([]);

  const registerTrigger = React.useCallback((triggerValue: string) => {
    setTriggers((prev) => {
      if (prev.includes(triggerValue)) return prev;
      return [...prev, triggerValue];
    });
  }, []);

  const ctx = React.useMemo<TabsContextValue>(
    () => ({ value, onValueChange, registerTrigger, triggers }),
    [value, onValueChange, registerTrigger, triggers]
  );

  return (
    <TabsContext.Provider value={ctx}>
      <div className={cn('flex flex-col gap-2', className)} {...props}>
        {children}
      </div>
    </TabsContext.Provider>
  );
}

export interface TabsListProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

function TabsList({ className, children, ...props }: TabsListProps) {
  return (
    <div
      role="tablist"
      className={cn(
        'inline-flex h-9 items-center justify-center gap-1 rounded-md bg-muted p-1 text-muted-foreground',
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export interface TabsTriggerProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  value: string;
  children: React.ReactNode;
}

function TabsTrigger({
  value,
  className,
  children,
  disabled,
  ...props
}: TabsTriggerProps) {
  const ctx = useTabsContext();
  const isActive = ctx.value === value;

  React.useEffect(() => {
    ctx.registerTrigger(value);
  }, [ctx, value]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const idx = ctx.triggers.indexOf(value);
    if (idx === -1) return;
    const nextIdx =
      e.key === 'ArrowRight'
        ? (idx + 1) % ctx.triggers.length
        : (idx - 1 + ctx.triggers.length) % ctx.triggers.length;
    const nextValue = ctx.triggers[nextIdx];
    if (nextValue) ctx.onValueChange(nextValue);
  }

  return (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      data-state={isActive ? 'active' : 'inactive'}
      disabled={disabled}
      onClick={() => ctx.onValueChange(value)}
      onKeyDown={handleKeyDown}
      className={cn(
        'inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1 text-sm font-medium ring-offset-background transition-all',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        'disabled:pointer-events-none disabled:opacity-50',
        isActive
          ? 'bg-background text-foreground shadow-sm'
          : 'hover:text-foreground',
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export interface TabsContentProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string;
  children: React.ReactNode;
  /** Quando true, mantém o conteúdo montado mesmo quando inactivo (display:none). */
  forceMount?: boolean;
}

function TabsContent({
  value,
  className,
  children,
  forceMount = false,
  ...props
}: TabsContentProps) {
  const ctx = useTabsContext();
  const isActive = ctx.value === value;

  if (!isActive && !forceMount) return null;

  return (
    <div
      role="tabpanel"
      data-state={isActive ? 'active' : 'inactive'}
      hidden={!isActive}
      className={cn(
        'mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
