/**
 * Write-back al gestor de tareas. Superficie pública para otros módulos:
 *  - fireTrigger(trigger, input): evalúa reglas y encola OutboxActions (productivity cablea
 *    commit.linked / session.started / reference.marked; webhooks ya dispara pr.* y deployment.success)
 *  - evaluateRules(trigger, context): motor puro (tests / previsualización)
 *  - processStreamBatch(event): lógica del Lambda task-sync (DynamoDB Streams)
 */
export { taskSyncService, TaskSyncService, RetryableOutboxError, MAX_ATTEMPTS } from './task-sync.service';
export { evaluateRules, renderTemplate, renderAction, triggerRefFor, commitUrl, seedRules } from './rules.engine';
export { processStreamBatch } from './task-sync.handler';
export type { TriggerInput, FireTrigger, RuleContext, RuleVars, PlannedAction } from './task-sync.types';

import { taskSyncService } from './task-sync.service';
import type { FireTrigger } from './task-sync.types';

/** Atajo: `await fireTrigger('commit.linked', { tenant_id, project_id, task_keys, ref: \`commit:${repo}:${sha}\`, vars: { sha, commit_url } })` */
export const fireTrigger: FireTrigger = (trigger, input) => taskSyncService.fireTrigger(trigger, input);
