'use client';

import * as React from 'react';
import { Check, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface CheckboxProps {
  /** Estado controlado: true, false, ou 'indeterminate' (estilo "tri-state"). */
  checked: boolean | 'indeterminate';
  /** Callback executado quando o estado muda. */
  onCheckedChange: (checked: boolean) => void;
  /** Label opcional renderizado à direita da checkbox. */
  label?: React.ReactNode;
  /** Texto auxiliar adicional (descrição por baixo). */
  description?: React.ReactNode;
  disabled?: boolean;
  id?: string;
  /** aria-label quando não há label visível. */
  'aria-label'?: string;
  className?: string;
  /** Classes aplicadas apenas ao quadrado da checkbox (sem afectar o wrapper). */
  boxClassName?: string;
}

/**
 * Checkbox controlada hand-rolled (sem Radix). Suporta o estado
 * "indeterminate" — útil para selects de cabeçalho de tabela ("alguns
 * seleccionados").
 */
const Checkbox = React.forwardRef<HTMLButtonElement, CheckboxProps>(
  (
    {
      checked,
      onCheckedChange,
      label,
      description,
      disabled = false,
      id,
      className,
      boxClassName,
      'aria-label': ariaLabel,
    },
    ref
  ) => {
    const isChecked = checked === true;
    const isIndeterminate = checked === 'indeterminate';
    const ariaChecked: 'true' | 'false' | 'mixed' = isIndeterminate
      ? 'mixed'
      : isChecked
        ? 'true'
        : 'false';

    function toggle() {
      if (disabled) return;
      // Indeterminate → marcar; marcado → desmarcar; desmarcado → marcar.
      onCheckedChange(!isChecked);
    }

    const button = (
      <button
        ref={ref}
        type="button"
        role="checkbox"
        id={id}
        aria-checked={ariaChecked}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            toggle();
          }
        }}
        className={cn(
          'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-input bg-background ring-offset-background transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          'disabled:cursor-not-allowed disabled:opacity-50',
          (isChecked || isIndeterminate) &&
            'border-primary bg-primary text-primary-foreground',
          boxClassName
        )}
      >
        {isChecked && !isIndeterminate ? (
          <Check className="h-3 w-3" strokeWidth={3} aria-hidden="true" />
        ) : null}
        {isIndeterminate ? (
          <Minus className="h-3 w-3" strokeWidth={3} aria-hidden="true" />
        ) : null}
      </button>
    );

    if (!label && !description) {
      return <span className={cn('inline-flex', className)}>{button}</span>;
    }

    return (
      <label
        htmlFor={id}
        className={cn(
          'inline-flex cursor-pointer items-start gap-2 select-none',
          disabled && 'cursor-not-allowed opacity-60',
          className
        )}
      >
        {button}
        <span className="flex flex-col text-left">
          {label ? (
            <span className="text-sm font-medium leading-tight text-foreground">
              {label}
            </span>
          ) : null}
          {description ? (
            <span className="text-xs text-muted-foreground">{description}</span>
          ) : null}
        </span>
      </label>
    );
  }
);
Checkbox.displayName = 'Checkbox';

export { Checkbox };
