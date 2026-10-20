import { TaskKey, type Criticality, type TaskListItem } from '@magicode/contracts';
import { BadRequestException, NotFoundException } from '../../common/exceptions';
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

const ACCEPTED = new Set(['accepted', 'committed', 'in_reference']);
const CRITICALITY: Criticality[] = ['low', 'medium', 'high', 'critical'];
/** Tope de tareas por proyecto en el listado (cada una cuesta 1 Query de links + sesiones). */
export const MAX_TASKS_PER_PROJECT = 200;

type SessionRows = { requests: Item[]; changes: Item[] };

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const s = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** ¿La fila (petición/cambio) cuenta para la tarea? La de la tarea, o sin tarea en una sesión enlazada. */
const belongs = (row: Item, taskKey: string) => !row.task_key || row.task_key === taskKey;

/**
 * Tokens / líneas de una tarea a partir de las sesiones enlazadas. La atribución es por ENLACE
 * (sesión ↔ tarea), no por petición medida en MagiHub ⇒ provenance `estimated` (o `simulated`
 * si cualquier petición viene del mock).
 */
export function aggregateTaskMetrics(taskKey: string, sessions: SessionRows[]): TaskMetrics {
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
      accepted += n(c.accepted_added_lines);
      effective += n((c.dimensions as { effective_lines?: number } | undefined)?.effective_lines);
      const level = CRITICALITY.indexOf((c.scores as { criticality?: Criticality } | undefined)?.criticality as Criticality);
      if (level > crit) crit = level;
    }
  }
  return {
    tokens: { value: sessions.length ? tokens : null, provenance: simulated ? 'simulated' : 'estimated' },
    accepted_lines: accepted,
    effective_lines: Math.round(effective * 100) / 100,
    criticality: crit >= 0 ? CRITICALITY[crit]! : null,
  };
}

const sessionIdsOf = (links: TaskLinkItem[]): string[] =>
  [...new Set(links.filter((l) => l.kind === 'session').map((l) => l.session_id ?? l.link_id))].filter(Boolean);

export function buildTaskListItem(
  taskKey: string,
  projectId: string,
  task: TaskItem | null,
  links: TaskLinkItem[],
  metrics: TaskMetrics,
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
    deployed: byKind('deployment').some((l) => l.deployed === true || l.state === 'success'),
    updated_at: task?.source_updated_at ?? task?.updated_at ?? lastLink ?? '',
  };
}

export class TasksService {
  constructor(
    private readonly repo: TasksRepository = tasksRepository,
    private readonly branches: BranchesRepository = branchesRepository,
    private readonly prRepo: PullRequestsRepository = pullRequestsRepository,
    private readonly prService: PullRequestsService = pullRequestsService,
  ) {}

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
    return { links, metrics: aggregateTaskMetrics(taskKey, rows) };
  }

  /** GET /tasks?project_id&status_category */
  async list(tenantId: string, q: TaskQuery): Promise<TaskListItem[]> {
    const projects = q.project_id ? [q.project_id] : await this.branches.projectIds(tenantId);
    const cache = new Map<string, Promise<SessionRows>>();
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
            return buildTaskListItem(key, project, task, links, metrics);
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
    const item = buildTaskListItem(taskKey, projectId, live, links, metrics);

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
        const remoteOnly = c.remote_only === true;
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
      deployed: l.deployed === true || l.state === 'success',
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
