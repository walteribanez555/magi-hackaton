import type { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'cambios' },
  {
    path: 'cambios',
    title: 'Cambios · MagiCode',
    loadComponent: () => import('./cambios.page').then((m) => m.CambiosPage),
  },
  {
    path: 'sesiones',
    title: 'Sesiones · MagiCode',
    loadComponent: () => import('./sesiones.page').then((m) => m.SesionesPage),
  },
  {
    path: 'sesiones/:sessionId',
    title: 'Sesión · MagiCode',
    loadComponent: () => import('./sesion-detalle.page').then((m) => m.SesionDetallePage),
  },
  {
    path: 'ramas',
    title: 'Ramas · MagiCode',
    loadComponent: () => import('./ramas.page').then((m) => m.RamasPage),
  },
  {
    path: 'pull-requests',
    title: 'Pull requests · MagiCode',
    loadComponent: () => import('./pull-requests.page').then((m) => m.PullRequestsPage),
  },
];
