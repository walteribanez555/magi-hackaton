/**
 * Envía una tarea descrita en un JSON legible como un webhook REAL de Jira Cloud
 * (`jira:issue_created`) firmado con el secreto de la integración de tareas.
 *
 *   npx tsx scripts/send-task.ts scripts/tasks/MGH-1.json
 *
 * JSON de entrada:
 *   { "key": "MGH-1", "title": "...", "type": "Story", "status": "En curso",
 *     "status_category": "todo" | "in_progress" | "done", "story_points": 3, "assignee": "usuario" }
 *
 * Env:
 *   API_URL                      base de la API (default: API dev desplegada)
 *   MAGICODE_API_KEY             opcional (sin ella: modo demo sin Authorization)
 *   MAGICODE_PROJECT_ID          proyecto de la integración (default: magi-hackaton)
 *   MAGICODE_TASKS_INTEGRATION   id de la integración Jira (default: se busca por proyecto + prefijo de la clave)
 *   MAGICODE_TASKS_SECRET        secreto del webhook; si falta se rota (POST /integrations/:id/rotate-secret)
 *   JIRA_BASE_URL                opcional: origen del sitio Jira para `issue.self` (sin él no hay URL de la tarea)
 *
 * Nunca escribe el secreto en disco ni en la salida.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { WEBHOOK_SIGNATURE_HEADERS } from '@magicode/contracts';

const API_URL = (process.env.API_URL || 'https://a5fo4490y4.execute-api.us-east-1.amazonaws.com/api/v1').replace(/\/+$/, '');
const API_KEY = process.env.MAGICODE_API_KEY;
const PROJECT = process.env.MAGICODE_PROJECT_ID || 'magi-hackaton';
const JIRA_BASE = process.env.JIRA_BASE_URL?.replace(/\/+$/, '');
const auth: Record<string, string> = API_KEY ? { authorization: `Bearer ${API_KEY}` } : {};

interface TaskFile {
  key: string;
  title: string;
  type?: string;
  status?: string;
  status_category?: 'todo' | 'in_progress' | 'done';
  story_points?: number;
  assignee?: string;
}

interface Integration {
  integration_id: string;
  provider: string;
  project_id: string;
  task_project_keys?: string[];
  webhook_url: string;
  status: string;
}

async function api<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { ...auth, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status}: ${text}`);
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

const CATEGORY = {
  todo: { id: 2, key: 'new', name: 'To Do' },
  in_progress: { id: 4, key: 'indeterminate', name: 'In Progress' },
  done: { id: 3, key: 'done', name: 'Done' },
} as const;
const STATUS_ID = { todo: '10000', in_progress: '3', done: '10001' } as const;

/** 2026-10-20T13:20:00.000Z → 2026-10-20T13:20:00.000+0000 (formato de Jira). */
const jiraTs = (d: Date) => d.toISOString().replace('Z', '+0000');

function numericId(key: string): string {
  const n = Number(key.split('-')[1] ?? '0');
  return String(10000 + n);
}

export function toJiraPayload(t: TaskFile, now = new Date()) {
  const projectKey = t.key.split('-')[0]!;
  const cat = CATEGORY[t.status_category ?? 'todo'];
  const id = numericId(t.key);
  const actor = { accountId: `account-${t.assignee ?? 'equipo'}`, displayName: t.assignee ?? 'Equipo' };
  return {
    timestamp: now.getTime(),
    webhookEvent: 'jira:issue_created',
    issue_event_type_name: 'issue_created',
    user: actor,
    issue: {
      id,
      ...(JIRA_BASE ? { self: `${JIRA_BASE}/rest/api/2/issue/${id}` } : {}),
      key: t.key,
      fields: {
        summary: t.title,
        issuetype: { id: t.type === 'Bug' ? '10004' : '10001', name: t.type ?? 'Story' },
        project: { id: '10000', key: projectKey, name: projectKey },
        status: {
          id: STATUS_ID[t.status_category ?? 'todo'],
          name: t.status ?? cat.name,
          statusCategory: { id: cat.id, key: cat.key, name: cat.name },
        },
        ...(t.assignee ? { assignee: { accountId: actor.accountId, displayName: t.assignee } } : {}),
        priority: { id: '3', name: 'Medium' },
        labels: [],
        customfield_10016: t.story_points ?? null,
        created: jiraTs(now),
        updated: jiraTs(now),
      },
    },
  };
}

async function findIntegration(projectKey: string): Promise<Integration> {
  const wanted = process.env.MAGICODE_TASKS_INTEGRATION;
  const { body } = await api<{ data: Integration[] }>(`/integrations?project_id=${encodeURIComponent(PROJECT)}`);
  const found = body.data.find(
    (i) =>
      i.status !== 'disabled' &&
      i.provider === 'jira' &&
      (wanted ? i.integration_id === wanted : i.project_id === PROJECT && !!i.task_project_keys?.includes(projectKey)),
  );
  if (!found) throw new Error(`No hay integración Jira activa para ${PROJECT} con la clave ${projectKey}`);
  return found;
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) throw new Error('Uso: npx tsx scripts/send-task.ts <tarea.json>');
  const task = JSON.parse(readFileSync(file, 'utf8')) as TaskFile;
  if (!/^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/.test(task.key)) throw new Error(`Clave de tarea inválida: ${task.key}`);
  const integration = await findIntegration(task.key.split('-')[0]!);
  let secret = process.env.MAGICODE_TASKS_SECRET;
  if (!secret) {
    const r = await api<{ data: { webhook_secret: string } }>(`/integrations/${integration.integration_id}/rotate-secret`, {
      method: 'POST',
      body: '{}',
    });
    secret = r.body.data.webhook_secret;
    console.log(`Secreto rotado para ${integration.integration_id} (solo en memoria)`);
  }

  const payload = toJiraPayload(task);
  const raw = JSON.stringify(payload);
  const h = WEBHOOK_SIGNATURE_HEADERS.jira;
  const deliveryId = randomUUID();
  const res = await fetch(integration.webhook_url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'Atlassian Webhook HTTP Client',
      [h.signature]: `sha256=${createHmac('sha256', secret).update(raw, 'utf8').digest('hex')}`,
      [h.delivery]: deliveryId,
      [h.event]: 'Primary',
    },
    body: raw,
  });
  console.log(`POST ${integration.webhook_url} (entrega ${deliveryId}) → ${res.status} ${await res.text()}`);
  if (!res.ok) process.exitCode = 1;

  await new Promise((r) => setTimeout(r, 1500));
  const t = await api<unknown>(`/tasks/${encodeURIComponent(task.key)}?project_id=${encodeURIComponent(PROJECT)}`);
  console.log(`GET /tasks/${task.key} →`, JSON.stringify(t.body, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
