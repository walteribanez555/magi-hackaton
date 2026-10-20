import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

import { ZardSonnerComponent } from '@/shared/components/sonner';
import { ConfirmDialogComponent } from '@/shared/components/ui/confirm-dialog.component';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, ZardSonnerComponent, ConfirmDialogComponent],
  template: `
    <router-outlet />
    <z-sonner />
    <app-confirm-dialog />
  `,
})
export class App {}
