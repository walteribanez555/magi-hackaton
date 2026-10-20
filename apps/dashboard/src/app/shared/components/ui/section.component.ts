import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** Encabezado de sección: h2 + nota a la derecha, sobre una regla de 1px en tinta. */
@Component({
  selector: 'app-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block mt-14' },
  template: `
    <section [attr.aria-labelledby]="headingId()">
      <div class="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-b border-ink pb-2.5">
        <h2 [id]="headingId()" class="m-0 text-lg font-semibold">{{ title() }}</h2>
        <span class="text-[13px] text-muted"><ng-content select="[hint]" /></span>
      </div>
      <ng-content />
    </section>
  `,
})
export class SectionComponent {
  readonly title = input.required<string>();
  readonly headingId = input.required<string>();
}
