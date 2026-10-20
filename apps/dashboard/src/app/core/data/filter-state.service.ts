import { Injectable, computed, inject, signal } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';

import type { Query, QueryValue } from '@/core/http/api-client';

/** Filtros de la cabecera (repositorio, developer, autor de PR) tal como viajan al API. */
export type FilterParams = {
  repository?: string;
  developer?: string;
  pr_author?: string;
};

/** Claves cortas en la URL (?repo=&dev=&author=) para que los enlaces se puedan compartir. */
export const FILTER_URL_KEYS = { repository: 'repo', developer: 'dev', pr_author: 'author' } as const;
export type FilterKey = keyof typeof FILTER_URL_KEYS;

/** Áreas donde aplican los filtros (Integraciones usa su propio ?repo=). */
const SCOPED_PATHS = ['/resumen', '/tareas', '/actividad'];

function isScopedPath(path: string): boolean {
  return SCOPED_PATHS.some((p) => path === p || path.startsWith(p + '/'));
}

/**
 * Estado de los filtros globales. Vive aparte de ScopeService para que los servicios de datos
 * (ProductivityService, TasksService) puedan leerlo sin dependencia circular.
 * Se sincroniza con la URL solo en las áreas con datos de productividad.
 */
@Injectable({ providedIn: 'root' })
export class FilterStateService {
  private readonly router = inject(Router);

  readonly repository = signal<string | null>(null);
  readonly developer = signal<string | null>(null);
  readonly pr_author = signal<string | null>(null);

  readonly params = computed<FilterParams>(() => ({
    repository: this.repository() ?? undefined,
    developer: this.developer() ?? undefined,
    pr_author: this.pr_author() ?? undefined,
  }));

  readonly active = computed(() => !!(this.repository() || this.developer() || this.pr_author()));

  constructor() {
    this.syncFromUrl();
    this.router.events.pipe(filter((e) => e instanceof NavigationEnd)).subscribe(() => this.syncFromUrl());
  }

  set(key: FilterKey, value: string | null): void {
    this.signalFor(key).set(value || null);
    this.writeUrl();
  }

  clear(): void {
    this.repository.set(null);
    this.developer.set(null);
    this.pr_author.set(null);
    this.writeUrl();
  }

  /** Mezcla los filtros activos con la consulta; lo que la consulta trae explícito gana. */
  withFilters<Q extends Query>(q: Q): Q & FilterParams {
    const out: Record<string, QueryValue> = { ...this.params() };
    for (const [k, v] of Object.entries(q)) if (v !== undefined) out[k] = v;
    return out as Q & FilterParams;
  }

  /**
   * Filtro en cliente por si el API aún ignora los parámetros: solo descarta filas que traen
   * el campo con otro valor (si el campo no viene, la fila se conserva).
   */
  applyTo<T extends object>(list: T[]): T[] {
    const f = this.params();
    const checks: [string, string | undefined][] = [
      ['repository', f.repository],
      ['developer', f.developer],
      ['author_login', f.pr_author],
    ];
    const active = checks.filter((c): c is [string, string] => !!c[1]);
    if (!active.length || !Array.isArray(list)) return list;
    return list.filter((item) =>
      active.every(([k, v]) => {
        const x = (item as Record<string, unknown>)[k];
        if (x === undefined) return true;
        return typeof x === 'string' && x.toLowerCase() === v.toLowerCase();
      }),
    );
  }

  private signalFor(key: FilterKey) {
    return key === 'repository' ? this.repository : key === 'developer' ? this.developer : this.pr_author;
  }

  private currentPath(tree = this.router.parseUrl(this.router.url)): string {
    return '/' + (tree.root.children['primary']?.segments.map((s) => s.path).join('/') ?? '');
  }

  /** URL → estado. Si la URL no trae filtros pero hay activos (navegación interna), se re-agregan. */
  private syncFromUrl(): void {
    const tree = this.router.parseUrl(this.router.url);
    if (!isScopedPath(this.currentPath(tree))) return;
    const qp = tree.queryParams;
    const keys = Object.entries(FILTER_URL_KEYS) as [FilterKey, string][];
    if (keys.some(([, k]) => qp[k] !== undefined)) {
      for (const [key, k] of keys) {
        const v = qp[k];
        this.signalFor(key).set(typeof v === 'string' && v ? v : null);
      }
    } else if (this.active()) {
      this.writeUrl();
    }
  }

  /** Estado → URL (replaceUrl: no ensucia el historial). */
  private writeUrl(): void {
    const tree = this.router.parseUrl(this.router.url);
    if (!isScopedPath(this.currentPath(tree))) return;
    const qp: Record<string, string> = { ...tree.queryParams };
    for (const [key, k] of Object.entries(FILTER_URL_KEYS) as [FilterKey, string][]) {
      const v = this.signalFor(key)();
      if (v) qp[k] = v;
      else delete qp[k];
    }
    const same = Object.keys(qp).length === Object.keys(tree.queryParams).length &&
      Object.entries(qp).every(([k, v]) => tree.queryParams[k] === v);
    if (same) return;
    tree.queryParams = qp;
    void this.router.navigateByUrl(tree, { replaceUrl: true });
  }
}
