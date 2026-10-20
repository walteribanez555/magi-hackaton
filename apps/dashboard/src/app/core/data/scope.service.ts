import { Injectable, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { catchError, of } from 'rxjs';

import { formatRange } from '@/shared/utils/format';
import { IntegrationsService } from './integrations.service';
import { ProductivityService, type ScopeQuery } from './productivity.service';
import { valueOf } from '@/shared/utils/resource';

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
 * Ámbito global (cabecera): proyecto, periodo y, en el resumen, tarea y rama.
 * Proyecto y periodo se recuerdan por navegador (localStorage, solo conveniencia).
 */
@Injectable({ providedIn: 'root' })
export class ScopeService {
  private readonly productivity = inject(ProductivityService);
  private readonly integrations = inject(IntegrationsService);

  readonly projects = rxResource({ stream: () => this.productivity.projects() });

  private readonly chosenProject = signal<string | null>(read(PROJECT_KEY));
  readonly period = signal<PeriodId>((read(PERIOD_KEY) as PeriodId | null) ?? '7d');
  readonly taskKey = signal<string | null>(null);
  readonly branch = signal<string | null>(null);

  /** Proyecto efectivo: el elegido si existe, si no el de actividad más reciente. */
  readonly projectId = computed<string | null>(() => {
    const list = valueOf(this.projects) ?? [];
    const chosen = this.chosenProject();
    if (chosen && list.some((p) => p.project_id === chosen)) return chosen;
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
    };
  });

  /** Readiness del proyecto para el aviso global (webhooks obligatorios). */
  readonly readiness = rxResource({
    params: () => this.projectId() ?? undefined,
    stream: ({ params }) => this.integrations.projectReadiness(params).pipe(catchError(() => of(null))),
  });

  selectProject(id: string): void {
    this.chosenProject.set(id);
    this.taskKey.set(null);
    this.branch.set(null);
    write(PROJECT_KEY, id);
  }

  selectPeriod(id: PeriodId): void {
    this.period.set(id);
    write(PERIOD_KEY, id);
  }
}
