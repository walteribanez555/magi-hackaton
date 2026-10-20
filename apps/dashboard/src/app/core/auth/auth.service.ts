import { HttpClient, HttpContext, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import type { KeyIdentity } from '@magicode/contracts';
import { firstValueFrom } from 'rxjs';

import { RuntimeConfigService } from '@/core/config/runtime-config.service';
import { API_PREFIX, ROUTES } from '@/core/http/api-routes';
import { SILENT_ERRORS, SKIP_AUTH } from '@/core/http/http-context';
import { unwrap } from '@/core/http/api-client';
import { SessionService } from './session.service';

export type ConnectResult = { ok: true; identity: KeyIdentity } | { ok: false; message: string };

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(RuntimeConfigService);
  private readonly session = inject(SessionService);
  private readonly router = inject(Router);

  /** Valida la key con GET /whoami (Bearer explícito, sin pasar por la sesión). */
  async connect(rawKey: string): Promise<ConnectResult> {
    const key = rawKey.trim();
    if (!key) return { ok: false, message: 'Pega una API key de MagiHub.' };
    try {
      const res = await firstValueFrom(
        this.http.get<unknown>(`${this.config.apiUrl}${API_PREFIX}${ROUTES.whoami}`, {
          headers: { Authorization: `Bearer ${key}` },
          context: new HttpContext().set(SKIP_AUTH, true).set(SILENT_ERRORS, true),
        }),
      );
      const identity = unwrap<KeyIdentity>(res);
      this.session.set(key, identity);
      return { ok: true, identity };
    } catch (err) {
      if (err instanceof HttpErrorResponse) {
        if (err.status === 401 || err.status === 403) {
          return { ok: false, message: 'MagiHub no reconoce esta API key.' };
        }
        if (err.status === 0) {
          return { ok: false, message: 'No se pudo contactar con el API de MagiCode.' };
        }
      }
      return { ok: false, message: 'No se pudo validar la key. Inténtalo de nuevo.' };
    }
  }

  logout(): void {
    this.session.clear();
    void this.router.navigate(['/conectar']);
  }
}
