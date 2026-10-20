import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';

import { formatNumber } from '@/shared/utils/format';

export interface ChartSeries {
  id: string;
  label: string;
  /** variable CSS del color (p. ej. 'var(--ink)') — tokens del tema, válidos en claro y oscuro */
  color: string;
  values: number[];
  dashed?: boolean;
}

const H = 180;
const PAD = { top: 12, right: 12, bottom: 26, left: 56 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return step * p;
}

/**
 * Gráfico de líneas en SVG inline (sin librería). Un solo eje Y por gráfico (dos magnitudes ⇒
 * dos gráficos). Accesible: role="img" + aria-label con el resumen, navegación con flechas,
 * tooltip al pasar el puntero y tabla equivalente desplegable.
 */
@Component({
  selector: 'app-line-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <figure class="m-0">
      @if (series().length > 1) {
        <ul class="m-0 mb-2 flex list-none flex-wrap gap-x-6 gap-y-1 p-0 text-[13px] text-ink-2" aria-hidden="true">
          @for (s of series(); track s.id) {
            <li class="flex items-center gap-2">
              <svg width="18" height="8" aria-hidden="true">
                <line x1="0" y1="4" x2="18" y2="4" [attr.stroke]="s.color" stroke-width="2" [attr.stroke-dasharray]="s.dashed ? '4 3' : null" />
              </svg>
              {{ s.label }}
            </li>
          }
        </ul>
      }
      <div class="relative" #box>
        <svg
          role="img"
          [attr.aria-label]="ariaLabel()"
          [attr.width]="width()"
          [attr.height]="height"
          [attr.viewBox]="'0 0 ' + width() + ' ' + height"
          class="block max-w-full touch-pan-y outline-none focus-visible:outline-2 focus-visible:outline-accent"
          tabindex="0"
          (pointermove)="onMove($event)"
          (pointerleave)="active.set(null)"
          (keydown)="onKey($event)"
          (blur)="active.set(null)"
        >
          @for (t of ticks(); track $index) {
            <line [attr.x1]="pad.left" [attr.x2]="width() - pad.right" [attr.y1]="t.y" [attr.y2]="t.y" stroke="var(--rule)" stroke-width="1" />
            <text [attr.x]="pad.left - 8" [attr.y]="t.y + 4" text-anchor="end" class="fill-muted font-mono text-[11px]">{{ t.label }}</text>
          }
          @for (l of xLabels(); track $index) {
            <text [attr.x]="l.x" [attr.y]="height - 6" text-anchor="middle" class="fill-muted font-mono text-[11px]">{{ l.label }}</text>
          }
          @for (s of paths(); track s.id) {
            <path [attr.d]="s.d" fill="none" [attr.stroke]="s.color" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" [attr.stroke-dasharray]="s.dashed ? '4 3' : null" />
          }
          @if (active() !== null) {
            <line [attr.x1]="xAt(active()!)" [attr.x2]="xAt(active()!)" [attr.y1]="pad.top" [attr.y2]="height - pad.bottom" stroke="var(--faint)" stroke-width="1" />
            @for (s of series(); track s.id) {
              <circle [attr.cx]="xAt(active()!)" [attr.cy]="yAt(s.values[active()!])" r="4" [attr.fill]="s.color" stroke="var(--bg)" stroke-width="2" />
            }
          }
        </svg>
        @if (active() !== null) {
          <div
            class="pointer-events-none absolute top-0 z-10 min-w-36 border border-rule bg-bg px-3 py-2 text-xs shadow-[0_4px_16px_rgba(0,0,0,0.08)]"
            [style.left.px]="tooltipLeft()"
            aria-live="polite"
          >
            <div class="mb-1 text-muted">{{ labels()[active()!] }}</div>
            @for (s of series(); track s.id) {
              <div class="flex justify-between gap-4">
                <span class="text-ink-2">{{ s.label }}</span>
                <span class="font-mono text-ink">{{ fmt(s.values[active()!]) }}</span>
              </div>
            }
          </div>
        }
      </div>
      <details class="mt-2 text-[13px]">
        <summary class="cursor-pointer py-1 text-muted hover:text-ink">Ver como tabla</summary>
        <div class="overflow-x-auto">
          <table class="mt-2 w-full border-collapse text-[13px] tabular-nums">
            <thead>
              <tr class="text-xs text-muted">
                <th scope="col" class="py-1.5 pr-3 text-left font-medium">{{ xTitle() }}</th>
                @for (s of series(); track s.id) {
                  <th scope="col" class="px-3 py-1.5 text-right font-medium">{{ s.label }}</th>
                }
              </tr>
            </thead>
            <tbody class="font-mono">
              @for (l of labels(); track $index; let i = $index) {
                <tr class="border-t border-rule">
                  <th scope="row" class="py-1.5 pr-3 text-left font-sans font-normal text-ink-2">{{ l }}</th>
                  @for (s of series(); track s.id) {
                    <td class="px-3 py-1.5 text-right">{{ fmt(s.values[i]) }}</td>
                  }
                </tr>
              }
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  `,
})
export class LineChartComponent {
  readonly series = input.required<ChartSeries[]>();
  /** etiqueta por punto (mismo largo que values) */
  readonly labels = input.required<string[]>();
  readonly ariaLabel = input.required<string>();
  readonly xTitle = input('Periodo');
  readonly decimals = input(0);

  protected readonly height = H;
  protected readonly pad = PAD;
  protected readonly width = signal(720);
  protected readonly active = signal<number | null>(null);

  private readonly host = inject(ElementRef<HTMLElement>);

  constructor() {
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      const el = this.host.nativeElement as HTMLElement;
      const measure = () => this.width.set(Math.max(280, Math.floor(el.clientWidth)));
      measure();
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        destroyRef.onDestroy(() => ro.disconnect());
      }
    });
  }

  private readonly max = computed(() => niceMax(Math.max(0, ...this.series().flatMap((s) => s.values))));

  protected readonly ticks = computed(() => {
    const m = this.max();
    return [0, 0.5, 1].map((f) => ({ y: this.yAt(m * f), label: formatNumber(m * f, m * f < 10 && f > 0 ? 1 : 0) }));
  });

  private readonly n = computed(() => Math.max(1, this.labels().length));

  xAt(i: number): number {
    const w = this.width() - PAD.left - PAD.right;
    return this.n() === 1 ? PAD.left + w / 2 : PAD.left + (w * i) / (this.n() - 1);
  }

  yAt(v: number): number {
    const h = H - PAD.top - PAD.bottom;
    return PAD.top + h - (h * v) / this.max();
  }

  protected readonly paths = computed(() =>
    this.series().map((s) => ({
      ...s,
      d: s.values.map((v, i) => `${i === 0 ? 'M' : 'L'}${this.xAt(i).toFixed(1)},${this.yAt(v).toFixed(1)}`).join(' '),
    })),
  );

  protected readonly xLabels = computed(() => {
    const labels = this.labels();
    const maxLabels = Math.max(2, Math.floor((this.width() - PAD.left - PAD.right) / 72));
    const every = Math.max(1, Math.ceil(labels.length / maxLabels));
    return labels.map((label, i) => ({ label, x: this.xAt(i), i })).filter((l) => l.i % every === 0);
  });

  protected readonly tooltipLeft = computed(() => {
    const i = this.active();
    if (i === null) return 0;
    const x = this.xAt(i);
    return x > this.width() - 170 ? x - 160 : x + 12;
  });

  protected fmt(v: number | undefined): string {
    return formatNumber(v ?? null, this.decimals());
  }

  protected onMove(ev: PointerEvent): void {
    const svg = ev.currentTarget as SVGElement;
    const rect = svg.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const w = this.width() - PAD.left - PAD.right;
    const i = Math.round(((x - PAD.left) / w) * (this.n() - 1));
    this.active.set(Math.min(this.n() - 1, Math.max(0, i)));
  }

  protected onKey(ev: KeyboardEvent): void {
    const cur = this.active();
    if (ev.key === 'ArrowRight') this.active.set(cur === null ? 0 : Math.min(this.n() - 1, cur + 1));
    else if (ev.key === 'ArrowLeft') this.active.set(cur === null ? this.n() - 1 : Math.max(0, cur - 1));
    else if (ev.key === 'Escape') this.active.set(null);
    else return;
    ev.preventDefault();
  }
}
