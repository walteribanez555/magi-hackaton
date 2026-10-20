import type { CheckResult, HealthStatus, IntegrationTestRun } from '@magicode/contracts';

import type { Tone } from '@/shared/components/ui/status-mark.component';

/** Clases compartidas por los formularios y botones de la página. */
export const FIELD =
  'min-h-11 w-full rounded-[4px] border border-field bg-bg px-3 py-2.5 font-mono text-[15px] text-ink focus-visible:border-ink';
export const LABEL = 'flex flex-col gap-1.5 text-[13px] text-ink-2';
export const BTN_PRIMARY =
  'min-h-11 cursor-pointer rounded-[4px] border-0 bg-ink px-[18px] text-sm font-semibold text-on-ink hover:opacity-90 disabled:cursor-default disabled:opacity-50';
export const BTN_LINK = 'cursor-pointer py-3 text-sm text-accent hover:text-accent-hover disabled:cursor-default disabled:opacity-50';
export const BTN_QUIET = 'cursor-pointer py-3 text-sm text-muted hover:text-ink disabled:cursor-default disabled:opacity-50';

export const HEALTH_TONE: Record<HealthStatus, Tone> = {
  healthy: 'info',
  degraded: 'warn',
  failing: 'fail',
  awaiting_first_delivery: 'warn',
  not_configured: 'none',
  disabled: 'muted',
};

export const CHECK_TONE: Record<CheckResult['status'], Tone> = { pass: 'info', warn: 'warn', fail: 'fail', skipped: 'muted' };

export const STEP_TONE: Record<IntegrationTestRun['steps'][number]['status'], Tone> = {
  pass: 'info',
  fail: 'fail',
  pending: 'muted',
  skipped: 'none',
};
export const STEP_LABEL: Record<IntegrationTestRun['steps'][number]['status'], string> = {
  pass: 'Hecho',
  fail: 'Falla',
  pending: 'Esperando',
  skipped: 'Omitido',
};
export const RUN_LABEL: Record<IntegrationTestRun['status'], string> = {
  pending: 'En curso',
  passed: 'Pasó',
  failed: 'Falló',
  timeout: 'Tiempo agotado',
};
export const RUN_TONE: Record<IntegrationTestRun['status'], Tone> = { pending: 'muted', passed: 'info', failed: 'fail', timeout: 'warn' };
