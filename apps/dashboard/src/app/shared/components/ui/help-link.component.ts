import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import { KbService } from '@/core/data/kb.service';

/** "?" discreto que lleva al artículo de la guía que explica la métrica (index.json metric_keys). */
@Component({
  selector: 'app-help',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (articleId(); as id) {<a
      [routerLink]="['/guia', id]"
      class="ml-1 inline-flex size-4 items-center justify-center align-[1px] font-sans text-[11px] leading-none text-faint no-underline hover:text-accent"
      [attr.aria-label]="'Qué significa: ' + (title() ?? key())"
      [attr.title]="'Qué significa: ' + (title() ?? key())"
      >?</a
    >}`,
})
export class HelpLinkComponent {
  private readonly kb = inject(KbService);
  readonly key = input.required<string>();
  protected readonly articleId = computed(() => (this.kb.articles().length ? this.kb.articleIdFor(this.key()) : null));
  protected readonly title = computed(() => (this.articleId() ? this.kb.meta(this.articleId()!)?.title : null));
}
