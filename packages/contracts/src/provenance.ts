import { z } from 'zod';

/**
 * Límite de honestidad de datos: TODA cifra que llega al dashboard declara su procedencia.
 * - real:      medido en la fuente (MagiHub, Git real, evento del IDE).
 * - estimated: derivado con una aproximación declarada (ventana horaria, diff simplificado…).
 * - simulated: generado por el mock de MagiHub o por el seed de demo. Nunca se mezcla sin etiqueta.
 */
export const Provenance = z.enum(['real', 'estimated', 'simulated']);
export type Provenance = z.infer<typeof Provenance>;

/** Origen concreto de un dato, para el tooltip "¿de dónde sale esto?" del dashboard. */
export const DataSource = z.enum([
  'magihub-usage-api', // consumo consultado por API key + intervalo (fuente de verdad de tokens)
  'magihub-response', // `usage` devuelto en la respuesta de Smart Auto (por petición)
  'ide-telemetry', // eventos de la extensión MagiCode
  'git-local', // git diff / rev-parse en la máquina del dev
  'git-remote', // GitHub/Bitbucket API
  'declared-reference', // tag elegido como "versión demo"
  'deployment-evidence', // GitHub Deployments / pipeline CI/CD
  'magihub-mock', // servicio simulado (services/magihub-mock)
  'demo-seed', // scripts/seed-demo.ts
]);
export type DataSource = z.infer<typeof DataSource>;

/** Un valor numérico con su etiqueta de procedencia. */
export const Measured = z.object({
  value: z.number().nullable(), // null = no calculable (p. ej. denominador 0)
  provenance: Provenance,
  source: DataSource,
  note: z.string().optional(),
});
export type Measured = z.infer<typeof Measured>;

/** Cómo se relacionaron tokens ↔ cambios. */
export const Attribution = z.enum([
  'exact', // request_id compartido entre IDE y medición de MagiHub
  'estimated', // API key + sesión + ventana horaria
]);
export type Attribution = z.infer<typeof Attribution>;
