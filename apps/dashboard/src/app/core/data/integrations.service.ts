import { HttpContext } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type {
  AutomationRule,
  AutomationRuleUpsert,
  GitProviderCredentials,
  Integration,
  IntegrationCreate,
  IntegrationCreated,
  IntegrationHealth,
  IntegrationTestRequest,
  IntegrationTestRun,
  ProjectReadiness,
  RegisterWebhookResult,
  RepositoryOption,
  RepositoryReadiness,
  TaskProviderCredentials,
} from '@magicode/contracts';
import type { Observable } from 'rxjs';

import { ApiClient } from '@/core/http/api-client';
import { SILENT_ERRORS } from '@/core/http/http-context';

const silent = () => new HttpContext().set(SILENT_ERRORS, true);

/** Respuesta de PUT credentials: 204 sin cuerpo; si el API devuelve la cuenta, se muestra. */
export interface CredentialsSaved {
  account?: string | null;
  display_name?: string | null;
}

/** Integraciones, webhooks, credenciales, reglas y salud (readiness). */
@Injectable({ providedIn: 'root' })
export class IntegrationsService {
  private readonly api = inject(ApiClient);

  list(projectId?: string): Observable<Integration[]> {
    return this.api.get<Integration[]>('integrations', { query: { project_id: projectId } });
  }

  create(body: IntegrationCreate): Observable<IntegrationCreated> {
    return this.api.post<IntegrationCreated>('integrations', body);
  }

  disable(integrationId: string): Observable<Integration> {
    return this.api.delete<Integration>('integration', { params: { integrationId } });
  }

  rotateSecret(integrationId: string): Observable<IntegrationCreated> {
    return this.api.post<IntegrationCreated>('integration', {}, { params: { integrationId }, suffix: '/rotate-secret' });
  }

  saveCredentials(
    integrationId: string,
    body: TaskProviderCredentials | GitProviderCredentials,
  ): Observable<CredentialsSaved | null> {
    return this.api.put<CredentialsSaved | null>('integrationCredentials', body, { params: { integrationId } });
  }

  rules(integrationId: string): Observable<AutomationRule[]> {
    return this.api.get<AutomationRule[]>('integrationRules', { params: { integrationId } });
  }

  createRule(integrationId: string, body: AutomationRuleUpsert): Observable<AutomationRule> {
    return this.api.post<AutomationRule>('integrationRules', body, { params: { integrationId } });
  }

  updateRule(integrationId: string, ruleId: string, body: AutomationRuleUpsert): Observable<AutomationRule> {
    return this.api.put<AutomationRule>('integrationRule', body, { params: { integrationId, ruleId } });
  }

  deleteRule(integrationId: string, ruleId: string): Observable<unknown> {
    return this.api.delete<unknown>('integrationRule', { params: { integrationId, ruleId } });
  }

  // ── Salud y readiness ─────────────────────────────────────────────
  projectReadiness(projectId: string): Observable<ProjectReadiness> {
    return this.api.get<ProjectReadiness>('projectReadiness', { params: { projectId }, context: silent() });
  }

  repositories(projectId?: string): Observable<RepositoryOption[]> {
    return this.api.get<RepositoryOption[]>('repositories', { query: { project_id: projectId } });
  }

  /** `repository` = "org/repo"; buildPath lo codifica como org%2Frepo. */
  repositoryReadiness(repository: string): Observable<RepositoryReadiness> {
    return this.api.get<RepositoryReadiness>('repositoryReadiness', { params: { repository } });
  }

  health(integrationId: string, refresh = false): Observable<IntegrationHealth> {
    return this.api.get<IntegrationHealth>('integrationHealth', {
      params: { integrationId },
      query: { refresh: refresh || undefined },
    });
  }

  startTest(integrationId: string, body: IntegrationTestRequest): Observable<IntegrationTestRun> {
    return this.api.post<IntegrationTestRun>('integrationTest', body, { params: { integrationId } });
  }

  testRun(integrationId: string, testId: string): Observable<IntegrationTestRun> {
    return this.api.get<IntegrationTestRun>('integrationTestRun', { params: { integrationId, testId }, context: silent() });
  }

  registerWebhook(integrationId: string): Observable<RegisterWebhookResult> {
    return this.api.post<RegisterWebhookResult>('integrationRegisterWebhook', {}, { params: { integrationId } });
  }
}
