import { HttpContext } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type {
  AvailableTransition,
  BranchListItem,
  OutboxAction,
  TaskActionRequest,
  TaskListItem,
} from '@magicode/contracts';
import type { Observable } from 'rxjs';

import { ApiClient } from '@/core/http/api-client';
import { SILENT_ERRORS } from '@/core/http/http-context';
import type { PullRequestListItem, TaskDetail } from './types';

/** Tareas (Jira), ramas, pull requests y la respuesta de vuelta a Jira (outbox). */
@Injectable({ providedIn: 'root' })
export class TasksService {
  private readonly api = inject(ApiClient);

  tasks(q: { project_id?: string; status_category?: string }): Observable<TaskListItem[]> {
    return this.api.get<TaskListItem[]>('tasks', { query: q });
  }

  task(taskKey: string): Observable<TaskDetail> {
    return this.api.get<TaskDetail>('task', { params: { taskKey } });
  }

  branches(q: { project_id?: string; repository?: string }): Observable<BranchListItem[]> {
    return this.api.get<BranchListItem[]>('branches', { query: q });
  }

  pullRequests(q: { project_id?: string; repository?: string; state?: string }): Observable<PullRequestListItem[]> {
    return this.api.get<PullRequestListItem[]>('pullRequests', { query: q });
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
