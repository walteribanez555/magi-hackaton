import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';

import { RuntimeConfigService } from '@/core/config/runtime-config.service';
import { SessionService } from './session.service';

/**
 * Modo demo (config.json `demoMode: true`): acceso directo, sin login.
 * Fuera de demo: sin API key en la sesión → /conectar?returnUrl=…
 */
export const authGuard: CanActivateFn = (_route, state) => {
  if (inject(RuntimeConfigService).demoMode) return true;
  if (inject(SessionService).isAuthenticated()) return true;
  return inject(Router).createUrlTree(['/conectar'], { queryParams: { returnUrl: state.url } });
};
