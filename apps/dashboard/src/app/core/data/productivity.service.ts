import { HttpContext } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type {
  ChangeListItem,
  ProductivitySummary,
  SessionListItem,
  TimelinePoint,
} from '@magicode/contracts';
import { map, type Observable } from 'rxjs';

import { ApiClient, type Query } from '@/core/http/api-client';
import { FilterStateService } from './filter-state.service';
import type { FilterOptionsView, ProjectItem, SessionDetail } from './types';

export interface ScopeQuery extends Query {
  project_id?: string;
  repository?: string;
  /** developer (email de git) */
  developer?: string;
  /** autor del PR en el proveedor */
  pr_author?: string;
  session_id?: string;
  task_key?: string;
  branch?: string;
  from?: string;
  to?: string;
}

/**
 * Acceso HTTP a /productivity/* (resumen, embudo, sesiones, cambios).
 * Toda consulta lleva los filtros de la cabecera (repositorio, developer, autor de PR).
 */
@Injectable({ providedIn: 'root' })
export class ProductivityService {
  private readonly api = inject(ApiClient);
  private readonly filters = inject(FilterStateService);

  projects(): Observable<ProjectItem[]> {
    return this.api.get<ProjectItem[]>('projects');
  }

  summary(q: ScopeQuery): Observable<ProductivitySummary> {
    return this.api.get<ProductivitySummary>('summary', { query: this.filters.withFilters(q) });
  }

  timeline(q: ScopeQuery & { bucket: 'hour' | 'day' }): Observable<TimelinePoint[]> {
    return this.api.get<TimelinePoint[]>('timeline', { query: this.filters.withFilters(q) });
  }

  sessions(q: ScopeQuery): Observable<SessionListItem[]> {
    return this.api
      .get<SessionListItem[]>('sessions', { query: this.filters.withFilters(q) })
      .pipe(map((list) => this.filters.applyTo(list)));
  }

  session(sessionId: string): Observable<SessionDetail> {
    return this.api.get<SessionDetail>('session', { params: { sessionId } });
  }

  changes(q: ScopeQuery, context?: HttpContext): Observable<ChangeListItem[]> {
    return this.api
      .get<ChangeListItem[]>('changes', { query: this.filters.withFilters(q), context })
      .pipe(map((list) => this.filters.applyTo(list)));
  }

  /** Opciones de los filtros (repositorios, developers, autores de PR) del proyecto. Sin filtros aplicados. */
  filterOptions(projectId: string, context?: HttpContext): Observable<FilterOptionsView> {
    return this.api.get<FilterOptionsView>('filters', { query: { project_id: projectId }, context });
  }

  /** Sesiones SIN los filtros de la cabecera (para derivar opciones). */
  rawSessions(q: ScopeQuery, context?: HttpContext): Observable<SessionListItem[]> {
    return this.api.get<SessionListItem[]>('sessions', { query: q, context });
  }
}
