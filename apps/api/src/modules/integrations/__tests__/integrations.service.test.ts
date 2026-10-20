import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IntegrationCreated, keys } from '@magicode/contracts';
import { HttpException } from '../../../common/exceptions';
import { IntegrationsRepository } from '../integrations.repository';
import { IntegrationsService, normalizeRepository, publicBaseUrl } from '../integrations.service';

const ddb = mockClient(DynamoDBDocumentClient);
const repo = new IntegrationsRepository(() => ddb as unknown as DynamoDBDocumentClient);
const NOW = new Date('2026-10-20T20:00:00.000Z');
const svc = new IntegrationsService(repo, () => NOW);
const scope = { tenant_id: 'tenant_acme', key_id: 'key_1' };

beforeEach(() => {
  ddb.reset();
  delete process.env.PUBLIC_API_URL;
});
afterEach(() => delete process.env.PUBLIC_API_URL);

describe('POST /integrations', () => {
  it('git: genera id int_+16hex y secreto de 32 bytes; Integration SIN secreto, IntLookup CON secreto', async () => {
    ddb.on(TransactWriteCommand).resolves({});
    process.env.PUBLIC_API_URL = 'https://api.magicode.dev/';
    const out = await svc.create(scope, { provider: 'github', project_id: 'shop', repository: 'https://github.com/acme/shop.git' }, 'https://ignored');

    expect(IntegrationCreated.parse(out)).toBeTruthy();
    expect(out.integration_id).toMatch(/^int_[0-9a-f]{16}$/);
    expect(out.webhook_secret).toMatch(/^[0-9a-f]{64}$/);
    expect(out).toMatchObject({ provider: 'github', repository: 'acme/shop', status: 'pending', last_delivery_at: null, tenant_id: 'tenant_acme' });
    expect(out.webhook_url).toBe(`https://api.magicode.dev/api/v1/webhooks/github/${out.integration_id}`);

    const [intPut, lookupPut] = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!.map((t) => t.Put!);
    expect(intPut!.Item).toMatchObject({ ...keys.integration('tenant_acme', out.integration_id), entity: 'Integration' });
    expect(JSON.stringify(intPut!.Item)).not.toContain(out.webhook_secret);
    expect(lookupPut!.Item).toMatchObject({
      ...keys.integrationLookup(out.integration_id),
      entity: 'IntLookup',
      tenant_id: 'tenant_acme',
      project_id: 'shop',
      repository: 'acme/shop',
      secret: out.webhook_secret,
      status: 'pending',
    });
    expect(intPut!.ConditionExpression).toBe('attribute_not_exists(PK)');
  });

  it('jira: task_project_keys y base_url; webhook_url con el origen de la petición si no hay PUBLIC_API_URL', async () => {
    ddb.on(TransactWriteCommand).resolves({});
    const out = await svc.create(
      scope,
      { provider: 'jira', project_id: 'shop', task_project_keys: ['MAG', 'MAG'], base_url: 'https://example.atlassian.net/' },
      'https://abc.execute-api.us-east-1.amazonaws.com',
    );
    expect(out.task_project_keys).toEqual(['MAG']);
    expect(out.repository).toBeUndefined();
    expect(out.webhook_url).toBe(`https://abc.execute-api.us-east-1.amazonaws.com/api/v1/webhooks/jira/${out.integration_id}`);
    const lookup = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems![1]!.Put!.Item!;
    expect(lookup.base_url).toBe('https://example.atlassian.net');
  });

  it('cuerpo inválido → ZodError (400 vía handleException)', async () => {
    await expect(svc.create(scope, { provider: 'jira', project_id: 'shop', task_project_keys: ['mag'] })).rejects.toThrow();
    await expect(svc.create(scope, { provider: 'svn', project_id: 'x', repository: 'a/b' })).rejects.toThrow();
  });
});

describe('GET /integrations', () => {
  it('lista sin secretos ni claves Dynamo, filtrable por proyecto', async () => {
    ddb.on(QueryCommand).resolves({
      Items: [
        { PK: 'T#tenant_acme', SK: 'INT#int_1', entity: 'Integration', integration_id: 'int_1', tenant_id: 'tenant_acme', project_id: 'shop', provider: 'github', repository: 'acme/shop', webhook_url: 'u', status: 'active', last_delivery_at: '2026-10-20T00:00:00Z', created_at: '2026-10-01T00:00:00Z', key_id: 'k', secret: 'LEAK?' },
        { PK: 'T#tenant_acme', SK: 'INT#int_2', entity: 'Integration', integration_id: 'int_2', tenant_id: 'tenant_acme', project_id: 'other', provider: 'jira', task_project_keys: ['OPS'], webhook_url: 'u', status: 'pending', created_at: '2026-10-02T00:00:00Z', key_id: 'k' },
      ],
    });
    const all = await svc.list('tenant_acme');
    expect(all.map((i) => i.integration_id)).toEqual(['int_2', 'int_1']);
    expect(JSON.stringify(all)).not.toMatch(/secret|LEAK|"PK"/);
    expect(all[0]!.last_delivery_at).toBeNull();
    expect((await svc.list('tenant_acme', 'shop')).map((i) => i.integration_id)).toEqual(['int_1']);
    expect(ddb.commandCalls(QueryCommand)[0]!.args[0].input.ExpressionAttributeValues).toEqual({ ':pk': 'T#tenant_acme', ':sk': 'INT#' });
  });
});

describe('DELETE / rotate-secret', () => {
  it('disable actualiza ambas filas (lookup condicionado al tenant)', async () => {
    ddb.on(TransactWriteCommand).resolves({});
    ddb.on(GetCommand).resolves({ Item: { integration_id: 'int_1', tenant_id: 'tenant_acme', project_id: 'p', provider: 'github', webhook_url: 'u', status: 'disabled', created_at: 'x' } });
    const out = await svc.disable('tenant_acme', 'int_1');
    expect(out.status).toBe('disabled');
    const items = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(items[1]!.Update!.ConditionExpression).toContain('tenant_id = :t');
  });

  it('disable de otra integración/tenant → 404', async () => {
    ddb.on(TransactWriteCommand).rejects(new TransactionCanceledException({ message: 'cancel', $metadata: {} }));
    await expect(svc.disable('tenant_acme', 'int_x')).rejects.toSatisfy((e) => e instanceof HttpException && e.statusCode === 404);
  });

  it('rotate-secret devuelve un secreto nuevo y solo toca IntLookup', async () => {
    ddb.on(GetCommand).resolves({ Item: { integration_id: 'int_1', tenant_id: 'tenant_acme', project_id: 'p', provider: 'github', webhook_url: 'u', status: 'active', created_at: 'x' } });
    ddb.on(UpdateCommand).resolves({});
    const out = await svc.rotateSecret('tenant_acme', 'int_1');
    expect(out.webhook_secret).toMatch(/^[0-9a-f]{64}$/);
    const upd = ddb.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(upd.Key).toEqual(keys.integrationLookup('int_1'));
    expect(upd.ExpressionAttributeValues![':s']).toBe(out.webhook_secret);
  });

  it('rotate-secret de una integración deshabilitada → 404', async () => {
    ddb.on(GetCommand).resolves({ Item: { integration_id: 'int_1', status: 'disabled' } });
    await expect(svc.rotateSecret('tenant_acme', 'int_1')).rejects.toSatisfy((e) => e instanceof HttpException && e.statusCode === 404);
  });
});

describe('helpers', () => {
  it('normalizeRepository', () => {
    expect(normalizeRepository('https://github.com/acme/shop.git')).toBe('acme/shop');
    expect(normalizeRepository('git@bitbucket.org:acme/payments.git')).toBe('acme/payments');
    expect(normalizeRepository(' acme/Shop/ ')).toBe('acme/Shop');
    expect(normalizeRepository('https://gitlab.com/group/sub/proj')).toBe('group/sub/proj');
  });

  it('publicBaseUrl prioriza PUBLIC_API_URL', () => {
    expect(publicBaseUrl('https://origin.test')).toBe('https://origin.test');
    process.env.PUBLIC_API_URL = 'https://api.x.dev//';
    expect(publicBaseUrl('https://origin.test')).toBe('https://api.x.dev');
  });
});
