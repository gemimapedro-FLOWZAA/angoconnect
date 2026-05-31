import * as React from 'react';
import { cn } from '@/lib/utils';

export interface SeparatorProps extends React.HTMLAttributes<HTMLHRElement> {
  orientation?: 'horizontal' | 'vertical';
}

/**
 * `<hr>` estilizado (orientação horizontal) ou `<div>` fininho (orientação
 * vertical). Hand-rolled, sem dependências de Radix.
 */
const Separator = React.forwardRef<HTMLHRElement, SeparatorProps>(
  ({ className, orientation = 'horizontal', ...props }, ref) => {
    if (orientation === 'vertical') {
      return (
        <div
          role="separator"
          aria-orientation="vertical"
          className={cn('h-full w-px shrink-0 bg-border', className)}
        />
      );
    }
    return (
      <hr
        ref={ref}
        role="separator"
        aria-orientation="horizontal"
        className={cn(
          'h-px w-full shrink-0 border-0 bg-border',
          className
        )}
        {...props}
      />
    );
  }
);
Separator.displayName = 'Separator';

export { Separator };
