import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { IntegrationProvider } from '@magicode/contracts';
import { signBody, verifyWebhookSignature } from '../webhooks.signature';

const SECRET = 'f'.repeat(64);
const BODY = JSON.stringify({ hello: 'world', n: 1 });
const hex = createHmac('sha256', SECRET).update(BODY).digest('hex');

describe('verifyWebhookSignature', () => {
  const cases: Array<{ provider: IntegrationProvider; header: string; valid: string }> = [
    { provider: 'github', header: 'x-hub-signature-256', valid: `sha256=${hex}` },
    { provider: 'bitbucket', header: 'x-hub-signature', valid: `sha256=${hex}` },
    { provider: 'jira', header: 'x-hub-signature', valid: `sha256=${hex}` },
    { provider: 'linear', header: 'linear-signature', valid: hex },
    { provider: 'gitlab', header: 'x-gitlab-token', valid: SECRET },
  ];

  for (const { provider, header, valid } of cases) {
    describe(provider, () => {
      it('acepta la firma válida', () => {
        expect(verifyWebhookSignature(provider, { [header]: valid }, BODY, SECRET)).toEqual({ ok: true });
      });

      it('rechaza si falta el header', () => {
        expect(verifyWebhookSignature(provider, {}, BODY, SECRET)).toEqual({ ok: false, reason: 'missing' });
      });

      it('rechaza un secreto distinto', () => {
        const res = verifyWebhookSignature(provider, { [header]: valid }, BODY, 'e'.repeat(64));
        expect(res.ok).toBe(false);
      });

      it('rechaza si el cuerpo fue alterado', () => {
        if (provider === 'gitlab') return; // GitLab no firma el cuerpo (solo token compartido)
        const res = verifyWebhookSignature(provider, { [header]: valid }, BODY.replace('world', 'w0rld'), SECRET);
        expect(res).toEqual({ ok: false, reason: 'mismatch' });
      });

      it('signBody genera exactamente lo que el proveedor enviaría', () => {
        expect(signBody(provider, BODY, SECRET)).toEqual({ [header]: valid });
      });
    });
  }

  it('github: rechaza firma sin prefijo sha256= (malformed) y SHA-1 legado', () => {
    expect(verifyWebhookSignature('github', { 'x-hub-signature-256': hex }, BODY, SECRET)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyWebhookSignature('github', { 'x-hub-signature-256': `sha1=${hex.slice(0, 40)}` }, BODY, SECRET)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('rechaza un hex truncado (longitud distinta) sin lanzar', () => {
    expect(verifyWebhookSignature('github', { 'x-hub-signature-256': `sha256=${hex.slice(0, 10)}` }, BODY, SECRET)).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    expect(verifyWebhookSignature('linear', { 'linear-signature': 'zz-not-hex' }, BODY, SECRET)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('acepta hex en mayúsculas', () => {
    expect(verifyWebhookSignature('github', { 'x-hub-signature-256': `sha256=${hex.toUpperCase()}` }, BODY, SECRET).ok).toBe(true);
  });
});
