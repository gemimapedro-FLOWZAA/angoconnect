import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Placeholder visual com pulso suave. Usar enquanto se aguarda dados
 * assíncronos. O consumidor controla o tamanho via className (`h-…`, `w-…`).
 */
const Skeleton = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => {
    return (
      <div
        ref={ref}
        aria-hidden="true"
        className={cn('animate-pulse rounded-md bg-muted/60', className)}
        {...props}
      />
    );
  }
);
Skeleton.displayName = 'Skeleton';

export { Skeleton };
