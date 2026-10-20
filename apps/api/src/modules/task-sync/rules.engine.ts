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

const isAbsoluteHttpUrl = (u: string): boolean => {
  if (!/^https?:\/\//i.test(u)) return false;
  try {
    new URL(u);
    return true;
  } catch {
    return false;
  }
};

export const COMMIT_URL_UNKNOWN = 'commit_url desconocido';

/**
 * Motor de reglas PURO: dado un disparo, qué acciones encolar.
 * - solo reglas `enabled` con el mismo `trigger` y cuyo `when` se cumpla;
 * - se renderizan las plantillas y DESPUÉS se valida (zod + URL absoluta http(s) en remote_link);
 * - remote_link con {{commit_url}} sin remoto conocido ⇒ se encola igual pero `skip_reason`
 *   (status skipped, last_error "commit_url desconocido") en vez de publicar un enlace roto;
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
    const base = {
      rule_id: rule.rule_id,
      integration_id: rule.integration_id,
      idempotency_key: `${rule.rule_id}:${context.trigger_ref}`,
      trigger_ref: context.trigger_ref,
    };
    const rendered = renderAction(rule.action, vars);
    if (rendered.kind === 'remote_link' && !isAbsoluteHttpUrl(rendered.url)) {
      if (rule.action.kind === 'remote_link' && rule.action.url.includes('{{commit_url}}')) {
        // se audita como skipped con la plantilla original (sigue siendo un TaskAction válido)
        planned.push({ ...base, action: { ...rendered, url: rule.action.url }, skip_reason: COMMIT_URL_UNKNOWN });
      } else {
        skipped.push({ rule_id: rule.rule_id, reason: `URL inválida tras plantillas: "${rendered.url}"` });
      }
      continue;
    }
    const parsed = TaskAction.safeParse(rendered);
    if (!parsed.success) {
      skipped.push({ rule_id: rule.rule_id, reason: `acción inválida tras plantillas: ${parsed.error.issues[0]?.message ?? 'zod'}` });
      continue;
    }
    planned.push({ ...base, action: parsed.data });
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
 * {{commit_url}} desde el `remote_url` del Commit (lo reporta la extensión):
 *   https://github.com/org/repo(.git) · git@github.com:org/repo.git · https://user@bitbucket.org/ws/repo.git
 * GitHub → /commit/<sha> · Bitbucket → /commits/<sha> · GitLab → /-/commit/<sha>. Otro host ⇒ ''.
 */
export function commitUrlFromRemote(remoteUrl: string | undefined | null, sha: string | undefined): string {
  if (!remoteUrl || !sha) return '';
  const m =
    /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i.exec(remoteUrl.trim()) ??
    /^[^@\s]+@([^:]+):(.+?)(?:\.git)?\/?$/.exec(remoteUrl.trim());
  if (!m) return '';
  const host = m[1]!.toLowerCase();
  const provider = host === 'github.com' ? 'github' : host === 'bitbucket.org' ? 'bitbucket' : host === 'gitlab.com' ? 'gitlab' : '';
  return commitUrl(provider, m[2]!, sha);
}

/** Reglas sembradas al guardar credenciales por primera vez (copia de DEFAULT_RULES). */
export function seedRules(): AutomationRuleUpsert[] {
  return structuredClone(DEFAULT_RULES);
}
