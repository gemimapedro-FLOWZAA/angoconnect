'use client';

import { useEffect, useState } from 'react';

/**
 * Devolve uma versão "atrasada" do valor de entrada. Útil para inputs de
 * pesquisa que devem aguardar antes de disparar um fetch.
 *
 * @param value      Valor de entrada (qualquer tipo serializável por igualdade
 *                   referencial — string/number/boolean são o caso comum).
 * @param delayMs    Atraso em milissegundos antes de propagar a mudança.
 *                   Default 300ms.
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState<T>(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
