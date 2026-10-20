# Embudo (etapas, aceptación, retención y supervivencia)

## Qué es

El **embudo** sigue las líneas producidas con IA por cinco etapas, desde que el LLM las propone hasta que hay evidencia de que están desplegadas. Responde la pregunta del reto: ¿cuántos tokens cuesta el código que **se acepta, se registra en Git y llega a una versión de referencia o despliegue**?

```
Tokens MagiHub (API key + intervalo)
  └─ generated      code.proposed                       la IA propuso
      └─ accepted   code.accepted                       el usuario aplicó (+ 3 aristas)
          └─ committed     git.committed                líneas IA presentes en el diff del commit
              └─ in_reference   reference.marked        líneas IA presentes en el SHA del tag
                  └─ deployed   reference.marked{kind=deployment} con evidence_url
                                o Deployment state=success (webhook) del mismo SHA
```

## Cómo se calcula

Cada etapa es un `FunnelStep` en `ProductivitySummary.funnel[]` con `stage`, `lines`, `effective_lines`, `tokens_per_100_lines`, `tokens_per_100_effective_lines` y `conversion`.

| etapa (`stage`) | `lines`                                                                 | `effective_lines`                                |
|-----------------|-------------------------------------------------------------------------|--------------------------------------------------|
| `generated`     | Σ líneas agregadas propuestas de **todos** los cambios (aceptados y rechazados); si falta la propuesta, se usa `accepted_added_lines` | `null` (las aristas se calculan al aceptar) |
| `accepted`      | Σ `accepted_added_lines` de cambios con estado `accepted`, `committed` o `in_reference` | Σ `dimensions.effective_lines`                 |
| `committed`     | Σ `automation.ai_matched_lines` de los commits del alcance              | Σ `automation.effective_lines`                   |
| `in_reference`  | `surviving_lines` de la **última** referencia de cada sesión            | `surviving_effective_lines` de esa referencia    |
| `deployed`      | por sesión: máx(`surviving_lines` de la última referencia `kind=deployment`, Σ `ai_matched_lines` de commits cuyo SHA tiene un Deployment `success` en el mismo repo) | ídem con líneas efectivas |

Tasas:

```
conversion(etapa)   = lines(etapa) / lines(etapa anterior)      (null en generated o si el anterior es 0)
Tasa de aceptación  = lines(accepted)  / lines(generated)       = funnel[accepted].conversion
Retención en Git    = lines(committed) / lines(accepted)        = funnel[committed].conversion
Supervivencia       = lines(in_reference) / lines(accepted)     (se calcula multiplicando las conversiones
                                                                 de committed e in_reference, o dividiendo directamente)
```

Las tasas de aceptación por **cambios** (no por líneas) salen de `counts`: `changes_accepted / changes_proposed`. Ojo: `changes_proposed` cuenta **todos** los cambios conocidos (incluye los que luego se aceptaron o rechazaron), no solo los que siguen en estado `proposed`.

Reglas de honestidad:

- `deployed` exige evidencia real: `reference.marked` con `kind = deployment` y `evidence_url` (el contrato rechaza el evento si falta), o un Deployment `success` recibido por webhook. Una rama `main`, un merge o un tag sin evidencia **nunca** cuentan como desplegados; como mucho son "versión de referencia (demo)".
- `in_reference` usa la última referencia de cada sesión, no la suma de todas (marcar dos tags no duplica las líneas).

## Fuente y procedencia

| etapa          | fuente (`source`)                 | procedencia típica |
|----------------|-----------------------------------|--------------------|
| `generated`    | `ide-telemetry`                   | `real` (conteo de eventos del IDE) |
| `accepted`     | `ide-telemetry`                   | `real` en `lines`; `estimated` en `effective_lines` |
| `committed`    | `git-local` o `git-remote`        | `estimated` (coincidencia por hash de línea) |
| `in_reference` | `declared-reference`              | `estimated` (diff simplificado contra el SHA del tag) |
| `deployed`     | `deployment-evidence`             | `estimated` (la evidencia es real; las líneas, por hash) |

Con datos del seed de demo, la fuente es `demo-seed` y la procedencia `simulated`. La procedencia de cada `conversion` es la peor entre la etapa y la anterior.

## Cómo interpretarlo

| tasa                     | valor     | lectura                                                                                     |
|--------------------------|-----------|---------------------------------------------------------------------------------------------|
| Aceptación (líneas)      | < 0.30    | Se descarta la mayoría de lo generado: prompts poco precisos o exploración. Mirar `tokens.on_rejected`. |
|                          | 0.30–0.70 | Normal en uso interactivo.                                                                  |
|                          | > 0.90    | Se acepta casi todo; verificar que haya revisión (ver `edited_before_accept` y [criticidad](criticidad.md)). |
| Retención en Git         | < 0.60    | Mucho de lo aceptado no llega al commit. Ver límite de unidades abajo antes de alarmarse.   |
| Supervivencia            | < 0.50    | La mitad de lo aceptado no sobrevive a la versión de referencia: retrabajo en revisión.     |
|                          | > 0.80    | El código IA aceptado se mantiene.                                                          |
| `conversion` in_reference| < 0.80    | La revisión de código (PR) está reescribiendo líneas IA.                                    |

La lectura más útil es la caída entre etapas: dónde se pierden más líneas indica dónde está el desperdicio (prompting, aceptación, revisión, integración).

## Ejemplo

Sesión `demo-001`, tarea `MAG-123`, rama `feature/MAG-123-descuentos`, `tokens.total = 9 520` (ver [ejemplo completo](ejemplo-demo-001.md)).

| etapa          | lines | effective_lines | conversion          | tokens / 100 líneas | tokens / 100 efectivas |
|----------------|------:|----------------:|---------------------|--------------------:|-----------------------:|
| `generated`    |   134 |            null | null                |            7 104.48 |                   null |
| `accepted`     |    64 |           30.64 | 64/134 = 0.4776     |           14 875.00 |              31 070.50 |
| `committed`    |    43 |           27.44 | 43/64 = 0.6719      |           22 139.53 |              34 693.88 |
| `in_reference` |    41 |           25.44 | 41/43 = 0.9535      |           23 219.51 |              37 421.38 |
| `deployed`     |     0 |               0 | 0/41 = 0            |                null |                   null |

- `generated = 42 + 35 + 35 + 22 = 134`: `chg-1`, `chg-2` (rechazado), `chg-3` (regeneración rechazada) y `chg-4`.
- Aceptación por cambios: `counts.changes_accepted / counts.changes_proposed = 2 / 4 = 0.50`.
- Supervivencia: `41 / 64 = 0.6406`.
- `deployed = 0`: el tag `demo-v0.1` es una referencia de demo, no hay evidencia de despliegue. Por eso tokens / 100 líneas es `null` y no infinito.

Lectura: la retención aparente (0.67) está subestimada por la diferencia de unidades (ver límites): de las 47 líneas IA no triviales aceptadas, 43 llegaron al commit (0.91).

## Errores comunes / límites

- **Unidades distintas entre etapas.** `generated` y `accepted` cuentan todas las líneas agregadas no vacías (incluidas las triviales como `}`); `committed`, `in_reference` y `deployed` cuentan hashes únicos de líneas **no triviales** (así lo calcula `matchCommit` y `computeSurvival`). La retención en Git y la supervivencia salen, por tanto, sesgadas hacia abajo en la proporción de triviales del cambio (25 % en el ejemplo). Para comparar etapas, usar `effective_lines` (las triviales pesan 0 y no sufren el sesgo).
- `deployed` por webhook solo casa si el SHA desplegado es el **mismo** SHA del commit de la sesión (comparación por prefijo). Un despliegue del commit de merge o de un squash no se detecta como despliegue de esas líneas; en ese caso se debe emitir `reference.marked` con `kind = deployment`, `evidence_url` y las líneas sobrevivientes en el SHA desplegado.
- `counts.deployments_success` cuenta solo los Deployment `success` cuyo SHA coincide con un commit del alcance; el mismo criterio que la etapa `deployed`.
- Los cambios aceptados que se descartan por completo antes del commit no suman `ai_lost_lines`; solo se ven como diferencia entre `accepted` y `committed`.
- Un commit con líneas IA de varias sesiones se atribuye a la sesión del evento `git.committed`.
- La etapa `generated` no pondera nada: es volumen bruto de propuestas.

## Implementación

- Esquema: `packages/contracts/src/summary.ts` (`FunnelStage`, `FunnelStep`), `packages/contracts/src/events.ts` (eventos de cada etapa).
- Cálculo: `apps/api/src/modules/productivity/productivity.metrics.ts` (`stageLines`, `buildFunnel`, `deployedCommits`, `highestStage`).
- Coincidencia por hash: `packages/metrics/src/commit.ts` (`matchCommit`, `computeSurvival`).
