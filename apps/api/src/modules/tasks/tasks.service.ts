import { TaskKey, type Criticality, type Provenance, type TaskListItem } from '@magicode/contracts';
import { config } from '../../config/config';
import { createLogger } from '../../config/logger';
import { BadRequestException, NotFoundException } from '../../common/exceptions';
import { isCommitDeployed, isProductionEnvironment, type DeployEvidenceRef, type DeployPrRef } from '../../common/utils/deployment-evidence';
import { DAY_MS, iso } from '../../common/utils/time';
import { acceptedNonTrivial, allocateUsage, worst } from '../productivity/productivity.metrics';
import { productivityRepository } from '../productivity/productivity.repository';
import type { AiRequestItem, ChangeItem, UsageInput } from '../productivity/productivity.types';
import { usageService } from '../usage/usage.service';
import { branchesRepository, type BranchesRepository } from '../branches/branches.repository';
import { asArray, toBranchListItem } from '../branches/branches.service';
import { pullRequestsService, type PullRequestsService } from '../pull-requests/pull-requests.service';
import { pullRequestsRepository, type PullRequestsRepository } from '../pull-requests/pull-requests.repository';
import type { Item } from '../webhooks/webhooks.repository';
import { tasksRepository, type TasksRepository } from './tasks.repository';
import type {
  TaskCommitView,
  TaskDeploymentView,
  TaskDetail,
  TaskItem,
  TaskLinkItem,
  TaskMetrics,
  TaskQuery,
  TaskSessionView,
} from './tasks.types';

const logger = createLogger('Tasks');

const ACCEPTED = new Set(['accepted', 'committed', 'in_reference']);
const CRITICALITY: Criticality[] = ['low', 'medium', 'high', 'critical'];
/** Tope de tareas por proyecto en el listado (cada una cuesta 1 Query de links + sesiones). */
export const MAX_TASKS_PER_PROJECT = 200;

type SessionRows = { requests: Item[]; changes: Item[] };

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const s = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** ¿La fila (petición/cambio) cuenta para la tarea? La de la tarea, o sin tarea en una sesión enlazada. */
const belongs = (row: Item, taskKey: string) => !row.task_key || row.task_key === taskKey;

/** Peticiones de la tarea en sus sesiones enlazadas (las de la tarea o sin tarea). */
export const taskRequests = (taskKey: string, sessions: SessionRows[]): Item[] =>
  sessions.flatMap((s) => s.requests.filter((r) => belongs(r, taskKey)));

/**
 * Tokens / líneas de una tarea a partir de las sesiones enlazadas. `tokens` (si viene) es la
 * imputación de la API de consumo (allocateTaskTokens); si no, Σ usage reportado ⇒ `estimated`
 * (o `simulated` si cualquier petición viene del mock). accepted_lines = no triviales (§2.5).
 */
export function aggregateTaskMetrics(taskKey: string, sessions: SessionRows[], allocated?: TaskMetrics['tokens']): TaskMetrics {
  let tokens = 0;
  let simulated = false;
  let accepted = 0;
  let effective = 0;
  let crit = -1;
  for (const { requests, changes } of sessions) {
    for (const r of requests) {
      if (!belongs(r, taskKey)) continue;
      const usage = (r.usage ?? {}) as { total_tokens?: number };
      tokens += n(usage.total_tokens);
      if (r.provenance === 'simulated' || r.usage_source === 'magihub-mock') simulated = true;
    }
    for (const c of changes) {
      if (!belongs(c, taskKey) || !ACCEPTED.has(String(c.status))) continue;
      accepted += acceptedNonTrivial(c as unknown as ChangeItem).lines;
      effective += n((c.dimensions as { effective_lines?: number } | undefined)?.effective_lines);
      const level = CRITICALITY.indexOf((c.scores as { criticality?: Criticality } | undefined)?.criticality as Criticality);
      if (level > crit) crit = level;
    }
  }
  return {
    tokens: allocated ?? { value: sessions.length ? tokens : null, provenance: simulated ? 'simulated' : 'estimated' },
    accepted_lines: accepted,
    effective_lines: Math.round(effective * 100) / 100,
    criticality: crit >= 0 ? CRITICALITY[crit]! : null,
  };
}

/** Fuente de consumo para imputar tokens a una tarea (inyectable en tests). */
export interface TaskUsageSource {
  /** snapshots guardados de la key (sin ir a MagiHub); null si nunca se sincronizó */
  cachedWindow(t: string, keyId: string, from: string, to: string): Promise<UsageInput | null>;
  /** todas las peticiones de la key en [from, to] (denominador del prorrateo hora/día) */
  requestsOfKey(t: string, keyId: string, from: string, to: string): Promise<AiRequestItem[]>;
  mode(): 'real' | 'mock' | 'bedrock';
}

export const defaultTaskUsageSource: TaskUsageSource = {
  cachedWindow: (t, k, from, to) => usageService.cachedWindow(t, k, from, to),
  requestsOfKey: (t, k, from, to) => productivityRepository.listRequestsOfKey(t, k, from, to),
  mode: () => config.getValue('magihub').mode,
};

/**
 * TaskListItem.tokens con el MISMO método que el summary?task_key (productivity.metrics →
 * allocateUsage): por cada key de las peticiones de la tarea, snapshots de la API de consumo en la
 * ventana [día de la 1ª petición, fin del día de la última] imputados por request_id o prorrateados
 * por ventana hora/día; sin snapshots ⇒ Σ usage reportado (estimated). Se suma por key.
 */
export async function allocateTaskTokens(
  t: string,
  requests: Item[],
  hasSessions: boolean,
  source: TaskUsageSource,
): Promise<TaskMetrics['tokens']> {
  if (!hasSessions) return { value: null, provenance: 'estimated' };
  const byKey = new Map<string, AiRequestItem[]>();
  for (const r of requests) {
    const k = typeof r.key_id === 'string' ? r.key_id : '';
    byKey.set(k, [...(byKey.get(k) ?? []), r as unknown as AiRequestItem]);
  }
  const mode = source.mode();
  let value = 0;
  const provs: Provenance[] = [];
  for (const [keyId, reqs] of byKey) {
    const times = reqs.map((r) => Date.parse(String(r.occurred_at ?? ''))).filter(Number.isFinite);
    let usage: UsageInput | null = null;
    let keyRequests: AiRequestItem[] | undefined;
    if (keyId && times.length) {
      const from = iso(Math.floor(Math.min(...times) / DAY_MS) * DAY_MS);
      const to = iso(Math.floor(Math.max(...times) / DAY_MS) * DAY_MS + DAY_MS - 1);
      try {
        usage = await source.cachedWindow(t, keyId, from, to);
        if (usage && usage.granularity !== 'request') keyRequests = await source.requestsOfKey(t, keyId, from, to);
      } catch (err) {
        logger.warn('Snapshots de usage no disponibles para la tarea; se usa Σ reportado', { error: err instanceof Error ? err.message : String(err) });
        usage = null;
      }
    }
    const { total } = allocateUsage({ usage, magihubMode: mode, requests: reqs, keyRequests, scoped: true });
    value += total.value ?? 0;
    provs.push(total.provenance);
  }
  return { value, provenance: provs.length ? worst(...provs) : mode === 'mock' ? 'simulated' : 'estimated' };
}

/** Datos por repo para la regla de despliegue (cacheados durante un listado). */
type RepoEvidence = { deployments: DeployEvidenceRef[]; prs: DeployPrRef[] };

const sessionIdsOf = (links: TaskLinkItem[]): string[] =>
  [...new Set(links.filter((l) => l.kind === 'session').map((l) => l.session_id ?? l.link_id))].filter(Boolean);

export function buildTaskListItem(
  taskKey: string,
  projectId: string,
  task: TaskItem | null,
  links: TaskLinkItem[],
  metrics: TaskMetrics,
  deployed = false,
): TaskListItem {
  const byKind = (k: TaskLinkItem['kind']) => links.filter((l) => l.kind === k);
  const prs = byKind('pr');
  const lastLink = links.map((l) => l.updated_at ?? '').sort().at(-1);
  return {
    task_key: taskKey,
    project_id: task?.project_id ?? projectId,
    title: task?.title ?? taskKey,
    status: task?.status ?? 'untracked',
    status_category: task?.status_category ?? 'todo',
    assignee: task?.assignee ?? null,
    story_points: typeof task?.story_points === 'number' ? task.story_points : null,
    url: task?.url ?? null,
    branches: [...new Set(byKind('branch').map((l) => l.branch ?? l.link_id))].sort(),
    sessions: sessionIdsOf(links).length,
    commits: new Set(byKind('commit').map((l) => l.sha ?? l.link_id)).size,
    pull_requests: prs
      .map((l) => ({ number: n(l.number), state: l.state ?? 'open', url: l.url ?? '' }))
      .sort((a, b) => a.number - b.number),
    tokens: metrics.tokens,
    accepted_lines: metrics.accepted_lines,
    effective_lines: metrics.effective_lines,
    deployed,
    updated_at: task?.source_updated_at ?? task?.updated_at ?? lastLink ?? '',
  };
}

export class TasksService {
  constructor(
    private readonly repo: TasksRepository = tasksRepository,
    private readonly branches: BranchesRepository = branchesRepository,
    private readonly prRepo: PullRequestsRepository = pullRequestsRepository,
    private readonly prService: PullRequestsService = pullRequestsService,
    private readonly usageSource: TaskUsageSource = defaultTaskUsageSource,
  ) {}

  /**
   * TaskListItem.deployed — misma regla que la etapa `deployed` del embudo: algún commit enlazado
   * (TaskLink kind=commit: repo, sha, rama) tiene Deployment success de su SHA o del merge/head de
   * un PR cuya rama origen lo contiene.
   */
  async deployedFor(tenantId: string, links: TaskLinkItem[], cache: Map<string, Promise<RepoEvidence>> = new Map()): Promise<boolean> {
    const refs = links
      .filter((l) => l.kind === 'commit' && l.repository)
      .map((l) => ({ repository: l.repository!, sha: l.sha ?? l.link_id, branch: l.branch ?? null }));
    if (!refs.length) return false;
    // rama del Commit (IDE: branch · push: remote_branch); la del enlace como respaldo
    const rows = new Map((await this.repo.commits(tenantId, refs)).map((c) => [`${c.repository}|${String(c.sha).toLowerCase()}`, c]));
    const commits = refs.map((r) => {
      const c = rows.get(`${r.repository}|${r.sha.toLowerCase()}`);
      return { ...r, branch: s(c?.branch) ?? r.branch, remote_branch: s(c?.remote_branch) };
    });
    for (const repo of new Set(commits.map((c) => c.repository))) {
      let p = cache.get(repo);
      if (!p) {
        p = Promise.all([this.repo.deploymentsOf(tenantId, repo), this.prRepo.byRepository(tenantId, repo)]).then(([deps, prs]) => ({
          deployments: deps.map((d) => ({
            repository: String(d.repository ?? repo),
            sha: String(d.sha ?? ''),
            state: s(d.state) ?? undefined,
            environment: s(d.environment),
          })),
          prs: prs as DeployPrRef[],
        }));
        cache.set(repo, p);
      }
      const ev = await p;
      if (commits.some((c) => c.repository === repo && isCommitDeployed(c, ev.deployments, ev.prs))) return true;
    }
    return false;
  }

  /** Métricas + enlaces de una tarea (lo usan el listado, el detalle y las reglas de write-back). */
  async metricsFor(
    tenantId: string,
    taskKey: string,
    cache: Map<string, Promise<SessionRows>> = new Map(),
  ): Promise<{ links: TaskLinkItem[]; metrics: TaskMetrics }> {
    const links = await this.repo.links(tenantId, taskKey);
    const rows = await Promise.all(
      sessionIdsOf(links).map((id) => {
        let p = cache.get(id);
        if (!p) cache.set(id, (p = this.repo.sessionRows(tenantId, id)));
        return p;
      }),
    );
    const tokens = await allocateTaskTokens(tenantId, taskRequests(taskKey, rows), rows.length > 0, this.usageSource);
    return { links, metrics: aggregateTaskMetrics(taskKey, rows, tokens) };
  }

  /** GET /tasks?project_id&status_category */
  async list(tenantId: string, q: TaskQuery): Promise<TaskListItem[]> {
    const projects = q.project_id ? [q.project_id] : await this.branches.projectIds(tenantId);
    const cache = new Map<string, Promise<SessionRows>>();
    const evidence = new Map<string, Promise<RepoEvidence>>();
    const perProject = await Promise.all(
      projects.map(async (project) => {
        const [tasks, branchItems] = await Promise.all([
          this.repo.byProject(tenantId, project, MAX_TASKS_PER_PROJECT),
          // tareas que aún no llegaron por webhook (sin Jira) pero ya aparecen en ramas/sesiones
          q.status_category ? Promise.resolve([]) : this.branches.byProject(tenantId, project),
        ]);
        const live = tasks.filter((t) => t.deleted !== true && (!q.status_category || t.status_category === q.status_category));
        const known = new Set(tasks.map((t) => t.task_key));
        const untracked = [...new Set(branchItems.flatMap((b) => asArray(b.task_keys)))]
          .filter((k) => !known.has(k))
          .slice(0, MAX_TASKS_PER_PROJECT);
        const entries: Array<{ key: string; task: TaskItem | null }> = [
          ...live.map((t) => ({ key: t.task_key, task: t })),
          ...untracked.map((k) => ({ key: k, task: null })),
        ];
        return Promise.all(
          entries.map(async ({ key, task }) => {
            const { links, metrics } = await this.metricsFor(tenantId, key, cache);
            return buildTaskListItem(key, project, task, links, metrics, await this.deployedFor(tenantId, links, evidence));
          }),
        );
      }),
    );
    const seen = new Set<string>();
    return perProject
      .flat()
      .filter((t) => (seen.has(t.task_key) ? false : (seen.add(t.task_key), true)))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  /** GET /tasks/:taskKey — la tarea + todo lo enlazado (sesiones, commits, ramas, PRs, despliegues). */
  async detail(tenantId: string, rawKey: string): Promise<TaskDetail> {
    const taskKey = rawKey.toUpperCase();
    if (!TaskKey.safeParse(taskKey).success) throw new BadRequestException('Clave de tarea inválida', 'INVALID_TASK_KEY');
    const [task, { links, metrics }] = await Promise.all([this.repo.get(tenantId, taskKey), this.metricsFor(tenantId, taskKey)]);
    if ((!task || task.deleted === true) && !links.length) throw new NotFoundException('Tarea no encontrada', 'TASK_NOT_FOUND');
    const live = task && task.deleted !== true ? task : null;
    const projectId = live?.project_id ?? links.find((l) => l.project_id)?.project_id ?? '';
    const item = buildTaskListItem(taskKey, projectId, live, links, metrics, await this.deployedFor(tenantId, links));

    const of = (k: TaskLinkItem['kind']) => links.filter((l) => l.kind === k);
    const commitRefs = of('commit')
      .filter((l) => l.repository)
      .map((l) => ({ repository: l.repository!, sha: l.sha ?? l.link_id }));
    const branchRefs = of('branch')
      .filter((l) => l.repository)
      .map((l) => ({ repository: l.repository!, branch: l.branch ?? l.link_id }));
    const prRefs = of('pr')
      .filter((l) => l.repository && typeof l.number === 'number')
      .map((l) => ({ repository: l.repository!, number: l.number! }));

    const [sessions, commits, branchItems, prItems] = await Promise.all([
      this.repo.sessions(tenantId, sessionIdsOf(links)),
      this.repo.commits(tenantId, commitRefs),
      this.branches.batchGet(tenantId, branchRefs),
      this.prRepo.batchGet(tenantId, prRefs),
    ]);
    const pullRequests = await this.prService.enrich(tenantId, prItems);

    const sessionViews: TaskSessionView[] = sessions
      .map((x) => ({
        session_id: String(x.session_id),
        repository: s(x.repository),
        branch: s(x.branch),
        started_at: s(x.started_at),
        ended_at: s(x.ended_at),
      }))
      .sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? ''));
    const commitViews: TaskCommitView[] = commits
      .map((c) => {
        const a = (c.automation ?? {}) as { ai_matched_lines?: number; commit_added_lines?: number; ai_share?: number };
        // remote_only y el IDE no lo reportó después (ide_reported_at) ⇒ sin cruce de hashes
        const remoteOnly = c.remote_only === true && !c.ide_reported_at;
        return {
          sha: String(c.sha),
          repository: String(c.repository),
          branch: s(c.branch) ?? s(c.remote_branch),
          committed_at: s(c.committed_at),
          verified_remote: c.verified_remote === true,
          commit_source: s(c.commit_source),
          session_id: s(c.session_id),
          // un commit "solo remoto" no tiene cruce de hashes: null = desconocido (no 0)
          ai_matched_lines: remoteOnly ? null : (a.ai_matched_lines ?? null),
          commit_added_lines: remoteOnly ? null : (a.commit_added_lines ?? null),
          ai_share: remoteOnly ? null : (a.ai_share ?? null),
        };
      })
      .sort((a, b) => (b.committed_at ?? '').localeCompare(a.committed_at ?? ''));
    const deployments: TaskDeploymentView[] = of('deployment').map((l) => ({
      deployment_id: l.deployment_id ?? l.link_id,
      repository: s(l.repository),
      sha: s(l.sha),
      environment: s(l.environment),
      state: s(l.state),
      // se listan todos los entornos; solo producción cuenta como desplegado
      deployed: (l.deployed === true || l.state === 'success') && isProductionEnvironment(s(l.environment)),
      url: s(l.url),
    }));

    return {
      ...item,
      criticality: metrics.criticality,
      linked: {
        sessions: sessionViews,
        commits: commitViews,
        branches: branchItems.map(toBranchListItem),
        pull_requests: pullRequests,
        deployments,
      },
    };
  }
}

export const tasksService = new TasksService();
