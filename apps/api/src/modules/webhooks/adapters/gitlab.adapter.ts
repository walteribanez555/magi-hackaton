import { extractTaskKeys, type NormalizedWebhookEvent } from '@magicode/contracts';
import type { AdapterInput, AdaptResult } from '../webhooks.types';
import { arr, base, commitRef, isZeroSha, obj, parseRef, str, toIso, ZERO_SHA } from './common';

type DeploymentState = Extract<NormalizedWebhookEvent, { kind: 'repo.deployment' }>['state'];

const DEPLOY_STATES: Record<string, DeploymentState> = {
  created: 'pending',
  running: 'in_progress',
  success: 'success',
  failed: 'failure',
  canceled: 'inactive',
  skipped: 'inactive',
  blocked: 'pending',
};

/** X-Gitlab-Event → object_kind (el cuerpo trae object_kind; el header es respaldo). */
const HEADER_KIND: Record<string, string> = {
  'Push Hook': 'push',
  'Tag Push Hook': 'tag_push',
  'Merge Request Hook': 'merge_request',
  'Deployment Hook': 'deployment',
};

/**
 * GitLab (opcional): push · tag_push · merge_request · deployment.
 * Docs: https://docs.gitlab.com/user/project/integrations/webhook_events/
 */
export function gitlabAdapter(input: AdapterInput): AdaptResult {
  const p = obj(input.payload);
  const kind = str(p.object_kind) ?? HEADER_KIND[input.event ?? ''] ?? '';
  const repository = str(obj(p.project).path_with_namespace);
  const b = base(input, 'gitlab');
  if (!repository) return { type: 'ignored', reason: `${kind || 'event'} without project` };

  switch (kind) {
    case 'push':
    case 'tag_push': {
      const ref = parseRef(str(p.ref));
      if (!ref) return { type: 'ignored', reason: 'unsupported ref' };
      const before = str(p.before) ?? ZERO_SHA;
      const after = str(p.after) ?? ZERO_SHA;
      const deleted = isZeroSha(after);
      if (ref.type === 'tag') {
        return {
          type: 'events',
          events: [
            {
              ...b,
              kind: 'repo.tag',
              repository,
              tag: ref.name,
              sha: deleted ? before : (str(p.checkout_sha) ?? after),
              action: deleted ? 'deleted' : 'created',
            },
          ],
        };
      }
      if (deleted) {
        return { type: 'events', events: [{ ...b, kind: 'repo.branch', repository, branch: ref.name, action: 'deleted' }] };
      }
      const commits = arr(p.commits).map((raw) => {
        const c = obj(raw);
        return commitRef({
          sha: str(c.id) ?? '',
          message: str(c.message),
          timestamp: toIso(c.timestamp, input.received_at),
          added: c.added,
          modified: c.modified,
          removed: c.removed,
        });
      });
      return {
        type: 'events',
        events: [
          {
            ...b,
            kind: 'repo.push',
            repository,
            branch: ref.name,
            before,
            after,
            forced: false, // GitLab no lo informa en el webhook
            commits: commits.filter((c) => c.sha),
          },
        ],
      };
    }

    case 'merge_request': {
      const a = obj(p.object_attributes);
      const number = typeof a.iid === 'number' ? a.iid : NaN;
      if (!Number.isInteger(number)) return { type: 'ignored', reason: 'merge_request without iid' };
      const raw = str(a.state) ?? '';
      const state = raw === 'merged' ? 'merged' : raw === 'closed' ? 'closed' : 'open';
      return {
        type: 'events',
        events: [
          {
            ...b,
            kind: 'repo.pull_request',
            repository,
            number,
            title_task_keys: extractTaskKeys(str(a.title)),
            source_branch: str(a.source_branch) ?? '',
            target_branch: str(a.target_branch) ?? '',
            state,
            merge_sha: state === 'merged' ? (str(a.merge_commit_sha) ?? null) : null,
            head_sha: str(obj(a.last_commit).id) ?? '',
            url: str(a.url) ?? '',
          },
        ],
      };
    }

    case 'deployment': {
      const state = DEPLOY_STATES[str(p.status) ?? ''];
      const id = p.deployment_id;
      // El webhook trae short_sha; el SHA completo va al final de commit_url (…/-/commit/<sha>)
      const fromUrl = /\/commit\/([0-9a-f]{7,64})\/?$/i.exec(str(p.commit_url) ?? '')?.[1];
      const sha = fromUrl ?? str(p.short_sha);
      if (!state || id === undefined || !sha) return { type: 'ignored', reason: 'deployment incomplete' };
      const url = str(p.deployable_url) ?? str(p.environment_external_url);
      return {
        type: 'events',
        events: [
          {
            ...b,
            kind: 'repo.deployment',
            repository,
            deployment_id: String(id),
            sha,
            ref: str(p.ref) ?? '',
            environment: str(p.environment) ?? 'unknown',
            state,
            ...(url ? { url } : {}),
          },
        ],
      };
    }

    default:
      return { type: 'ignored', reason: `event ${kind || input.event || '(none)'} not supported` };
  }
}
