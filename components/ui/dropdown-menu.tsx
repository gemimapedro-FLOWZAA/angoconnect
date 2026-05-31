'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * DropdownMenu hand-rolled (sem Radix). Suficiente para menus simples de
 * acções (Edit/Delete/Apply template). Click fora ou tecla Escape fecham.
 */

interface DropdownMenuContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  triggerRef: React.MutableRefObject<HTMLButtonElement | null>;
  contentRef: React.MutableRefObject<HTMLDivElement | null>;
}

const DropdownMenuContext = React.createContext<DropdownMenuContextValue | null>(
  null
);

function useDropdownMenu(): DropdownMenuContextValue {
  const ctx = React.useContext(DropdownMenuContext);
  if (!ctx) throw new Error('Componente usado fora de <DropdownMenu>.');
  return ctx;
}

export interface DropdownMenuProps {
  children: React.ReactNode;
  /** Opcional: torna o componente controlado pelo pai. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

function DropdownMenu({
  children,
  open: openProp,
  onOpenChange,
}: DropdownMenuProps) {
  const [internalOpen, setInternalOpen] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const contentRef = React.useRef<HTMLDivElement | null>(null);

  const isControlled = openProp !== undefined;
  const open = isControlled ? openProp : internalOpen;

  const setOpen = React.useCallback(
    (next: boolean) => {
      if (!isControlled) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [isControlled, onOpenChange]
  );

  // Click-outside + Escape
  React.useEffect(() => {
    if (!open) return;

    function handlePointerDown(e: MouseEvent | TouchEvent) {
      const target = e.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target)) return;
      if (contentRef.current?.contains(target)) return;
      setOpen(false);
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, setOpen]);

  const ctx = React.useMemo<DropdownMenuContextValue>(
    () => ({ open, setOpen, triggerRef, contentRef }),
    [open, setOpen]
  );

  return (
    <DropdownMenuContext.Provider value={ctx}>
      <div className="relative inline-block">{children}</div>
    </DropdownMenuContext.Provider>
  );
}

export interface DropdownMenuTriggerProps {
  /** Single React element para clonar. */
  asChild?: boolean;
  children: React.ReactElement;
}

function DropdownMenuTrigger({ children, asChild = true }: DropdownMenuTriggerProps) {
  const { open, setOpen, triggerRef } = useDropdownMenu();

  if (asChild) {
    type ChildProps = {
      ref?:
        | React.RefCallback<HTMLButtonElement>
        | React.MutableRefObject<HTMLButtonElement | null>
        | null;
      onClick?: React.MouseEventHandler<HTMLButtonElement>;
    };
    const childProps = children.props as ChildProps;

    const mergedProps = {
      ref: (node: HTMLButtonElement | null) => {
        triggerRef.current = node;
        const originalRef = childProps.ref;
        if (typeof originalRef === 'function') originalRef(node);
        else if (originalRef && typeof originalRef === 'object') {
          originalRef.current = node;
        }
      },
      'aria-haspopup': 'menu' as const,
      'aria-expanded': open,
      onClick: (e: React.MouseEvent<HTMLButtonElement>) => {
        childProps.onClick?.(e);
        if (!e.defaultPrevented) setOpen(!open);
      },
    };

    // React.cloneElement aceita props parciais; o cast assegura que TS não
    // exige que coincidam exactamente com o tipo do elemento original.
    return React.cloneElement(
      children,
      mergedProps as React.HTMLAttributes<HTMLButtonElement>
    );
  }

  return (
    <button
      type="button"
      ref={triggerRef}
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={() => setOpen(!open)}
    >
      {children}
    </button>
  );
}

export type DropdownMenuAlign = 'start' | 'end';

export interface DropdownMenuContentProps
  extends React.HTMLAttributes<HTMLDivElement> {
  align?: DropdownMenuAlign;
  /** sideOffset em pixels (gap entre o trigger e o conteúdo). */
  sideOffset?: number;
  children: React.ReactNode;
}

function DropdownMenuContent({
  align = 'start',
  sideOffset = 4,
  className,
  children,
  style,
  ...props
}: DropdownMenuContentProps) {
  const { open, contentRef } = useDropdownMenu();

  if (!open) return null;

  return (
    <div
      ref={contentRef}
      role="menu"
      style={{ marginTop: sideOffset, ...style }}
      className={cn(
        'absolute z-50 min-w-[12rem] overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md',
        'top-full',
        align === 'end' ? 'right-0' : 'left-0',
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export interface DropdownMenuItemProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Quando true, fecha o menu automaticamente após o click. */
  closeOnSelect?: boolean;
}

function DropdownMenuItem({
  className,
  onClick,
  closeOnSelect = true,
  children,
  disabled,
  ...props
}: DropdownMenuItemProps) {
  const { setOpen } = useDropdownMenu();
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={(e) => {
        onClick?.(e);
        if (!e.defaultPrevented && closeOnSelect) setOpen(false);
      }}
      className={cn(
        'relative flex w-full cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors',
        'hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground',
        'disabled:pointer-events-none disabled:opacity-50',
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="separator"
      className={cn('-mx-1 my-1 h-px bg-border', className)}
      {...props}
    />
  );
}

function DropdownMenuLabel({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'px-2 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground',
        className
      )}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
};
