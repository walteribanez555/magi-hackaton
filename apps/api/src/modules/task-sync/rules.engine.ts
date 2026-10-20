import {
  DEFAULT_RULES,
  TaskAction,
  type AutomationRule,
  type AutomationRuleUpsert,
  type GitProvider,
  type RuleTrigger,
} from '@magicode/contracts';
import type { PlannedAction, RuleContext, RuleVars, SkippedRule } from './task-sync.types';

const PLACEHOLDER = /\{\{\s*([a-z_]+)\s*\}\}/g;

/** Placeholders que exigen agregar tokens/líneas de la tarea (consulta extra). */
export const METRIC_PLACEHOLDERS = ['tokens', 'effective_lines', 'criticality'] as const;

/** Rellena {{placeholders}}; los desconocidos o vacíos quedan como cadena vacía. `sha` → 12 caracteres. */
export function renderTemplate(template: string, vars: RuleVars): string {
  return template.replace(PLACEHOLDER, (_, name: string) => {
    const v = vars[name];
    if (v === undefined || v === null || v === '') return '';
    if (name === 'sha') return String(v).slice(0, 12);
    if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toFixed(1);
    return String(v);
  });
}

/** Aplica renderTemplate a TODOS los strings de la acción (recursivo, sin tocar números/booleans). */
export function renderAction(action: TaskAction, vars: RuleVars): TaskAction {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return renderTemplate(v, vars);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(action) as TaskAction;
}

/** ¿Alguna regla usa placeholders de métricas? (para no agregar tokens si no hace falta) */
export const needsMetrics = (rules: AutomationRule[]): boolean =>
  rules.some((r) => METRIC_PLACEHOLDERS.some((p) => new RegExp(`\\{\\{\\s*${p}\\s*\\}\\}`).test(JSON.stringify(r.action))));

const eqi = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Condiciones `when` de la regla contra el contexto del disparo. */
export function matchesWhen(rule: AutomationRule, ctx: RuleContext): string | null {
  const w = rule.when ?? {};
  if (w.environment && !(ctx.environment && eqi(w.environment, ctx.environment))) return `environment ≠ ${w.environment}`;
  if (w.target_branch && !(ctx.target_branch && ctx.target_branch === w.target_branch)) return `target_branch ≠ ${w.target_branch}`;
  if (w.from_status_category && ctx.status_category !== w.from_status_category) {
    return `status_category ${ctx.status_category ?? '(desconocido)'} ≠ ${w.from_status_category}`;
  }
  return null;
}

/**
 * Motor de reglas PURO: dado un disparo, qué acciones encolar.
 * - solo reglas `enabled` con el mismo `trigger` y cuyo `when` se cumpla;
 * - plantillas renderizadas y re-validadas con zod (una URL vacía ⇒ regla omitida, no acción rota);
 * - idempotency_key = `${rule_id}:${trigger_ref}` (trigger_ref ya incluye la tarea).
 */
export function evaluateRules(
  trigger: RuleTrigger,
  context: RuleContext & { rules: AutomationRule[] },
): { planned: PlannedAction[]; skipped: SkippedRule[] } {
  const planned: PlannedAction[] = [];
  const skipped: SkippedRule[] = [];
  const vars: RuleVars = { task_key: context.task_key, ...context.vars };
  for (const rule of context.rules) {
    if (!rule.enabled || rule.trigger !== trigger) continue;
    const miss = matchesWhen(rule, context);
    if (miss) {
      skipped.push({ rule_id: rule.rule_id, reason: miss });
      continue;
    }
    const parsed = TaskAction.safeParse(renderAction(rule.action, vars));
    if (!parsed.success) {
      skipped.push({ rule_id: rule.rule_id, reason: `acción inválida tras plantillas: ${parsed.error.issues[0]?.message ?? 'zod'}` });
      continue;
    }
    planned.push({
      rule_id: rule.rule_id,
      integration_id: rule.integration_id,
      idempotency_key: `${rule.rule_id}:${context.trigger_ref}`,
      trigger_ref: context.trigger_ref,
      action: parsed.data,
    });
  }
  return { planned, skipped };
}

/** trigger_ref canónico: `${task_key}|${ref}` (ref = `pr:org/repo:12`, `deploy:org/repo:987`…). */
export const triggerRefFor = (taskKey: string, ref: string): string => `${taskKey}|${ref}`.slice(0, 100);

/** URL del commit en el proveedor git (placeholder {{commit_url}}). */
export function commitUrl(provider: GitProvider | string | undefined, repository: string | undefined, sha: string | undefined): string {
  if (!repository || !sha || !/^[\w.-]+\/[\w./-]+$/.test(repository)) return '';
  switch (provider) {
    case 'bitbucket':
      return `https://bitbucket.org/${repository}/commits/${sha}`;
    case 'gitlab':
      return `https://gitlab.com/${repository}/-/commit/${sha}`;
    case 'github':
      return `https://github.com/${repository}/commit/${sha}`;
    default:
      return '';
  }
}

/**
 * Reglas sembradas al guardar credenciales por primera vez = DEFAULT_RULES, salvo que la URL de
 * ejemplo (`https://example.invalid/…`) del remote_link se sustituye por {{commit_url}}.
 */
export function seedRules(): AutomationRuleUpsert[] {
  return DEFAULT_RULES.map((r) =>
    r.action.kind === 'remote_link' && r.action.url.includes('example.invalid')
      ? { ...r, action: { ...r.action, url: '{{commit_url}}' } }
      : r,
  );
}
