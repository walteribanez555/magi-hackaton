import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-not-found',
  imports: [RouterLink],
  template: `
    <h1 class="m-0 text-[34px] leading-tight font-semibold tracking-tight">No encontramos esta página</h1>
    <p class="mt-3 text-ink-2">La dirección no corresponde a ninguna vista del dashboard.</p>
    <a routerLink="/resumen" class="mt-4 inline-block py-2">Volver al resumen</a>
  `,
})
export class NotFoundComponent {}
