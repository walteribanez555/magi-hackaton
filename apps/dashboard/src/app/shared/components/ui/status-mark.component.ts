import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { Criticality } from '@magicode/contracts';

import { CRITICALITY_LABEL } from '@/shared/labels/labels';
import { formatScore } from '@/shared/utils/format';

export type Tone = 'ok' | 'info' | 'warn' | 'fail' | 'muted' | 'none';

const TONE_CLASS: Record<Tone, string> = {
  ok: 'bg-ink',
  info: 'bg-accent',
  warn: 'bg-estimated',
  fail: 'bg-critical',
  muted: 'bg-low',
  none: 'border border-faint bg-transparent',
};

/** Cuadrado pequeño + la PALABRA del estado (el color nunca va solo). */
@Component({
  selector: 'app-status',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'whitespace-nowrap' },
  template: `<span aria-hidden="true" class="mr-2 inline-block size-2 align-[1px]" [class]="toneClass()"></span
    ><span [class.text-estimated]="emphasize() && tone() === 'warn'" [class.text-critical]="emphasize() && tone() === 'fail'">{{ label() }}</span
    ><ng-content />`,
})
export class StatusMarkComponent {
  readonly tone = input<Tone>('muted');
  readonly label = input.required<string>();
  readonly emphasize = input(false);
  protected readonly toneClass = computed(() => TONE_CLASS[this.tone()]);
}

const CRIT_TONE: Record<Criticality, Tone> = { low: 'muted', medium: 'info', high: 'warn', critical: 'fail' };

/** Criticidad: cuadrado + "Alta" + puntuación en mono. */
@Component({
  selector: 'app-crit',
  imports: [StatusMarkComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (level(); as l) {<app-status [tone]="tone()" [label]="text()"
      >@if (score() !== null && score() !== undefined) {<span class="ml-1 font-mono text-xs text-muted">{{ scoreText() }}</span>}</app-status
    >} @else {<span class="text-muted">{{ emptyText() }}</span>}`,
})
export class CriticalityComponent {
  readonly level = input<Criticality | null | undefined>(null);
  readonly score = input<number | null | undefined>(null);
  readonly emptyText = input('—');
  protected readonly tone = computed(() => CRIT_TONE[this.level() ?? 'low']);
  protected readonly text = computed(() => CRITICALITY_LABEL[this.level() ?? 'low']);
  protected readonly scoreText = computed(() => formatScore(this.score()));
}
