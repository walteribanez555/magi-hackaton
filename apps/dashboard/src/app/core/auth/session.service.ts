import { Injectable, computed, signal } from '@angular/core';
import type { KeyIdentity } from '@magicode/contracts';

/**
 * La API key de MagiHub vive SOLO en sessionStorage (se borra al cerrar la pestaña) y en
 * memoria. Nunca se registra en consola ni se envía a otro origen que el API configurado.
 */
const KEY_STORAGE = 'magicode.api_key';
const IDENTITY_STORAGE = 'magicode.identity';

function safeGet(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* sin almacenamiento: la sesión vive solo en memoria */
  }
}
function safeRemove(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* noop */
  }
}

@Injectable({ providedIn: 'root' })
export class SessionService {
  private readonly key = signal<string | null>(safeGet(KEY_STORAGE));
  readonly identity = signal<KeyIdentity | null>(this.readIdentity());

  readonly isAuthenticated = computed(() => !!this.key());

  /** La key solo se expone al interceptor. */
  apiKey(): string | null {
    return this.key();
  }

  set(key: string, identity: KeyIdentity): void {
    this.key.set(key);
    this.identity.set(identity);
    safeSet(KEY_STORAGE, key);
    safeSet(IDENTITY_STORAGE, JSON.stringify(identity));
  }

  clear(): void {
    this.key.set(null);
    this.identity.set(null);
    safeRemove(KEY_STORAGE);
    safeRemove(IDENTITY_STORAGE);
  }

  private readIdentity(): KeyIdentity | null {
    const raw = safeGet(IDENTITY_STORAGE);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as KeyIdentity;
    } catch {
      return null;
    }
  }
}
