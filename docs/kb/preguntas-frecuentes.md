# Preguntas frecuentes

## Qué es

Respuestas cortas a las dudas habituales de managers y desarrolladores al leer el dashboard. Cada respuesta enlaza al artículo con el detalle.

## Preguntas

**¿Cuál es el número que responde la pregunta del reto?**
`funnel[in_reference].tokens_per_100_effective_lines` (o `deployed` si hay evidencia de despliegue): tokens de MagiHub por cada 100 líneas efectivas que llegaron a la versión de referencia. En el ejemplo, 37 421. Ver [tokens por 100 líneas](tokens-por-100-lineas.md).

**¿Los tokens son reales?**
`tokens.total` sale de la API de consumo de MagiHub para la key y la ventana: `real` en la vista de toda la key. En vistas filtradas puede ser `estimated` (reparto por hora/día). Con el mock, `simulated`. Ver [tokens](tokens.md) y [procedencia](procedencia-y-atribucion.md).

**¿Por qué el total de tokens no coincide con la suma de las sesiones o tareas?**
Las sesiones, cambios y tareas suman el `usage` de cada respuesta (`reported_by_requests`); el total viene de la API de consumo. La diferencia es `tokens.unreconciled` (otra aplicación usando la key o retraso de ingesta). En el ejemplo: 9 520 frente a 9 400.

**¿Por qué se cuentan los tokens de rechazos y errores?**
Porque son el costo real de producir lo que sobrevive. `tokens.on_rejected` los muestra por separado.

**¿Por qué "líneas efectivas" y no líneas aceptadas?**
Las líneas brutas premian el boilerplate, la duplicación y las regeneraciones. Las efectivas ponderan por importancia y quitan redundantes y mecánicas. Ver [líneas efectivas](lineas-efectivas.md).

**La retención en Git parece baja, ¿perdemos código?**
Revise primero la unidad: `accepted` incluye líneas triviales (`}`), `committed` no. Compare `effective_lines` entre etapas. Ver [embudo](embudo.md).

**¿Qué significa una redundancia de 0.35?**
Más de un tercio de las líneas no triviales aceptadas ya existía o se repitió: tokens pagados por duplicación. Mire qué señal domina (`existing_in_repo`, `repeated_in_session`, `intra_change`). Ver [redundancia](redundancia.md).

**¿Un `mechanical_share` de 0.6 es malo?**
Indica que el 60 % de las líneas aceptadas era automatizable sin LLM (imports, cierres, archivos generados). No es un error, pero sí tokens mal invertidos. Ver [automatización](automatizacion.md).

**¿"Mergeado a main" cuenta como desplegado?**
No. Solo una evidencia de despliegue (GitHub `deployment_status` `success` o `reference.marked` con `kind = deployment` y `evidence_url`). Sin ella, como mucho es "versión de referencia (demo)".

**¿Qué tan confiables son la supervivencia y el riesgo de retrabajo?**
Son probabilidades con AUC ≈ 0.70 y, hoy, entrenadas con datos sintéticos (`simulated`) o calculadas por una heurística (`estimated`). Sirven para priorizar revisiones. Ver [puntuaciones](puntuaciones-xgboost.md).

**¿Cuándo un cambio es `critical`?**
Cuando `criticality_score ≥ 0.80`, lo que requiere `rework_risk ≥ 0.73` con exposición máxima: cambios grandes en `core`, sin tests, en tareas Bug, en la rama default, de noche o con muchas regeneraciones. Ver [criticidad](criticidad.md).

**¿Cuántos PR tienen código IA?**
`GET /api/v1/pull-requests` → `meta.with_ai_lines` (de `meta.total`). El % IA de un PR es `ai.ai_matched_lines / ai.commit_added_lines`. Ver [pull requests](pull-requests.md).

**¿Hay lead time de PR?**
No como campo. Se puede derivar `merged_at − opened_at`, con horas de recepción del webhook (aproximado). Ver [pull requests](pull-requests.md).

**¿Por qué una tarea aparece como "untracked"?**
La clave aparece en ramas o commits, pero Jira no envió la tarea: falta la integración o el prefijo no está en `task_project_keys`. Ver [tareas y ramas](tareas-y-ramas.md).

**¿MagiCode puede mover la tarea en Jira?**
Sí, manualmente desde el dashboard o con reglas (p. ej. "PR abierto → En revisión"). Las acciones pasan por un outbox auditado e idempotente. Ver [respuesta a tareas](respuesta-a-tareas.md).

**¿Se envía mi código a algún servidor?**
No. El análisis se hace en el IDE; al backend solo llegan conteos, rutas relativas y hashes. Ni prompts ni la API key. Ver [privacidad](privacidad.md).

**¿Por qué mis números de un mismo día cambian?**
La API de consumo de MagiHub puede tener retraso de ingesta; cuando llega, `tokens.total` y `unreconciled` se actualizan. Las puntuaciones también pueden cambiar si se despliega un modelo nuevo (`model_version`).

**¿Puedo comparar equipos con estas métricas?**
Con cuidado: solo con los mismos pesos de importancia, la misma convención de ramas y API keys dedicadas. Úselas como tendencia del mismo equipo, no para evaluar personas.

## Implementación

Ver los artículos enlazados.
