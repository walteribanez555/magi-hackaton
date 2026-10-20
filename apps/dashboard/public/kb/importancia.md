# Importancia

## Qué es

La **importancia** mide cuánto valor aporta una línea aceptada según su clase (`kind`) y la criticidad de su archivo (`tier`). Es la primera de las tres aristas con las que se pondera cada línea; las otras dos son [redundancia](redundancia.md) y [automatización](automatizacion.md).

## Cómo se calcula

Para cada línea agregada no vacía de un cambio aceptado:

```
peso(línea) = peso(kind) × peso(tier del archivo)
```

Pesos por defecto (`DEFAULT_KIND_WEIGHTS` y `DEFAULT_TIER_WEIGHTS` en `packages/contracts/src/dimensions.ts`):

| kind          | ejemplo                            | peso |
|---------------|------------------------------------|------|
| `logic`       | `if (x > 0) total += x;`           | 1.0  |
| `declaration` | `export function sum(a: number) {` | 0.8  |
| `test`        | `expect(sum(1, 2)).toBe(3);`       | 0.7  |
| `config`      | `"strict": true,`                  | 0.4  |
| `comment`     | `// suma los positivos`            | 0.2  |
| `import`      | `import { x } from './x';`         | 0.1  |
| `trivial`     | `}` · `);` · `]`                   | 0.0  |

| tier        | rutas (heurística por ruta)                                   | peso |
|-------------|---------------------------------------------------------------|------|
| `core`      | `src/**`, `lib/**`, `app/**` y todo lo que no caiga en otro    | 1.0  |
| `test`      | `*.test.*`, `*.spec.*`, `tests/**`, `__tests__/**`, `_test.go` | 0.9  |
| `infra`     | `infra/**`, `Dockerfile`, `*.tf`, `.github/**`, CI            | 0.7  |
| `docs`      | `*.md`, `docs/**`, `README`, `CHANGELOG`                       | 0.3  |
| `generated` | lockfiles, `dist/**`, `build/**`, `*.g.*`, `__snapshots__/**`  | 0.0  |

El tier se decide con precedencia `generated → test → infra → docs → core` (así `dist/x.test.js` es `generated` y `.github/PULL_REQUEST_TEMPLATE.md` es `infra`).

La clase de línea se decide con precedencia `trivial → (config | markdown por familia) → comment → import → test → declaration → logic`. Toda línea no trivial, no comentario y no import de un archivo de tier `test` es `test`.

Por cambio (`code.accepted.payload.dimensions.importance`):

```
lines          = líneas agregadas no vacías (incluye triviales)
weighted_lines = Σ peso(kind) × peso(tier)          ("líneas ponderadas")
score          = weighted_lines / lines              (0..1; 0 si lines = 0)
by_kind        = conteo de líneas por kind (las 7 claves siempre presentes)
```

En el resumen (`ProductivitySummary.dimensions.importance`):

```
score   = Σ weighted_lines / Σ lines   sobre los cambios aceptados del alcance
by_kind = Σ by_kind por clase
```

Es un promedio ponderado por líneas, no la media simple de los `score` de cada cambio. En la lista de cambios (`ChangeListItem.importance_score`) se muestra el `score` del cambio.

Los pesos se pueden configurar por proyecto; los valores se acotan a [0, 1] para que `score` siga en 0..1.

## Fuente y procedencia

- Lo calcula la extensión en local con `@magicode/metrics` (tiene el código); al backend solo llegan conteos y pesos, nunca el contenido.
- Fuente: `ide-telemetry`. Procedencia del `score` agregado: `estimated`, porque la clasificación de líneas es heurística (regex por familia de lenguaje), no un parser. En datos de demo (`source: demo-seed`) es `simulated`.

## Cómo interpretarlo

| `importance.score` | lectura                                                                                       |
|--------------------|-----------------------------------------------------------------------------------------------|
| ≥ 0.70             | La IA produjo sobre todo lógica y declaraciones en código `core`. Valor alto por línea.       |
| 0.40 – 0.70        | Mezcla habitual de lógica, tests, imports y cierres de bloque. Rango típico de una feature.   |
| 0.20 – 0.40        | Mucho config, comentarios, imports o archivos `docs`/`infra`. Revisar si el LLM era necesario. |
| < 0.20             | Casi todo trivial, generado o documentación. Las líneas brutas inflan la productividad.       |

- `by_kind` explica el número: si `trivial` + `import` superan el 40 % de las líneas, el `score` bajará aunque la lógica sea buena; esto no es un problema de calidad sino de composición.
- Un `score` bajo con `test` alto es normal en un cambio que solo agrega pruebas (0.7 × 0.9 = 0.63 por línea de test).
- Comparar importancia entre equipos solo tiene sentido con los mismos pesos.

## Ejemplo

Sesión `demo-001`, tarea `MAG-123`, rama `feature/MAG-123-descuentos` (ver [ejemplo completo](ejemplo-demo-001.md)).

Cambio `chg-1` (42 líneas): `src/pricing/discounts.ts` (30, tier `core`) y `src/pricing/discounts.test.ts` (12, tier `test`).

| archivo (tier)          | logic | declaration | test | comment | import | trivial |
|-------------------------|------:|------------:|-----:|--------:|-------:|--------:|
| discounts.ts (core 1.0) |    14 |           4 |    0 |       2 |      3 |       7 |
| discounts.test.ts (0.9) |     0 |           0 |    8 |       0 |      1 |       3 |

```
core: 14×1.0 + 4×0.8 + 2×0.2 + 3×0.1 + 7×0 = 14 + 3.2 + 0.4 + 0.3 = 17.90
test: 8×0.7×0.9 + 1×0.1×0.9 + 3×0          = 5.04 + 0.09        =  5.13
weighted_lines = 23.03     score = 23.03 / 42 = 0.5483
```

Cambio `chg-4` (22 líneas, todo tier `core`): logic 9, declaration 2, config 3 (`src/config/pricing.json`), comment 1, import 1, trivial 6.

```
weighted_lines = 9 + 1.6 + 1.2 + 0.2 + 0.1 = 12.10     score = 12.10 / 22 = 0.5500
```

Sesión: `score = (23.03 + 12.10) / (42 + 22) = 35.13 / 64 = 0.5489`. La media simple de los dos `score` daría 0.5492: la diferencia es pequeña aquí, pero crece cuando los cambios tienen tamaños muy distintos.

## Errores comunes / límites

- Confundir importancia con calidad: una línea `logic` incorrecta pesa 1.0. La calidad se aproxima con [criticidad](criticidad.md) y [supervivencia](embudo.md).
- La heurística no tiene estado entre líneas: los nombres de un `import { a, b }` multilínea cuentan como `logic`, y el cuerpo de un comentario de bloque solo se detecta si empieza con `*`.
- `break;` y `default:` se consideran triviales (relleno de `switch`).
- En archivos de config (json/yaml/toml/env/xml) toda línea no trivial es `config`; en markdown toda línea no trivial es `comment`.
- Un archivo de `src/` con nombre no estándar para tests (p. ej. `src/checks.ts`) se clasifica como `core`; sus aserciones sí se reconocen como `test` por patrón (`expect(`, `assert`, `it(`…).

## Implementación

- Pesos y esquema: `packages/contracts/src/dimensions.ts` (`LineKind`, `FileTier`, `DEFAULT_KIND_WEIGHTS`, `DEFAULT_TIER_WEIGHTS`, `ImportanceBreakdown`).
- Clasificación: `packages/metrics/src/classify.ts` (`classifyLine`, `fileTier`, `languageFamily`).
- Cálculo por cambio: `packages/metrics/src/analyze.ts` (`analyzeChange`, `resolveWeights`).
- Agregación: `apps/api/src/modules/productivity/productivity.metrics.ts`.
