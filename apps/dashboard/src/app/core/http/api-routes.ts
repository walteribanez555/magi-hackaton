/**
 * Copia local de `API_PREFIX` y `ROUTES` de @magicode/contracts (api.ts).
 * No se importan en runtime para no arrastrar zod al bundle (el índice del paquete
 * ejecuta los esquemas al cargarse). `api-routes.spec.ts` verifica que sigan iguales.
 */
export const API_PREFIX = '/api/v1';

export const ROUTES = {
  health: '/health',
  events: '/productivity/events',
  summary: '/productivity/summary',
  timeline: '/productivity/timeline',
  projects: '/productivity/projects',
  sessions: '/productivity/sessions',
  session: '/productivity/sessions/:sessionId',
  changes: '/productivity/changes',
  commits: '/productivity/commits',
  usage: '/usage',
  usageSync: '/usage/sync',
  whoami: '/whoami',
  tasks: '/tasks',
  task: '/tasks/:taskKey',
  branches: '/branches',
  pullRequests: '/pull-requests',
  integrations: '/integrations',
  integration: '/integrations/:integrationId',
  webhook: '/webhooks/:provider/:integrationId',
  taskActions: '/tasks/:taskKey/actions',
  taskTransitions: '/tasks/:taskKey/transitions',
  integrationCredentials: '/integrations/:integrationId/credentials',
  integrationRules: '/integrations/:integrationId/rules',
  integrationRule: '/integrations/:integrationId/rules/:ruleId',
  projectReadiness: '/projects/:projectId/readiness',
  repositories: '/repositories',
  repositoryReadiness: '/repositories/:repository/readiness',
  integrationHealth: '/integrations/:integrationId/health',
  integrationTest: '/integrations/:integrationId/test',
  integrationTestRun: '/integrations/:integrationId/tests/:testId',
  integrationRegisterWebhook: '/integrations/:integrationId/register-webhook',
} as const;

export type RouteName = keyof typeof ROUTES;

/** Sustituye `:param` por valores codificados. */
export function buildPath(route: string, params: Record<string, string> = {}): string {
  return route.replace(/:([A-Za-z]+)/g, (_, k: string) => {
    const v = params[k];
    if (v === undefined) throw new Error(`Falta el parámetro de ruta "${k}"`);
    return encodeURIComponent(v);
  });
}

/** Umbrales de criticidad (copia de contracts/scoring.ts CRITICALITY_THRESHOLDS). */
export const CRITICALITY_THRESHOLDS = {
  low: 0,
  medium: 0.35,
  high: 0.6,
  critical: 0.8,
} as const;

/** Cabeceras de firma por proveedor (copia de contracts/api.ts WEBHOOK_SIGNATURE_HEADERS). */
export const WEBHOOK_SIGNATURE_HEADERS = {
  github: { signature: 'x-hub-signature-256', delivery: 'x-github-delivery', event: 'x-github-event' },
  bitbucket: { signature: 'x-hub-signature', delivery: 'x-request-uuid', event: 'x-event-key' },
  gitlab: { signature: 'x-gitlab-token', delivery: 'x-gitlab-event-uuid', event: 'x-gitlab-event' },
  jira: {
    signature: 'x-hub-signature',
    delivery: 'x-atlassian-webhook-identifier',
    event: 'x-atlassian-webhook-flow',
  },
  linear: { signature: 'linear-signature', delivery: 'linear-delivery', event: 'linear-event' },
} as const;
