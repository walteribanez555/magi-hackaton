# Tokens por 100 líneas (y por 100 líneas efectivas)

## Qué es

**Tokens por 100 líneas** es el costo en tokens de MagiHub por cada 100 líneas que llegan a una etapa del embudo. **Tokens por 100 líneas efectivas** es el KPI principal: el mismo costo, pero sobre [líneas efectivas](lineas-efectivas.md) (ponderadas por importancia, sin redundantes ni mecánicas). Menor es mejor.

## Cómo se calcula

Para cada etapa del [embudo](embudo.md) (`ProductivitySummary.funnel[]`):

```
tokens_per_100_lines           = (tokens.total / lines(etapa)) × 100            null si lines = 0
tokens_per_100_effective_lines = (tokens.total / effective_lines(etapa)) × 100  null si effective_lines = 0 o null
```

- El numerador es siempre `tokens.total` (todos los tokens del alcance, incluidos rechazos y errores), no solo los de peticiones aceptadas. Es el costo real de lo que llega a la etapa.
- Denominador 0 ⇒ `value = null` con nota ("Sin líneas en esta etapa."), nunca infinito ni 0.
- Valores redondeados a 4 decimales.

## Fuente y procedencia

- `tokens_per_100_lines`: peor procedencia entre `tokens.total` y `lines` de la etapa. Con tokens reales y líneas del IDE es `real` en `generated`/`accepted`; `estimated` desde `committed`.
- `tokens_per_100_effective_lines`: siempre como mínimo `estimated` (las líneas efectivas son heurísticas). La fuente que se muestra es la de `tokens.total`.

## Cómo interpretarlo

- Leer la fila de la etapa que importa al negocio: `in_reference` (o `deployed` si hay evidencia) responde la pregunta del reto. `accepted` mide la eficiencia del flujo IDE.
- La subida entre etapas es el costo del desperdicio aguas abajo. Si `in_reference` cuesta el doble que `accepted`, la mitad de lo aceptado no sobrevivió.
- `tokens_per_100_effective_lines / tokens_per_100_lines` (misma etapa) = `lines / effective_lines`. Un cociente > 3 indica que la mayoría de las líneas brutas es relleno, duplicación o archivos de bajo peso.
- No hay un umbral universal: depende del tamaño de contexto que envía el IDE y del modelo que elige Smart Auto. Usar el valor como tendencia del mismo equipo/proyecto, y comparar por modelo con `by_model`.
- Una caída sostenida del valor en la misma etapa indica mejores prompts, menos regeneración o menos exploración; una subida, lo contrario. Cruzar con `tokens.on_rejected` y `tokens.on_redundant_regenerations` para saber cuál.

## Ejemplo

Sesión `demo-001`, `tokens.total = 9 520` (ver [ejemplo completo](ejemplo-demo-001.md)):

| etapa          | lines | tokens / 100 líneas         | effective_lines | tokens / 100 efectivas         |
|----------------|------:|-----------------------------|----------------:|--------------------------------|
| `generated`    |   100 | 9 520 / 100 × 100 = 9 520.00 |            null | null                           |
| `accepted`     |    48 | 9 520 / 48 × 100 = 19 833.33 |           30.64 | 9 520 / 30.64 × 100 = 31 070.50 |
| `committed`    |    43 | 22 139.53                    |           27.44 | 34 693.88                      |
| `in_reference` |    41 | 23 219.51                    |           25.44 | 37 421.38                      |
| `deployed`     |     0 | null                         |               0 | null                           |

Respuesta a la pregunta del reto para esta sesión: **9 520 tokens de MagiHub produjeron 41 líneas IA que llegaron a la versión de referencia `demo-v0.1`, equivalentes a 25.44 líneas efectivas: unos 37 400 tokens por cada 100 líneas efectivas.** No hay despliegue con evidencia, así que no se reporta costo por línea desplegada.

## Errores comunes / límites

- Dividir por los tokens de peticiones aceptadas (`on_accepted`) en lugar de `total` subestima el costo: oculta la exploración y los errores.
- Todas las etapas cuentan líneas no triviales (ver [embudo](embudo.md)); en `generated` las triviales de lo rechazado se estiman (`estimated`). `accepted` cuenta repeticiones y `committed` hashes únicos: queda un sesgo pequeño entre ambas que tokens / 100 líneas efectivas no tiene.
- Con pocas líneas el valor es muy volátil: 1 línea más o menos mueve mucho el resultado. Agregar por proyecto o por semana antes de sacar conclusiones.
- Si `tokens.total` sale del respaldo (`reported_by_requests`), el KPI hereda `estimated`.

## Implementación

- Esquema: `packages/contracts/src/summary.ts` (`FunnelStep.tokens_per_100_lines`, `FunnelStep.tokens_per_100_effective_lines`).
- Cálculo: `apps/api/src/modules/productivity/productivity.metrics.ts` (`per100`, `buildFunnel`).
