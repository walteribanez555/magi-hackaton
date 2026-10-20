import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';

import { ToastService } from '@/shared/services/toast.service';
import { SILENT_ERRORS } from './http-context';

const recent = new Map<string, number>();

/** Mensaje legible para un error del API (`ApiError.message`) o de red. */
export function describeHttpError(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    if (err.status === 0) return 'No se pudo contactar con el API de MagiCode.';
    const msg = (err.error as { message?: unknown } | null)?.message;
    if (typeof msg === 'string' && msg) return msg;
    if (err.status === 404) return 'No se encontró el recurso.';
    if (err.status >= 500) return 'El API respondió con un error interno.';
    return `Error ${err.status}`;
  }
  return 'Error inesperado.';
}

/** Toast de error por petición fallida (deduplicado 5 s por URL + estado). */
export const errorToastInterceptor: HttpInterceptorFn = (req, next) => {
  if (req.context.get(SILENT_ERRORS)) return next(req);
  const toast = inject(ToastService);
  return next(req).pipe(
    catchError((err: unknown) => {
      if (err instanceof HttpErrorResponse && err.status !== 401) {
        const key = `${req.method} ${req.urlWithParams.split('?')[0]} ${err.status}`;
        const now = Date.now();
        if ((recent.get(key) ?? 0) < now - 5000) {
          recent.set(key, now);
          toast.error('No se pudieron cargar los datos', { description: describeHttpError(err) });
        }
      }
      return throwError(() => err);
    }),
  );
};
