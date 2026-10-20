import { extractTaskKeys, type NormalizedWebhookEvent } from '@magicode/contracts';
import type { AdapterInput, AdaptResult } from '../webhooks.types';
import { arr, authorOf, base, commitRef, isZeroSha, obj, parseRef, str, toIso, ZERO_SHA } from './common';

type DeploymentState = Extract<NormalizedWebhookEvent, { kind: 'repo.deployment' }>['state'];

const PR_ACTIONS = new Set([
  'opened',
  'edited',
  'closed',
  'reopened',
  'synchronize',
  'ready_for_review',
  'converted_to_draft',
]);

const DEPLOY_STATES: Record<string, DeploymentState> = {
  pending: 'pending',
  queued: 'pending',
  waiting: 'pending',
  in_progress: 'in_progress',
  success: 'success',
  failure: 'failure',
  error: 'error',
  inactive: 'inactive',
};

/**
 * GitHub (X-GitHub-Event): push · create · delete · pull_request · deployment_status · ping.
 * Docs: https://docs.github.com/webhooks/webhook-events-and-payloads
 */
export function githubAdapter(input: AdapterInput): AdaptResult {
  const p = obj(input.payload);
  const repository = str(obj(p.repository).full_name);
  const b = base(input, 'github');

  switch (input.event) {
    case 'ping':
      return { type: 'ping' };

    case 'push': {
      if (!repository) return { type: 'ignored', reason: 'push without repository' };
      const ref = parseRef(str(p.ref));
      if (!ref) return { type: 'ignored', reason: 'unsupported ref' };
      const before = str(p.before) ?? ZERO_SHA;
      const after = str(p.after) ?? ZERO_SHA;
      const deleted = p.deleted === true || isZeroSha(after);

      if (ref.type === 'tag') {
        return {
          type: 'events',
          events: [
            {
              ...b,
              kind: 'repo.tag',
              repository,
              tag: ref.name,
              sha: deleted ? before : after,
              action: deleted ? 'deleted' : 'created',
            },
          ],
        };
      }
      if (deleted) {
        return {
          type: 'events',
          events: [{ ...b, kind: 'repo.branch', repository, branch: ref.name, action: 'deleted' }],
        };
      }
      const commits = arr(p.commits).map((raw) => {
        const c = obj(raw);
        return commitRef({
          sha: str(c.id) ?? '',
          message: str(c.message),
          author_login: str(obj(c.author).username),
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
            forced: p.forced === true,
            commits: commits.filter((c) => c.sha),
          },
        ],
      };
    }

    case 'create':
    case 'delete': {
      if (!repository) return { type: 'ignored', reason: `${input.event} without repository` };
      // Los tags llegan también como `push` (con SHA); create/delete de tag no trae SHA → se ignora.
      if (p.ref_type !== 'branch') return { type: 'ignored', reason: `${input.event} ${String(p.ref_type)} handled via push` };
      const branch = str(p.ref);
      if (!branch) return { type: 'ignored', reason: `${input.event} without ref` };
      return {
        type: 'events',
        events: [
          { ...b, kind: 'repo.branch', repository, branch, action: input.event === 'create' ? 'created' : 'deleted' },
        ],
      };
    }

    case 'pull_request': {
      const action = str(p.action) ?? '';
      if (!PR_ACTIONS.has(action)) return { type: 'ignored', reason: `pull_request.${action}` };
      const pr = obj(p.pull_request);
      const number = typeof pr.number === 'number' ? pr.number : typeof p.number === 'number' ? p.number : NaN;
      if (!repository || !Number.isInteger(number)) return { type: 'ignored', reason: 'pull_request without number' };
      const merged = pr.merged === true;
      const state = merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'open';
      const head = obj(pr.head);
      return {
        type: 'events',
        events: [
          {
            ...b,
            kind: 'repo.pull_request',
            repository,
            number,
            title_task_keys: extractTaskKeys(str(pr.title)),
            source_branch: str(head.ref) ?? '',
            target_branch: str(obj(pr.base).ref) ?? '',
            state,
            // merge_commit_sha existe también en PRs abiertos (merge de prueba): solo cuenta si se fusionó
            merge_sha: merged ? (str(pr.merge_commit_sha) ?? null) : null,
            head_sha: str(head.sha) ?? '',
            url: str(pr.html_url) ?? '',
            ...authorOf(str(obj(pr.user).login)),
          },
        ],
      };
    }

    case 'deployment_status': {
      const ds = obj(p.deployment_status);
      const d = obj(p.deployment);
      const state = DEPLOY_STATES[str(ds.state) ?? ''];
      const id = d.id ?? ds.deployment_id;
      const sha = str(d.sha);
      if (!repository || !state || id === undefined || !sha) {
        return { type: 'ignored', reason: 'deployment_status incomplete' };
      }
      const url = str(ds.target_url) ?? str(ds.log_url) ?? str(ds.environment_url);
      return {
        type: 'events',
        events: [
          {
            ...b,
            kind: 'repo.deployment',
            repository,
            deployment_id: String(id),
            sha,
            ref: str(d.ref) ?? '',
            environment: str(ds.environment) ?? str(d.environment) ?? 'unknown',
            state,
            ...(url ? { url } : {}),
          },
        ],
      };
    }

    default:
      return { type: 'ignored', reason: `event ${input.event ?? '(none)'} not supported` };
  }
}
