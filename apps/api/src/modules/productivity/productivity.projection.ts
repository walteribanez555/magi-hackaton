import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { ENTITY, extractTaskKeys, keys, type ProductivityEvent, type Provenance, type RuleTrigger } from '@magicode/contracts';
import { buildUpdate, type UpdateSpec } from '../../common/utils/dynamo-expr';
import { commitUrlFromRemote } from '../task-sync/rules.engine';
import type { TriggerInput } from '../task-sync/task-sync.types';
import { filterTaskKeys } from '../webhooks/webhooks.projection';
import { normalizeDeveloper } from './productivity.filters';
import type { ChangeStatus } from './productivity.types';

/**
 * Traduce UN evento validado a operaciones DynamoDB (puro, sin I/O → testeable).
 *  - core:   dedupe (condicional, SIEMPRE índice 0) + raw event + proyecciones de la sesión/proyecto/entidad
 *  - linked: actualizaciones derivadas (estado de cambios incluidos en un commit/referencia, tags en commits)
 */

export type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

export interface ProjectionContext {
  tenant_id: string;
  key_id: string;
  table: string;
  now: string;
  /** identidad de la key (Session.key_fingerprint / key_name → integration-health api_keys) */
  key_fingerprint?: string;
  key_name?: string;
  /** prefijos Jira/Linear del proyecto (task_project_keys); null/[] ⇒ denylist NOISE_PREFIXES */
  task_prefixes?: string[] | null;
}

/** Lo que se sabe de un commit ya escrito (Dynamo o lote). */
export interface PreCommit {
  session_id: string;
  change_ids: string[];
  task_keys?: string[];
  remote_url?: string;
}

/** Estado previo leído de Dynamo (o de la caché local del lote). Claves: `${session}|${change}` y `${repo}|${sha}`. */
export interface PreState {
  changes: Map<string, ChangeStatus>;
  commits: Map<string, PreCommit>;
}

/** Disparo de reglas de write-back (task-sync fireTrigger) que genera el evento. */
export interface ProjectionTrigger {
  trigger: RuleTrigger;
  input: TriggerInput;
}

export interface Projection {
  core: TransactItem[];
  linked: TransactItem[];
  /** nuevos estados de cambios (para actualizar la caché del lote tras escribir) */
  changeStatuses: Array<{ key: string; status: ChangeStatus }>;
  /** commit escrito por git.committed (para la caché del lote) */
  commit?: { key: string; value: PreCommit };
  /** reglas a disparar DESPUÉS de escribir (commit.linked, session.started, reference.marked) */
  triggers: ProjectionTrigger[];
}

export const changeRef = (session: string, change: string) => `${session}|${change}`;
export const commitRef = (repo: string, sha: string) => `${repo}|${sha.toLowerCase()}`;

// ── Transiciones de estado ───────────────────────────────────────────────────

const RANK: Record<ChangeStatus, number> = { proposed: 0, rejected: 1, accepted: 1, committed: 2, in_reference: 3 };
export type ChangeAction = 'proposed' | 'accepted' | 'rejected' | 'committed' | 'in_reference';

/**
 * Máquina de estados monótona: nunca retrocede aunque los eventos lleguen desordenados.
 * proposed → accepted | rejected → committed → in_reference (Git manda: un rechazado que aparece en un commit pasa a committed).
 */
export function nextChangeStatus(current: ChangeStatus | undefined, action: ChangeAction): ChangeStatus {
  switch (action) {
    case 'proposed':
      return current ?? 'proposed';
    case 'accepted':
      return !current || current === 'proposed' || current === 'rejected' ? 'accepted' : current;
    case 'rejected':
      return !current || current === 'proposed' ? 'rejected' : current;
    case 'committed':
      return !current || RANK[current] < RANK.committed ? 'committed' : current;
    case 'in_reference':
      return 'in_reference';
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export const eventProvenance = (ev: ProductivityEvent): Provenance => (ev.source === 'demo-seed' ? 'simulated' : 'real');

/** Quita credenciales embebidas (https://token@host/...) de una URL remota. */
export function sanitizeRemoteUrl(u: string | undefined): string | undefined {
  if (!u) return undefined;
  try {
    const url = new URL(u);
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return u.replace(/\/\/[^@/]+@/, '//');
  }
}

const update = (table: string, Key: Record<string, string>, spec: UpdateSpec): TransactItem => ({
  Update: { TableName: table, Key, ...buildUpdate(spec) },
});

const DEDUPE_TTL_DAYS = 30;

/** Rama efectiva del evento: payload.branch (commit/sesión) o envelope.branch. */
export function eventBranch(ev: ProductivityEvent): string | undefined {
  if (ev.event_type === 'git.committed' || ev.event_type === 'session.started') return ev.payload.branch ?? ev.branch;
  return ev.branch;
}

/**
 * Tareas del evento: envelope.task_key + claves inferidas de la rama, con el MISMO filtro que los
 * webhooks (filterTaskKeys): prefijos Jira/Linear del proyecto si hay, si no denylist de ruido
 * (UTF, ISO, SHA, HTTP…) ⇒ `fix/utf-8` no crea la tarea UTF-8.
 */
export function eventTaskKeys(ev: ProductivityEvent, prefixes: string[] | null = null): string[] {
  const raw = [...(ev.task_key ? [ev.task_key] : []), ...extractTaskKeys(eventBranch(ev))];
  // tope de 5 para acotar el tamaño de la transacción
  return filterTaskKeys(raw, prefixes).slice(0, 5);
}

const union = (...lists: Array<Iterable<string> | undefined>): string[] => {
  const out = new Set<string>();
  for (const l of lists) for (const x of l ?? []) out.add(x);
  return [...out];
};

// ── Proyección ───────────────────────────────────────────────────────────────

export function projectEvent(ctx: ProjectionContext, ev: ProductivityEvent, pre: PreState): Projection {
  const { tenant_id: t, key_id, table, now } = ctx;
  const prov = eventProvenance(ev);
  const occ = ev.occurred_at;
  const branch = eventBranch(ev);
  const prefixes = ctx.task_prefixes ?? null;
  const taskKeys = eventTaskKeys(ev, prefixes);
  const primaryTask = taskKeys[0];
  const base = { tenant_id: t, key_id, provenance: prov };
  const core: TransactItem[] = [];
  const linked: TransactItem[] = [];
  const changeStatuses: Projection['changeStatuses'] = [];
  const triggers: ProjectionTrigger[] = [];
  let commitOut: Projection['commit'];
  const identity = { key_fingerprint: ctx.key_fingerprint, key_name: ctx.key_name };
  // developer (git user.email) del envelope: se guarda en Session y se copia a Change/Commit
  const developer = normalizeDeveloper(ev.developer);
  const developerName = ev.developer_name?.trim() || undefined;
  const devFields = { developer, ...(developer ? { developer_name: developerName } : {}) };

  // 0) dedupe — DEBE ser el primer elemento (se identifica por índice al cancelar la transacción)
  core.push({
    Put: {
      TableName: table,
      Item: {
        ...keys.dedupe(t, ev.event_id),
        entity: ENTITY.dedupe,
        ...base,
        event_id: ev.event_id,
        event_type: ev.event_type,
        session_id: ev.session_id,
        created_at: now,
        updated_at: now,
        expires_at: Math.floor(Date.parse(now) / 1000) + DEDUPE_TTL_DAYS * 86_400,
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    },
  });

  // 1) evento crudo (solo IDs/conteos/hashes: el contrato no admite código ni prompts)
  core.push({
    Put: {
      TableName: table,
      Item: {
        ...keys.rawEvent(t, ev.session_id, occ, ev.event_id),
        entity: ENTITY.rawEvent,
        ...base,
        event_id: ev.event_id,
        event_type: ev.event_type,
        session_id: ev.session_id,
        project_id: ev.project_id,
        repository: ev.repository,
        branch,
        task_key: primaryTask,
        occurred_at: occ,
        source: ev.source,
        event: ev,
        created_at: now,
        updated_at: now,
      },
    },
  });

  // 2) sesión: upsert en session.started, "touch" en el resto
  const sessionKey = keys.session(t, ev.session_id);
  const gsi = keys.sessionGsi1(t, ev.project_id, occ, ev.session_id);
  if (ev.event_type === 'session.started') {
    core.push(
      update(table, sessionKey, {
        set: {
          entity: ENTITY.session,
          ...base,
          session_id: ev.session_id,
          project_id: ev.project_id,
          repository: ev.repository,
          started_at: occ,
          ...gsi,
          editor: ev.payload.editor,
          extension_version: ev.payload.extension_version,
          branch,
          task_key: primaryTask,
          head_sha: ev.payload.head_sha,
          source: ev.source,
          last_activity_at: occ,
          updated_at: now,
          ...identity,
          ...devFields,
        },
        setIfNotExists: { created_at: now },
        add: { event_count: 1 },
      }),
    );
    if (taskKeys.length) {
      const sha = ev.payload.head_sha?.toLowerCase();
      triggers.push({
        trigger: 'session.started',
        input: {
          tenant_id: t,
          project_id: ev.project_id,
          task_keys: taskKeys,
          ref: `session:${ev.session_id}`,
          vars: { repository: ev.repository, ...(sha ? { sha } : {}) },
        },
      });
    }
  } else {
    core.push(
      update(table, sessionKey, {
        set: {
          last_activity_at: occ,
          updated_at: now,
          ...identity,
          ...devFields, // si un evento posterior trae el developer, la sesión lo toma
          ...(ev.event_type === 'session.ended' ? { ended_at: occ, end_reason: ev.payload.reason } : {}),
        },
        setIfNotExists: {
          entity: ENTITY.session,
          tenant_id: t,
          key_id,
          provenance: prov,
          session_id: ev.session_id,
          project_id: ev.project_id,
          repository: ev.repository,
          started_at: occ,
          ...gsi,
          branch,
          task_key: primaryTask,
          source: ev.source,
          created_at: now,
        },
        add: { event_count: 1 },
      }),
    );
  }

  // 3) proyecto
  core.push(
    update(table, keys.project(t, ev.project_id), {
      set: { entity: ENTITY.project, tenant_id: t, key_id, project_id: ev.project_id, last_activity_at: occ, updated_at: now },
      setIfNotExists: { created_at: now, provenance: prov },
      add: { repositories: new Set([ev.repository]) },
    }),
  );

  // 4) rama + enlaces a tareas (solo en eventos "fuertes" para no amplificar escrituras)
  const linkWorthy = ev.event_type === 'session.started' || ev.event_type === 'code.accepted' || ev.event_type === 'git.committed';
  if (branch && linkWorthy) {
    const isCommit = ev.event_type === 'git.committed';
    core.push(
      update(table, keys.branch(t, ev.repository, branch), {
        set: {
          entity: ENTITY.branch,
          tenant_id: t,
          key_id,
          repository: ev.repository,
          branch,
          project_id: ev.project_id,
          last_activity_at: occ,
          updated_at: now,
          ...keys.branchGsi1(t, ev.project_id, occ),
          ...(isCommit ? { head_sha: ev.payload.sha.toLowerCase() } : {}),
        },
        setIfNotExists: { created_at: now, provenance: prov },
        add: {
          session_ids: new Set([ev.session_id]),
          task_keys: new Set(taskKeys),
          ...(isCommit ? { commit_shas: new Set([ev.payload.sha.toLowerCase()]) } : {}),
        },
      }),
    );
  }
  if (linkWorthy) {
    for (const tk of taskKeys) {
      const linkBase = {
        entity: ENTITY.taskLink,
        tenant_id: t,
        key_id,
        task_key: tk,
        project_id: ev.project_id,
        repository: ev.repository,
        branch,
        updated_at: now,
      };
      const links: Array<{ kind: 'session' | 'branch' | 'commit'; id: string; extra?: Record<string, unknown> }> = [
        { kind: 'session', id: ev.session_id, extra: { session_id: ev.session_id } },
      ];
      if (branch) links.push({ kind: 'branch', id: branch });
      if (ev.event_type === 'git.committed') {
        const sha = ev.payload.sha.toLowerCase();
        links.push({ kind: 'commit', id: sha, extra: { sha, session_id: ev.session_id } });
      }
      for (const l of links) {
        core.push(
          update(table, keys.taskLink(t, tk, l.kind, l.id), {
            set: { ...linkBase, kind: l.kind, link_id: l.id, ...(l.extra ?? {}) },
            setIfNotExists: { created_at: now, linked_at: occ, provenance: prov },
          }),
        );
      }
    }
  }

  // 5) entidad específica
  const changeBase = (changeId: string, aiRequestId?: string) => ({
    entity: ENTITY.change,
    tenant_id: t,
    key_id,
    provenance: prov,
    change_id: changeId,
    session_id: ev.session_id,
    project_id: ev.project_id,
    repository: ev.repository,
    ai_request_id: aiRequestId,
    branch,
    task_key: primaryTask,
    first_seen_at: occ,
    source: ev.source,
    developer,
    created_at: now,
  });

  switch (ev.event_type) {
    case 'session.started':
    case 'session.ended':
      break;

    case 'ai.request.completed': {
      const p = ev.payload;
      core.push({
        Put: {
          TableName: table,
          Item: {
            ...keys.aiRequest(t, ev.session_id, p.ai_request_id),
            ...keys.aiRequestGsi1(t, key_id, occ),
            entity: ENTITY.aiRequest,
            ...base,
            ai_request_id: p.ai_request_id,
            session_id: ev.session_id,
            project_id: ev.project_id,
            repository: ev.repository,
            branch,
            task_key: primaryTask,
            model: p.model,
            status: p.status,
            latency_ms: p.latency_ms,
            usage: p.usage,
            usage_source: p.usage_source,
            output_hash: p.output_hash,
            regenerates: p.regenerates,
            occurred_at: occ,
            source: ev.source,
            created_at: now,
            updated_at: now,
          },
        },
      });
      break;
    }

    case 'code.proposed':
    case 'code.accepted':
    case 'code.rejected': {
      const p = ev.payload;
      const ref = changeRef(ev.session_id, p.change_id);
      const action: ChangeAction =
        ev.event_type === 'code.proposed' ? 'proposed' : ev.event_type === 'code.accepted' ? 'accepted' : 'rejected';
      const status = nextChangeStatus(pre.changes.get(ref), action);
      const set: Record<string, unknown> = { status, status_rank: RANK[status], updated_at: now, developer };
      if (ev.event_type === 'code.proposed') {
        Object.assign(set, {
          proposed_at: occ,
          proposed_files: ev.payload.files,
          proposed_added_lines: ev.payload.files.reduce((a, f) => a + f.added, 0),
          proposed_patch_hash: ev.payload.patch_hash,
        });
      } else if (ev.event_type === 'code.accepted') {
        Object.assign(set, {
          accepted_at: occ,
          accepted_files: ev.payload.files,
          accepted_added_lines: ev.payload.accepted_added_lines,
          accepted_deleted_lines: ev.payload.accepted_deleted_lines,
          patch_hash: ev.payload.patch_hash,
          dimensions: ev.payload.dimensions,
        });
      } else {
        Object.assign(set, { rejected_at: occ, reject_reason: ev.payload.reason });
      }
      core.push(
        update(table, keys.change(t, ev.session_id, p.change_id), {
          set,
          setIfNotExists: changeBase(p.change_id, p.ai_request_id),
        }),
      );
      changeStatuses.push({ key: ref, status });
      break;
    }

    case 'git.committed': {
      const p = ev.payload;
      const sha = p.sha.toLowerCase();
      const ref = commitRef(ev.repository, sha);
      const prev = pre.commits.get(ref);
      const remoteUrl = sanitizeRemoteUrl(p.remote_url) ?? prev?.remote_url;
      // claves del IDE ∪ las que ya escribió el push (mensaje/rama), filtradas igual
      const commitKeys = filterTaskKeys(union(taskKeys, prev?.task_keys), prefixes);
      // UpdateItem (no Put): solo campos del IDE; verified_remote / remote_* / remote_only /
      // reference_tags del webhook push o de reference.marked se conservan.
      core.push(
        update(table, keys.commit(t, ev.repository, sha), {
          set: {
            ...keys.commitGsi1(t, ev.session_id, p.committed_at),
            entity: ENTITY.commit,
            ...base,
            sha,
            repository: ev.repository,
            session_id: ev.session_id,
            project_id: ev.project_id,
            branch,
            task_keys: commitKeys.length ? commitKeys : undefined,
            parent_sha: p.parent_sha,
            committed_at: p.committed_at,
            files: p.files,
            change_ids: p.change_ids,
            automation: p.automation,
            has_session_trailer: p.has_session_trailer,
            remote_url: sanitizeRemoteUrl(p.remote_url),
            developer,
            commit_source: p.source,
            occurred_at: occ,
            source: ev.source,
            ide_reported_at: now,
            updated_at: now,
          },
          setIfNotExists: { created_at: now },
        }),
      );
      commitOut = { key: ref, value: { session_id: ev.session_id, change_ids: p.change_ids, task_keys: commitKeys, remote_url: remoteUrl } };
      if (p.change_ids.length && commitKeys.length) {
        const commitUrl = commitUrlFromRemote(remoteUrl, sha);
        triggers.push({
          trigger: 'commit.linked',
          input: {
            tenant_id: t,
            project_id: ev.project_id,
            task_keys: commitKeys,
            ref: `commit:${ev.repository}:${sha}`,
            vars: { sha, repository: ev.repository, ...(commitUrl ? { commit_url: commitUrl } : {}) },
          },
        });
      }
      // Cambios incluidos → committed (se crean como "stub" si el accepted aún no llegó).
      for (const changeId of new Set(p.change_ids)) {
        const ref = changeRef(ev.session_id, changeId);
        const status = nextChangeStatus(pre.changes.get(ref), 'committed');
        linked.push(
          update(table, keys.change(t, ev.session_id, changeId), {
            set: { status, status_rank: RANK[status], commit_sha: sha, updated_at: now },
            setIfNotExists: { ...changeBase(changeId), committed_at: p.committed_at },
          }),
        );
        changeStatuses.push({ key: ref, status });
      }
      break;
    }

    case 'reference.marked': {
      const p = ev.payload;
      core.push({
        Put: {
          TableName: table,
          Item: {
            ...keys.reference(t, ev.repository, p.tag),
            entity: ENTITY.reference,
            ...base,
            tag: p.tag,
            sha: p.sha,
            kind: p.kind,
            evidence_url: p.evidence_url,
            included_shas: p.included_shas,
            surviving_lines: p.surviving_lines,
            surviving_effective_lines: p.surviving_effective_lines,
            session_id: ev.session_id,
            project_id: ev.project_id,
            repository: ev.repository,
            branch,
            occurred_at: occ,
            source: ev.source,
            created_at: now,
            updated_at: now,
          },
        },
      });
      const deployed = p.kind === 'deployment';
      const touched = new Set<string>(); // un mismo cambio puede venir en 2 commits: 1 sola operación por ítem
      const refKeys: string[] = [...taskKeys];
      let remoteUrl: string | undefined;
      for (const sha of new Set(p.included_shas.map((s) => s.toLowerCase()))) {
        const commit = pre.commits.get(commitRef(ev.repository, sha));
        if (!commit) continue; // commit desconocido (de otra sesión/no reportado): no se crean stubs
        refKeys.push(...(commit.task_keys ?? []));
        remoteUrl ??= commit.remote_url;
        linked.push(
          update(table, keys.commit(t, ev.repository, sha), {
            set: { updated_at: now },
            add: { reference_tags: new Set([p.tag]) },
          }),
        );
        for (const changeId of new Set(commit.change_ids)) {
          const ref = changeRef(commit.session_id, changeId);
          if (!pre.changes.has(ref) || touched.has(ref)) continue;
          touched.add(ref);
          const status = nextChangeStatus(pre.changes.get(ref), 'in_reference');
          linked.push(
            update(table, keys.change(t, commit.session_id, changeId), {
              set: { status, status_rank: RANK[status], updated_at: now },
              setIfNotExists: { in_reference_at: occ, ...(deployed ? { deployed_at: occ } : {}) },
              add: { reference_tags: new Set([p.tag]) },
            }),
          );
          changeStatuses.push({ key: ref, status });
        }
      }
      const tagKeys = filterTaskKeys(refKeys, prefixes);
      if (tagKeys.length) {
        const sha = p.sha.toLowerCase();
        const commitUrl = commitUrlFromRemote(remoteUrl, sha);
        triggers.push({
          trigger: 'reference.marked',
          input: {
            tenant_id: t,
            project_id: ev.project_id,
            task_keys: tagKeys,
            ref: `ref:${ev.repository}:${p.tag}`,
            vars: { sha, repository: ev.repository, ...(commitUrl ? { commit_url: commitUrl } : {}) },
          },
        });
      }
      break;
    }
  }

  return { core, linked, changeStatuses, triggers, ...(commitOut ? { commit: commitOut } : {}) };
}
