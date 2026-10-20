import { HttpClient, HttpContext } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type {
  AvailableTransition,
  BranchListItem,
  OutboxAction,
  TaskActionRequest,
  TaskListItem,
} from '@magicode/contracts';
import type { PullRequestTotals } from '@magicode/contracts';
import { map, type Observable } from 'rxjs';

import { ApiClient, toParams } from '@/core/http/api-client';
import { SILENT_ERRORS } from '@/core/http/http-context';
import { FilterStateService, type FilterParams } from './filter-state.service';
import type { PullRequestListItem, TaskDetail } from './types';

type ProjectQuery = FilterParams & { project_id?: string };

/**
 * Tareas (Jira), ramas, pull requests y la respuesta de vuelta a Jira (outbox).
 * Las listas llevan los filtros de la cabecera (repositorio, developer, autor de PR).
 */
@Injectable({ providedIn: 'root' })
export class TasksService {
  private readonly api = inject(ApiClient);
  private readonly http = inject(HttpClient);
  private readonly filters = inject(FilterStateService);

  tasks(q: ProjectQuery & { status_category?: string }): Observable<TaskListItem[]> {
    return this.api.get<TaskListItem[]>('tasks', { query: this.filters.withFilters(q) });
  }

  task(taskKey: string): Observable<TaskDetail> {
    return this.api.get<TaskDetail>('task', { params: { taskKey } });
  }

  branches(q: ProjectQuery): Observable<BranchListItem[]> {
    return this.api
      .get<BranchListItem[]>('branches', { query: this.filters.withFilters(q) })
      .pipe(map((list) => this.filters.applyTo(list)));
  }

  pullRequests(q: ProjectQuery & { state?: string }): Observable<PullRequestListItem[]> {
    return this.api
      .get<PullRequestListItem[]>('pullRequests', { query: this.filters.withFilters(q) })
      .pipe(map((list) => this.filters.applyTo(list)));
  }

  /** PRs con el cuerpo completo: `meta` trae los totales históricos (PullRequestTotals). */
  pullRequestsWithTotals<T extends object = PullRequestListItem>(
    q: ProjectQuery & { state?: string },
    opts: { filtered?: boolean; context?: HttpContext } = {},
  ): Observable<{ data: T[]; meta: PullRequestTotals | null }> {
    const query = opts.filtered === false ? q : this.filters.withFilters(q);
    return this.http
      .get<{ data?: T[]; meta?: PullRequestTotals } | T[]>(this.api.url('pullRequests'), {
        params: toParams(query),
        context: opts.context,
      })
      .pipe(
        map((b) => (Array.isArray(b) ? { data: b, meta: null } : { data: b.data ?? [], meta: b.meta ?? null })),
        map((r) => (opts.filtered === false ? r : { ...r, data: this.filters.applyTo(r.data) })),
      );
  }

  /** Transiciones disponibles AHORA en Jira para el issue (consulta en vivo). */
  transitions(taskKey: string): Observable<AvailableTransition[]> {
    return this.api.get<AvailableTransition[]>('taskTransitions', { params: { taskKey } });
  }

  /** Auditoría del outbox. `silent` para el polling (sin toasts repetidos). */
  actions(taskKey: string, silent = false): Observable<OutboxAction[]> {
    return this.api.get<OutboxAction[]>('taskActions', {
      params: { taskKey },
      context: silent ? new HttpContext().set(SILENT_ERRORS, true) : undefined,
    });
  }

  enqueueAction(taskKey: string, body: TaskActionRequest): Observable<OutboxAction> {
    return this.api.post<OutboxAction>('taskActions', body, { params: { taskKey } });
  }
}
