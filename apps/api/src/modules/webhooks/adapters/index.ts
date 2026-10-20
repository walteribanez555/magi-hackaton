import { NormalizedWebhookEvent, type IntegrationProvider } from '@magicode/contracts';
import type { Adapter, AdapterInput, AdaptResult } from '../webhooks.types';
import { bitbucketAdapter } from './bitbucket.adapter';
import { githubAdapter } from './github.adapter';
import { gitlabAdapter } from './gitlab.adapter';
import { jiraAdapter } from './jira.adapter';
import { linearAdapter } from './linear.adapter';

export const ADAPTERS: Record<IntegrationProvider, Adapter> = {
  github: githubAdapter,
  bitbucket: bitbucketAdapter,
  gitlab: gitlabAdapter,
  jira: jiraAdapter,
  linear: linearAdapter,
};

/**
 * Traduce el payload del proveedor y VALIDA cada evento normalizado con zod
 * (lanza ZodError si un adaptador produjo algo fuera de contrato → 400).
 */
export function adaptWebhook(provider: IntegrationProvider, input: AdapterInput): AdaptResult {
  const res = ADAPTERS[provider](input);
  if (res.type !== 'events') return res;
  return { type: 'events', events: res.events.map((e) => NormalizedWebhookEvent.parse(e)) };
}

export { bitbucketAdapter, githubAdapter, gitlabAdapter, jiraAdapter, linearAdapter };
