# Guía de métricas de MagiCode

Esta guía es la referencia única de **cada métrica y concepto** que muestra el dashboard de productividad de MagiCode. Está escrita para engineering managers y desarrolladores, y está alineada con los contratos (`packages/contracts/src/`) y con el código que calcula cada número.

La pregunta que responde el producto:

> ¿Cuántos tokens consumimos mediante MagiHub para producir cambios de código que se aceptan, se registran en Git y llegan a una versión de referencia o despliegue?

Respuesta corta para el ejemplo de la guía: 9 520 tokens → 41 líneas IA en la versión de referencia `demo-v0.1` → 37 421 tokens por cada 100 líneas efectivas. Ver [ejemplo de referencia](ejemplo-demo-001.md).

## Cómo leer la guía

Cada artículo tiene las mismas secciones:

1. **Qué es**: definición en una o dos líneas.
2. **Cómo se calcula**: fórmula exacta, entradas y el evento o campo de origen.
3. **Fuente y procedencia**: si el dato es `real`, `estimated` o `simulated`, y por qué.
4. **Cómo interpretarlo**: rangos y umbrales con indicaciones concretas.
5. **Ejemplo**: cálculo numérico sobre el mismo caso en toda la guía (sesión `demo-001`, tarea `MAG-123`, rama `feature/MAG-123-descuentos`).
6. **Errores comunes / límites**.
7. **Implementación**: archivos donde vive el cálculo.

Convenciones:

- Los nombres de campo van en `código` y coinciden con el JSON de la API.
- Toda cifra del dashboard es un `Measured` `{value, provenance, source, note?}`; `value = null` significa "no calculable" (p. ej. denominador 0), nunca cero.
- Las proporciones van de 0 a 1 (el dashboard puede mostrarlas como %). Los valores se redondean a 4 decimales.
- Los ejemplos usan espacio como separador de miles y punto decimal.

## Índice

**Pregunta central**

| artículo | qué explica |
|----------|-------------|
| [Embudo](embudo.md) | Etapas generado → aceptado → Git → versión de referencia → desplegado; tasas de aceptación, retención y supervivencia. |
| [Tokens](tokens.md) | Total de MagiHub, reconciliación y desglose (aceptados, rechazados, regeneraciones, mecánico, costo). |
| [Tokens por 100 líneas](tokens-por-100-lineas.md) | El KPI por etapa, sobre líneas brutas y efectivas. |
| [Líneas efectivas](lineas-efectivas.md) | El denominador honesto: importancia sin redundancia ni código mecánico. |

**Las tres aristas de cada línea**

| artículo | qué explica |
|----------|-------------|
| [Importancia](importancia.md) | Pesos por clase de línea y por tier de archivo. |
| [Redundancia](redundancia.md) | Repeticiones en el cambio, en la sesión y en el repo; regeneraciones redundantes. |
| [Automatización](automatizacion.md) | Código mecánico, % IA de cada commit, líneas perdidas antes del commit. |

**Calidad y riesgo**

| artículo | qué explica |
|----------|-------------|
| [Puntuaciones (XGBoost)](puntuaciones-xgboost.md) | Probabilidad de supervivencia y riesgo de retrabajo; modelo, features, heurística de respaldo. |
| [Criticidad](criticidad.md) | Fórmula, umbrales `low`/`medium`/`high`/`critical` y qué hacer en cada nivel. |

**Trabajo y entrega**

| artículo | qué explica |
|----------|-------------|
| [Pull requests](pull-requests.md) | Total, abiertos/fusionados/cerrados, PR con líneas IA, % IA por PR, lead time. |
| [Tareas y ramas](tareas-y-ramas.md) | Enlace por clave Jira, métricas por tarea y por rama. |
| [Respuesta a tareas](respuesta-a-tareas.md) | Escritura de vuelta en Jira: outbox, reglas, plantillas, idempotencia, anti-bucle, permisos. |
| [Webhooks](webhooks.md) | GitHub, Bitbucket y Jira: firma, eventos, normalización, respuestas. |

**Datos y confianza**

| artículo | qué explica |
|----------|-------------|
| [Multitenant](multitenant.md) | Jerarquía tenant → proyecto → tarea → rama → sesión → cambio → commit → PR → despliegue. |
| [Procedencia y atribución](procedencia-y-atribucion.md) | `real`/`estimated`/`simulated` y `exact`/`estimated`. |
| [Privacidad](privacidad.md) | Qué sale del IDE y qué nunca se guarda. |
| [Limitaciones](limitaciones.md) | Lo que las métricas no garantizan y cómo afecta a cada número. |

**Referencia**

| artículo | qué explica |
|----------|-------------|
| [Ejemplo de referencia](ejemplo-demo-001.md) | Todas las cifras del caso `demo-001` en un solo lugar. |
| [Glosario](glosario.md) | Definiciones cortas con enlace al artículo. |
| [Preguntas frecuentes](preguntas-frecuentes.md) | Dudas habituales al leer el dashboard. |

## Índice para el dashboard

`index.json` lista cada artículo con `id`, `title`, `summary`, `file`, `metric_keys` y `tags`. Las `metric_keys` son rutas JSON de los números que explica el artículo:

- Sin prefijo: rutas dentro de `ProductivitySummary` (`tokens.total`, `dimensions.redundancy.score`, `funnel[].conversion`). `[]` indica "cualquier elemento del arreglo".
- Con prefijo de tipo: `ChangeListItem.`, `SessionListItem.`, `TaskListItem.`, `BranchListItem.`, `TimelinePoint.`, `PullRequestListItem.`, `PullRequestTotals.`, `Integration.`, `Measured.`.
- Identificadores de sección: `task_actions`, `automation_rules` (vistas de respuesta a tareas).

Cada clave aparece en un solo artículo, así el enlace "?" de un número lleva siempre al mismo lugar.

## Mantenimiento

- Fuentes de verdad: `docs/metrics-model.md` y `packages/contracts/src/*.ts`. Si cambia un peso, umbral o campo, se actualiza el artículo y su ejemplo.
- El dashboard sirve la guía desde `apps/dashboard/public/kb/`. Después de editar, ejecutar `node scripts/sync-kb.mjs` para copiar los `.md` y `index.json` y validar el índice.
