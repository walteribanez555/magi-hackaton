import { Injectable, signal } from '@angular/core';

import { environment } from '../../../environments/environment';

/** `/config.json` — lo escribe CDK en el bucket del dashboard (public/config.json en local). */
export interface RuntimeConfig {
  apiUrl: string;
  environment: string;
  /** El backend acepta peticiones sin Authorization (DEMO_OPEN_ACCESS; nunca en producción). */
  demoMode?: boolean;
}

/**
 * Configuración de runtime: se lee una vez al arrancar (provideAppInitializer) para que el
 * mismo build sirva en cualquier entorno. Si falla, cae a `environment.apiUrl`.
 */
@Injectable({ providedIn: 'root' })
export class RuntimeConfigService {
  private readonly state = signal<RuntimeConfig>({
    apiUrl: environment.apiUrl,
    environment: environment.production ? 'production' : 'local',
    demoMode: environment.useMocks,
  });

  readonly config = this.state.asReadonly();

  get demoMode(): boolean {
    return this.state().demoMode === true;
  }

  get apiUrl(): string {
    return this.state().apiUrl.replace(/\/+$/, '');
  }

  async load(fetchFn: typeof fetch = fetch): Promise<void> {
    try {
      const res = await fetchFn(`config.json?v=${environment.buildVersion}`, { cache: 'no-store' });
      if (!res.ok) return;
      const json = (await res.json()) as Partial<RuntimeConfig>;
      this.state.set({
        apiUrl: typeof json.apiUrl === 'string' ? json.apiUrl : this.state().apiUrl,
        environment: typeof json.environment === 'string' ? json.environment : this.state().environment,
        demoMode: typeof json.demoMode === 'boolean' ? json.demoMode : this.state().demoMode,
      });
    } catch {
      /* sin config.json: se usa el respaldo del environment */
    }
  }
}
