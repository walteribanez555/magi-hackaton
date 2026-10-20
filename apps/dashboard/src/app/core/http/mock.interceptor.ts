import { HttpErrorResponse, HttpHeaders, type HttpInterceptorFn, HttpResponse } from '@angular/common/http';
import { delay, from, mergeMap, of, throwError } from 'rxjs';

import { environment } from '../../../environments/environment';
import { API_PREFIX } from './api-routes';

/**
 * Modo `environment.useMocks`: responde las rutas del API con fixtures locales
 * (core/data/fixtures, "Datos de ejemplo") para poder demostrar el dashboard sin backend.
 * Los fixtures se cargan en un chunk diferido: en producción (useMocks=false) nunca se piden.
 */
export const mockInterceptor: HttpInterceptorFn = (req, next) => {
  if (!environment.useMocks) return next(req);
  const idx = req.url.indexOf(API_PREFIX + '/');
  if (idx < 0) return next(req);
  const path = req.url.slice(idx + API_PREFIX.length).split('?')[0]!;

  return from(import('@/core/data/fixtures')).pipe(
    mergeMap(({ handleMock }) => {
      const res = handleMock(req.method, path, req.params, req.body);
      if (res === undefined) {
        return throwError(
          () => new HttpErrorResponse({ status: 404, url: req.url, error: { statusCode: 404, message: `Sin fixture para ${req.method} ${path}` } }),
        );
      }
      if (res instanceof HttpErrorResponse) return throwError(() => res);
      return of(
        new HttpResponse({
          status: res.status ?? 200,
          url: req.url,
          body: res.body === null ? null : { data: res.body },
          headers: new HttpHeaders({ 'x-magicode-demo': 'true' }),
        }),
      );
    }),
    delay(180),
  );
};
