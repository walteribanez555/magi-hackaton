import {
  BatchGetCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type QueryCommandInput,
  type UpdateCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { ENTITY, keys } from '@magicode/contracts';
import { getDynamo, tableName } from '../../config/dynamo';
import { chunk } from '../../common/utils/dynamo-expr';
import type { TransactItem } from './productivity.projection';
import type {
  AiRequestItem,
  ChangeItem,
  CommitItem,
  DeploymentEvidence,
  PullRequestRef,
  ReferenceMark,
  SessionItem,
} from './productivity.types';

type Key = { PK: string; SK: string };
type Item = Record<string, unknown>;

/** Convierte Sets de DynamoDB (SS) a arrays para devolver JSON plano. */
export function plain<T>(item: Item): T {
  const out: Item = {};
  for (const [k, v] of Object.entries(item)) out[k] = v instanceof Set ? [...v] : v;
  return out as T;
}

const MAX_PAGES = 20;

/** Acceso a la tabla single-table (keys.ts). Sin lógica de negocio. */
export class ProductivityRepository {
  private get db() {
    return getDynamo();
  }
  private get table() {
    return tableName();
  }

  async get<T = Item>(key: Key, consistent = false): Promise<T | undefined> {
    const res = await this.db.send(new GetCommand({ TableName: this.table, Key: key, ConsistentRead: consistent }));
    return res.Item ? plain<T>(res.Item) : undefined;
  }

  /** BatchGet en bloques de 100 con reintento de UnprocessedKeys. */
  async batchGet<T = Item>(ks: Key[]): Promise<T[]> {
    const uniq = [...new Map(ks.map((k) => [`${k.PK}\u0000${k.SK}`, k])).values()];
    const out: T[] = [];
    for (const part of chunk(uniq, 100)) {
      let pending: Key[] = part;
      for (let attempt = 0; pending.length && attempt < 5; attempt++) {
        const res = await this.db.send(new BatchGetCommand({ RequestItems: { [this.table]: { Keys: pending } } }));
        for (const it of res.Responses?.[this.table] ?? []) out.push(plain<T>(it));
        pending = (res.UnprocessedKeys?.[this.table]?.Keys as Key[] | undefined) ?? [];
        if (pending.length) await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
      }
    }
    return out;
  }

  async transactWrite(items: TransactItem[]): Promise<void> {
    if (!items.length) return;
    await this.db.send(new TransactWriteCommand({ TransactItems: items }));
  }

  /** UpdateItem suelto (p. ej. `scores` del Change con attribute_exists). */
  async update(input: UpdateCommandInput): Promise<void> {
    await this.db.send(new UpdateCommand({ ...input, TableName: input.TableName ?? this.table }));
  }

  private async queryAll<T>(input: Omit<QueryCommandInput, 'TableName'>, limitPages = MAX_PAGES): Promise<T[]> {
    const out: T[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    for (let page = 0; page < limitPages; page++) {
      const res = await this.db.send(new QueryCommand({ TableName: this.table, ...input, ExclusiveStartKey }));
      for (const it of res.Items ?? []) out.push(plain<T>(it));
      ExclusiveStartKey = res.LastEvaluatedKey;
      if (!ExclusiveStartKey) break;
    }
    return out;
  }

  // ── Lecturas por entidad ─────────────────────────────────────────────────

  async listProjects(t: string): Promise<Array<{ project_id: string; repositories: string[]; last_activity_at: string }>> {
    const k = keys.projectsOfTenant(t);
    return this.queryAll({
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': k.PK, ':sk': k.SKPrefix },
    });
  }

  getSession(t: string, sessionId: string): Promise<SessionItem | undefined> {
    return this.get<SessionItem>(keys.session(t, sessionId));
  }

  /** Sesiones de un proyecto con started_at ∈ [from, to] (GSI1). */
  listSessionsOfProject(t: string, projectId: string, from: string, to: string): Promise<SessionItem[]> {
    const pk = keys.sessionGsi1(t, projectId, '', '').GSI1PK;
    return this.queryAll<SessionItem>({
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND GSI1SK BETWEEN :a AND :b',
      ExpressionAttributeValues: { ':pk': pk, ':a': `S#${from}`, ':b': `S#${to}￿` },
      ScanIndexForward: false,
    });
  }

  /** Partición completa de la sesión salvo eventos crudos (excepto reference.marked, que se usan por sesión). */
  async loadSessionPartition(t: string, sessionId: string): Promise<{
    session?: SessionItem;
    requests: AiRequestItem[];
    changes: ChangeItem[];
    references: ReferenceMark[];
  }> {
    const items = await this.queryAll<Item>({
      KeyConditionExpression: 'PK = :pk',
      FilterExpression: '#e <> :raw OR #et = :ref',
      ExpressionAttributeNames: { '#e': 'entity', '#et': 'event_type' },
      ExpressionAttributeValues: {
        ':pk': keys.sessionPk(t, sessionId),
        ':raw': ENTITY.rawEvent,
        ':ref': 'reference.marked',
      },
    });
    const out = { session: undefined as SessionItem | undefined, requests: [] as AiRequestItem[], changes: [] as ChangeItem[], references: [] as ReferenceMark[] };
    for (const it of items) {
      switch (it.entity) {
        case ENTITY.session:
          out.session = it as unknown as SessionItem;
          break;
        case ENTITY.aiRequest:
          out.requests.push(it as unknown as AiRequestItem);
          break;
        case ENTITY.change:
          out.changes.push(it as unknown as ChangeItem);
          break;
        case ENTITY.rawEvent: {
          const ev = it.event as { payload: Omit<ReferenceMark, 'session_id' | 'project_id' | 'repository' | 'occurred_at' | 'provenance'>; source?: string };
          out.references.push({
            ...ev.payload,
            session_id: sessionId,
            project_id: String(it.project_id),
            repository: String(it.repository),
            occurred_at: String(it.occurred_at),
            provenance: it.provenance as ReferenceMark['provenance'],
            source: it.source as ReferenceMark['source'],
          });
          break;
        }
      }
    }
    return out;
  }

  listCommitsOfSession(t: string, sessionId: string): Promise<CommitItem[]> {
    return this.queryAll<CommitItem>({
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :sk)',
      ExpressionAttributeValues: { ':pk': keys.sessionPk(t, sessionId), ':sk': 'COMMIT#' },
    });
  }

  listCommitsOfRepo(t: string, repo: string): Promise<CommitItem[]> {
    return this.queryAll<CommitItem>({
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': keys.repoPk(t, repo), ':sk': 'COMMIT#' },
    });
  }

  /** Todas las peticiones de la key en [from, to] (GSI1 T#t#K#key / R#occurred_at). */
  listRequestsOfKey(t: string, keyId: string, from: string, to: string): Promise<AiRequestItem[]> {
    const pk = keys.aiRequestGsi1(t, keyId, '').GSI1PK;
    return this.queryAll<AiRequestItem>({
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND GSI1SK BETWEEN :a AND :b',
      ExpressionAttributeValues: { ':pk': pk, ':a': `R#${from}`, ':b': `R#${to}￿` },
    });
  }

  /** Sesiones enlazadas a una tarea (TaskLink kind=session). */
  async listTaskSessionIds(t: string, taskKey: string): Promise<string[]> {
    const items = await this.queryAll<{ link_id?: string; session_id?: string }>({
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': keys.taskPk(t, taskKey), ':sk': 'L#session#' },
    });
    return items.map((i) => i.session_id ?? i.link_id ?? '').filter(Boolean);
  }

  /** Items del proyecto en GSI1 con prefijo (PR#, TASK#, BRANCH#) y ventana opcional. */
  listProjectGsi<T = Item>(t: string, projectId: string, prefix: string, from?: string, to?: string): Promise<T[]> {
    const pk = keys.sessionGsi1(t, projectId, '', '').GSI1PK;
    return from && to
      ? this.queryAll<T>({
          IndexName: 'GSI1',
          KeyConditionExpression: 'GSI1PK = :pk AND GSI1SK BETWEEN :a AND :b',
          ExpressionAttributeValues: { ':pk': pk, ':a': `${prefix}${from}`, ':b': `${prefix}${to}￿` },
        })
      : this.queryAll<T>({
          IndexName: 'GSI1',
          KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :p)',
          ExpressionAttributeValues: { ':pk': pk, ':p': prefix },
        });
  }

  /** AiRequest (R#) o Change (C#) de una sesión con lectura consistente (contexto de scoring). */
  listSessionPrefix<T>(t: string, sessionId: string, prefix: 'R#' | 'C#'): Promise<T[]> {
    return this.queryAll<T>({
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': keys.sessionPk(t, sessionId), ':sk': prefix },
      ConsistentRead: true,
    });
  }

  /** Deployments de un repo (PK repo · DEPLOY#): se comparan por prefijo de SHA (commit, merge, head). */
  listDeploymentsOfRepo(t: string, repo: string): Promise<DeploymentEvidence[]> {
    return this.queryAll<DeploymentEvidence>({
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': keys.repoPk(t, repo), ':sk': 'DEPLOY#' },
    });
  }

  /** PullRequests de un repo (PK repo · PR#) para la regla de despliegue del merge commit. */
  listPullRequestsOfRepo(t: string, repo: string): Promise<PullRequestRef[]> {
    return this.queryAll<PullRequestRef>({
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': keys.repoPk(t, repo), ':sk': 'PR#' },
    });
  }

  /** Deployments de un SHA (GSI1 T#t#REPO#repo#SHA#sha). */
  listDeploymentsOfSha(t: string, repo: string, sha: string): Promise<DeploymentEvidence[]> {
    return this.queryAll<DeploymentEvidence>({
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :sk)',
      ExpressionAttributeValues: { ':pk': keys.deploymentGsi1(t, repo, sha, '').GSI1PK, ':sk': 'DEPLOY#' },
    });
  }
}

export const productivityRepository = new ProductivityRepository();
