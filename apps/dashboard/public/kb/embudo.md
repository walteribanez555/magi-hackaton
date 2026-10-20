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
                                o Deployment success A PRODUCCIÓN (webhook) del SHA del commit
                                o del merge_sha/head_sha del PR de su rama
```

**Unidad única** (`docs/metrics-model.md` §2.5): todas las etapas cuentan **líneas agregadas no vacías y no triviales** (las triviales como `}` o `);` no se rastrean por hash). Así cada conversión compara lo mismo con lo mismo.

## Cómo se calcula

Cada etapa es un `FunnelStep` en `ProductivitySummary.funnel[]` con `stage`, `lines`, `effective_lines`, `tokens_per_100_lines`, `tokens_per_100_effective_lines` y `conversion`.

| etapa (`stage`) | `lines` (no triviales)                                                  | `effective_lines`                                |
|-----------------|-------------------------------------------------------------------------|--------------------------------------------------|
| `generated`     | por cambio: si se aceptó tal cual, `importance.lines − by_kind.trivial`; si no, `proposed_added_lines × (1 − proporción trivial)` (la del propio cambio si se aceptó editado; si no, la de lo aceptado en la **misma sesión**; si tampoco, la del alcance). Nunca menos que lo aceptado del cambio. `estimated` en cuanto hay una estimación; sin proporción de referencia es cota superior (nota) | `null` (las aristas se calculan al aceptar) |
| `accepted`      | Σ `importance.lines − importance.by_kind.trivial` de cambios `accepted`, `committed` o `in_reference` (sin `dimensions` ⇒ `accepted_added_lines`, cota superior, `estimated`) | Σ `dimensions.effective_lines`                 |
| `committed`     | Σ por commit de `min(automation.ai_matched_lines, no triviales aceptadas de sus change_ids del alcance aún no consumidas)` | `automation.effective_lines` escalado por el mismo tope |
| `in_reference`  | por commit: se toma la referencia **más reciente cuyo `included_shas` incluye el commit** y su `surviving_lines` se reparte entre los commits incluidos en proporción a sus líneas `committed` (tope: las del commit) | ídem con `surviving_effective_lines` |
| `deployed`      | por commit: máx(reparto de la referencia `kind=deployment` que lo incluye, líneas `committed` del commit si hay Deployment `success` a producción de su SHA o del `merge_sha`/`head_sha` de un PR cuya rama origen lo contiene) | ídem con líneas efectivas |

Tasas:

```
conversion(etapa)   = lines(etapa) / lines(etapa anterior)      (null en generated o si el anterior es 0)
conversion(deployed)= lines(deployed) / lines(committed)        (un despliegue puede llegar por el merge del PR sin tag)
Tasa de aceptación  = lines(accepted)  / lines(generated)       = funnel[accepted].conversion
Retención en Git    = lines(committed) / lines(accepted)        = funnel[committed].conversion
Supervivencia       = lines(in_reference) / lines(accepted)     (se calcula multiplicando las conversiones
                                                                 de committed e in_reference, o dividiendo directamente)
```

Las tasas de aceptación por **cambios** (no por líneas) salen de `counts`: `changes_accepted / changes_proposed`. Ojo: `changes_proposed` cuenta **todos** los cambios conocidos (incluye los que luego se aceptaron o rechazaron), no solo los que siguen en estado `proposed`.

Reglas de honestidad:

- **Embudo monótono**: ninguna etapa supera a la anterior. `committed` se topa por lo aceptado (hashes repetidos como `return null;` o cambios aceptados fuera de la ventana podrían inflarlo), `in_reference` y `deployed` se reparten sobre las líneas `committed` de cada commit, y `generated` nunca es menor que lo aceptado.
- `deployed` exige evidencia real: `reference.marked` con `kind = deployment` y `evidence_url` (el contrato rechaza el evento si falta), o un Deployment `success` recibido por webhook **en un entorno de producción** (`DEPLOY_PRODUCTION_ENVIRONMENTS`, por defecto `production,prod`; `staging` no cuenta). Vale el SHA del commit o el merge commit / head del PR cuya rama origen (`Commit.branch` o `remote_branch`) contiene el commit. Una rama `main`, un merge o un tag sin evidencia **nunca** cuentan como desplegados; como mucho son "versión de referencia (demo)".
- `in_reference` solo cuenta líneas de commits presentes en `included_shas` del tag; si un commit está en varios tags manda el más reciente (marcar dos tags no duplica las líneas).

## Fuente y procedencia

| etapa          | fuente (`source`)                 | procedencia típica |
|----------------|-----------------------------------|--------------------|
| `generated`    | `ide-telemetry`                   | `estimated` (las triviales propuestas se estiman; `real` solo si todo se aceptó tal cual) |
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
| `generated`    |   100 |            null | null                |            9 520.00 |                   null |
| `accepted`     |    48 |           30.64 | 48/100 = 0.48       |           19 833.33 |              31 070.50 |
| `committed`    |    43 |           27.44 | 43/48 = 0.8958      |           22 139.53 |              34 693.88 |
| `in_reference` |    41 |           25.44 | 41/43 = 0.9535      |           23 219.51 |              37 421.38 |
| `deployed`     |     0 |               0 | 0/43 = 0            |                null |                   null |

- `accepted = (42 − 10) + (22 − 6) = 32 + 16 = 48` líneas no triviales.
- `generated = 32 + 16 + 26 + 26 = 100` (`estimated`): `chg-1` y `chg-4` se aceptaron tal cual (exactas); `chg-2` y `chg-3` (35 propuestas cada uno, rechazados) se estiman con la proporción trivial de lo aceptado en la sesión, `16 / 64 = 0.25`: `round(35 × 0.75) = 26`.
- Aceptación por cambios: `counts.changes_accepted / counts.changes_proposed = 2 / 4 = 0.50`.
- Supervivencia: `41 / 48 = 0.8542`.
- `deployed = 0`: el tag `demo-v0.1` es una referencia de demo, no hay evidencia de despliegue. Por eso tokens / 100 líneas es `null` y no infinito.

Lectura: de las 48 líneas IA no triviales aceptadas, 43 llegaron al commit (0.90) y 41 sobreviven en la versión de referencia.

## Errores comunes / límites

- `generated` es una estimación: `code.proposed` solo trae `files[].added` (sin clasificar por `kind`), así que las triviales de lo rechazado se suponen en la misma proporción que lo aceptado de la sesión.
- `accepted` cuenta líneas no triviales (con repeticiones dentro del cambio); `committed` cuenta hashes únicos. Una línea repetida intencionalmente se cuenta una vez en Git: la conversión `committed` puede quedar algo por debajo de 1 aunque todo llegara.
- El tope de `committed` usa solo cambios aceptados **del alcance**: un commit de la ventana cuyos cambios se aceptaron antes de `from` aporta 0 líneas (la nota lo indica).
- El despliegue por merge commit se reconoce por la rama origen del PR, no por ancestros reales del merge: un commit que se agregó a la rama después del merge contaría igual (`estimated`).
- `counts.deployments_success` cuenta los Deployment `success` a producción que prueban el despliegue de algún commit del alcance; el mismo criterio que la etapa `deployed`.
- Los cambios aceptados que se descartan por completo antes del commit no suman `ai_lost_lines`; solo se ven como diferencia entre `accepted` y `committed`.
- Un commit con líneas IA de varias sesiones se atribuye a la sesión del evento `git.committed`.
- La etapa `generated` no pondera nada: es volumen bruto de propuestas.

## Implementación

- Esquema: `packages/contracts/src/summary.ts` (`FunnelStage`, `FunnelStep`), `packages/contracts/src/events.ts` (eventos de cada etapa).
- Cálculo: `apps/api/src/modules/productivity/productivity.metrics.ts` (`acceptedNonTrivial`, `generatedNonTrivial`, `committedLinesByCommit`, `referenceLinesByCommit`, `stageLines`, `buildFunnel`, `deployedCommits`, `highestStage`).
- Regla de despliegue (compartida con tareas): `apps/api/src/common/utils/deployment-evidence.ts`.
- Coincidencia por hash: `packages/metrics/src/commit.ts` (`matchCommit`, `computeSurvival`).
