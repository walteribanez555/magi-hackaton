# MagiCode (extensión VS Code)

Asistente de código dentro del IDE que usa **MagiHub Smart Auto** para proponer cambios con
diff, los aplica cuando los aceptas, los enlaza a un **repositorio Git real y su commit SHA**, y
emite telemetría de productividad **sin enviar código, prompts ni la API key**.

## Ejecutar (desarrollo)

```bash
# en la raíz del monorepo (dependencias ya instaladas)
npx turbo run build --filter=magicode     # compila contracts + metrics + la extensión
scripts/init-demo-repo.sh                 # crea ~/magicode-demo como repo Git independiente
```

1. Abre `apps/extension` en VS Code y pulsa **F5** (*Run Extension*). Se abre una ventana
   *Extension Development Host* con `~/magicode-demo` cargado.
2. Opcional (local): levanta el mock de MagiHub (`services/magihub-mock`, puerto 4010) y la API
   (`apps/api`, puerto 3000). Todo lo que devuelve el mock se etiqueta como **simulado**.
3. En la barra lateral aparece el ícono **MagiCode** (vista *Sesión*) y en la barra de estado
   `✨ MagiCode · <tokens> tok · <líneas> líneas`.

Empaquetar: `npm run build -w magicode && (cd apps/extension && npm run package)` → `magicode-0.1.0.vsix`.

## Ajustes

| ajuste | por defecto | uso |
|---|---|---|
| `magicode.magihubBaseUrl` | `http://localhost:4010` | MagiHub (OpenAI-compatible). Inferencia: `POST {base}/v1/chat/completions`, `model: "smart-auto"` |
| `magicode.telemetryUrl` | `http://localhost:3000/api/v1` | API de productividad: `POST {url}/productivity/events` |
| `magicode.dashboardUrl` | `http://localhost:4200` | comando *Open Dashboard* |
| `magicode.projectId` | nombre del repo | `project_id` de los eventos |
| `magicode.repository` | `org/repo` de `origin`, o nombre de carpeta | `repository` de los eventos |
| `magicode.taskKey` | inferida de la rama | tarea Jira (`MAG-123`); *Set Task* tiene prioridad |
| `magicode.addSessionTrailer` | `true` | escribe `.git/magicode-session` para el hook de trailers |

## Comandos (categoría *MagiCode*)

| comando | qué hace |
|---|---|
| **Configure API Key** | pide la key (input de contraseña), la valida con `GET {base}/v1/keys/self` y la guarda en **SecretStorage**. Nunca se escribe en settings ni en logs. |
| **Start Session / End Session** | sesión `uuid` con **sal aleatoria local** (solo `workspaceState`). Se inicia sola al abrir un repo Git y se reanuda tras recargar la ventana (≤ 8 h de inactividad; si expira se emite `session.ended{idle}`). |
| **Generate & Apply** (`Ctrl+Alt+M`, menú contextual) | instrucción → Smart Auto (contexto: selección activa o archivo completo) → diff `vscode.diff` → **Aceptar / Editar y aceptar / Rechazar / Regenerar**. |
| **Mark Reference Version** | `git tag -a magicode-demo-<fecha>` en HEAD, calcula qué líneas IA sobreviven en ese SHA y emite `reference.marked{kind: demo-reference}`. Opción de `git push` del tag. |
| **Install Commit Trailer Hook** | instala `prepare-commit-msg` (respeta `core.hooksPath`; pregunta antes de reemplazar uno ajeno y guarda copia `.magicode-backup`). Agrega `MagiCode-Session: <id>` y `MagiCode-Task: <KEY>`. |
| **Set Task** | fija la tarea Jira de la sesión (vacío = inferir de la rama `feature/MAG-123-…`). |
| **Show Session Stats / Open Dashboard / Show Log** | resumen modal, dashboard con `?project_id&session_id&task_key`, canal de salida *MagiCode* (con secretos redactados). |

## Flujo de demo

| paso | en el IDE | evidencia |
|---|---|---|
| **01 Conectar** | *Configure API Key* → valida contra MagiHub `/v1/keys/self` | notificación con tenant/key; barra de estado activa |
| **02 Generar** | abre `src/math.ts`, selecciona (opcional) y *Generate & Apply*: "agrega `clamp(x, min, max)` con validación y su test" | `ai.request.completed` (request id de `x-request-id`/`body.id`, modelo elegido por Smart Auto, `usage`, latencia, `output_hash`) + `code.proposed` |
| **03 Revisar y aceptar** | diff actual ↔ propuesta; **Aceptar** (o *Editar y aceptar*: borrador editable, se confirma con ✓ en el título del editor; o *Regenerar*) | `code.accepted` con las 3 aristas (importancia, redundancia, automatización) y líneas efectivas; `code.rejected{superseded}` al regenerar |
| **04 Commit** | (opcional *Install Commit Trailer Hook*) `git commit -am "feat: clamp"` | el watcher de `.git/HEAD`/`refs` (y polling cada 10 s) detecta el SHA, cruza hashes con el diff real → `git.committed` (sha, padre, rama, `ai_share`, `ai_lost_lines`, trailer, remoto sin credenciales) |
| **05 Versión de referencia** | *Mark Reference Version* → `magicode-demo-20261020-1530` | `reference.marked` (sha del tag, commits de la sesión incluidos vía `git merge-base --is-ancestor`, líneas IA que sobreviven) — "versión de referencia (demo)", **nunca** "deployment" |
| **06 Medir** | *Open Dashboard* | tokens reales (API de consumo de MagiHub) ÷ líneas por etapa |

## Privacidad

- **Inferencia**: solo hacia `magicode.magihubBaseUrl` (`/v1/chat/completions`, `model: smart-auto`).
  El prompt y el archivo viajan a MagiHub —es el servicio de inferencia— y a ningún otro lado.
- **Telemetría**: solo IDs, rutas relativas, conteos, pesos y hashes. Los hashes de línea son
  `HMAC-SHA256(sal_de_sesión, línea_normalizada)` truncados; la **sal nunca sale del equipo**
  (vive en `workspaceState`). Cada evento se valida contra `ProductivityEvent`
  (`@magicode/contracts`) antes de encolarse; si no valida, se descarta con un aviso en el log.
- **API key**: SecretStorage; viaja solo en el header `Authorization` (a MagiHub y a la API de
  productividad, que deriva el tenant de ella). El log redacta la key y patrones `Bearer …`.
- **Remoto Git**: se envía `remote_url` sin credenciales (`https://user:token@` → `https://`).
- **Local**: el índice de hashes del repo (para detectar duplicación) se construye en memoria
  desde `git ls-files` (omite binarios y archivos > 1 MB). Los cambios aceptados se guardan
  como `change_id + hashes + pesos`, nunca como contenido.

## Cómo se mide (resumen)

- **Generado** → `code.proposed` · **Aceptado** → `code.accepted` · **En Git** → `git.committed`
  (hashes de líneas aceptadas ∈ líneas agregadas del commit) · **En versión demo** →
  `reference.marked` (hashes presentes en el SHA del tag). Ver `docs/metrics-model.md`.
- Los **tokens de la barra de estado** son los que MagiHub reporta en cada respuesta (`usage`);
  el dashboard usa la **API de consumo** como fuente de verdad y muestra la diferencia.

## Limitaciones conocidas

- Coincidencia por hash de línea: líneas movidas/reformateadas pueden no casar y duplicados
  legítimos pueden casar de más (cifras "aproximadas").
- La propuesta reemplaza el archivo completo (Smart Auto devuelve el archivo entero); archivos
  > 200 000 caracteres se rechazan. Un archivo por cambio.
- Si el archivo cambió entre la petición y la aceptación, se pide confirmación (se reemplaza todo).
- Commits: se analiza cada commit nuevo contra su primer padre (merges incluidos); como máximo 50
  por revisión y solo los posteriores al inicio de la sesión. Las líneas que ya casaron en un
  commit no vuelven a casar: tras un rebase/amend el nuevo SHA solo se emite si trae el trailer
  de sesión (con `change_ids` vacío).
- La sal es por sesión: cambios aceptados en una sesión no casan con commits de una sesión
  posterior (por diseño de privacidad).
- `usage_source = magihub-mock` si la respuesta se declara simulada (`x-magihub-simulated: true`,
  `body.simulated`) o si `magihubBaseUrl` apunta a `localhost`.
- Sin streaming: la petición a Smart Auto es no-streaming (cancelable desde la notificación).
