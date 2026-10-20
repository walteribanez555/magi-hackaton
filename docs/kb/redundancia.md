# Redundancia

## Qué es

La **redundancia** mide qué parte de las líneas aceptadas no agrega nada nuevo: líneas repetidas dentro del mismo cambio, copiadas de código que ya existía en el repositorio o aceptadas antes en la misma sesión. También se marcan las **regeneraciones redundantes**: peticiones al LLM cuya salida repite la de otra.

## Cómo se calcula

Señales por línea (detección local por hash; la extensión nunca envía el contenido):

| señal                 | campo                 | se detecta cuando…                                                     |
|-----------------------|-----------------------|-------------------------------------------------------------------------|
| intra-cambio          | `intra_change`        | la misma línea normalizada aparece por 2ª vez o más en el cambio (entre todos sus archivos) |
| repetida en la sesión | `repeated_in_session` | el hash ya fue aceptado en un cambio anterior de la misma sesión       |
| existente en el repo  | `existing_in_repo`    | el hash ya existía en el workspace **antes** de aceptar (duplicación)  |

Reglas:

- Las líneas `trivial` (`}`, `);`, `]`…) nunca cuentan como redundantes: siempre se repiten.
- Cada línea se cuenta una sola vez aunque dispare varias señales. Prioridad: `intra_change` → `repeated_in_session` → `existing_in_repo`.
- Normalización antes de comparar: se recortan los extremos y se colapsan los espacios internos a uno (`normalizeLine`). Por eso un cambio de indentación no evita la coincidencia.

Por cambio (`code.accepted.payload.dimensions.redundancy`):

```
redundant_lines = intra_change + repeated_in_session + existing_in_repo
score           = redundant_lines / líneas no triviales      (0..1; 0 si no hay no triviales)
líneas no triviales = importance.lines − importance.by_kind.trivial
```

En el resumen (`ProductivitySummary.dimensions.redundancy`):

```
score               = Σ redundant_lines / Σ líneas no triviales   (cambios aceptados del alcance)
intra_change, existing_in_repo, repeated_in_session = sumas por señal
redundant_regenerations = nº de peticiones cuyo output_hash repite el de otra petición
```

Regeneración redundante: `ai.request.completed.payload.output_hash` es `sha256` de las líneas normalizadas no vacías de la salida (16 hex). Si dos peticiones tienen el mismo `output_hash`, la segunda es una regeneración redundante y sus tokens se suman en `tokens.on_redundant_regenerations` (ver [tokens](tokens.md)).

## Fuente y procedencia

- Fuente: `ide-telemetry` (la extensión calcula los hashes con `HMAC-SHA256(salt_de_sesión, línea_normalizada)` truncado a 16 hex).
- Procedencia: `estimated`. Comparar por hash de línea es una aproximación: no detecta código equivalente escrito de otra forma y puede casar de más con líneas genéricas (`return null;`). En datos de demo, `simulated`.

## Cómo interpretarlo

| `redundancy.score` | lectura                                                                                                   |
|--------------------|-----------------------------------------------------------------------------------------------------------|
| < 0.10             | Sano. La IA está escribiendo código nuevo.                                                                |
| 0.10 – 0.30        | Aceptable. Suele venir de guardas, validaciones o helpers repetidos. Revisar el desglose por señal.       |
| > 0.30             | Alerta: casi una de cada tres líneas no triviales ya existía o se repitió. Se están pagando tokens por duplicación. |
| > 0.50             | El cambio es mayoritariamente copia. Probable falta de reutilización (extraer función) o prompt que regenera lo mismo. |

Lectura por señal:

- `existing_in_repo` alto: el LLM está copiando código del repositorio en lugar de importarlo o reutilizarlo. Acción: pedir que reutilice la función existente; considerar refactor.
- `repeated_in_session` alto: el desarrollador acepta varias veces lo mismo (p. ej. aceptó, deshizo y volvió a pedir). Mirar también `redundant_regenerations`.
- `intra_change` alto: el cambio repite bloques internamente (switch con ramas idénticas, tests copiados). Suele indicar que falta un helper o una tabla de casos.
- `redundant_regenerations` > 0: se pagó una petición completa para obtener el mismo resultado. Más de 1 por cada 5 peticiones indica un flujo de "regenerar" poco útil.

## Ejemplo

Sesión `demo-001` (ver [ejemplo completo](ejemplo-demo-001.md)):

| cambio | líneas | triviales | no triviales | intra | sesión | repo | redundantes | `score` |
|--------|-------:|----------:|-------------:|------:|-------:|-----:|------------:|--------:|
| chg-1  |     42 |        10 |           32 |     1 |      0 |    2 |           3 |  0.0938 |
| chg-4  |     22 |         6 |           16 |     0 |      2 |    0 |           2 |  0.1250 |
| sesión |     64 |        16 |           48 |     1 |      2 |    2 |           5 |  0.1042 |

- En `chg-1`, una guarda `if (!cart) return 0;` aparece dos veces (1 `intra_change`); un `import { Cart } from './cart';` y una línea de lógica ya existían en el repo (2 `existing_in_repo`).
- En `chg-4`, dos líneas de lógica son idénticas a líneas ya aceptadas en `chg-1` (2 `repeated_in_session`).
- `req-103` regeneró `req-102` y devolvió el mismo `output_hash`: `redundant_regenerations = 1` y sus 1 700 tokens van a `on_redundant_regenerations`.

`score = 5 / 48 = 0.1042`: rango aceptable; la señal a vigilar es la regeneración.

## Errores comunes / límites

- No es un detector de clones semánticos: renombrar una variable rompe la coincidencia.
- Duplicados legítimos (`return null;`, `break`, `await next();`) pueden marcarse como `existing_in_repo`. Por eso el número es `estimated`.
- `existing_in_repo` depende de que el índice de hashes del workspace se construya **antes** de aplicar el cambio; solo incluye los archivos que la extensión indexa.
- El salt es de sesión: no se pueden comparar hashes entre sesiones distintas (es intencional, por privacidad). Por eso `repeated_in_session` no cubre repeticiones entre sesiones.
- Una línea redundante sigue contando en `importance.weighted_lines`; solo se excluye de [líneas efectivas](lineas-efectivas.md).

## Implementación

- Esquema: `packages/contracts/src/dimensions.ts` (`RedundancyBreakdown`), `packages/contracts/src/summary.ts` (`DimensionsSummary.redundancy`).
- Cálculo por cambio: `packages/metrics/src/analyze.ts` (`analyzeChange`, `buildRepoHashIndex`).
- Hashes: `packages/metrics/src/hash.ts` (`normalizeLine`, `hashLine`, `outputHash`).
- Agregación y regeneraciones: `apps/api/src/modules/productivity/productivity.metrics.ts`.
