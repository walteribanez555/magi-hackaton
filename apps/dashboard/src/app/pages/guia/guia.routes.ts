import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', loadComponent: () => import('./guia-page.component').then((m) => m.GuiaPage), title: 'Guía · MagiCode' },
  { path: ':id', loadComponent: () => import('./guia-page.component').then((m) => m.GuiaPage), title: 'Guía · MagiCode' },
];
