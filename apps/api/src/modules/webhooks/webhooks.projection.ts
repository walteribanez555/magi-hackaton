import { ENTITY, extractTaskKeys, keys, type NormalizedWebhookEvent, type RuleTrigger } from '@magicode/contracts';
import { commitUrl } from '../task-sync/rules.engine';
import type { TriggerInput } from '../task-sync/task-sync.types';
import { webhooksRepository, type Item, type WebhooksRepository } from './webhooks.repository';

type Ev<K extends NormalizedWebhookEvent['kind']> = Extract<NormalizedWebhookEvent, { kind: K }>;

export interface ProjectionContext {
  tenant_id: string;
  key_id: string;
  project_id: string;
  integration_id: string;
  /** repo canónico de la integración ("org/repo" tal como lo configuró el usuario) */
  repository?: string;
  /** prefijos de proyecto de tareas permitidos (Jira/Linear de este proyecto); null ⇒ sin filtro (denylist) */
  task_prefixes: string[] | null;
  now: string;
}

export interface ProjectionTrigger {
  trigger: RuleTrigger;
  input: Omit<TriggerInput, 'tenant_id' | 'project_id'>;
}

export interface ProjectionResult {
  kind: NormalizedWebhookEvent['kind'];
  task_keys: string[];
  note?: string;
  /** disparos de reglas de write-back que generó este evento (los ejecuta webhooks.service) */
  triggers?: ProjectionTrigger[];
}

/** Máximo de commits por push que se proyectan (GitHub manda hasta 2048; Bitbucket ~5 por change). */
export const MAX_COMMITS_PER_PUSH = 200;

/** Ramas "largas" a las que no se les acumulan las tareas de cada commit (solo las de su nombre). */
const LONG_LIVED = /^(main|master|develop|development|dev|trunk|staging|production|prod|release\/.+|hotfix\/.+)$/i;

/** Falsos positivos típicos de TASK_KEY_RE en mensajes en mayúsculas ("UTF-8", "SHA-256"…). */
const NOISE_PREFIXES = new Set(['UTF', 'SHA', 'ISO', 'RFC', 'HTTP', 'TLS', 'SSL', 'UTC', 'GMT', 'ES', 'ECMA', 'PEP', 'CVE', 'MD', 'AES', 'RSA', 'X86', 'ARM', 'WIN', 'IE', 'V', 'H']);

const ZERO_AUTOMATION = { commit_added_lines: 0, ai_matched_lines: 0, ai_share: 0, ai_lost_lines: 0, effective_lines: 0 };

/** Filtra claves: si el proyecto tiene Jira/Linear configurado, solo sus prefijos; si no, quita ruido conocido. */
export function filterTaskKeys(taskKeys: Iterable<string>, prefixes: string[] | null): string[] {
  const out = new Set<string>();
  for (const k of taskKeys) {
    const prefix = k.split('-')[0]!;
    if (prefixes && prefixes.length ? prefixes.includes(prefix) : !NOISE_PREFIXES.has(prefix)) out.add(k);
  }
  return [...out];
}

const asArray = (v: unknown): string[] =>
  v instanceof Set ? [...(v as Set<string>)] : Array.isArray(v) ? (v as string[]) : [];

const union = (...lists: Array<Iterable<string> | undefined>): string[] => {
  const s = new Set<string>();
  for (const l of lists) for (const x of l ?? []) s.add(x);
  return [...s];
};

/**
 * Proyecta eventos normalizados al single-table (keys.ts). Solo campos normalizados:
 * nunca payloads, mensajes de commit, código ni diffs. Escrituras idempotentes (UpdateItem con
 * if_not_exists / ADD de Sets), así que un reintento tras un fallo parcial no duplica nada.
 */
export class WebhookProjector {
  constructor(private readonly repo: WebhooksRepository = webhooksRepository) {}

  async project(ev: NormalizedWebhookEvent, ctx: ProjectionContext): Promise<ProjectionResult> {
    switch (ev.kind) {
      case 'repo.push':
        return this.push(ev, ctx);
      case 'repo.branch':
        return this.branch(ev, ctx);
      case 'repo.tag':
        return this.tag(ev, ctx);
      case 'repo.pull_request':
        return this.pullRequest(ev, ctx);
      case 'repo.deployment':
        return this.deployment(ev, ctx);
      case 'task.upserted':
        return this.taskUpserted(ev, ctx);
      case 'task.deleted':
        return this.taskDeleted(ev, ctx);
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private repoOf(ctx: ProjectionContext, ev: { repository: string }): string {
    return ctx.repository ?? ev.repository;
  }

  private base(ctx: ProjectionContext) {
    return { tenant_id: ctx.tenant_id, key_id: ctx.key_id, project_id: ctx.project_id, updated_at: ctx.now };
  }

  private link(
    ctx: ProjectionContext,
    taskKey: string,
    kind: 'branch' | 'session' | 'commit' | 'pr' | 'deployment',
    id: string,
    fields: Record<string, unknown>,
    linkedAt: string,
    extraIfNotExists: Record<string, unknown> = {},
  ) {
    return this.repo.update(keys.taskLink(ctx.tenant_id, taskKey, kind, id), {
      set: { entity: ENTITY.taskLink, ...this.base(ctx), task_key: taskKey, kind, link_id: id, source: 'git-remote', ...fields },
      setIfNotExists: { created_at: ctx.now, linked_at: linkedAt, provenance: 'real', ...extraIfNotExists },
    });
  }

  private upsertBranch(
    ctx: ProjectionContext,
    repository: string,
    branch: string,
    at: string,
    set: Record<string, unknown>,
    add: { task_keys?: string[]; commit_shas?: string[] } = {},
  ) {
    return this.repo.update(keys.branch(ctx.tenant_id, repository, branch), {
      set: {
        entity: ENTITY.branch,
        ...this.base(ctx),
        repository,
        branch,
        last_activity_at: at,
        ...keys.branchGsi1(ctx.tenant_id, ctx.project_id, at),
        ...set,
      },
      setIfNotExists: { created_at: ctx.now, provenance: 'real' },
      add: {
        ...(add.task_keys?.length ? { task_keys: new Set(add.task_keys) } : {}),
        ...(add.commit_shas?.length ? { commit_shas: new Set(add.commit_shas) } : {}),
      },
    });
  }

  // ── repo.push ───────────────────────────────────────────────────────────

  private async push(ev: Ev<'repo.push'>, ctx: ProjectionContext): Promise<ProjectionResult> {
    const t = ctx.tenant_id;
    const R = this.repoOf(ctx, ev);
    const branchKeys = filterTaskKeys(extractTaskKeys(ev.branch), ctx.task_prefixes);
    const commits = ev.commits.slice(0, MAX_COMMITS_PER_PUSH);

    const existing = new Map<string, Item>();
    for (const it of await this.repo.batchGet(commits.map((c) => keys.commit(t, R, c.sha)))) {
      existing.set(String(it.sha ?? '').toLowerCase(), it);
    }

    const allKeys = new Set(branchKeys);
    const sessionLinks = new Set<string>();
    const writes: Array<Promise<unknown>> = [];
    for (const c of commits) {
      const commitKeys = filterTaskKeys(union(c.message_task_keys, branchKeys), ctx.task_prefixes);
      commitKeys.forEach((k) => allKeys.add(k));
      const ex = existing.get(c.sha.toLowerCase());
      const mergedKeys = union(asArray(ex?.task_keys), commitKeys);

      writes.push(
        this.repo.update(keys.commit(t, R, c.sha), {
          set: {
            verified_remote: true,
            remote_pushed_at: ev.received_at,
            remote_branch: ev.branch,
            remote_files: { added: c.files_added, modified: c.files_modified, removed: c.files_removed },
            ...(c.author_login ? { remote_author_login: c.author_login } : {}),
            ...(c.session_id ? { remote_session_id: c.session_id } : {}),
            ...(mergedKeys.length ? { task_keys: mergedKeys } : {}),
            updated_at: ctx.now,
          },
          // El IDE nunca lo reportó → commit mínimo "solo remoto" (sin automation real: 0 líneas IA)
          setIfNotExists: ex
            ? {}
            : {
                entity: ENTITY.commit,
                tenant_id: t,
                key_id: ctx.key_id,
                project_id: ctx.project_id,
                repository: R,
                sha: c.sha,
                branch: ev.branch,
                session_id: c.session_id ?? '',
                committed_at: c.timestamp,
                occurred_at: c.timestamp,
                files: [],
                change_ids: [],
                automation: ZERO_AUTOMATION,
                has_session_trailer: c.has_session_trailer,
                commit_source: 'git-remote',
                remote_only: true,
                provenance: 'real',
                created_at: ctx.now,
                ...(c.session_id ? keys.commitGsi1(t, c.session_id, c.timestamp) : {}),
              },
        }),
      );

      for (const k of commitKeys) {
        writes.push(
          this.link(
            ctx,
            k,
            'commit',
            c.sha,
            {
              repository: R,
              branch: ev.branch,
              sha: c.sha,
              verified_remote: true,
              ...(c.session_id ? { session_id: c.session_id } : {}),
            },
            c.timestamp,
          ),
        );
        if (c.session_id && !sessionLinks.has(`${k}|${c.session_id}`)) {
          sessionLinks.add(`${k}|${c.session_id}`);
          writes.push(this.link(ctx, k, 'session', c.session_id, { repository: R, branch: ev.branch, session_id: c.session_id }, c.timestamp));
        }
      }
    }

    const branchTaskKeys = LONG_LIVED.test(ev.branch) ? branchKeys : [...allKeys];
    writes.push(
      this.upsertBranch(
        ctx,
        R,
        ev.branch,
        ev.received_at,
        { head_sha: ev.after, deleted: false, verified_remote: true },
        { task_keys: branchTaskKeys, commit_shas: commits.map((c) => c.sha) },
      ),
    );
    for (const k of branchTaskKeys) {
      writes.push(this.link(ctx, k, 'branch', ev.branch, { repository: R, branch: ev.branch, head_sha: ev.after }, ev.received_at));
    }
    await Promise.all(writes);
    return {
      kind: ev.kind,
      task_keys: [...allKeys],
      ...(ev.commits.length > MAX_COMMITS_PER_PUSH ? { note: `truncated to ${MAX_COMMITS_PER_PUSH} commits` } : {}),
    };
  }

  // ── repo.branch ─────────────────────────────────────────────────────────

  private async branch(ev: Ev<'repo.branch'>, ctx: ProjectionContext): Promise<ProjectionResult> {
    const R = this.repoOf(ctx, ev);
    if (ev.action === 'deleted') {
      await this.upsertBranch(ctx, R, ev.branch, ev.received_at, { deleted: true, deleted_at: ev.received_at });
      return { kind: ev.kind, task_keys: [] };
    }
    const taskKeys = filterTaskKeys(extractTaskKeys(ev.branch), ctx.task_prefixes);
    await Promise.all([
      this.upsertBranch(ctx, R, ev.branch, ev.received_at, { deleted: false, verified_remote: true }, { task_keys: taskKeys }),
      ...taskKeys.map((k) => this.link(ctx, k, 'branch', ev.branch, { repository: R, branch: ev.branch }, ev.received_at)),
    ]);
    return { kind: ev.kind, task_keys: taskKeys };
  }

  // ── repo.tag: SOLO verifica una Reference existente (nunca crea "versiones demo") ──

  private async tag(ev: Ev<'repo.tag'>, ctx: ProjectionContext): Promise<ProjectionResult> {
    const R = this.repoOf(ctx, ev);
    const created = ev.action === 'created';
    const found = await this.repo.update(
      keys.reference(ctx.tenant_id, R, ev.tag),
      {
        set: {
          verified_remote: created,
          remote_sha: ev.sha,
          remote_verified_at: ev.received_at,
          ...(created ? {} : { remote_deleted_at: ev.received_at }),
          updated_at: ctx.now,
        },
      },
      { expression: 'attribute_exists(PK)' },
    );
    if (!found) return { kind: ev.kind, task_keys: [], note: 'no reference marked for this tag' };
    if (!created) return { kind: ev.kind, task_keys: [] };
    // la tarea entra en una versión de referencia verificada en el remoto → reference.marked
    const ref = await this.repo.get(keys.reference(ctx.tenant_id, R, ev.tag));
    const shas = asArray(ref?.included_shas).slice(0, 100);
    const commits = shas.length ? await this.repo.batchGet(shas.map((sha) => keys.commit(ctx.tenant_id, R, sha))) : [];
    const taskKeys = filterTaskKeys(commits.flatMap((c) => asArray(c.task_keys)), ctx.task_prefixes);
    return {
      kind: ev.kind,
      task_keys: taskKeys,
      triggers: taskKeys.length
        ? [{ trigger: 'reference.marked', input: { task_keys: taskKeys, ref: `ref:${R}:${ev.tag}`, vars: { sha: ev.sha, repository: R, commit_url: commitUrl(ev.provider, R, ev.sha) } } }]
        : [],
    };
  }

  // ── repo.pull_request ───────────────────────────────────────────────────

  private async pullRequest(ev: Ev<'repo.pull_request'>, ctx: ProjectionContext): Promise<ProjectionResult> {
    const t = ctx.tenant_id;
    const R = this.repoOf(ctx, ev);
    const prKey = keys.pullRequest(t, R, ev.number);
    const ex = await this.repo.get(prKey);
    // monótono: un PR fusionado no vuelve a open/closed por una entrega desordenada
    const state = ex?.state === 'merged' ? 'merged' : ev.state;
    const mergeSha = state === 'merged' ? (ev.merge_sha ?? (ex?.merge_sha as string | null | undefined) ?? null) : null;
    const taskKeys = filterTaskKeys(
      union(asArray(ex?.task_keys), ev.title_task_keys, extractTaskKeys(ev.source_branch)),
      ctx.task_prefixes,
    );
    const writes: Array<Promise<unknown>> = [
      this.repo.update(prKey, {
        set: {
          entity: ENTITY.pullRequest,
          ...this.base(ctx),
          provider: ev.provider,
          repository: R,
          number: ev.number,
          state,
          source_branch: ev.source_branch,
          target_branch: ev.target_branch,
          merge_sha: mergeSha,
          head_sha: ev.head_sha || (ex?.head_sha as string | undefined) || '',
          url: ev.url,
          task_keys: taskKeys,
          last_event_at: ev.received_at,
          ...keys.pullRequestGsi1(t, ctx.project_id, ev.received_at),
        },
        setIfNotExists: {
          created_at: ctx.now,
          opened_at: ev.received_at,
          provenance: 'real',
          ...(state === 'merged' ? { merged_at: ev.received_at } : {}),
          ...(state === 'closed' ? { closed_at: ev.received_at } : {}),
        },
      }),
    ];
    const id = `${R}:${ev.number}`;
    for (const k of taskKeys) {
      writes.push(
        this.link(
          ctx,
          k,
          'pr',
          id,
          {
            repository: R,
            number: ev.number,
            state,
            url: ev.url,
            source_branch: ev.source_branch,
            target_branch: ev.target_branch,
            merge_sha: mergeSha,
          },
          ev.received_at,
        ),
      );
    }
    if (state === 'merged' && ev.source_branch) {
      writes.push(
        this.upsertBranch(ctx, R, ev.source_branch, ev.received_at, { merged_into: ev.target_branch, merged_at: ev.received_at }, { task_keys: taskKeys }),
      );
    }
    await Promise.all(writes);
    const triggers: ProjectionTrigger[] = [];
    const prVars = { pr_url: ev.url, repository: R };
    if (!ex && state === 'open') {
      triggers.push({
        trigger: 'pr.opened',
        input: { task_keys: taskKeys, ref: `pr:${R}:${ev.number}`, target_branch: ev.target_branch, vars: { ...prVars, sha: ev.head_sha } },
      });
    }
    if (state === 'merged' && ex?.state !== 'merged') {
      const sha = mergeSha ?? ev.head_sha;
      triggers.push({
        trigger: 'pr.merged',
        input: {
          task_keys: taskKeys,
          ref: `pr-merged:${R}:${ev.number}`,
          target_branch: ev.target_branch,
          vars: { ...prVars, sha, commit_url: commitUrl(ev.provider, R, sha) },
        },
      });
    }
    return { kind: ev.kind, task_keys: taskKeys, triggers };
  }

  // ── repo.deployment: SOLO state=success es evidencia de despliegue ─────────

  private async deployment(ev: Ev<'repo.deployment'>, ctx: ProjectionContext): Promise<ProjectionResult> {
    const t = ctx.tenant_id;
    const R = this.repoOf(ctx, ev);
    const depKey = keys.deployment(t, R, ev.deployment_id);
    const [ex, commit, prs] = await Promise.all([
      this.repo.get(depKey),
      this.repo.get(keys.commit(t, R, ev.sha)),
      this.repo.queryPrefix(keys.repoPk(t, R), 'PR#', { limit: 500 }),
    ]);
    // `success` es terminal: un `inactive` posterior (lo reemplazó otro deploy) o una entrega
    // desordenada no borran la evidencia; el último estado crudo queda en `latest_state`.
    const state = ex?.state === 'success' ? 'success' : ev.state;
    const deployed = state === 'success';
    const sha = ev.sha.toLowerCase();
    const prKeys = prs
      .filter((p) => [p.merge_sha, p.head_sha].some((s) => typeof s === 'string' && s && (sha.startsWith(s.toLowerCase()) || s.toLowerCase().startsWith(sha))))
      .flatMap((p) => asArray(p.task_keys));
    const taskKeys = filterTaskKeys(union(asArray(commit?.task_keys), prKeys, extractTaskKeys(ev.ref)), ctx.task_prefixes);

    const writes: Array<Promise<unknown>> = [
      this.repo.update(depKey, {
        set: {
          entity: ENTITY.deployment,
          ...this.base(ctx),
          provider: ev.provider,
          repository: R,
          deployment_id: ev.deployment_id,
          sha: ev.sha,
          ref: ev.ref,
          environment: ev.environment,
          state,
          latest_state: ev.state,
          url: ev.url,
          evidence_url: deployed ? (ev.url ?? (ex?.evidence_url as string | undefined)) : undefined,
          deployed,
          task_keys: taskKeys.length ? taskKeys : undefined,
          source: 'deployment-evidence',
          provenance: 'real',
          last_event_at: ev.received_at,
          ...keys.deploymentGsi1(t, R, ev.sha, ev.received_at),
        },
        setIfNotExists: { created_at: ctx.now, ...(ev.state === 'success' ? { succeeded_at: ev.received_at } : {}) },
      }),
    ];
    for (const k of taskKeys) {
      writes.push(
        this.link(
          ctx,
          k,
          'deployment',
          `${R}:${ev.deployment_id}`,
          { repository: R, deployment_id: ev.deployment_id, sha: ev.sha, environment: ev.environment, state, deployed, url: ev.url, source: 'deployment-evidence' },
          ev.received_at,
          ev.state === 'success' ? { succeeded_at: ev.received_at } : {},
        ),
      );
    }
    await Promise.all(writes);
    const firstSuccess = ev.state === 'success' && ex?.state !== 'success';
    return {
      kind: ev.kind,
      task_keys: taskKeys,
      ...(deployed ? {} : { note: `state ${ev.state} is not deployment evidence` }),
      triggers: firstSuccess
        ? [
            {
              trigger: 'deployment.success',
              input: {
                task_keys: taskKeys,
                ref: `deploy:${R}:${ev.deployment_id}`,
                environment: ev.environment,
                vars: { sha: ev.sha, environment: ev.environment, repository: R, commit_url: commitUrl(ev.provider, R, ev.sha) },
              },
            },
          ]
        : [],
    };
  }

  // ── tareas ──────────────────────────────────────────────────────────────

  private async taskUpserted(ev: Ev<'task.upserted'>, ctx: ProjectionContext): Promise<ProjectionResult> {
    const t = ctx.tenant_id;
    const applied = await this.repo.update(
      keys.task(t, ev.task_key),
      {
        set: {
          entity: ENTITY.task,
          ...this.base(ctx),
          provider: ev.provider,
          integration_id: ev.integration_id,
          task_key: ev.task_key,
          title: ev.title,
          type: ev.type ?? null,
          status: ev.status,
          status_category: ev.status_category,
          assignee: ev.assignee ?? null,
          story_points: ev.story_points ?? null,
          url: ev.url ?? null,
          source_updated_at: ev.updated_at,
          deleted: false,
          ...keys.taskGsi1(t, ctx.project_id, ev.updated_at),
        },
        setIfNotExists: { created_at: ctx.now, provenance: 'real' },
      },
      // entregas desordenadas: no se pisa una versión más nueva de la tarea
      {
        expression: 'attribute_not_exists(#csu) OR #csu <= :csu',
        names: { '#csu': 'source_updated_at' },
        values: { ':csu': ev.updated_at },
      },
    );
    return { kind: ev.kind, task_keys: [ev.task_key], ...(applied ? {} : { note: 'stale update ignored' }) };
  }

  private async taskDeleted(ev: Ev<'task.deleted'>, ctx: ProjectionContext): Promise<ProjectionResult> {
    const found = await this.repo.update(
      keys.task(ctx.tenant_id, ev.task_key),
      { set: { deleted: true, deleted_at: ev.received_at, updated_at: ctx.now } },
      { expression: 'attribute_exists(PK)' },
    );
    return { kind: ev.kind, task_keys: [ev.task_key], ...(found ? {} : { note: 'task not found' }) };
  }
}

export const webhookProjector = new WebhookProjector();
