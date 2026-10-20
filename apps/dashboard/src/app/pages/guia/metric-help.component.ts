import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import { KbService } from '@/core/data/kb.service';

/**
 * "?" que lleva al artículo de la guía que explica una métrica (según `metric_keys` de kb/index.json).
 * Uso: `<mc-metric-help key="dimensions.redundancy.score" />`. Si no hay artículo, no pinta nada.
 */
@Component({
  selector: 'mc-metric-help',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (articleId(); as id) {<a
      [routerLink]="['/guia', id]"
      class="ml-1 inline-flex size-4 items-center justify-center align-[1px] font-sans text-[11px] leading-none text-faint no-underline hover:text-accent"
      [attr.aria-label]="label()"
      [attr.title]="label()"
      >?</a
    >}`,
})
export class MetricHelpLink {
  private readonly kb = inject(KbService);
  readonly key = input.required<string>();
  protected readonly articleId = computed(() => (this.kb.articles().length ? this.kb.articleIdFor(this.key()) : null));
  protected readonly label = computed(() => {
    const id = this.articleId();
    return 'Qué significa: ' + ((id && this.kb.meta(id)?.title) || this.key());
  });
}
