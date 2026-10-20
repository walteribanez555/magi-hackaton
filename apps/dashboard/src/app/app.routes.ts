import type { Routes } from '@angular/router';

import { authGuard } from '@/core/auth/auth.guard';

/**
 * Shell (cabecera + navegación lateral) con las áreas cargadas en diferido.
 * Cada área exporta `routes` desde `pages/<area>/<area>.routes.ts`.
 */
export const routes: Routes = [
  {
    path: 'conectar',
    title: 'Conectar · MagiCode',
    loadComponent: () => import('@/pages/conectar/conectar.component').then((m) => m.ConectarComponent),
  },
  {
    path: '',
    loadComponent: () => import('@/layout/layout.component').then((m) => m.LayoutComponent),
    canActivate: [authGuard],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'resumen' },
      {
        path: 'resumen',
        title: 'Resumen · MagiCode',
        loadComponent: () => import('@/pages/resumen/resumen.component').then((m) => m.ResumenComponent),
      },
      { path: 'tareas', loadChildren: () => import('@/pages/tareas/tareas.routes').then((m) => m.routes) },
      { path: 'actividad', loadChildren: () => import('@/pages/actividad/actividad.routes').then((m) => m.routes) },
      {
        path: 'integraciones',
        loadChildren: () => import('@/pages/integraciones/integraciones.routes').then((m) => m.routes),
      },
      { path: 'guia', loadChildren: () => import('@/pages/guia/guia.routes').then((m) => m.routes) },
      // Atajos a las rutas de actividad
      { path: 'cambios', redirectTo: 'actividad/cambios' },
      { path: 'sesiones', redirectTo: 'actividad/sesiones' },
      { path: 'ramas', redirectTo: 'actividad/ramas' },
      { path: 'pull-requests', redirectTo: 'actividad/pull-requests' },
      {
        path: '**',
        title: 'No encontrado · MagiCode',
        loadComponent: () => import('@/pages/not-found/not-found.component').then((m) => m.NotFoundComponent),
      },
    ],
  },
];
