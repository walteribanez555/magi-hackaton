import { z } from 'zod';
import { TokenUsage } from './events.js';

/**
 * Lo que necesitamos de MagiHub. Los paths reales se configuran por env en el adaptador
 * (apps/api/src/modules/magihub); `services/magihub-mock` implementa exactamente esto para
 * desarrollo y demo, y TODO lo que devuelve se etiqueta como `simulated`.
 *
 *   POST {base}/v1/chat/completions   (OpenAI-compatible, model = "smart-auto")
 *        → header `x-request-id`, body.id, body.model, body.usage
 *   GET  {base}/v1/keys/self          → identidad de la key (tenant, key_id, nombre)
 *   GET  {base}/v1/usage?from&to&granularity=request|hour|day
 *        → consumo REAL por API key + intervalo (fuente de verdad de tokens)
 */

export const SMART_AUTO_MODEL = 'smart-auto';

export const KeyIdentity = z.object({
  tenant_id: z.string(),
  key_id: z.string(),
  key_name: z.string().optional(),
  scopes: z.array(z.string()).default([]),
  /** gobernanza: modelos permitidos / tope de tokens, si MagiHub lo expone */
  governance: z
    .object({
      allowed_models: z.array(z.string()).optional(),
      monthly_token_limit: z.number().optional(),
    })
    .optional(),
});
export type KeyIdentity = z.infer<typeof KeyIdentity>;

export const UsageGranularity = z.enum(['request', 'hour', 'day']);
export type UsageGranularity = z.infer<typeof UsageGranularity>;

export const UsageRecord = z.object({
  /** presente solo con granularity=request ⇒ atribución exacta */
  request_id: z.string().optional(),
  window_start: z.string(),
  window_end: z.string(),
  model: z.string().optional(),
  usage: TokenUsage,
  requests: z.number().int().nonnegative(),
  cost_usd: z.number().optional(),
});
export type UsageRecord = z.infer<typeof UsageRecord>;

export const UsageResponse = z.object({
  key_id: z.string(),
  from: z.string(),
  to: z.string(),
  granularity: UsageGranularity,
  records: z.array(UsageRecord),
  /** el mock pone true; el adaptador real false */
  simulated: z.boolean().default(false),
  /** retraso de ingesta conocido (min) — el dashboard avisa si la ventana es muy reciente */
  ingestion_delay_minutes: z.number().optional(),
});
export type UsageResponse = z.infer<typeof UsageResponse>;
