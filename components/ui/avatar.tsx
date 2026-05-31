'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { initials } from '@/lib/format';

export interface AvatarProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Nome do utilizador — usado para gerar iniciais quando não há imagem. */
  name: string | null | undefined;
  /** URL opcional da imagem. Se o load falhar, faz fallback para iniciais. */
  src?: string | null;
  /** Diâmetro em pixels. Default 32px. */
  size?: number;
}

/**
 * Círculo com iniciais (fallback) ou imagem opcional. Hand-rolled, sem Radix.
 *
 * Quando `src` está presente, tenta carregar a imagem. Se o `onError` disparar
 * (URL inválida, 404, etc.), faz fallback para as iniciais geradas com o
 * helper `initials()`.
 */
const Avatar = React.forwardRef<HTMLSpanElement, AvatarProps>(
  ({ name, src, size = 32, className, style, ...props }, ref) => {
    const [imgFailed, setImgFailed] = React.useState(false);
    const showImage = Boolean(src) && !imgFailed;

    return (
      <span
        ref={ref}
        aria-label={name ?? 'Avatar'}
        // Tamanho dinâmico via inline style — Tailwind não suporta arbitrary
        // values em runtime sem JIT specific config.
        // eslint-disable-next-line react/forbid-dom-props
        style={{ width: size, height: size, ...style }}
        className={cn(
          'relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full bg-muted text-xs font-medium text-muted-foreground',
          className
        )}
        {...props}
      >
        {showImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src ?? undefined}
            alt={name ?? ''}
            className="h-full w-full object-cover"
            onError={() => setImgFailed(true)}
          />
        ) : (
          <span aria-hidden="true">{initials(name)}</span>
        )}
      </span>
    );
  }
);
Avatar.displayName = 'Avatar';

export { Avatar };
