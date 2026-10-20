import { createLogger } from '../../config/logger';
import { integrationHealthService, type IntegrationHealthService } from './integration-health.service';

const logger = createLogger('SummaryWarnings');

export interface SummaryWarning {
  code: string;
  message: string;
}

export interface SummaryWarningsInput {
  project_id?: string;
  repository?: string;
  to: string;
  now: string;
  usage: { ingestion_delay_minutes?: number } | null;
  changes: Array<{ scores?: { model_version?: string } | null }>;
}

/**
 * Avisos de ProductivitySummary (baratos: sin llamadas a proveedores):
 *  - project_not_ready: el proyecto/repo no tiene sus DOS webhooks obligatorios funcionando
 *    (las etapas Git verificado / PR / despliegue / tareas son estimadas);
 *  - usage_ingestion_delay: la ventana termina dentro del retraso de ingesta que informa MagiHub;
 *  - scoring_heuristic: las puntuaciones vienen de la heurística (sin endpoint XGBoost).
 * Nunca lanza: un fallo aquí no debe romper el resumen.
 */
export async function summaryWarnings(
  tenantId: string,
  input: SummaryWarningsInput,
  svc: Pick<IntegrationHealthService, 'projectReadiness' | 'repositoryReadiness'> = integrationHealthService,
): Promise<SummaryWarning[]> {
  const out: SummaryWarning[] = [];
  try {
    if (input.project_id || input.repository) {
      const repos = input.project_id
        ? (await svc.projectReadiness(tenantId, input.project_id)).repositories.filter((r) => !input.repository || r.repository.toLowerCase() === input.repository.toLowerCase())
        : [await svc.repositoryReadiness(tenantId, input.repository!)];
      const notReady = repos.filter((r) => !r.ready);
      if (!repos.length && input.project_id) {
        out.push({
          code: 'project_not_ready',
          message: `El proyecto ${input.project_id} no tiene repositorios con webhook: conecta el repositorio y el gestor de tareas. Git verificado, PR, despliegue y tareas se muestran como estimados.`,
        });
      } else if (notReady.length) {
        const detail = notReady.map((r) => `${r.repository} (${r.blocking_reasons[0] ?? 'webhooks incompletos'})`).join('; ');
        out.push({
          code: 'project_not_ready',
          message: `Repositorios sin sus dos webhooks obligatorios funcionando: ${detail}. Git verificado, PR, despliegue y tareas se muestran como estimados.`,
        });
      }
    }
  } catch (err) {
    logger.warn('No se pudo evaluar la readiness para el resumen', { error: err instanceof Error ? err.message : String(err) });
  }
  const delay = input.usage?.ingestion_delay_minutes;
  if (delay && Date.parse(input.now) - Date.parse(input.to) < delay * 60_000) {
    out.push({
      code: 'usage_ingestion_delay',
      message: `MagiHub informa un retraso de ingesta de ~${delay} min: el consumo de los últimos minutos de la ventana puede estar incompleto.`,
    });
  }
  if (input.changes.some((c) => c.scores?.model_version?.startsWith('heuristic'))) {
    out.push({
      code: 'scoring_heuristic',
      message: 'Las puntuaciones de supervivencia y retrabajo vienen de la heurística determinista (no hay endpoint XGBoost desplegado).',
    });
  }
  return out;
}
