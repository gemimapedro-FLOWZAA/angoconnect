import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Timeline visual primitive — uma vertical line à esquerda + bolinha por evento,
 * com slot para ícone, título, timestamp e descrição. Sem dependências externas.
 *
 * Uso típico:
 *   <Timeline>
 *     <TimelineItem icon={<X/>} title="…" timestamp="…">…</TimelineItem>
 *   </Timeline>
 */

const Timeline = React.forwardRef<
  HTMLOListElement,
  React.HTMLAttributes<HTMLOListElement>
>(({ className, ...props }, ref) => (
  <ol
    ref={ref}
    className={cn('relative flex flex-col gap-4 border-l border-border pl-6', className)}
    {...props}
  />
));
Timeline.displayName = 'Timeline';

export interface TimelineItemProps
  extends Omit<React.HTMLAttributes<HTMLLIElement>, 'title'> {
  /** Ícone à esquerda (substitui a bolinha default). */
  icon?: React.ReactNode;
  /** Título da linha (sempre visível). */
  title: React.ReactNode;
  /** Timestamp já formatado pelo consumidor. */
  timestamp?: React.ReactNode;
  /** Cor de fundo do marker (Tailwind class — ex: 'bg-emerald-500'). */
  markerClassName?: string;
}

const TimelineItem = React.forwardRef<HTMLLIElement, TimelineItemProps>(
  (
    {
      icon,
      title,
      timestamp,
      markerClassName,
      className,
      children,
      ...props
    },
    ref
  ) => {
    return (
      <li
        ref={ref}
        className={cn('relative flex flex-col gap-0.5', className)}
        {...props}
      >
        <span
          aria-hidden="true"
          className={cn(
            'absolute -left-[33px] top-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full border-2 border-background text-[10px] leading-none shadow-sm',
            markerClassName ?? 'bg-muted text-foreground'
          )}
        >
          {icon}
        </span>
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm font-medium text-foreground">{title}</span>
          {timestamp ? (
            <span className="text-xs text-muted-foreground">{timestamp}</span>
          ) : null}
        </div>
        {children ? (
          <div className="text-xs text-muted-foreground">{children}</div>
        ) : null}
      </li>
    );
  }
);
TimelineItem.displayName = 'TimelineItem';

export { Timeline, TimelineItem };
