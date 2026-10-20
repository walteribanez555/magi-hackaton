import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { Provenance } from '@magicode/contracts';

import { PROVENANCE_LABEL, PROVENANCE_LETTER } from '@/shared/labels/labels';

/**
 * Procedencia como superíndice tipográfico R/E/S (nunca un chip). El significado va en la
 * leyenda del pie y en texto para lectores de pantalla.
 */
@Component({
  selector: 'app-prov',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (p(); as v) {<sup
      class="ml-0.5 align-super font-sans text-[10px]"
      [class.text-estimated]="v === 'estimated'"
      [class.text-muted]="v !== 'estimated'"
      [attr.title]="label()"
      aria-hidden="true"
      >{{ letter() }}</sup
    ><span class="sr-only"> ({{ label() }})</span>}`,
})
export class ProvenanceComponent {
  readonly p = input<Provenance | null | undefined>(null);
  protected readonly letter = computed(() => (this.p() ? PROVENANCE_LETTER[this.p()!] : ''));
  protected readonly label = computed(() => (this.p() ? PROVENANCE_LABEL[this.p()!].split(':')[0] : ''));
}
