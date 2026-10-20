/**
 * Filtros comunes de las lecturas (summary, timeline, sessions, changes, commits, tasks, branches,
 * pull-requests): ?repository ?developer ?pr_author. Se combinan con AND (y con project_id,
 * task_key, branch, from, to de cada endpoint). Funciones puras: la carga (PRs, sesiones) la hace
 * cada servicio y aquí solo se decide qué pasa el filtro.
 *
 *  - repository: repositorio exacto.
 *  - developer:  `git config user.email` (minúsculas). Sesiones de ese developer ⇒ todo lo derivado
 *                de ellas (peticiones, cambios, commits, imputación de tokens).
 *  - pr_author:  login del autor del PR en el proveedor. PRs de ese autor ⇒ sus ramas origen ⇒
 *                sesiones/commits en esas ramas y sus tareas. Los listados de PR filtran por
 *                author_login directamente.
 */

export interface ScopeFilters {
  repository?: string;
  developer?: string;
  pr_author?: string;
}

/** developer = email de git: sin espacios y en minúsculas (así se guarda y así se compara). */
export const normalizeDeveloper = (v: string | null | undefined): string | undefined => {
  const out = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return out || undefined;
};

/** Los logins de GitHub/Bitbucket/GitLab no distinguen mayúsculas: se comparan en minúsculas. */
export const normalizeLogin = (v: string | null | undefined): string | undefined => {
  const out = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return out || undefined;
};

/** Lee los tres filtros de un query string (valores vacíos = sin filtro). */
export function readScopeFilters(get: (k: string) => string | undefined): ScopeFilters {
  const repository = get('repository')?.trim() || undefined;
  const developer = normalizeDeveloper(get('developer'));
  const pr_author = get('pr_author')?.trim() || undefined;
  return { ...(repository ? { repository } : {}), ...(developer ? { developer } : {}), ...(pr_author ? { pr_author } : {}) };
}

export const hasScopeFilters = (f: ScopeFilters): boolean => !!(f.repository || f.developer || f.pr_author);

export const branchRef = (repository: string, branch: string) => `${repository}|${branch}`;

const asList = (v: unknown): string[] =>
  v instanceof Set ? [...(v as Set<string>)] : Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === 'string') : [];

const shaPrefix = (a: string | null | undefined, b: string | null | undefined): boolean => {
  if (!a || !b) return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x));
};

/** PR mínimo para el filtro (filas PullRequest de webhooks). */
export interface PrFilterRow {
  repository: string;
  number?: number;
  source_branch?: string | null;
  head_sha?: string | null;
  merge_sha?: string | null;
  task_keys?: string[] | Set<string>;
  author_login?: string | null;
}

/** Lo que se deriva de los PRs de un autor: ramas origen (repo|rama), SHAs head/merge y tareas. */
export interface PrAuthorScope {
  author: string;
  prs: PrFilterRow[];
  branches: Set<string>;
  shas: string[];
  taskKeys: Set<string>;
}

export const prAuthoredBy = (pr: Pick<PrFilterRow, 'author_login'>, author: string): boolean =>
  !!pr.author_login && normalizeLogin(pr.author_login) === normalizeLogin(author);

export function prAuthorScope(prs: PrFilterRow[], author: string): PrAuthorScope {
  const mine = prs.filter((p) => prAuthoredBy(p, author));
  return {
    author,
    prs: mine,
    branches: new Set(mine.filter((p) => p.source_branch).map((p) => branchRef(p.repository, p.source_branch!))),
    shas: mine.flatMap((p) => [p.head_sha, p.merge_sha]).filter((s): s is string => !!s),
    taskKeys: new Set(mine.flatMap((p) => asList(p.task_keys))),
  };
}

/** Sesión: repo exacto · developer de la sesión · rama de la sesión ∈ ramas origen de los PRs del autor. */
export function sessionMatches(
  s: { repository?: string; branch?: string | null; developer?: string | null },
  f: ScopeFilters,
  pa?: PrAuthorScope | null,
): boolean {
  if (f.repository && s.repository !== f.repository) return false;
  if (f.developer && normalizeDeveloper(s.developer) !== f.developer) return false;
  if (f.pr_author && !(pa && s.repository && s.branch && pa.branches.has(branchRef(s.repository, s.branch)))) return false;
  return true;
}

/**
 * Commit: repo exacto · developer del commit (o, si el commit no lo trae, el de su sesión —
 * `sessionDevelopers`) · rama (IDE o push) ∈ ramas de los PRs del autor, o es su head/merge.
 */
export function commitMatches(
  c: { repository: string; sha: string; session_id?: string | null; branch?: string | null; remote_branch?: string | null; developer?: string | null },
  f: ScopeFilters,
  ctx: { pa?: PrAuthorScope | null; sessionDevelopers?: Map<string, string | undefined> } = {},
): boolean {
  if (f.repository && c.repository !== f.repository) return false;
  if (f.developer) {
    const dev = normalizeDeveloper(c.developer) ?? (c.session_id ? normalizeDeveloper(ctx.sessionDevelopers?.get(c.session_id)) : undefined);
    if (dev !== f.developer) return false;
  }
  if (f.pr_author) {
    const pa = ctx.pa;
    if (!pa) return false;
    const onBranch = [c.branch, c.remote_branch].some((b) => !!b && pa.branches.has(branchRef(c.repository, b)));
    if (!onBranch && !pa.shas.some((s) => shaPrefix(s, c.sha))) return false;
  }
  return true;
}

/**
 * PR: repo exacto · author_login · developer ⇒ su rama origen tiene sesiones del developer
 * (`devBranches` = repo|rama de esas sesiones).
 */
export function pullRequestMatches(pr: PrFilterRow, f: ScopeFilters, ctx: { devBranches?: Set<string> } = {}): boolean {
  if (f.repository && pr.repository !== f.repository) return false;
  if (f.pr_author && !prAuthoredBy(pr, f.pr_author)) return false;
  if (f.developer && !(pr.source_branch && ctx.devBranches?.has(branchRef(pr.repository, pr.source_branch)))) return false;
  return true;
}

/** Rama: repo exacto · alguna sesión del developer · es rama origen de un PR del autor. */
export function branchMatches(
  b: { repository: string; branch: string; session_ids?: string[] | Set<string> },
  f: ScopeFilters,
  ctx: { pa?: PrAuthorScope | null; devSessionIds?: Set<string> } = {},
): boolean {
  if (f.repository && b.repository !== f.repository) return false;
  if (f.developer && !asList(b.session_ids).some((id) => ctx.devSessionIds?.has(id))) return false;
  if (f.pr_author && !ctx.pa?.branches.has(branchRef(b.repository, b.branch))) return false;
  return true;
}

/**
 * Tarea (por sus TaskLink): algún enlace del repo · alguna sesión enlazada del developer · la tarea
 * es de un PR del autor o tiene una rama que es origen de uno de sus PRs.
 */
export function taskMatches(
  taskKey: string,
  links: Array<{ kind: string; repository?: string; branch?: string; link_id?: string; session_id?: string }>,
  f: ScopeFilters,
  ctx: { pa?: PrAuthorScope | null; devSessionIds?: Set<string> } = {},
): boolean {
  if (f.repository && !links.some((l) => l.repository === f.repository)) return false;
  if (f.developer && !links.some((l) => l.kind === 'session' && ctx.devSessionIds?.has(l.session_id ?? l.link_id ?? ''))) return false;
  if (f.pr_author) {
    const pa = ctx.pa;
    if (!pa) return false;
    const viaBranch = links.some((l) => l.kind === 'branch' && l.repository && pa.branches.has(branchRef(l.repository, l.branch ?? l.link_id ?? '')));
    if (!pa.taskKeys.has(taskKey) && !viaBranch) return false;
  }
  return true;
}

/** Sesiones de un developer entre las dadas (id → developer). */
export function developerSessionIds(sessions: Array<{ session_id?: unknown; developer?: unknown }>, developer: string): Set<string> {
  return new Set(
    sessions
      .filter((s) => normalizeDeveloper(typeof s.developer === 'string' ? s.developer : undefined) === developer)
      .map((s) => String(s.session_id ?? ''))
      .filter(Boolean),
  );
}
