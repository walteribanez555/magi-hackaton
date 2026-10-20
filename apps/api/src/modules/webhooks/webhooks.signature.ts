import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { WEBHOOK_SIGNATURE_HEADERS, type IntegrationProvider } from '@magicode/contracts';

export type SignatureResult = { ok: true } | { ok: false; reason: 'missing' | 'malformed' | 'mismatch' };

const hmacHex = (secret: string, body: string): Buffer =>
  createHmac('sha256', secret).update(body, 'utf8').digest();

/** Compara dos digests hex en tiempo constante (longitudes distintas ⇒ false sin cortocircuito por contenido). */
function safeHexEqual(expected: Buffer, providedHex: string): boolean {
  if (!/^[0-9a-f]+$/i.test(providedHex) || providedHex.length !== expected.length * 2) return false;
  const provided = Buffer.from(providedHex, 'hex');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/** Compara dos strings arbitrarios en tiempo constante (vía sha256 para igualar longitudes). */
function safeStringEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a, 'utf8').digest();
  const db = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(da, db) && a.length === b.length;
}

function verifyPrefixed(header: string | undefined, secret: string, body: string): SignatureResult {
  if (!header) return { ok: false, reason: 'missing' };
  const m = /^sha256=([0-9a-f]+)$/i.exec(header.trim());
  if (!m) return { ok: false, reason: 'malformed' };
  return safeHexEqual(hmacHex(secret, body), m[1]!) ? { ok: true } : { ok: false, reason: 'mismatch' };
}

/**
 * Verifica la autenticidad de una entrega con el secreto de la integración.
 *   github    X-Hub-Signature-256: sha256=<hex HMAC-SHA256(secret, raw body)>
 *   bitbucket X-Hub-Signature:     sha256=<hex>         (Bitbucket Cloud, webhook con secreto)
 *   jira      X-Hub-Signature:     sha256=<hex>         (Jira Cloud admin webhooks con secreto)
 *   linear    Linear-Signature:    <hex>
 *   gitlab    X-Gitlab-Token:      <secreto en claro>   (GitLab no firma: compara el token)
 * `headers` con claves en minúsculas. `body` = cuerpo CRUDO (antes de JSON.parse).
 */
export function verifyWebhookSignature(
  provider: IntegrationProvider,
  headers: Record<string, string | undefined>,
  body: string,
  secret: string,
): SignatureResult {
  const header = headers[WEBHOOK_SIGNATURE_HEADERS[provider].signature];
  switch (provider) {
    case 'github':
    case 'bitbucket':
    case 'jira':
      return verifyPrefixed(header, secret, body);
    case 'linear': {
      if (!header) return { ok: false, reason: 'missing' };
      const hex = header.trim();
      if (!/^[0-9a-f]+$/i.test(hex)) return { ok: false, reason: 'malformed' };
      return safeHexEqual(hmacHex(secret, body), hex) ? { ok: true } : { ok: false, reason: 'mismatch' };
    }
    case 'gitlab':
      if (!header) return { ok: false, reason: 'missing' };
      return safeStringEqual(header, secret) ? { ok: true } : { ok: false, reason: 'mismatch' };
  }
}

/** Utilidad para tests / herramientas: firma un cuerpo como lo haría el proveedor. */
export function signBody(provider: IntegrationProvider, body: string, secret: string): Record<string, string> {
  const name = WEBHOOK_SIGNATURE_HEADERS[provider].signature;
  if (provider === 'gitlab') return { [name]: secret };
  const hex = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  return { [name]: provider === 'linear' ? hex : `sha256=${hex}` };
}
