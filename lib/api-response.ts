import { NextResponse } from 'next/server';

export type ApiMeta = Record<string, unknown>;

export interface ApiSuccess<T> {
  data: T;
  error: null;
  meta?: ApiMeta;
}

export interface ApiFailure {
  data: null;
  error: {
    message: string;
    code?: string;
  };
  meta?: ApiMeta;
}

export function apiOk<T>(data: T, meta?: ApiMeta): NextResponse<ApiSuccess<T>> {
  const body: ApiSuccess<T> = { data, error: null, ...(meta ? { meta } : {}) };
  return NextResponse.json(body, { status: 200 });
}

export function apiError(
  message: string,
  status = 400,
  code?: string,
  meta?: ApiMeta
): NextResponse<ApiFailure> {
  const body: ApiFailure = {
    data: null,
    error: { message, ...(code ? { code } : {}) },
    ...(meta ? { meta } : {}),
  };
  return NextResponse.json(body, { status });
}
