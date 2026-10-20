# scripts

Utilidades del monorepo. Los dos `seed-*` generan **datos de demo / simulados** para el proyecto
`magicode-demo` (repositorio ficticio `magihub/magicode-demo`, tareas `MAG-101..103`). Nada de lo
que crean corresponde a trabajo real: sirven para mostrar el embudo completo en el dashboard.

## Caso de ejemplo (demo)

Orden: primero `seed-demo.ts`, después `seed-webhooks.ts`.

### `seed-demo.ts` — sesiones del IDE (simuladas)

```bash
npm run seed:demo        # = npx tsx scripts/seed-demo.ts
```

Env: `API_URL` (default `http://localhost:3000`), `MAGIHUB_URL` (MagiHub **simulado**, default
`http://localhost:4010`), `MAGIHUB_API_KEY` (default `mh_demo_walter`).

Envía 2 sesiones (MAG-101 y MAG-102) a `POST /productivity/events`: peticiones reales al MagiHub
mock (request_id y usage salen de sus respuestas), cambios aceptados/rechazados con sus aristas,
2 commits con SHAs ficticios de 40 hex (con trailer `MagiCode-Session`) y versiones de referencia.
Todo evento lleva `source: 'demo-seed'` ⇒ la API lo etiqueta `simulated`.

### `seed-webhooks.ts` — entregas de webhook firmadas (datos de demo, pipeline real)

```bash
npm run seed:webhooks    # = npx tsx scripts/seed-webhooks.ts
```

Env: `API_URL` (default: la API dev desplegada, ver `docs/api-routes.md`), `MAGICODE_API_KEY`
(opcional; sin ella usa el modo demo sin `Authorization`).

1. Reutiliza (por `GET /integrations`) o crea dos integraciones del proyecto `magicode-demo`:
   Jira (`task_project_keys: ['MAG']`, base `https://demo.atlassian.net`) y GitHub para
   `magihub/magicode-demo`. El secreto solo se muestra una vez y el script no guarda nada en disco:
   si la integración ya existe, rota el secreto (`POST /integrations/:id/rotate-secret`). Nunca
   toca integraciones de otros repositorios.
2. Jira: `jira:issue_created` + `jira:issue_updated` (firma `X-Hub-Signature`) para MAG-101 (In
   Progress, 5 pts), MAG-102 (Done, 3 pts) y MAG-103 (Bug, To Do).
3. GitHub (firma `X-Hub-Signature-256`): `ping`; `create` + `push` de las ramas del seed con los
   SHAs y session ids del seed (leídos de `GET /productivity/commits`) ⇒ commits `verified_remote`;
   `pull_request` opened → closed+merged (#14 MAG-101, #11 MAG-102, merge SHA ficticio
   determinista); `deployment_status` success: `staging` sobre el head de MAG-101 y `production`
   sobre el merge de MAG-102.
4. Prueba manual de ida y vuelta (`POST /integrations/:id/test {mode:'manual'}` + una entrega
   firmada) en ambas integraciones; imprime salud y `GET /projects/magicode-demo/readiness`.
5. Imprime el embudo y los conteos de `GET /productivity/summary` y `GET /tasks`.

Re-ejecutable: los delivery ids son nuevos en cada corrida, pero PRs, deployments y SHAs de merge
son deterministas, así que se actualizan las mismas entidades.
