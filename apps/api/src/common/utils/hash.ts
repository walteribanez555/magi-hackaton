import { createHash } from 'node:crypto';

export const sha256Hex = (v: string): string => createHash('sha256').update(v).digest('hex');

/** Huella pública de la API key: sha256(key)[:12]. Es lo único que se guarda/loguea de la key. */
export const keyFingerprint = (apiKey: string): string => sha256Hex(apiKey).slice(0, 12);
