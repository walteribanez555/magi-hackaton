# Privacidad y datos que se guardan

## Qué es

Qué datos salen de la máquina del desarrollador, qué se guarda en el backend y qué **nunca** se guarda. Regla del reto: "Sin volcar código: almacenar IDs, rutas, conteos y hashes de parches. No registrar API keys, prompts sensibles ni código completo por defecto".

## Cómo se calcula

| dato                                   | ¿sale del IDE? | cómo viaja / se guarda                                                         |
|----------------------------------------|----------------|--------------------------------------------------------------------------------|
| Código propuesto o aceptado            | No             | Se analiza en local con `@magicode/metrics`.                                    |
| Prompts                                | No             | Solo van a MagiHub (Smart Auto), nunca al servicio de productividad.            |
| Línea de código                        | No             | Viaja su hash: `HMAC-SHA256(salt_de_sesión, línea_normalizada)`, 16 hex.        |
| Salida del LLM                         | No             | Viaja `output_hash`: `sha256` de líneas normalizadas no vacías, 16 hex.         |
| Parche                                 | No             | Viaja `patch_hash`: `sha256` de rutas ordenadas + hashes de línea, 16 hex.      |
| Rutas de archivo                       | Sí             | Relativas al repo (`src/pricing/discounts.ts`).                                 |
| Conteos y pesos                        | Sí             | Líneas agregadas/borradas, `by_kind`, señales, `effective_lines`.               |
| API key de MagiHub                     | Solo en `Authorization` | El backend la valida contra MagiHub y guarda `key_id` + huella `sha256[:12]`. Nunca la key. En el IDE vive en `SecretStorage` de VS Code. |
| Mensaje de commit                      | No se guarda   | Del webhook se extraen solo claves de tarea y el trailer `MagiCode-Session`.    |
| Título de tarea Jira                   | Sí (webhook)   | Texto de negocio, no código; se recorta a 500 caracteres.                       |
| Payload crudo de webhooks              | No se guarda   | Se guarda el evento normalizado (`NormalizedWebhookEvent`); las entregas se deduplican con TTL de 30 días. |
| Secreto HMAC de cada integración       | –              | Lo genera el backend, se muestra una sola vez, se guarda solo en la fila `IntLookup` (cifrado en reposo por DynamoDB). |

El `salt` es por sesión: sin él no se puede construir un diccionario de líneas comunes para revertir los hashes.

## Fuente y procedencia

No aplica (es una política). Las reglas están codificadas en los contratos: los esquemas de eventos no tienen campos para código, prompts ni keys.

## Cómo interpretarlo

- Si un análisis requiere ver el código (p. ej. por qué una línea se marcó redundante), hay que hacerlo en el IDE del desarrollador: el backend no puede.
- Los hashes de línea no se pueden comparar entre sesiones (salt distinto). Es una limitación deliberada.
- Un auditor puede verificar el cumplimiento revisando los esquemas Zod: cualquier campo nuevo que transporte texto libre es una regresión de privacidad.

## Ejemplo

Lo que realmente llega al backend del cambio `chg-1` de la sesión `demo-001` (extracto de `code.accepted`):

```json
{
  "event_type": "code.accepted",
  "session_id": "demo-001",
  "project_id": "magicode-demo",
  "repository": "org/repo-demo",
  "branch": "feature/MAG-123-descuentos",
  "task_key": "MAG-123",
  "source": "ide-extension",
  "payload": {
    "change_id": "chg-1",
    "ai_request_id": "req-101",
    "files": [
      { "path": "src/pricing/discounts.ts", "language": "typescript", "added": 30, "deleted": 0 },
      { "path": "src/pricing/discounts.test.ts", "language": "typescript", "added": 12, "deleted": 0 }
    ],
    "patch_hash": "8c1f4e2a9b7d3c60",
    "accepted_added_lines": 42,
    "accepted_deleted_lines": 0,
    "dimensions": { "importance": { "lines": 42, "weighted_lines": 23.03, "score": 0.5483, "by_kind": { "logic": 14, "declaration": 4, "test": 8, "config": 0, "comment": 2, "import": 4, "trivial": 10 } }, "...": "..." }
  }
}
```

Ninguna línea de `discounts.ts` sale de la máquina.

## Errores comunes / límites

- Las rutas de archivo pueden revelar información de negocio (`src/fraud/rules.ts`). Se consideran aceptables en el MVP; un modo de rutas hasheadas es trabajo futuro.
- El título de la tarea Jira sí se guarda (para el dashboard).
- Los hashes truncados a 16 hex (64 bits) tienen una probabilidad de colisión despreciable para el volumen de una sesión.

## Implementación

- Hashes: `packages/metrics/src/hash.ts` (`normalizeLine`, `hashLine`, `outputHash`, `patchHash`).
- Contratos sin campos de contenido: `packages/contracts/src/events.ts`, `packages/contracts/src/integrations.ts`.
- Huella de key y autenticación: `apps/api/src/common/utils/hash.ts`, `apps/api/src/common/middlewares/auth.middleware.ts`.
- Secretos de integración: `apps/api/src/modules/integrations/integrations.service.ts`; normalización de webhooks: `apps/api/src/modules/webhooks/adapters/`.
