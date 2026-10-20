import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceNotFoundException,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import type { DynamoDBRecord, DynamoDBStreamEvent } from 'aws-lambda';
import { beforeEach, describe, expect, it } from 'vitest';
import { keys } from '@magicode/contracts';
import { CredentialsStore, secretNameFor } from '../credentials.store';
import { processStreamBatch } from '../task-sync.handler';
import { IDEM_TTL_SECONDS, TaskSyncRepository } from '../task-sync.repository';
import { RetryableOutboxError } from '../task-sync.service';
import type { OutboxItem } from '../task-sync.types';
import { JIRA_CREDS } from './helpers';

const record = (seq: string, status = 'pending', entity = 'OutboxAction'): DynamoDBRecord => ({
  eventName: 'INSERT',
  dynamodb: {
    SequenceNumber: seq,
    Keys: { PK: { S: 'T#t1#TASK#MAG-1' }, SK: { S: `ACT#2026-10-20T20:00:00.000Z#act_${seq}` } },
    NewImage: { entity: { S: entity }, status: { S: status } },
  },
});

describe('processStreamBatch', () => {
  it('procesa en orden, ignora lo que no es OutboxAction pending y corta en el primer error transitorio', async () => {
    const seen: string[] = [];
    const service = {
      processOutbox: async ({ SK }: { PK: string; SK: string }) => {
        seen.push(SK.slice(-1));
        if (SK.endsWith('3')) throw new RetryableOutboxError('503');
        return 'sent' as const;
      },
    };
    const event: DynamoDBStreamEvent = { Records: [record('1'), record('2', 'sent'), record('9', 'pending', 'Task'), record('3'), record('4')] };
    expect(await processStreamBatch(event, service)).toEqual({ batchItemFailures: [{ itemIdentifier: '3' }] });
    expect(seen).toEqual(['1', '3']); // el 4 se reintenta junto con el 3 (orden preservado)
  });

  it('todo OK → sin fallos; REMOVE se ignora', async () => {
    const event: DynamoDBStreamEvent = { Records: [{ ...record('1'), eventName: 'REMOVE' }, record('2')] };
    expect(await processStreamBatch(event, { processOutbox: async () => 'noop' as const })).toEqual({ batchItemFailures: [] });
  });
});

describe('TaskSyncRepository (DynamoDB)', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  const repo = new TaskSyncRepository(() => ddb as unknown as DynamoDBDocumentClient);
  const item = {
    ...keys.outboxAction('t1', 'MAG-1', '2026-10-20T20:00:00.000Z', 'act_1'),
    ...keys.outboxGsi1('t1', 'pending', '2026-10-20T20:00:00.000Z'),
    entity: 'OutboxAction',
    action_id: 'act_1',
    tenant_id: 't1',
    key_id: 'k',
    integration_id: 'int_aaaaaaaaaaaaaaaa',
    provider: 'jira',
    task_key: 'MAG-1',
    action: { kind: 'comment', body_markdown: 'x' },
    origin: { type: 'manual', key_id: 'k' },
    idempotency_key: 'manual:abc12345',
    status: 'pending',
    attempts: 0,
    last_error: null,
    result: null,
    created_at: '2026-10-20T20:00:00.000Z',
    updated_at: '2026-10-20T20:00:00.000Z',
    provenance: 'real',
  } as OutboxItem;

  beforeEach(() => ddb.reset());

  it('enqueue: ActionIdem condicional (TTL 7 d) + OutboxAction en una transacción', async () => {
    ddb.on(TransactWriteCommand).resolves({});
    expect(await repo.enqueue(item, 1_760_990_400)).toEqual({ item, duplicate: false });
    const [idem, out] = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(idem!.Put!.Item).toMatchObject({ ...keys.actionIdem('t1', 'manual:abc12345'), entity: 'ActionIdem', outbox_pk: item.PK, outbox_sk: item.SK, expires_at: 1_760_990_400 + IDEM_TTL_SECONDS });
    expect(idem!.Put!.ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(out!.Put!.Item).toBe(item);
  });

  it('enqueue duplicado → devuelve la OutboxAction original', async () => {
    ddb.on(TransactWriteCommand).rejects(
      new TransactionCanceledException({ message: 'cancelled', $metadata: {}, CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }] }),
    );
    ddb.on(GetCommand, { Key: keys.actionIdem('t1', 'manual:abc12345') }).resolves({ Item: { outbox_pk: item.PK, outbox_sk: 'ACT#old#act_0' } });
    ddb.on(GetCommand, { Key: { PK: item.PK, SK: 'ACT#old#act_0' } }).resolves({ Item: { ...item, action_id: 'act_0', status: 'sent' } });
    const res = await repo.enqueue(item, 1);
    expect(res.duplicate).toBe(true);
    expect(res.item).toMatchObject({ action_id: 'act_0', status: 'sent' });
  });

  it('claim: condición pending o sending huérfano; mueve GSI1 a sending', async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: { ...item, status: 'sending', attempts: 1 } });
    expect(await repo.claim(item, new Date('2026-10-20T20:10:00.000Z'))).toMatchObject({ status: 'sending' });
    const u = ddb.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(u.ConditionExpression).toBe('#s = :pending OR (#s = :sending AND claimed_at < :stale)');
    expect(u.ExpressionAttributeValues).toMatchObject({ ':g': 'T#t1#OUTBOX#sending', ':stale': '2026-10-20T20:08:00.000Z' });
  });

  it('finish: solo desde sending; actualiza GSI1 al estado final', async () => {
    ddb.on(UpdateCommand).resolves({});
    await repo.finish(item, 'sent', { result: { comment_id: '1' }, last_error: null }, new Date('2026-10-20T20:11:00.000Z'));
    const u = ddb.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(u.ConditionExpression).toBe('#s = :sending');
    expect(u.ExpressionAttributeValues).toMatchObject({ ':s': 'sent', ':g': 'T#t1#OUTBOX#sent', ':r': { comment_id: '1' }, ':e': null });
  });
});

describe('CredentialsStore (Secrets Manager)', () => {
  const sm = mockClient(SecretsManagerClient);
  let now = 0;
  const store = new CredentialsStore(() => sm as unknown as SecretsManagerClient, () => now);

  beforeEach(() => {
    sm.reset();
    store.clearCache();
    process.env.APP_ENV = 'dev';
  });

  it('nombre magicode/<APP_ENV>/integrations/<id>', () => {
    expect(secretNameFor('int_1')).toBe('magicode/dev/integrations/int_1');
  });

  it('PutSecretValue y, si no existe, CreateSecret con tags', async () => {
    sm.on(PutSecretValueCommand).rejects(new ResourceNotFoundException({ message: 'nf', $metadata: {} }));
    sm.on(CreateSecretCommand).resolves({});
    await store.save('int_1', 't1', JIRA_CREDS);
    const create = sm.commandCalls(CreateSecretCommand)[0]!.args[0].input;
    expect(create.Name).toBe('magicode/dev/integrations/int_1');
    expect(JSON.parse(create.SecretString!)).toEqual(JIRA_CREDS);
    expect(create.Tags).toContainEqual({ Key: 'integration_id', Value: 'int_1' });
  });

  it('get valida con zod, cachea 5 min y devuelve null si no existe', async () => {
    sm.on(GetSecretValueCommand).resolvesOnce({ SecretString: JSON.stringify(JIRA_CREDS) });
    expect(await store.get('int_1')).toEqual(JIRA_CREDS);
    expect(await store.get('int_1')).toEqual(JIRA_CREDS);
    expect(sm.commandCalls(GetSecretValueCommand)).toHaveLength(1);
    now = 6 * 60_000;
    sm.on(GetSecretValueCommand).rejects(new ResourceNotFoundException({ message: 'nf', $metadata: {} }));
    expect(await store.get('int_1')).toBeNull();
  });
});
