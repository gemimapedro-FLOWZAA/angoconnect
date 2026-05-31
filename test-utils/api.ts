/**
 * AngoConnect — Helper para testes de API Routes
 * ===========================================================================
 * Constrói um `NextRequest`-compatible directamente, sem levantar o servidor
 * Next.js. Os handlers em `app/api/**` esperam um `NextRequest` mas, em
 * runtime de testes, a interface relevante (`.json()`, `.url`, `.headers`,
 * `.nextUrl.searchParams`) está satisfeita por um `Request` global do
 * Node 18+ com um `nextUrl` artificial colado por cima.
 */

import { NextRequest } from 'next/server';

export interface MakeRequestOpts {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * Cria um `NextRequest` para passar directamente aos handlers das API Routes.
 * Para `GET`/`DELETE` ignora `body` (estes verbos não têm body por convenção
 * REST e o `Request` do Node rejeita body sem header `content-type`).
 */
export function makeRequest(opts: MakeRequestOpts): NextRequest {
  const baseHeaders: Record<string, string> = { ...(opts.headers ?? {}) };
  const init: { method: string; headers: Record<string, string>; body?: string } = {
    method: opts.method,
    headers: baseHeaders,
  };

  if (opts.body !== undefined && opts.method !== 'GET' && opts.method !== 'DELETE') {
    init.body = JSON.stringify(opts.body);
    if (!baseHeaders['content-type'] && !baseHeaders['Content-Type']) {
      baseHeaders['content-type'] = 'application/json';
    }
  }

  // `NextRequest` aceita Request — Next adiciona `nextUrl` internamente.
  return new NextRequest(opts.url, init);
}

/**
 * Parser conveniente: lê o JSON da resposta + devolve o status. Útil para
 * `expect(json.error.code).toBe('UNAUTHENTICATED')`.
 */
export async function parseJson<T = unknown>(
  res: Response
): Promise<{ status: number; json: T }> {
  const json = (await res.json()) as T;
  return { status: res.status, json };
}
