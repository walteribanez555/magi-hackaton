import { HttpContext, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type {
  CheckResult,
  Integration,
  IntegrationCreate,
  IntegrationCreated,
  IntegrationHealth,
  IntegrationTestRequest,
  IntegrationTestRun,
  RegisterWebhookResult,
  RepositoryOption,
  RepositoryReadiness,
} from '@magicode/contracts';
import { type Observable, catchError, delay, map, of, switchMap } from 'rxjs';

import { ApiClient } from '@/core/http/api-client';
import { SILENT_ERRORS } from '@/core/http/http-context';
import { environment } from '../../../environments/environment';
import {
  fixtureCreated,
  fixtureHealth,
  fixtureIntegrations,
  fixtureReadiness,
  fixtureRepositories,
  fixtureTestRun,
} from './integraciones.fixtures';

const silent = () => new HttpContext().set(SILENT_ERRORS, true);
const GIT = new Set(['github', 'bitbucket', 'gitlab']);
const TASKS = new Set(['jira', 'linear']);

/** Readiness + la integración detrás de cada bloque (para URL del webhook y destino). */
export interface RepoState {
  readiness: RepositoryReadiness;
  repositoryIntegration: Integration | null;
  tasksIntegration: Integration | null;
  /** el endpoint de readiness no respondió: estado armado a partir de GET /integrations */
  derived: boolean;
}

/** Texto de error para la persona (la página maneja sus errores, sin toast global). */
export function errorText(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    const body = err.error as { message?: string; error?: { message?: string } } | null;
    const msg = body?.error?.message ?? body?.message;
    if (err.status === 0) return 'No se pudo conectar con el servidor.';
    return msg ? `${msg} (${err.status})` : `El servidor respondió ${err.status}.`;
  }
  return err instanceof Error ? err.message : 'Error inesperado.';
}

function emptyHealth(role: 'repository' | 'tasks', integ: Integration | null): IntegrationHealth {
  const now = new Date().toISOString();
  const base: Omit<IntegrationHealth, 'status' | 'checks'> = {
    integration_id: integ?.integration_id ?? null,
    role,
    provider: integ?.provider ?? null,
    deliveries_24h: { accepted: 0, duplicate: 0, ignored: 0, rejected_signature: 0, rejected_other: 0 },
    last_event_at: {},
    last_delivery_at: integ?.last_delivery_at ?? null,
    last_error: null,
    last_test: null,
    can_auto_register: false,
  };
  if (!integ) {
    return {
      ...base,
      status: 'not_configured',
      checks: [
        {
          id: 'integration_exists',
          status: 'fail',
          message:
            role === 'repository'
              ? 'No hay integración para este repositorio. Créala para confirmar commits, pull requests y despliegues.'
              : 'No hay integración de tareas en este proyecto. Créala para dar contexto a cada cambio.',
          action: 'create_integration',
          checked_at: now,
        },
      ],
    };
  }
  const checks: CheckResult[] = [
    { id: 'integration_exists', status: 'pass', message: `Creada; URL ${integ.webhook_url}`, action: null, checked_at: now },
    integ.last_delivery_at
      ? { id: 'recent_delivery', status: 'pass', message: 'Llegan entregas del proveedor.', action: null, checked_at: now }
      : {
          id: 'recent_delivery',
          status: 'skipped',
          message: 'Aún no llega ninguna entrega. Configura el webhook en el proveedor y comprueba.',
          action: 'run_test',
          checked_at: now,
        },
  ];
  return {
    ...base,
    status: integ.status === 'disabled' ? 'disabled' : integ.last_delivery_at ? 'healthy' : 'awaiting_first_delivery',
    checks,
  };
}

/** Acceso a datos de la página: API real con errores silenciosos, o fixtures en modo mock. */
@Injectable()
export class IntegracionesData {
  private readonly api = inject(ApiClient);
  private readonly mock = environment.useMocks;

  integrations(projectId: string | null): Observable<Integration[]> {
    if (this.mock) return of(fixtureIntegrations());
    return this.api
      .get<Integration[]>('integrations', { query: { project_id: projectId ?? undefined }, context: silent() })
      .pipe(catchError(() => of([] as Integration[])));
  }

  /** GET /repositories; si no existe, la lista sale de los repos de cada proyecto. */
  repositories(projectId: string | null, fallback: { project_id: string; repositories: string[] }[]): Observable<RepositoryOption[]> {
    if (this.mock) return of(fixtureRepositories()).pipe(delay(150));
    const fromProjects = (): RepositoryOption[] =>
      fallback.flatMap((p) =>
        p.repositories.map((repository) => ({ repository, project_id: p.project_id, ready: false, status: 'not_configured' as const })),
      );
    return this.api
      .get<RepositoryOption[]>('repositories', { query: { project_id: projectId ?? undefined }, context: silent() })
      .pipe(
        map((list) => (list.length ? list : fromProjects())),
        catchError(() => of(fromProjects())),
      );
  }

  state(repository: string, projectId: string): Observable<RepoState> {
    if (this.mock) {
      const all = fixtureIntegrations();
      return of({
        readiness: fixtureReadiness(repository, projectId),
        repositoryIntegration: all.find((i) => GIT.has(i.provider) && i.repository === repository) ?? null,
        tasksIntegration: all.find((i) => TASKS.has(i.provider) && i.project_id === projectId) ?? null,
        derived: false,
      }).pipe(delay(200));
    }
    return this.integrations(projectId).pipe(
      switchMap((list) => {
        const repositoryIntegration =
          list.find((i) => GIT.has(i.provider) && i.repository === repository && i.status !== 'disabled') ?? null;
        const tasksIntegration = list.find((i) => TASKS.has(i.provider) && i.status !== 'disabled') ?? null;
        return this.api
          .get<RepositoryReadiness>('repositoryReadiness', { params: { repository }, context: silent() })
          .pipe(
            map((readiness) => ({ readiness, repositoryIntegration, tasksIntegration, derived: false })),
            catchError(() =>
              of({
                readiness: {
                  repository,
                  project_id: projectId,
                  ready: false,
                  api_keys: [],
                  repository_webhook: emptyHealth('repository', repositoryIntegration),
                  tasks_webhook: emptyHealth('tasks', tasksIntegration),
                  ide: { last_event_at: null, sessions_7d: 0 },
                  blocking_reasons: [],
                  evaluated_at: new Date().toISOString(),
                },
                repositoryIntegration,
                tasksIntegration,
                derived: true,
              }),
            ),
          );
      }),
    );
  }

  create(body: IntegrationCreate): Observable<IntegrationCreated> {
    if (this.mock) return of(fixtureCreated(body)).pipe(delay(300));
    return this.api.post<IntegrationCreated>('integrations', body, { context: silent() });
  }

  health(integrationId: string): Observable<IntegrationHealth> {
    if (this.mock) return of(fixtureHealth(integrationId)).pipe(delay(300));
    return this.api.get<IntegrationHealth>('integrationHealth', {
      params: { integrationId },
      query: { refresh: true },
      context: silent(),
    });
  }

  registerWebhook(integrationId: string): Observable<RegisterWebhookResult> {
    if (this.mock) return of({ provider_hook_id: '48211907', created: true, events: [] }).pipe(delay(300));
    return this.api.post<RegisterWebhookResult>('integrationRegisterWebhook', {}, { params: { integrationId }, context: silent() });
  }

  rotateSecret(integrationId: string): Observable<IntegrationCreated> {
    if (this.mock) return of(fixtureCreated({ provider: 'github', project_id: 'magicode-demo', repository: 'x/y' })).pipe(delay(300));
    return this.api.post<IntegrationCreated>('integration', {}, { params: { integrationId }, suffix: '/rotate-secret', context: silent() });
  }

  private mockTicks = 0;

  startTest(integrationId: string, body: IntegrationTestRequest): Observable<IntegrationTestRun> {
    if (this.mock) {
      this.mockTicks = 0;
      return of(fixtureTestRun(integrationId, body.mode, 0)).pipe(delay(300));
    }
    return this.api.post<IntegrationTestRun>('integrationTest', body, { params: { integrationId }, context: silent() });
  }

  testRun(integrationId: string, testId: string, mode: 'auto' | 'manual'): Observable<IntegrationTestRun> {
    if (this.mock) return of(fixtureTestRun(integrationId, mode, ++this.mockTicks));
    return this.api.get<IntegrationTestRun>('integrationTestRun', { params: { integrationId, testId }, context: silent() });
  }
}
