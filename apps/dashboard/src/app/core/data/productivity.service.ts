import { HttpContext } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type {
  ChangeListItem,
  ProductivitySummary,
  SessionListItem,
  TimelinePoint,
} from '@magicode/contracts';
import type { Observable } from 'rxjs';

import { ApiClient, type Query } from '@/core/http/api-client';
import type { ProjectItem, SessionDetail } from './types';

export interface ScopeQuery extends Query {
  project_id?: string;
  repository?: string;
  session_id?: string;
  task_key?: string;
  branch?: string;
  from?: string;
  to?: string;
}

/** Acceso HTTP a /productivity/* (resumen, embudo, sesiones, cambios). */
@Injectable({ providedIn: 'root' })
export class ProductivityService {
  private readonly api = inject(ApiClient);

  projects(): Observable<ProjectItem[]> {
    return this.api.get<ProjectItem[]>('projects');
  }

  summary(q: ScopeQuery): Observable<ProductivitySummary> {
    return this.api.get<ProductivitySummary>('summary', { query: q });
  }

  timeline(q: ScopeQuery & { bucket: 'hour' | 'day' }): Observable<TimelinePoint[]> {
    return this.api.get<TimelinePoint[]>('timeline', { query: q });
  }

  sessions(q: ScopeQuery): Observable<SessionListItem[]> {
    return this.api.get<SessionListItem[]>('sessions', { query: q });
  }

  session(sessionId: string): Observable<SessionDetail> {
    return this.api.get<SessionDetail>('session', { params: { sessionId } });
  }

  changes(q: { project_id?: string; session_id?: string; from?: string; to?: string }, context?: HttpContext): Observable<ChangeListItem[]> {
    return this.api.get<ChangeListItem[]>('changes', { query: q, context });
  }
}
