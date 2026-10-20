import { ChangeDetectionStrategy, Component, DestroyRef, inject, input, output, signal } from '@angular/core';
import type { IntegrationTestRun } from '@magicode/contracts';
import { type Subscription, switchMap, takeWhile, timer } from 'rxjs';

import { StatusMarkComponent } from '@/shared/components/ui/status-mark.component';
import { IntegracionesData, errorText } from './integraciones.data';
import { BTN_PRIMARY, BTN_QUIET, FIELD, LABEL, RUN_LABEL, RUN_TONE, STEP_LABEL, STEP_TONE } from './integraciones.ui';

const ISSUE_RE = /^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/;

/** "Comprobar ahora": lanza la prueba de ida y vuelta y consulta su estado cada 2 s. */
@Component({
  selector: 'app-test-panel',
  imports: [StatusMarkComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'mt-5 flex flex-wrap gap-x-14 gap-y-6 border-t border-ink pt-4' },
  template: `
    <form class="flex max-w-[420px] flex-[1_1_300px] flex-col gap-3.5" (submit)="$event.preventDefault(); start()">
      <h3 class="m-0 text-[15px] font-semibold">Comprobar ahora</h3>
      <p class="m-0 text-[13px] text-ink-2">
        @if (isJira()) {
          Agrega y quita la etiqueta <span class="font-mono">magicode-healthcheck</span> en un issue y espera el webhook de vuelta.
        } @else {
          Pide al proveedor un evento de prueba y espera que llegue firmado a esta integración.
        }
      </p>
      <fieldset class="m-0 flex flex-wrap gap-x-6 gap-y-1 border-0 p-0 text-sm">
        <legend class="mb-1.5 p-0 text-[13px] text-ink-2">Modo</legend>
        <label class="flex min-h-11 cursor-pointer items-center gap-2">
          <input type="radio" name="mode-{{ integrationId() }}" value="auto" [checked]="mode() === 'auto'" (change)="mode.set('auto')" />
          Automático (usa las credenciales)
        </label>
        <label class="flex min-h-11 cursor-pointer items-center gap-2">
          <input type="radio" name="mode-{{ integrationId() }}" value="manual" [checked]="mode() === 'manual'" (change)="mode.set('manual')" />
          Manual (disparo el evento yo)
        </label>
      </fieldset>
      @if (isJira() && mode() === 'auto') {
        <label [class]="label">
          Issue de prueba
          <input [class]="field" type="text" placeholder="MAG-100" [value]="issue()" (input)="issue.set($any($event.target).value.trim().toUpperCase())" />
        </label>
      }
      <div class="flex flex-wrap items-center gap-x-6">
        <button type="submit" [class]="primary" [disabled]="running() || (isJira() && mode() === 'auto' && !issueOk())">
          {{ running() ? 'Prueba en curso…' : 'Iniciar prueba' }}
        </button>
        <button type="button" [class]="quiet" (click)="closed.emit()">Cerrar</button>
      </div>
      @if (error()) {
        <p class="m-0 text-[13px] text-critical" role="alert">{{ error() }}</p>
      }
    </form>

    <div class="min-w-0 flex-[1_1_360px]" aria-live="polite">
      @if (run(); as r) {
        <h3 class="m-0 mb-2 text-[15px] font-semibold">
          Prueba <app-status class="ml-1 text-sm font-normal" [tone]="runTone[r.status]" [label]="runLabel[r.status]" />
          <span class="ml-2 font-mono text-[13px] font-normal text-muted"
            >{{ r.test_id }}@if (r.latency_ms !== null) { · {{ (r.latency_ms / 1000).toFixed(1) }} s}</span
          >
        </h3>
        @if (r.instructions) {
          <p class="m-0 mb-2 text-[13px] text-ink-2">{{ r.instructions }}</p>
        }
        <ol class="m-0 list-none p-0 text-sm">
          @for (s of r.steps; track $index) {
            <li class="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-2.5 border-t border-rule py-2.5">
              <span
                >{{ s.name }}
                @if (s.message) {
                  <span class="block text-xs text-muted">{{ s.message }}</span>
                }
              </span>
              <app-status class="text-[13px] text-ink-2" [tone]="stepTone[s.status]" [label]="stepLabel[s.status]" />
            </li>
          }
        </ol>
      } @else {
        <p class="m-0 text-[13px] text-muted">Aún no se ha lanzado ninguna prueba en esta vista.</p>
      }
    </div>
  `,
})
export class TestPanelComponent {
  private readonly data = inject(IntegracionesData);
  private readonly destroyRef = inject(DestroyRef);

  readonly integrationId = input.required<string>();
  readonly provider = input<string | null>(null);
  readonly closed = output<void>();
  readonly finished = output<IntegrationTestRun>();

  protected readonly field = FIELD;
  protected readonly label = LABEL;
  protected readonly primary = BTN_PRIMARY;
  protected readonly quiet = BTN_QUIET;
  protected readonly stepTone = STEP_TONE;
  protected readonly stepLabel = STEP_LABEL;
  protected readonly runTone = RUN_TONE;
  protected readonly runLabel = RUN_LABEL;

  protected readonly mode = signal<'auto' | 'manual'>('auto');
  protected readonly issue = signal('');
  protected readonly run = signal<IntegrationTestRun | null>(null);
  protected readonly running = signal(false);
  protected readonly error = signal<string | null>(null);

  private poll: Subscription | null = null;

  constructor() {
    this.destroyRef.onDestroy(() => this.poll?.unsubscribe());
  }

  protected isJira(): boolean {
    return this.provider() === 'jira';
  }

  protected issueOk(): boolean {
    return ISSUE_RE.test(this.issue());
  }

  protected start(): void {
    const id = this.integrationId();
    const mode = this.mode();
    this.poll?.unsubscribe();
    this.error.set(null);
    this.running.set(true);
    const body = this.isJira() && mode === 'auto' ? { mode, test_issue_key: this.issue() } : { mode };
    this.poll = this.data
      .startTest(id, body)
      .pipe(
        switchMap((first) => {
          this.run.set(first);
          return timer(2000, 2000).pipe(
            switchMap(() => this.data.testRun(id, first.test_id, mode)),
            takeWhile((r) => r.status === 'pending', true),
          );
        }),
      )
      .subscribe({
        next: (r) => {
          this.run.set(r);
          if (r.status !== 'pending') {
            this.running.set(false);
            this.finished.emit(r);
          }
        },
        error: (e: unknown) => {
          this.running.set(false);
          this.error.set(errorText(e));
        },
        complete: () => this.running.set(false),
      });
  }
}
