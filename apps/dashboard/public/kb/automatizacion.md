# Automatización

## Qué es

La **automatización** separa dos preguntas: (1) qué parte de lo que aceptamos de la IA era **mecánico**, es decir, algo que una herramienta determinista (autoimport, formateador, generador) habría producido sin LLM; y (2) qué parte de cada **commit** vino realmente de la IA. Es la tercera arista de ponderación, junto con [importancia](importancia.md) y [redundancia](redundancia.md).

## Cómo se calcula

Línea mecánica (`isMechanical`): `kind ∈ {import, trivial}` **o** `tier = generated`.

Por cambio aceptado (`code.accepted.payload.dimensions.automation`):

```
mechanical_lines     = nº de líneas mecánicas
mechanical_share     = mechanical_lines / importance.lines        (0..1)
accepted_as_is       = líneas aceptadas tal como las propuso la IA
edited_before_accept = líneas que el usuario modificó antes de aceptar
```

`accepted_as_is` / `edited_before_accept`: si el IDE conoce la propuesta original, una línea es "tal cual" cuando su forma normalizada está en la propuesta; si no, es editada. Si el IDE no conoce la propuesta, todas cuentan como "tal cual".

Por commit (`git.committed.payload.automation`, se calcula al detectar el commit cruzando hashes):

```
commit_added_lines = líneas agregadas no vacías y NO triviales del commit (IA + humano)
ai_matched_lines   = de esas, cuántas coinciden con hashes de líneas IA aceptadas
ai_share           = ai_matched_lines / commit_added_lines         (0..1)
ai_lost_lines      = líneas IA aceptadas (hashes únicos) de los cambios incluidos en el commit
                     que NO aparecen en él (editadas o borradas por el humano)
effective_lines    = Σ peso efectivo de las líneas IA que llegaron al commit
```

La coincidencia es un multiconjunto: cada línea aceptada casa como máximo una vez, así un `return null;` aceptado una vez no casa con cinco apariciones en el commit. Las triviales se excluyen del numerador y del denominador de `ai_share` porque casarían por azar.

En el resumen (`ProductivitySummary.dimensions.automation`):

```
mechanical_share     = Σ mechanical_lines / Σ lines                 (cambios aceptados)
ai_share_of_commits  = Σ ai_matched_lines / Σ commit_added_lines    (commits del alcance)
lost_before_commit   = Σ ai_lost_lines / Σ (importance.lines − by_kind.trivial) de los cambios aceptados commiteados
                       (misma unidad: líneas no triviales; ver metrics-model §2.5)
accepted_as_is, edited_before_accept = sumas
```

Tokens asociados (en [tokens](tokens.md)): `tokens.on_mechanical = tokens.on_accepted × mechanical_share`.

## Fuente y procedencia

- `mechanical_share`, `accepted_as_is`, `edited_before_accept`: `ide-telemetry`, procedencia `estimated` (la clase de línea es heurística).
- `ai_share_of_commits`, `lost_before_commit`: cruzan Git real (`git-local` o `git-remote`) con hashes de la telemetría; procedencia `estimated` porque la coincidencia por hash es aproximada.
- `on_mechanical`: `estimated` (reparto proporcional de tokens reales).

## Cómo interpretarlo

`mechanical_share`:

| valor       | lectura                                                                                                 |
|-------------|---------------------------------------------------------------------------------------------------------|
| < 0.25      | La IA se usa para código con contenido.                                                                 |
| 0.25 – 0.50 | Normal: toda feature trae imports y cierres de bloque. Los cierres (`}`) suelen ser la mayor parte.     |
| > 0.50      | Más de la mitad de las líneas aceptadas era automatizable sin LLM: se gastan tokens en código que un autoimport, un formateador o un generador produciría gratis. Revisar si se está pidiendo a la IA scaffolding, lockfiles o archivos generados. |

`ai_share_of_commits`:

| valor       | lectura                                                                                       |
|-------------|-----------------------------------------------------------------------------------------------|
| < 0.20      | La IA es un apoyo puntual; el commit es mayoritariamente humano.                              |
| 0.20 – 0.70 | Colaboración: el humano integra, ajusta y completa.                                            |
| > 0.70      | El commit es mayoritariamente IA. Conviene que la revisión de código sea más estricta y mirar [criticidad](criticidad.md). |

`lost_before_commit`: > 0.30 indica que casi un tercio de lo aceptado se reescribió o borró antes del commit. Aceptar no equivalía a usar: revisar la calidad de las propuestas o el hábito de "aceptar para ver".

`edited_before_accept / (accepted_as_is + edited_before_accept)` > 0.20: el desarrollador corrige mucho las propuestas antes de aceptar. Es una señal de esfuerzo humano que las líneas aceptadas no reflejan.

## Ejemplo

Sesión `demo-001` (ver [ejemplo completo](ejemplo-demo-001.md)):

| cambio | líneas | import | trivial | mecánicas | `mechanical_share` | as_is | editadas |
|--------|-------:|-------:|--------:|----------:|-------------------:|------:|---------:|
| chg-1  |     42 |      4 |      10 |        14 |             0.3333 |    42 |        0 |
| chg-4  |     22 |      1 |       6 |         7 |             0.3182 |    19 |        3 |
| sesión |     64 |      5 |      16 |        21 |             0.3281 |    61 |        3 |

Tokens en código mecánico: `on_accepted × mechanical_share = 5 300 × 0.3281 ≈ 1 739`.

Commit `3f9c2e1` en `feature/MAG-123-descuentos`:

```
líneas IA aceptadas (hashes únicos no triviales): 31 (chg-1) + 16 (chg-4) = 47
commit_added_lines = 55     ai_matched_lines = 43     ai_lost_lines = 47 − 43 = 4
ai_share = 43 / 55 = 0.7818
```

Lectura: el 78 % del commit (sin contar llaves) vino de la IA; el humano aportó 12 líneas y descartó 4 de las aceptadas (3 de lógica de `chg-1` y 1 comentario de `chg-4`).

`lost_before_commit = 4 / (32 + 16) = 4 / 48 = 0.0833` (no triviales aceptadas: `42 − 10` y `22 − 6`). El denominador cuenta la guarda repetida de `chg-1` dos veces (no son hashes únicos), por eso es 48 y no 47.

## Errores comunes / límites

- "Mecánico" no es "inútil": los imports son necesarios. Significa que no hacía falta un LLM para producirlos.
- Las líneas triviales cuentan en `mechanical_share` (están en `lines`) pero no en `ai_share` (se excluyen del commit). No se deben comparar directamente.
- `ai_lost_lines` solo cuenta los cambios que tuvieron al menos una coincidencia en el commit. Un cambio aceptado que se descartó por completo no aparece en `change_ids` y no suma pérdidas en ese commit; se ve como `accepted` sin pasar a `committed` en el [embudo](embudo.md).
- Si un cambio se reparte en varios commits, las líneas que fueron al otro commit cuentan como perdidas en este. La extensión solo debe pasar los cambios aún no registrados.
- Líneas IA movidas o reformateadas por el humano pueden no casar (se cuentan como humanas y como perdidas).

## Implementación

- Esquema: `packages/contracts/src/dimensions.ts` (`AutomationBreakdown`, `CommitAutomation`), `packages/contracts/src/summary.ts` (`DimensionsSummary.automation`).
- Regla de línea mecánica: `packages/metrics/src/classify.ts` (`isMechanical`).
- Cálculo por cambio: `packages/metrics/src/analyze.ts`; por commit: `packages/metrics/src/commit.ts` (`matchCommit`).
- Agregación: `apps/api/src/modules/productivity/productivity.metrics.ts`.
