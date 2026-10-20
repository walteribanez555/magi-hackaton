import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { keys } from '@magicode/contracts';
import { DELIVERY_TTL_SECONDS, WebhooksRepository } from '../webhooks.repository';

const ddb = mockClient(DynamoDBDocumentClient);
const repo = new WebhooksRepository(() => ddb as unknown as DynamoDBDocumentClient);

beforeEach(() => ddb.reset());

describe('WebhooksRepository.putDelivery (dedupe)', () => {
  const input = {
    tenant_id: 't1',
    delivery_key: 'github:72d3162e-cc78-11e3-81ab-4c9367dc0958',
    integration_id: 'int_0123456789abcdef',
    provider: 'github',
    received_at: '2026-10-20T20:00:00.000Z',
    kinds: ['repo.push'],
    now_epoch_s: 1_760_990_400,
  };

  it('put condicional con TTL de 30 días → true si es nueva', async () => {
    ddb.on(PutCommand).resolves({});
    expect(await repo.putDelivery(input)).toBe(true);
    const call = ddb.commandCalls(PutCommand)[0]!.args[0].input;
    expect(call.ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(call.Item).toMatchObject({
      ...keys.webhookDelivery('t1', input.delivery_key),
      entity: 'WebhookDelivery',
      expires_at: input.now_epoch_s + DELIVERY_TTL_SECONDS,
    });
    // solo metadatos: nada del payload
    expect(Object.keys(call.Item!).sort()).toEqual(
      ['PK', 'SK', 'created_at', 'entity', 'expires_at', 'integration_id', 'kinds', 'provenance', 'provider', 'received_at', 'tenant_id', 'updated_at'].sort(),
    );
  });

  it('ConditionalCheckFailed → false (duplicada)', async () => {
    ddb.on(PutCommand).rejects(new ConditionalCheckFailedException({ message: 'exists', $metadata: {} }));
    expect(await repo.putDelivery(input)).toBe(false);
  });

  it('otros errores se propagan', async () => {
    ddb.on(PutCommand).rejects(new Error('throttled'));
    await expect(repo.putDelivery(input)).rejects.toThrow('throttled');
  });
});

describe('WebhooksRepository.update', () => {
  it('usa el builder compartido (SET / if_not_exists / ADD de Sets) y mezcla la condición', async () => {
    ddb.on(UpdateCommand).resolves({});
    await repo.update(
      { PK: 'p', SK: 's' },
      { set: { status: 'x' }, setIfNotExists: { created_at: 'now' }, add: { task_keys: new Set(['MAG-1']) } },
      { expression: 'attribute_exists(PK)' },
    );
    const call = ddb.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(call.UpdateExpression).toMatch(/^SET #n0 = :v0, #n1 = if_not_exists\(#n1, :v1\) ADD #n2 :v2$/);
    expect(call.ExpressionAttributeNames).toEqual({ '#n0': 'status', '#n1': 'created_at', '#n2': 'task_keys' });
    expect(call.ConditionExpression).toBe('attribute_exists(PK)');
  });

  it('condición fallida → false; sin condición, el error se propaga', async () => {
    ddb.on(UpdateCommand).rejects(new ConditionalCheckFailedException({ message: 'no', $metadata: {} }));
    expect(await repo.update({ PK: 'p', SK: 's' }, { set: { a: 1 } }, { expression: 'attribute_exists(PK)' })).toBe(false);
    await expect(repo.update({ PK: 'p', SK: 's' }, { set: { a: 1 } })).rejects.toThrow();
  });
});
