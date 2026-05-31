'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

type SheetSide = 'right' | 'left';

interface SheetContextValue {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const SheetContext = React.createContext<SheetContextValue | null>(null);

function useSheet() {
  const ctx = React.useContext(SheetContext);
  if (!ctx) throw new Error('Componente Sheet usado fora de <Sheet>.');
  return ctx;
}

export interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}

/**
 * Drawer lateral hand-rolled. Render via React.createPortal para
 * o `document.body`. Click-outside e tecla `Escape` fecham o sheet.
 */
function Sheet({ open, onOpenChange, children }: SheetProps) {
  return (
    <SheetContext.Provider value={{ open, onOpenChange }}>
      {children}
    </SheetContext.Provider>
  );
}

export interface SheetTriggerProps {
  children: React.ReactElement;
}

/**
 * Wrapper que adiciona `onClick` ao filho para abrir o Sheet. Como toda a
 * gestão é controlada (Sheet recebe `open`), este componente é opcional.
 */
function SheetTrigger({ children }: SheetTriggerProps) {
  const { onOpenChange } = useSheet();
  return React.cloneElement(children, {
    onClick: (e: React.MouseEvent) => {
      children.props.onClick?.(e);
      if (!e.defaultPrevented) onOpenChange(true);
    },
  });
}

export interface SheetContentProps extends React.HTMLAttributes<HTMLDivElement> {
  side?: SheetSide;
  /** Largura customizada (default: max-w-md, ~448px). */
  widthClassName?: string;
  /** Esconde o botão "X" no canto. */
  hideCloseButton?: boolean;
  children: React.ReactNode;
}

function SheetContent({
  side = 'right',
  widthClassName = 'w-full sm:max-w-xl',
  hideCloseButton = false,
  className,
  children,
  ...props
}: SheetContentProps) {
  const { open, onOpenChange } = useSheet();
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  React.useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onOpenChange]);

  React.useEffect(() => {
    if (!open) return;
    // Bloqueia scroll do body enquanto o sheet está aberto.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!mounted || !open) return null;

  const sideClasses =
    side === 'right'
      ? 'right-0 top-0 h-full border-l animate-in-from-right'
      : 'left-0 top-0 h-full border-r animate-in-from-left';

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex"
      role="dialog"
      aria-modal="true"
    >
      <button
        type="button"
        aria-label="Fechar"
        onClick={() => onOpenChange(false)}
        className="absolute inset-0 cursor-default bg-black/40 backdrop-blur-[1px]"
      />
      <div
        {...props}
        className={cn(
          'absolute flex flex-col bg-card text-card-foreground border-border shadow-xl',
          'transition-transform duration-200 ease-out',
          sideClasses,
          widthClassName,
          className
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {!hideCloseButton ? (
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label="Fechar painel"
            className="absolute right-3 top-3 z-10 inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
        {children}
      </div>
    </div>,
    document.body
  );
}

const SheetHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      'flex shrink-0 flex-col gap-1.5 border-b border-border px-6 py-4 pr-12',
      className
    )}
    {...props}
  />
));
SheetHeader.displayName = 'SheetHeader';

const SheetTitle = React.forwardRef<
  HTMLHeadingElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h2
    ref={ref}
    className={cn('text-base font-semibold tracking-tight', className)}
    {...props}
  />
));
SheetTitle.displayName = 'SheetTitle';

const SheetDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p
    ref={ref}
    className={cn('text-sm text-muted-foreground', className)}
    {...props}
  />
));
SheetDescription.displayName = 'SheetDescription';

const SheetFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      'flex shrink-0 flex-col gap-2 border-t border-border bg-card px-6 py-4 sm:flex-row sm:items-center sm:justify-end',
      className
    )}
    {...props}
  />
));
SheetFooter.displayName = 'SheetFooter';

export {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
};
