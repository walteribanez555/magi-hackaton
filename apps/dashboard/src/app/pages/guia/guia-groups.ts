/** Agrupación del índice de la guía (estática; lo no listado cae en "Referencia"). */
export const GUIA_GROUPS: readonly { label: string; ids: readonly string[] }[] = [
  { label: 'Medición', ids: ['embudo', 'tokens', 'tokens-por-100-lineas', 'lineas-efectivas'] },
  { label: 'Aristas', ids: ['importancia', 'redundancia', 'automatizacion', 'criticidad'] },
  {
    label: 'Modelos y enlaces',
    ids: [
      'puntuaciones-xgboost',
      'pull-requests',
      'tareas-y-ramas',
      'respuesta-a-tareas',
      'webhooks',
      'multitenant',
      'procedencia-y-atribucion',
      'privacidad',
    ],
  },
];

export const FALLBACK_GROUP = 'Referencia';

export function groupOf(id: string): string {
  return GUIA_GROUPS.find((g) => g.ids.includes(id))?.label ?? FALLBACK_GROUP;
}

export function orderOf(id: string): number {
  let n = 0;
  for (const g of GUIA_GROUPS) {
    const k = g.ids.indexOf(id);
    if (k >= 0) return n + k;
    n += g.ids.length;
  }
  return Number.MAX_SAFE_INTEGER;
}
