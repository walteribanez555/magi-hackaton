import { extractTaskKeys, type NormalizedWebhookEvent } from '@magicode/contracts';
import type { AdapterInput, AdaptResult } from '../webhooks.types';
import { arr, base, commitRef, obj, str, toIso, ZERO_SHA } from './common';

const PR_EVENTS = new Set([
  'pullrequest:created',
  'pullrequest:updated',
  'pullrequest:fulfilled',
  'pullrequest:rejected',
]);

/**
 * Bitbucket Cloud (X-Event-Key): repo:push · pullrequest:created|updated|fulfilled|rejected · diagnostics:ping.
 * Docs: https://support.atlassian.com/bitbucket-cloud/docs/event-payloads/
 * Bitbucket no informa archivos por commit en el webhook → files_* = 0 (limitación declarada).
 */
export function bitbucketAdapter(input: AdapterInput): AdaptResult {
  const p = obj(input.payload);
  const repository = str(obj(p.repository).full_name);
  const b = base(input, 'bitbucket');
  const event = input.event ?? '';

  if (event === 'diagnostics:ping') return { type: 'ping' };
  if (!repository) return { type: 'ignored', reason: `${event || 'event'} without repository` };

  if (event === 'repo:push') {
    const events: NormalizedWebhookEvent[] = [];
    for (const raw of arr(obj(p.push).changes)) {
      const ch = obj(raw);
      const next = ch.new ? obj(ch.new) : null;
      const prev = ch.old ? obj(ch.old) : null;
      const ref = next ?? prev;
      const name = str(ref?.name);
      const type = str(ref?.type); // 'branch' | 'tag' | 'named_branch' | 'bookmark'
      if (!ref || !name) continue;
      const afterSha = next ? (str(obj(next.target).hash) ?? ZERO_SHA) : ZERO_SHA;
      const beforeSha = prev ? (str(obj(prev.target).hash) ?? ZERO_SHA) : ZERO_SHA;

      if (type === 'tag') {
        events.push({
          ...b,
          kind: 'repo.tag',
          repository,
          tag: name,
          sha: next ? afterSha : beforeSha,
          action: next ? 'created' : 'deleted',
        });
        continue;
      }
      if (type !== 'branch' && type !== 'named_branch') continue;
      if (!next || ch.closed === true) {
        events.push({ ...b, kind: 'repo.branch', repository, branch: name, action: 'deleted' });
        continue;
      }
      const commits = arr(ch.commits).map((rc) => {
        const c = obj(rc);
        const author = obj(c.author);
        return commitRef({
          sha: str(c.hash) ?? '',
          message: str(c.message),
          author_login: str(obj(author.user).nickname),
          timestamp: toIso(c.date, input.received_at),
        });
      });
      events.push({
        ...b,
        kind: 'repo.push',
        repository,
        branch: name,
        before: beforeSha,
        after: afterSha,
        forced: ch.forced === true,
        commits: commits.filter((c) => c.sha),
      });
    }
    return events.length ? { type: 'events', events } : { type: 'ignored', reason: 'repo:push without supported changes' };
  }

  if (PR_EVENTS.has(event)) {
    const pr = obj(p.pullrequest);
    const number = typeof pr.id === 'number' ? pr.id : NaN;
    if (!Number.isInteger(number)) return { type: 'ignored', reason: 'pullrequest without id' };
    const rawState = (str(pr.state) ?? '').toUpperCase();
    const state =
      event === 'pullrequest:fulfilled' || rawState === 'MERGED'
        ? 'merged'
        : event === 'pullrequest:rejected' || rawState === 'DECLINED' || rawState === 'SUPERSEDED'
          ? 'closed'
          : 'open';
    const source = obj(pr.source);
    return {
      type: 'events',
      events: [
        {
          ...b,
          kind: 'repo.pull_request',
          repository,
          number,
          title_task_keys: extractTaskKeys(str(pr.title)),
          source_branch: str(obj(source.branch).name) ?? '',
          target_branch: str(obj(obj(pr.destination).branch).name) ?? '',
          state,
          merge_sha: state === 'merged' ? (str(obj(pr.merge_commit).hash) ?? null) : null,
          head_sha: str(obj(source.commit).hash) ?? '',
          url: str(obj(obj(pr.links).html).href) ?? '',
        },
      ],
    };
  }

  return { type: 'ignored', reason: `event ${event || '(none)'} not supported` };
}
