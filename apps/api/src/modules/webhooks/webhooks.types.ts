import type { IntegrationProvider, NormalizedWebhookEvent } from '@magicode/contracts';

/** Entrada común de los adaptadores (funciones PURAS: sin I/O, sin reloj implícito). */
export interface AdapterInput {
  /** valor del header de evento del proveedor (X-GitHub-Event, X-Event-Key, X-Gitlab-Event…) */
  event: string | undefined;
  payload: unknown;
  delivery_id: string;
  integration_id: string;
  received_at: string;
  /** opciones de la integración / entorno */
  options?: {
    /** Jira/Linear: https://empresa.atlassian.net — para construir la URL de la tarea */
    base_url?: string;
    /** Jira: campo de story points (env JIRA_STORY_POINTS_FIELD, default customfield_10016) */
    story_points_field?: string;
    /** anti-bucle: accountId de la cuenta de servicio de write-back (IntLookup.service_account_id) */
    service_account_id?: string;
    /** anti-bucle: ids de campos que gestiona MagiCode (story points, métricas) */
    managed_field_ids?: string[];
  };
}

export type AdaptResult =
  | { type: 'events'; events: NormalizedWebhookEvent[] }
  | { type: 'ping' }
  | { type: 'ignored'; reason: string; self?: boolean };

export type Adapter = (input: AdapterInput) => AdaptResult;

export type WebhookOutcome =
  | { status: 200; body: { ok: true; ping: true } }
  | { status: 200; body: { ok: true; duplicate: true } }
  | { status: 202; body: { ok: true; ignored: true; reason: string } }
  | { status: 200; body: { ok: true; ignored: 'self' } }
  | { status: 200; body: { ok: true; processed: number; kinds: string[] } };

export interface WebhookRequest {
  provider: string;
  integration_id: string;
  /** headers en minúsculas */
  headers: Record<string, string | undefined>;
  raw_body: string;
}

export type ProviderName = IntegrationProvider;
