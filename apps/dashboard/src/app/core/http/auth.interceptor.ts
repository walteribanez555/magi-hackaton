import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';

import { RuntimeConfigService } from '@/core/config/runtime-config.service';
import { SessionService } from '@/core/auth/session.service';
import { SKIP_AUTH } from './http-context';

/**
 * Adjunta `Authorization: Bearer <MagiHub API key>` SOLO a peticiones hacia el API configurado
 * (nunca a otros orígenes: fuentes, kb, config.json). En modo demo no se envía nada salvo que la
 * persona haya pegado su key. Un 401 fuera de demo limpia la sesión y vuelve a /conectar.
 * La key jamás se registra.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  if (req.context.get(SKIP_AUTH)) return next(req);

  const config = inject(RuntimeConfigService);
  const session = inject(SessionService);
  const router = inject(Router);

  const apiBase = config.apiUrl;
  const isApi = apiBase ? req.url.startsWith(apiBase + '/') : req.url.startsWith('/api/');
  if (!isApi) return next(req);

  const key = session.apiKey();
  const authed = key ? req.clone({ setHeaders: { Authorization: `Bearer ${key}` } }) : req;

  return next(authed).pipe(
    catchError((err: unknown) => {
      if (err instanceof HttpErrorResponse && err.status === 401 && !config.demoMode) {
        session.clear();
        void router.navigate(['/conectar'], { queryParams: { returnUrl: router.url } });
      }
      return throwError(() => err);
    }),
  );
};
