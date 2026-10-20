import { HttpClient, HttpContext, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import { RuntimeConfigService } from '@/core/config/runtime-config.service';
import { API_PREFIX, ROUTES, buildPath, type RouteName } from './api-routes';

export type QueryValue = string | number | boolean | null | undefined;
export type Query = Record<string, QueryValue>;

/** El API responde `{ data, meta? }` (contracts ApiResponse); se tolera también el cuerpo pelado. */
export function unwrap<T>(body: unknown): T {
  if (body && typeof body === 'object' && 'data' in (body as Record<string, unknown>)) {
    return (body as { data: T }).data;
  }
  return body as T;
}

export function toParams(query: Query = {}): HttpParams {
  let p = new HttpParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    p = p.set(k, String(v));
  }
  return p;
}

/** Cliente fino sobre HttpClient: arma `${apiUrl}/api/v1/<ruta>` y desenvuelve `data`. */
@Injectable({ providedIn: 'root' })
export class ApiClient {
  private readonly http = inject(HttpClient);
  private readonly config = inject(RuntimeConfigService);

  url(route: RouteName, params: Record<string, string> = {}): string {
    return `${this.config.apiUrl}${API_PREFIX}${buildPath(ROUTES[route], params)}`;
  }

  get<T>(route: RouteName, opts: { params?: Record<string, string>; query?: Query; context?: HttpContext } = {}): Observable<T> {
    return this.http
      .get<unknown>(this.url(route, opts.params), { params: toParams(opts.query), context: opts.context })
      .pipe(map((b) => unwrap<T>(b)));
  }

  post<T>(route: RouteName, body: unknown, opts: { params?: Record<string, string>; suffix?: string; context?: HttpContext } = {}): Observable<T> {
    return this.http
      .post<unknown>(this.url(route, opts.params) + (opts.suffix ?? ''), body, { context: opts.context })
      .pipe(map((b) => unwrap<T>(b)));
  }

  put<T>(route: RouteName, body: unknown, opts: { params?: Record<string, string>; context?: HttpContext } = {}): Observable<T> {
    return this.http
      .put<unknown>(this.url(route, opts.params), body, { context: opts.context })
      .pipe(map((b) => unwrap<T>(b)));
  }

  delete<T>(route: RouteName, opts: { params?: Record<string, string>; context?: HttpContext } = {}): Observable<T> {
    return this.http
      .delete<unknown>(this.url(route, opts.params), { context: opts.context })
      .pipe(map((b) => unwrap<T>(b)));
  }
}
