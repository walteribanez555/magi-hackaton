import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { Measured, Provenance } from '@magicode/contracts';

import { ZardTooltipDirective } from '@/shared/components/tooltip';
import { formatNumber, formatPercent, formatScore, isPresent } from '@/shared/utils/format';
import { HelpLinkComponent } from './help-link.component';
import { ProvenanceComponent } from './provenance.component';

export type MetricFormat = 'int' | 'dec1' | 'pct' | 'score';

/**
 * Cifra con su procedencia y su "?" a la guía. `null` → "—" con tooltip "sin denominador".
 * Acepta un `Measured` o un número suelto + procedencia.
 */
@Component({
  selector: 'app-metric',
  imports: [ProvenanceComponent, HelpLinkComponent, ZardTooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'whitespace-nowrap' },
  template: `@if (present()) {<span>{{ text() }}</span>} @else {<span
        tabindex="0"
        [zTooltip]="emptyHint()"
        class="cursor-help"
        [attr.aria-label]="'sin dato: ' + emptyHint()"
        >—</span
      >}<app-prov [p]="prov()" />@if (help()) {<app-help [key]="help()!" />}`,
})
export class MetricComponent {
  readonly m = input<Measured | null | undefined>(null);
  readonly value = input<number | null | undefined>(undefined);
  readonly provenance = input<Provenance | null | undefined>(undefined);
  readonly format = input<MetricFormat>('int');
  readonly help = input<string | null>(null);
  readonly emptyHint = input('sin denominador');
  /** Oculta la procedencia (p. ej. cuando la columna entera la declara). */
  readonly hideProvenance = input(false);

  private readonly raw = computed(() => (this.value() !== undefined ? this.value() : this.m()?.value));
  protected readonly present = computed(() => isPresent(this.raw()));
  protected readonly prov = computed(() =>
    this.hideProvenance() ? null : (this.provenance() ?? this.m()?.provenance ?? null),
  );
  protected readonly text = computed(() => {
    const v = this.raw();
    switch (this.format()) {
      case 'pct':
        return formatPercent(v);
      case 'score':
        return formatScore(v);
      case 'dec1':
        return formatNumber(v, 1);
      default:
        return formatNumber(v === null || v === undefined ? v : Math.round(v));
    }
  });
}
