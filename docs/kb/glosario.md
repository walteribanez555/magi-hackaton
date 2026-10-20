# Glosario

## Qué es

Definiciones cortas de los términos que aparecen en el dashboard y en esta guía. Cada término enlaza al artículo que lo define en detalle.

## Términos

| término | definición |
|---------|------------|
| **Aceptado** (`accepted`) | Etapa del embudo: el usuario aplicó al menos un cambio de la IA en un archivo (`code.accepted`). Incluye los cambios luego `committed` e `in_reference`. [Embudo](embudo.md) |
| **Aristas** | Las tres dimensiones con que se pondera cada línea aceptada: importancia, redundancia y automatización. [Líneas efectivas](lineas-efectivas.md) |
| **Atribución** (`attribution`) | Cómo se relacionan tokens y cambios: `exact` (por `request_id`) o `estimated` (por key + ventana). [Procedencia y atribución](procedencia-y-atribucion.md) |
| **Automatización** | Arista que separa lo mecánico (automatizable sin LLM) y mide qué parte de cada commit vino de la IA (`ai_share`). [Automatización](automatizacion.md) |
| **`ai_share`** | `ai_matched_lines / commit_added_lines` de un commit (sin triviales). [Automatización](automatizacion.md) |
| **Cambio** (`change`) | Una propuesta de la IA (`change_id`), con estado `proposed`, `accepted`, `rejected`, `committed` o `in_reference`. |
| **Conversión** (`conversion`) | `lines(etapa) / lines(etapa anterior)`; `deployed` se compara con `committed`. [Embudo](embudo.md) |
| **Criticidad** | `rework_risk^0.7 × exposure^0.3`, en niveles `low`/`medium`/`high`/`critical` (umbrales 0, 0.35, 0.60, 0.80). [Criticidad](criticidad.md) |
| **Desplegado** (`deployed`) | Etapa del embudo que exige evidencia real: `reference.marked{kind=deployment}` con `evidence_url` o Deployment `success` a producción por webhook (SHA del commit o merge commit de su PR). [Embudo](embudo.md) |
| **Embudo** (`funnel`) | Las cinco etapas `generated → accepted → committed → in_reference → deployed`. [Embudo](embudo.md) |
| **Exposición** (`exposure`) | `0.5 × importance_score + 0.5 × tier_weight`; modula la criticidad. [Criticidad](criticidad.md) |
| **Generado** (`generated`) | Etapa inicial: la IA propuso líneas (`code.proposed`). No implica utilidad. |
| **Heurística `heuristic:v1`** | Regresión logística con pesos fijos que reemplaza al XGBoost si no hay endpoint. [Puntuaciones](puntuaciones-xgboost.md) |
| **Importancia** | `Σ peso(kind) × peso(tier) / líneas`, 0..1. [Importancia](importancia.md) |
| **Integración** | Conexión de un proveedor (GitHub, Bitbucket, Jira…) con un proyecto; tiene su URL de webhook y su secreto HMAC. [Webhooks](webhooks.md) |
| **`kind`** | Clase de línea: `logic`, `declaration`, `test`, `config`, `comment`, `import`, `trivial`. [Importancia](importancia.md) |
| **Lead time del PR** | `merged_at − opened_at` (horas de recepción del webhook). Derivable, no es un campo. [Pull requests](pull-requests.md) |
| **Línea** | En el embudo, línea agregada no vacía y **no trivial** en todas las etapas (en `committed`/`in_reference`/`deployed`, hash único). [Embudo](embudo.md) |
| **Líneas efectivas** | Líneas aceptadas ponderadas por importancia, sin redundantes ni mecánicas. KPI base. [Líneas efectivas](lineas-efectivas.md) |
| **Línea mecánica** | `import`, `trivial` o en archivo `generated`: la habría producido una herramienta sin LLM. [Automatización](automatizacion.md) |
| **`Measured`** | Valor con etiqueta: `{value, provenance, source, note?}`; `value = null` si no es calculable. [Procedencia](procedencia-y-atribucion.md) |
| **Outbox** | Cola persistente de acciones hacia Jira (`OutboxAction`), con estados `pending`, `sending`, `sent`, `failed`, `skipped`. [Respuesta a tareas](respuesta-a-tareas.md) |
| **`output_hash`** | `sha256` (16 hex) de la salida normalizada del LLM; detecta regeneraciones redundantes sin guardar código. [Redundancia](redundancia.md) |
| **Procedencia** (`provenance`) | `real`, `estimated` o `simulated`. [Procedencia](procedencia-y-atribucion.md) |
| **PR con líneas IA** | PR cuyo bloque `ai.ai_matched_lines > 0`. [Pull requests](pull-requests.md) |
| **Redundancia** | Líneas no triviales repetidas en el cambio, en la sesión o ya existentes en el repo, sobre las no triviales. [Redundancia](redundancia.md) |
| **Regeneración redundante** | Petición cuyo `output_hash` repite el de una anterior de la sesión. [Redundancia](redundancia.md) |
| **Registrado en Git** (`committed`) | Etapa: líneas IA presentes en el diff de un commit con SHA real. [Embudo](embudo.md) |
| **Regla automática** | `AutomationRule`: cuando ocurre un trigger (`pr.opened`, `deployment.success`…), encola una acción en Jira. [Respuesta a tareas](respuesta-a-tareas.md) |
| **Respuesta a tareas** (write-back) | Escritura de vuelta en el gestor de tareas: transición, comentario, campos, enlaces, asignación. [Respuesta a tareas](respuesta-a-tareas.md) |
| **Retención en Git** | `lines(committed) / lines(accepted)`. [Embudo](embudo.md) |
| **Riesgo de retrabajo** (`rework_risk`) | P(el cambio se reescribe en ≤ 14 días). [Puntuaciones](puntuaciones-xgboost.md) |
| **Sesión** | Intervalo de trabajo en MagiCode (`session_id`), ligado a una key, un proyecto y una rama. [Multitenant](multitenant.md) |
| **Supervivencia** | `lines(in_reference) / lines(accepted)`. La **probabilidad de supervivencia** (`survival_probability`) es su predicción por cambio. [Embudo](embudo.md), [Puntuaciones](puntuaciones-xgboost.md) |
| **Tasa de aceptación** | `lines(accepted) / lines(generated)`; por cambios, `changes_accepted / changes_proposed`. [Embudo](embudo.md) |
| **Tenant** | Organización en MagiHub; se deriva de la API key, nunca del cuerpo del evento. [Multitenant](multitenant.md) |
| **`tier`** | Criticidad del archivo por ruta: `core`, `test`, `infra`, `docs`, `generated`. [Importancia](importancia.md) |
| **Tokens** | Consumo medido por MagiHub para la key y la ventana (`tokens.total`). [Tokens](tokens.md) |
| **Tokens por 100 líneas (efectivas)** | `tokens.total / lines × 100` por etapa; `null` si el denominador es 0. [Tokens por 100 líneas](tokens-por-100-lineas.md) |
| **`top_factors`** | Hasta 5 features que más empujan el riesgo de retrabajo, con dirección. [Puntuaciones](puntuaciones-xgboost.md) |
| **Trailer `MagiCode-Session`** | Línea `MagiCode-Session: <session_id>` en el mensaje del commit; enlaza commits remotos con la sesión. [Webhooks](webhooks.md) |
| **`unreconciled`** | `tokens.total − reported_by_requests`; ≠ 0 si otra aplicación usó la key o hay retraso. [Tokens](tokens.md) |
| **Versión de referencia (demo)** (`in_reference`) | Tag elegido como versión demo; líneas IA presentes en su SHA. No implica producción. [Embudo](embudo.md) |
| **Webhook** | Notificación firmada del repositorio o de Jira hacia `POST /api/v1/webhooks/{provider}/{integration_id}`. [Webhooks](webhooks.md) |

## Implementación

Los nombres de campo provienen de `packages/contracts/src/` (`summary.ts`, `dimensions.ts`, `events.ts`, `scoring.ts`, `integrations.ts`, `writeback.ts`, `provenance.ts`).
