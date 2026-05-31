import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SpinnerProps extends React.SVGAttributes<SVGSVGElement> {
  size?: number;
}

const Spinner = React.forwardRef<SVGSVGElement, SpinnerProps>(
  ({ className, size = 16, ...props }, ref) => {
    return (
      <Loader2
        ref={ref}
        width={size}
        height={size}
        className={cn('animate-spin text-current', className)}
        aria-hidden="true"
        {...props}
      />
    );
  }
);
Spinner.displayName = 'Spinner';

export { Spinner };
