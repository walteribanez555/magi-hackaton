import { Component } from '@angular/core';
import type { Routes } from '@angular/router';

/** Marcador temporal: el área se completa en pages/integraciones/. */
@Component({
  selector: 'app-integraciones-stub',
  template: '<h1 class="m-0 text-[34px] font-semibold tracking-tight">Integraciones</h1><p class="mt-3 text-ink-2">En construcción.</p>',
})
export class IntegracionesStubComponent {}

export const routes: Routes = [
  { path: '', component: IntegracionesStubComponent },
  { path: '**', component: IntegracionesStubComponent },
];
