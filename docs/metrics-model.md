# Modelo de métricas — tokens ↔ código útil

> Pregunta del reto: **¿Cuántos tokens consumimos mediante MagiHub para producir cambios de
> código que se aceptan, se registran en Git y llegan a una versión de referencia?**

Una línea no vale lo mismo que otra. Contar "líneas aceptadas" a secas premia el boilerplate,
el copy-paste y las regeneraciones. Por eso cada línea aceptada se evalúa en **tres aristas**
y el KPI principal se calcula sobre **líneas efectivas**.

## 1. El embudo

```
Tokens MagiHub (reales: API key + intervalo)
  └─ Generado        code.proposed         → la IA propuso
      └─ Aceptado    code.accepted         → el usuario aplicó   (+ 3 aristas)
          └─ En Git  git.committed         → hashes de líneas ∈ diff del commit
              └─ En versión demo  reference.marked  → líneas presentes en el SHA del tag
                  └─ Desplegado   reference.marked{kind=deployment} con evidence_url, o Deployment
                                  success a producción del commit o del merge commit de su PR
```

Los tokens se imputan **completos** (incluye rechazos, errores y regeneraciones): son el costo
real de producir lo que sobrevive.

## 2. Las tres aristas

### 2.1 Importancia — ¿cuánto valor aporta la línea?

`peso(línea) = peso(kind) × peso(tier del archivo)`

| kind          | ejemplo                               | peso |
|---------------|---------------------------------------|------|
| `logic`       | `if (x > 0) total += x;`              | 1.0  |
| `declaration` | `export function sum(a: number) {`    | 0.8  |
| `test`        | `expect(sum(1, 2)).toBe(3);`          | 0.7  |
| `config`      | `"strict": true,`                     | 0.4  |
| `comment`     | `// suma los positivos`               | 0.2  |
| `import`      | `import { x } from './x';`            | 0.1  |
| `trivial`     | `}` · `);` · `]`                      | 0.0  |

| tier        | rutas                                         | peso |
|-------------|-----------------------------------------------|------|
| `core`      | `src/**`, `lib/**`, `app/**`, resto            | 1.0  |
| `test`      | `*.test.*`, `*.spec.*`, `tests/**`, `__tests__`| 0.9  |
| `infra`     | `infra/**`, `Dockerfile`, `*.tf`, `.github/**` | 0.7  |
| `docs`      | `*.md`, `docs/**`                             | 0.3  |
| `generated` | lockfiles, `dist/**`, `*.g.*`, `__snapshots__`| 0.0  |

`importance.score = weighted_lines / lines` (0..1). Pesos configurables por proyecto.

### 2.2 Redundancia — ¿la línea agrega algo nuevo?

| señal                  | cómo se detecta (en local, por hash)                                   |
|------------------------|-------------------------------------------------------------------------|
| `intra_change`         | la misma línea normalizada aparece >1 vez en el cambio                 |
| `existing_in_repo`     | el hash ya existía en el workspace antes de aceptar (duplicación)      |
| `repeated_in_session`  | el hash ya fue aceptado en un cambio anterior de la sesión             |
| regeneración redundante| `output_hash` de una petición repite el de otra → sus tokens se marcan |

Las líneas `trivial` nunca cuentan como redundantes (siempre se repiten). Una línea se cuenta
una sola vez aunque dispare varias señales. `redundancy.score = redundant / no_triviales`.

### 2.3 Automatización — ¿qué fue automatización real de IA?

| métrica                 | definición                                                                  |
|-------------------------|------------------------------------------------------------------------------|
| `mechanical_share`      | % de líneas IA que una herramienta determinista habría generado: `import`, `trivial`, tier `generated` |
| `ai_share` (commit)     | líneas no triviales del commit que coinciden con hashes IA / líneas agregadas no triviales del commit |
| `ai_lost_lines`         | aceptadas que no llegaron al commit (editadas o borradas por el humano)     |
| `accepted_as_is` / `edited_before_accept` | si el usuario modificó la propuesta antes de aceptar      |

### 2.4 Líneas efectivas

```
effective_lines = Σ  peso(kind) × peso(tier)
                 líneas aceptadas  ∧ ¬redundante ∧ ¬mecánica
```

### 2.5 Unidades

Todas las etapas del embudo desde **Aceptado** cuentan la misma unidad: **líneas agregadas no
vacías y no triviales** (las triviales — `}`, `);` — no se pueden rastrear por hash porque se
repiten en todas partes). **Generado** cuenta lo propuesto con el mismo criterio. Así las
conversiones (`committed / accepted`, `in_reference / accepted`) comparan cosas equivalentes y
`lost_before_commit = ai_lost_lines / líneas no triviales aceptadas`.

Cómo se obtiene cada etapa (`productivity.metrics.ts`):

- **Aceptado** = Σ `importance.lines − importance.by_kind.trivial`.
- **Generado**: `code.proposed` solo trae `files[].added` (sin `by_kind`). Si el cambio se aceptó
  tal cual, se usa su valor exacto; si no, `propuestas × (1 − proporción trivial)` con la proporción
  del propio cambio (si se aceptó editado) o la de lo aceptado en la misma sesión (o del alcance) ⇒
  `estimated`; sin ninguna proporción de referencia queda como cota superior (nota). Nunca menor
  que lo aceptado del cambio.
- **En Git** = Σ por commit de `min(ai_matched_lines, no triviales aceptadas aún no consumidas de
  sus change_ids del alcance)`: el embudo es monótono (hashes repetidos no inflan la etapa).
- **En versión** = por commit, `surviving_lines` de la referencia más reciente que lo incluye en
  `included_shas`, repartido entre sus commits incluidos (tope: las líneas En Git del commit).
- **Desplegado** = por commit, máx(referencia `kind=deployment` que lo incluye, líneas En Git si hay
  Deployment `success` a producción — `DEPLOY_PRODUCTION_ENVIRONMENTS` — de su SHA o del
  merge/head del PR de su rama). Su conversión se calcula contra **En Git** (puede desplegarse
  por el merge del PR sin tag).

## 3. KPIs

| KPI                               | fórmula                                             | procedencia            |
|-----------------------------------|-----------------------------------------------------|------------------------|
| Tokens consumidos                 | MagiHub usage API (key + ventana)                   | real (o simulated)     |
| Tokens / 100 líneas (por etapa)   | `tokens_total / lines(etapa) × 100`, null si 0      | real ÷ telemetría      |
| **Tokens / 100 líneas efectivas** | `tokens_total / effective_lines(etapa) × 100`       | **estimated**          |
| Tasa de aceptación                | accepted / generated                                | telemetría IDE         |
| Retención en Git                  | committed / accepted                                | Git real + aproximado  |
| Supervivencia                     | in_reference / accepted                             | aproximado             |
| Tokens en exploración             | tokens de peticiones sin cambio aceptado            | real/estimated         |
| Tokens en regeneración redundante | Σ tokens de peticiones con output_hash repetido     | real/estimated         |
| Tokens en código mecánico         | tokens_on_accepted × mechanical_share               | estimated              |

## 4. Atribución tokens ↔ cambios

1. **exact**: MagiHub devuelve `request_id` y la API de consumo trae granularidad `request`.
2. **estimated**: solo API key + ventana horaria → usar **API key dedicada** por demo.
3. Reconciliación: `unreconciled = total(usage API) − Σ usage(respuestas)`; ≠ 0 ⇒ otra
   aplicación usó la key o hay retraso de ingesta. Se muestra, no se oculta.

## 5. Privacidad

- La extensión calcula todo con `@magicode/metrics` en local. Al backend solo viajan
  conteos, rutas relativas y hashes (`HMAC-SHA256(salt_de_sesión, línea_normalizada)`, 16 hex).
- La API key viaja solo en `Authorization`; el backend guarda `key_id` + huella `sha256[:12]`.
- Nunca se guardan prompts ni código.

## 6. Limitaciones declaradas

- Coincidencia por hash de línea: líneas movidas o reformateadas pueden no casar; duplicados
  legítimos (`return null;`) pueden casar de más → "aproximado".
- La clasificación de `kind` es heurística por regex y lenguaje, no un parser.
- "Desplegado" solo con `evidence_url` (GitHub Deployments / pipeline). En la demo:
  "versión de referencia (demo)".
