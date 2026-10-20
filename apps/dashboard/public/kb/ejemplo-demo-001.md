# Ejemplo de referencia: sesión demo-001 (MAG-123)

Este es el ejemplo que usan todos los artículos de la guía. Las cifras están calculadas con las fórmulas implementadas y son coherentes entre sí; si un artículo muestra un número de este caso, sale de aquí.

## Contexto

| elemento     | valor                                                                                      |
|--------------|--------------------------------------------------------------------------------------------|
| Tenant       | `acme` (derivado de la API key; `key_id = k_7f3a9c`, huella `1c9e0b7a4d2f`)                 |
| Proyecto     | `magicode-demo`, repositorio `org/repo-demo` (GitHub)                                       |
| Tarea        | `MAG-123` "Descuentos por volumen en el carrito" (Story, 5 puntos)                          |
| Rama         | `feature/MAG-123-descuentos`                                                                |
| Sesión       | `demo-001`, 2026-10-20 14:00–15:10 UTC                                                       |
| Consumo      | API de consumo de MagiHub con granularidad `hour`                                          |
| Scoring      | sin endpoint SageMaker → `heuristic:v1`                                                     |

## Cronología (UTC)

| hora              | evento                                                                                         |
|-------------------|------------------------------------------------------------------------------------------------|
| 10-20 13:55       | Jira `jira:issue_updated`: `MAG-123` → "In Progress" (`in_progress`)                           |
| 14:00             | `session.started` en `feature/MAG-123-descuentos`                                               |
| 14:05 → 14:12     | `req-101` (2 400 tokens, 4 200 ms) → `code.proposed` `chg-1` (42 líneas) → `code.accepted`      |
| 14:20 → 14:22     | `req-102` (1 800) → `chg-2` (35 líneas) → `code.rejected` (user)                                 |
| 14:25 → 14:27     | `req-103` regenera `req-102` (1 700, mismo `output_hash`) → `chg-3` (35 líneas) → `code.rejected` |
| 14:40 → 14:48     | `req-104` (2 900, 5 100 ms) → `chg-4` (22 líneas, 3 editadas antes de aceptar) → `code.accepted` |
| 14:55             | `req-105` `status = error` (600 tokens), sin propuesta                                           |
| 15:05             | `git.committed` `3f9c2e1` ("MAG-123 descuentos por volumen" + `MagiCode-Session: demo-001`)     |
| 15:06 / 15:08     | webhook `push` del commit; webhook `pull_request` `opened` del **PR #14** → `main`             |
| 15:08             | regla "PR abierto → En revisión" → transición en Jira (ver [respuesta a tareas](respuesta-a-tareas.md)) |
| 15:10             | `session.ended`                                                                                 |
| 10-21 09:50       | push de `5a6b7c8` "MAG-123 ajustes de revisión" (reescribe 2 líneas IA de lógica)              |
| 10:30             | PR #14 `merged`, `merge_sha = 9d8e7f6`                                                          |
| 10:35             | tag `demo-v0.1` en `9d8e7f6`; `reference.marked` `kind = demo-reference`, `included_shas = [3f9c2e1]`, `surviving_lines = 41`, `surviving_effective_lines = 25.44` |
| 11:00             | Jira: `MAG-123` → "Done"                                                                       |

No hay despliegue con evidencia.

## Tokens

| petición | estado | tokens | resultado |
|----------|--------|-------:|-----------|
| req-101  | ok     |  2 400 | chg-1 aceptado |
| req-102  | ok     |  1 800 | chg-2 rechazado |
| req-103  | ok     |  1 700 | regeneración redundante; chg-3 rechazado |
| req-104  | ok     |  2 900 | chg-4 aceptado |
| req-105  | error  |    600 | – |

API de consumo: una ventana 14:00–15:00 con `total_tokens = 9 520` y `requests = 6` (una llamada de prueba hecha con `curl` y la misma key, de 120 tokens).

```
reported_by_requests = 9 400        total = 9 520        unreconciled = 120
on_accepted = 5 300   on_redundant_regenerations = 1 700   on_rejected = 2 400   (partición: 5 300 + 1 700 + 2 400 = 9 400)
on_mechanical = 5 300 × 0.328125 = 1 739.0625
```

## Cambios aceptados y sus aristas

| cambio | archivos (tier)                                         | líneas | logic | decl | test | config | comment | import | trivial |
|--------|---------------------------------------------------------|-------:|------:|-----:|-----:|-------:|--------:|-------:|--------:|
| chg-1  | `src/pricing/discounts.ts` (core, 30) + `src/pricing/discounts.test.ts` (test, 12) | 42 | 14 | 4 | 8 | 0 | 2 | 4 | 10 |
| chg-4  | `src/pricing/discounts.ts` (core, 18, −4) + `src/config/pricing.json` (core, 4)   | 22 |  9 | 2 | 0 | 3 | 1 | 1 |  6 |

| cambio | weighted | importance | no triviales | redundantes (intra/sesión/repo) | redundancy | mecánicas | mechanical_share | effective |
|--------|---------:|-----------:|-------------:|---------------------------------|-----------:|----------:|-----------------:|----------:|
| chg-1  |    23.03 |     0.5483 |           32 | 3 (1 / 0 / 2)                   |     0.0938 |        14 |           0.3333 |     20.64 |
| chg-4  |    12.10 |     0.5500 |           16 | 2 (0 / 2 / 0)                   |     0.1250 |         7 |           0.3182 |     10.00 |
| sesión |    35.13 |     0.5489 |           48 | 5 (1 / 2 / 2)                   |     0.1042 |        21 |           0.3281 |     30.64 |

Líneas no triviales aceptadas (unidad del embudo): (42 − 10) + (22 − 6) = 32 + 16 = 48. Hashes únicos no triviales: 31 (chg-1, la guarda repetida cuenta una vez) + 16 (chg-4) = 47.

## Commit, PR y referencia

```
commit 3f9c2e1: commit_added_lines = 55 · ai_matched_lines = 43 · ai_lost_lines = 4
                ai_share = 0.7818 · effective_lines = 27.44 · change_ids = [chg-1, chg-4]
PR #14: commits 3 (3f9c2e1, 5a6b7c8, 9d8e7f6) · con IA 1 · % IA = 43/55 = 0.7818 · lead time ≈ 19 h 22 min
reference demo-v0.1 @ 9d8e7f6: surviving_lines = 41 · surviving_effective_lines = 25.44
```

## Resumen (`GET /api/v1/productivity/summary?session_id=demo-001&from=2026-10-20T00:00Z&to=2026-10-22T00:00Z`)

```json
{
  "attribution": "estimated",
  "overall_provenance": "estimated",
  "tokens": {
    "total":                      { "value": 9520, "provenance": "estimated", "source": "magihub-usage-api" },
    "reported_by_requests":       { "value": 9400, "provenance": "real", "source": "magihub-response" },
    "unreconciled":               { "value": 120,  "provenance": "estimated", "source": "magihub-usage-api" },
    "on_accepted":                { "value": 5300, "provenance": "real", "source": "magihub-response" },
    "on_rejected":                { "value": 2400, "provenance": "real", "source": "magihub-response" },
    "on_redundant_regenerations": { "value": 1700, "provenance": "real", "source": "magihub-response" },
    "on_mechanical":              { "value": 1739.0625, "provenance": "estimated", "source": "magihub-response" },
    "cost_usd":                   { "value": null, "provenance": "estimated", "source": "magihub-usage-api" }
  },
  "funnel": [
    { "stage": "generated",    "lines": 100, "effective_lines": null,  "tokens_per_100_lines": 9520,       "tokens_per_100_effective_lines": null,       "conversion": null },
    { "stage": "accepted",     "lines": 48,  "effective_lines": 30.64, "tokens_per_100_lines": 19833.3333, "tokens_per_100_effective_lines": 31070.4961, "conversion": 0.48 },
    { "stage": "committed",    "lines": 43,  "effective_lines": 27.44, "tokens_per_100_lines": 22139.5349, "tokens_per_100_effective_lines": 34693.8776, "conversion": 0.8958 },
    { "stage": "in_reference", "lines": 41,  "effective_lines": 25.44, "tokens_per_100_lines": 23219.5122, "tokens_per_100_effective_lines": 37421.3836, "conversion": 0.9535 },
    { "stage": "deployed",     "lines": 0,   "effective_lines": 0,     "tokens_per_100_lines": null,       "tokens_per_100_effective_lines": null,       "conversion": 0 }
  ],
  "dimensions": {
    "importance": { "score": 0.5489, "by_kind": { "logic": 23, "declaration": 6, "test": 8, "config": 3, "comment": 3, "import": 5, "trivial": 16 } },
    "redundancy": { "score": 0.1042, "intra_change": 1, "existing_in_repo": 2, "repeated_in_session": 2, "redundant_regenerations": 1 },
    "automation": { "ai_share_of_commits": 0.7818, "mechanical_share": 0.3281, "lost_before_commit": 0.0833, "accepted_as_is": 61, "edited_before_accept": 3 }
  },
  "counts": {
    "sessions": 1, "ai_requests": 5, "changes_proposed": 4, "changes_accepted": 2, "changes_rejected": 2,
    "commits": 1, "references": 1, "pull_requests": 1, "pull_requests_merged": 1,
    "deployments_success": 0, "tasks": 1, "tasks_done": 1
  }
}
```

Notas: `generated = 100` es `estimated` (32 + 16 exactas de los aceptados; `chg-2` y `chg-3` = `round(35 × (1 − 16/64)) = 26` cada uno). `deployed.conversion` se calcula contra `committed` (0 / 43). `lost_before_commit = 4 / 48`.

(En el JSON real cada valor del embudo y de las aristas es un `Measured` `{value, provenance, source, note?}`; aquí se muestra solo `value` para abreviar. En la vista de toda la key, sin `session_id`, `tokens.total` sería `real`.)

## Lista de cambios (`ChangeListItem`)

| change_id | status         | accepted_added_lines | importance | redundancy | mechanical | effective | commit_sha | tokens | survival | rework | criticality |
|-----------|----------------|---------------------:|-----------:|-----------:|-----------:|----------:|------------|-------:|---------:|-------:|-------------|
| chg-1     | `in_reference` |                   42 |     0.5483 |     0.0938 |     0.3333 |     20.64 | 3f9c2e1    |  2 400 |   0.8374 | 0.0933 | low (0.1750) |
| chg-2     | `rejected`     |                    0 |          0 |          0 |          0 |         0 | null       |  1 800 | –        | –      | –           |
| chg-3     | `rejected`     |                    0 |          0 |          0 |          0 |         0 | null       |  1 700 | –        | –      | –           |
| chg-4     | `in_reference` |                   22 |     0.5500 |     0.1250 |     0.3182 |     10.00 | 3f9c2e1    |  2 900 |   0.7975 | 0.1748 | low (0.2732) |

## Tarea (`TaskListItem`)

`MAG-123`: `status = Done`, `branches = [feature/MAG-123-descuentos]`, `sessions = 1`, `commits = 3`, `pull_requests = [{14, merged}]`, `tokens = {9520, estimated}` (snapshot por hora prorrateado, misma regla que el resumen; sin snapshots guardados sería el respaldo `{9400, estimated}`), `accepted_lines = 48`, `effective_lines = 30.64`, `deployed = false` (no hay Deployment `success` a producción del commit ni del merge commit `9d8e7f6`).

Sesión (`SessionListItem`): `tokens = {9520, estimated, magihub-usage-api}` (prorrateo de la ventana horaria), `accepted_lines = 48`, `effective_lines = 30.64`, `highest_stage = in_reference`.

## Respuesta a la pregunta del reto

**En la sesión demo-001 se consumieron 9 520 tokens de MagiHub (dato real de la API de consumo, 120 no reconciliados). Produjeron 48 líneas no triviales aceptadas; 43 líneas IA llegaron al commit `3f9c2e1` y 41 sobreviven en la versión de referencia (demo) `demo-v0.1`, equivalentes a 25.44 líneas efectivas: 37 421 tokens por cada 100 líneas efectivas en la versión de referencia. No hay evidencia de despliegue, así que no se reporta la etapa "desplegado".**

## Artículos que usan este ejemplo

[Embudo](embudo.md) · [Tokens](tokens.md) · [Tokens por 100 líneas](tokens-por-100-lineas.md) · [Líneas efectivas](lineas-efectivas.md) · [Importancia](importancia.md) · [Redundancia](redundancia.md) · [Automatización](automatizacion.md) · [Puntuaciones](puntuaciones-xgboost.md) · [Criticidad](criticidad.md) · [Pull requests](pull-requests.md) · [Tareas y ramas](tareas-y-ramas.md) · [Respuesta a tareas](respuesta-a-tareas.md) · [Procedencia](procedencia-y-atribucion.md)
