import { HttpClient, HttpContext } from '@angular/common/http';
import { Injectable, computed, inject } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { type Observable, catchError, map, of } from 'rxjs';

import { SILENT_ERRORS } from '@/core/http/http-context';
import type { KbArticleMeta } from './types';
import { valueOf } from '@/shared/utils/resource';

/** Normaliza public/kb/index.json: acepta `[...]`, `{ articles: [...] }` o `{ items: [...] }`. */
export function normalizeKbIndex(raw: unknown): KbArticleMeta[] {
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object'
      ? (((raw as Record<string, unknown>)['articles'] ?? (raw as Record<string, unknown>)['items']) as unknown[]) ?? []
      : [];
  if (!Array.isArray(list)) return [];
  const out: KbArticleMeta[] = [];
  list.forEach((item, i) => {
    if (!item || typeof item !== 'object') return;
    const r = item as Record<string, unknown>;
    const id = typeof r['id'] === 'string' ? r['id'] : typeof r['slug'] === 'string' ? r['slug'] : null;
    if (!id || !/^[a-z0-9][a-z0-9_-]*$/i.test(id)) return;
    const file = typeof r['file'] === 'string' ? r['file'] : typeof r['path'] === 'string' ? r['path'] : `${id}.md`;
    if (file.includes('..') || /^[a-z]+:/i.test(file)) return; // solo archivos dentro de /kb
    out.push({
      id,
      title: typeof r['title'] === 'string' ? r['title'] : id,
      summary: typeof r['summary'] === 'string' ? r['summary'] : typeof r['description'] === 'string' ? r['description'] : undefined,
      section: typeof r['section'] === 'string' ? r['section'] : typeof r['category'] === 'string' ? r['category'] : undefined,
      file: file.replace(/^\.?\/?(kb\/)?/, ''),
      metric_keys: Array.isArray(r['metric_keys']) ? (r['metric_keys'] as unknown[]).filter((k): k is string => typeof k === 'string') : [],
      order: typeof r['order'] === 'number' ? r['order'] : i,
    });
  });
  return out;
}

/** Busca el artículo de una métrica: exacto, luego por sufijo (`dimensions.redundancy.score` ↔ `redundancy.score`). */
export function findArticleForMetric(index: Map<string, string>, key: string): string | null {
  if (index.has(key)) return index.get(key)!;
  for (const [k, id] of index) {
    if (k.endsWith('.' + key) || key.endsWith('.' + k)) return id;
  }
  return null;
}

/** Guía de métricas: public/kb/index.json + artículos Markdown. */
@Injectable({ providedIn: 'root' })
export class KbService {
  private readonly http = inject(HttpClient);

  readonly index = rxResource({
    stream: () =>
      this.http.get<unknown>('kb/index.json', { context: new HttpContext().set(SILENT_ERRORS, true) }).pipe(
        map(normalizeKbIndex),
        catchError(() => of([] as KbArticleMeta[])),
      ),
  });

  readonly articles = computed(() => [...(valueOf(this.index) ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)));

  private readonly metricMap = computed(() => {
    const m = new Map<string, string>();
    for (const a of this.articles()) for (const k of a.metric_keys) if (!m.has(k)) m.set(k, a.id);
    return m;
  });

  articleIdFor(metricKey: string): string | null {
    return findArticleForMetric(this.metricMap(), metricKey);
  }

  meta(id: string): KbArticleMeta | null {
    return this.articles().find((a) => a.id === id) ?? null;
  }

  markdown(file: string): Observable<string> {
    return this.http.get(`kb/${file}`, { responseType: 'text', context: new HttpContext().set(SILENT_ERRORS, true) });
  }
}
