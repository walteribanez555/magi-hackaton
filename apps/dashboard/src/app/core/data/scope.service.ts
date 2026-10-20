import { HttpContext } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import type { SessionListItem } from '@magicode/contracts';
import { catchError, forkJoin, map, of, type Observable } from 'rxjs';

import { SILENT_ERRORS } from '@/core/http/http-context';
import { formatRange } from '@/shared/utils/format';
import { FilterStateService, type FilterKey, type FilterParams } from './filter-state.service';
import { IntegrationsService } from './integrations.service';
import { ProductivityService, type ScopeQuery } from './productivity.service';
import { TasksService } from './tasks.service';
import type { FilterOptionsView, PullRequestListItem, SessionWithDeveloper } from './types';
import { valueOf } from '@/shared/utils/resource';

/** Proyecto por defecto si existe (el repo real de la demo); si no, el de actividad más reciente. */
const DEFAULT_PROJECT = 'magi-hackaton';

const silent = () => new HttpContext().set(SILENT_ERRORS, true);

/** Opciones derivadas de sesiones + PRs + repos del proyecto (si /productivity/filters aún no existe). */
function deriveOptions(
  repos: string[],
  sessions: SessionListItem[],
  prs: Array<PullRequestListItem & { author_login?: string | null }>,
): FilterOptionsView {
  const repositories = new Set(repos);
  const devs = new Map<string, { id: string; name: string | null; sessions: number }>();
  for (const s of sessions as SessionWithDeveloper[]) {
    if (s.repository) repositories.add(s.repository);
    const id = s.developer?.trim();
    if (!id) continue;
    const d = devs.get(id) ?? { id, name: s.developer_name ?? null, sessions: 0 };
    d.sessions += 1;
    if (!d.name && s.developer_name) d.name = s.developer_name;
    devs.set(id, d);
  }
  const authors = new Map<string, number>();
  for (const p of prs) {
    if (p.repository) repositories.add(p.repository);
    if (p.author_login) authors.set(p.author_login, (authors.get(p.author_login) ?? 0) + 1);
  }
  return {
    repositories: [...repositories].sort(),
    developers: [...devs.values()].sort((a, b) => b.sessions - a.sessions),
    pr_authors: [...authors.entries()].map(([login, pull_requests]) => ({ login, pull_requests })).sort((a, b) => b.pull_requests - a.pull_requests),
  };
}

export type PeriodId = '1d' | '7d' | '14d' | '30d' | '90d';

export const PERIODS: { id: PeriodId; label: string; days: number }[] = [
  { id: '1d', label: 'Hoy', days: 1 },
  { id: '7d', label: 'Últimos 7 días', days: 7 },
  { id: '14d', label: 'Últimos 14 días', days: 14 },
  { id: '30d', label: 'Últimos 30 días', days: 30 },
  { id: '90d', label: 'Últimos 90 días', days: 90 },
];

const PROJECT_KEY = 'magicode.project';
const PERIOD_KEY = 'magicode.period';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* preferencia local, opcional */
  }
}

/**
 * Ámbito global (cabecera): proyecto, periodo, filtros (repositorio, developer, autor de PR) y,
 * en el resumen, tarea y rama. Proyecto y periodo se recuerdan por navegador (localStorage, solo
 * conveniencia); los filtros viajan en la URL (?repo=&dev=&author=) para compartir enlaces.
 */
@Injectable({ providedIn: 'root' })
export class ScopeService {
  private readonly productivity = inject(ProductivityService);
  private readonly tasksApi = inject(TasksService);
  private readonly integrations = inject(IntegrationsService);
  private readonly filters = inject(FilterStateService);

  readonly projects = rxResource({ stream: () => this.productivity.projects() });

  private readonly chosenProject = signal<string | null>(read(PROJECT_KEY));
  readonly period = signal<PeriodId>((read(PERIOD_KEY) as PeriodId | null) ?? '7d');
  readonly taskKey = signal<string | null>(null);
  readonly branch = signal<string | null>(null);

  /** Filtros de la cabecera (estado en FilterStateService, sincronizado con la URL). */
  readonly repository = this.filters.repository.asReadonly();
  readonly developer = this.filters.developer.asReadonly();
  readonly pr_author = this.filters.pr_author.asReadonly();
  readonly filtersActive = this.filters.active;
  readonly filterParams = this.filters.params;

  /** Proyecto efectivo: el elegido si existe; si no 'magi-hackaton'; si no el de actividad más reciente. */
  readonly projectId = computed<string | null>(() => {
    const list = valueOf(this.projects) ?? [];
    const chosen = this.chosenProject();
    if (chosen && list.some((p) => p.project_id === chosen)) return chosen;
    if (list.some((p) => p.project_id === DEFAULT_PROJECT)) return DEFAULT_PROJECT;
    return list[0]?.project_id ?? null;
  });

  readonly project = computed(() => (valueOf(this.projects) ?? []).find((p) => p.project_id === this.projectId()) ?? null);

  readonly range = computed(() => {
    const days = PERIODS.find((p) => p.id === this.period())?.days ?? 7;
    const to = new Date();
    to.setHours(23, 59, 59, 999);
    const from = new Date(to);
    from.setDate(from.getDate() - (days - 1));
    from.setHours(0, 0, 0, 0);
    return { from: from.toISOString(), to: to.toISOString(), days };
  });

  readonly periodLabel = computed(() => formatRange(this.range().from, this.range().to));

  /** Parámetros para /productivity/* (undefined hasta conocer el proyecto ⇒ rxResource no carga). */
  readonly query = computed<ScopeQuery | undefined>(() => {
    const project_id = this.projectId();
    if (!project_id) return undefined;
    const { from, to } = this.range();
    return {
      project_id,
      from,
      to,
      task_key: this.taskKey() ?? undefined,
      branch: this.branch() ?? undefined,
      ...this.filters.params(),
    };
  });

  /** Proyecto + filtros, sin periodo (tareas, ramas, pull requests). undefined hasta conocer el proyecto. */
  readonly projectQuery = computed<(FilterParams & { project_id: string }) | undefined>(() => {
    const project_id = this.projectId();
    return project_id ? { project_id, ...this.filters.params() } : undefined;
  });

  /** Opciones de los filtros: /productivity/filters o, si aún no existe, derivadas de sesiones y PRs. */
  readonly filterOptions = rxResource({
    params: () => this.projectId() ?? undefined,
    stream: ({ params }) =>
      this.productivity.filterOptions(params, silent()).pipe(
        map((o) => ({
          repositories: [...new Set([...(this.project()?.repositories ?? []), ...(o?.repositories ?? [])])].sort(),
          developers: o?.developers ?? [],
          pr_authors: o?.pr_authors ?? [],
        })),
        catchError(() => this.derivedOptions(params)),
      ),
  });

  private derivedOptions(projectId: string): Observable<FilterOptionsView> {
    const repos = (valueOf(this.projects) ?? []).find((p) => p.project_id === projectId)?.repositories ?? [];
    return forkJoin({
      sessions: this.productivity.rawSessions({ project_id: projectId }, silent()).pipe(catchError(() => of([] as SessionListItem[]))),
      prs: this.tasksApi
        .pullRequestsWithTotals<PullRequestListItem>({ project_id: projectId }, { filtered: false, context: silent() })
        .pipe(
          map((r) => r.data),
          catchError(() => of([] as PullRequestListItem[])),
        ),
    }).pipe(map(({ sessions, prs }) => deriveOptions(repos, Array.isArray(sessions) ? sessions : [], prs)));
  }

  /** Readiness del proyecto para el aviso global (webhooks obligatorios). */
  readonly readiness = rxResource({
    params: () => this.projectId() ?? undefined,
    stream: ({ params }) => this.integrations.projectReadiness(params).pipe(catchError(() => of(null))),
  });

  selectProject(id: string): void {
    const changed = id !== this.projectId();
    this.chosenProject.set(id);
    this.taskKey.set(null);
    this.branch.set(null);
    // repositorios, developers y autores son por proyecto
    if (changed && this.filters.active()) this.filters.clear();
    write(PROJECT_KEY, id);
  }

  selectFilter(key: FilterKey, value: string | null): void {
    this.filters.set(key, value);
  }

  clearFilters(): void {
    this.filters.clear();
  }

  selectPeriod(id: PeriodId): void {
    this.period.set(id);
    write(PERIOD_KEY, id);
  }
}
