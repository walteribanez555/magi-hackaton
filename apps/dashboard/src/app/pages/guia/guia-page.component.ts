import { ChangeDetectionStrategy, Component, ViewEncapsulation, computed, effect, inject, signal } from '@angular/core';
import { rxResource, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { HttpClient, HttpContext } from '@angular/common/http';
import { catchError, map, of } from 'rxjs';

import { SILENT_ERRORS } from '@/core/http/http-context';

import { KbService } from '@/core/data/kb.service';
import type { KbArticleMeta } from '@/core/data/types';

import { FALLBACK_GROUP, GUIA_GROUPS, groupOf, orderOf } from './guia-groups';
import { renderKbArticle } from './kb-markdown';

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

@Component({
  selector: 'mc-guia-page',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styles: `
    .guia-article h2 { font-size: 20px; margin: 40px 0 10px; padding-bottom: 0; border-bottom: 0; }
    .guia-article pre { font: 14px/1.7 var(--font-mono); white-space: pre-wrap; padding: 16px 0; }
    .guia-article table { font-size: 15px; }
    .guia-article td code, .guia-article th code { white-space: nowrap; }
  `,
  template: `
    <div class="mx-auto flex max-w-[1440px] flex-wrap gap-x-14 px-4 sm:px-8">
      <nav aria-label="Artículos de la guía" class="max-w-[260px] flex-[1_1_200px] pt-10 text-sm">
        <a routerLink="/" class="block pt-2 pb-4 text-muted no-underline hover:text-ink">← Volver al resumen</a>
        <label class="mb-4 block text-[13px] text-muted">
          <span class="mb-1 block">Buscar</span>
          <input
            type="search"
            placeholder="redundancia, criticidad, PR…"
            [value]="query()"
            (input)="query.set($any($event.target).value)"
            class="w-full min-w-0 rounded border border-field bg-bg px-3 py-2 text-sm text-ink"
          />
        </label>
        @for (g of groups(); track g.label) {
          <p class="mt-4 mb-1 text-xs text-muted">{{ g.label }}</p>
          @for (a of g.items; track a.id) {
            <a
              [routerLink]="['/guia', a.id]"
              [attr.aria-current]="a.id === currentId() ? 'page' : null"
              class="block py-1.5 no-underline"
              [class]="a.id === currentId() ? 'font-semibold text-ink' : 'text-ink-2 hover:text-accent'"
              >{{ a.title }}</a
            >
          }
        } @empty {
          @if (kb.index.isLoading()) {
            <p class="text-muted">Cargando…</p>
          } @else {
            <p class="text-muted">{{ query() ? 'Sin resultados.' : 'La guía no está disponible.' }}</p>
          }
        }
      </nav>

      <main class="min-w-0 flex-[999_1_560px] pt-10 pb-24">
        @if (meta(); as m) {
          <article class="max-w-[720px]">
            <p class="m-0 text-[13px] text-muted">Guía · {{ groupLabel() }}</p>
            <h1 class="mt-1 mb-0 text-[40px] leading-[1.15] font-semibold tracking-[-0.02em]">{{ title() }}</h1>
            @if (m.summary) {
              <p class="mt-4 mb-0 text-[19px] leading-normal text-ink-2">{{ m.summary }}</p>
            }
            @if (article.isLoading()) {
              <p class="mt-10 text-muted">Cargando artículo…</p>
            } @else if (article.error()) {
              <p class="mt-10 text-muted">No se pudo cargar el artículo.</p>
            } @else {
              <div class="kb-prose guia-article mt-8" [innerHTML]="rendered()?.html ?? ''" (click)="onBodyClick($event)"></div>
            }
            @if (m.metric_keys.length) {
              <p class="mt-12 mb-0 border-t border-rule pt-3.5 text-[13px] text-muted">
                Métricas que explica este artículo:
                @for (k of m.metric_keys; track k; let last = $last) {
                  <span class="font-mono">{{ k }}</span>{{ last ? '.' : ', ' }}
                }
              </p>
            }
          </article>
        } @else if (kb.index.isLoading()) {
          <p class="text-muted">Cargando…</p>
        } @else {
          <p class="text-muted">No existe ese artículo. Elige uno de la lista.</p>
        }
      </main>
    </div>
  `,
})
export class GuiaPage {
  protected readonly kb = inject(KbService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  private readonly paramId = toSignal(this.route.paramMap.pipe(map((p) => p.get('id'))), { initialValue: null });
  protected readonly query = signal('');

  protected readonly currentId = computed(() => {
    const id = this.paramId();
    if (id) return id;
    const list = this.kb.articles();
    return list.find((a) => a.id === 'inicio')?.id ?? list[0]?.id ?? null;
  });

  protected readonly meta = computed<KbArticleMeta | null>(() => {
    const id = this.currentId();
    return id ? this.kb.meta(id) : null;
  });

  protected readonly groupLabel = computed(() => (this.meta() ? groupOf(this.meta()!.id) : ''));

  /** Etiquetas por artículo (index.json las trae; el servicio no las expone). */
  private readonly tags = toSignal(
    inject(HttpClient)
      .get<unknown>('kb/index.json', { context: new HttpContext().set(SILENT_ERRORS, true) })
      .pipe(
        map((raw) => {
          const m = new Map<string, string[]>();
          if (Array.isArray(raw))
            for (const r of raw as Record<string, unknown>[])
              if (r && typeof r['id'] === 'string' && Array.isArray(r['tags']))
                m.set(r['id'], (r['tags'] as unknown[]).filter((t): t is string => typeof t === 'string'));
          return m;
        }),
        catchError(() => of(new Map<string, string[]>())),
      ),
    { initialValue: new Map<string, string[]>() },
  );

  protected readonly groups = computed(() => {
    const q = norm(this.query().trim());
    const list = this.kb
      .articles()
      .filter(
        (a) =>
          !q ||
          norm(a.title).includes(q) ||
          norm(a.summary ?? '').includes(q) ||
          (this.tags().get(a.id) ?? []).some((t) => norm(t).includes(q)) ||
          a.metric_keys.some((k) => norm(k).includes(q)),
      )
      .sort((a, b) => orderOf(a.id) - orderOf(b.id));
    const labels = [...GUIA_GROUPS.map((g) => g.label), FALLBACK_GROUP];
    return labels
      .map((label) => ({ label, items: list.filter((a) => groupOf(a.id) === label) }))
      .filter((g) => g.items.length);
  });

  protected readonly article = rxResource({
    params: () => this.meta()?.file,
    stream: ({ params }) => this.kb.markdown(params),
  });

  protected readonly rendered = computed(() => {
    const md = this.article.value();
    return md == null ? null : renderKbArticle(md, this.kb.articles());
  });

  protected readonly title = computed(() => this.rendered()?.title ?? this.meta()?.title ?? '');

  constructor() {
    effect(() => {
      this.currentId();
      if (typeof window !== 'undefined') window.scrollTo({ top: 0 });
    });
  }

  /** Los enlaces del Markdown son <a href> planos: los internos se navegan con el router. */
  protected onBodyClick(ev: MouseEvent): void {
    if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    const a = (ev.target as HTMLElement | null)?.closest?.('a');
    const href = a?.getAttribute('href');
    if (!href) return;
    if (href.startsWith('/guia/')) {
      ev.preventDefault();
      void this.router.navigateByUrl(href);
    } else if (href.startsWith('#')) {
      ev.preventDefault();
      document.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView({ block: 'start' });
    }
  }
}
