import type { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', title: 'Tareas · MagiCode', loadComponent: () => import('./task-list.page').then((m) => m.TaskListPage) },
  {
    path: ':taskKey',
    title: 'Tarea · MagiCode',
    loadComponent: () => import('./task-detail.page').then((m) => m.TaskDetailPage),
  },
];
