/**
 * Índice de hashes de líneas del repo (para la señal de redundancia `existing_in_repo`).
 * Se construye desde `git ls-files` (omitiendo binarios y archivos > 1 MB), se cachea por sesión
 * y se actualiza incrementalmente por archivo. Solo guarda hashes HMAC salados, nunca contenido.
 * Puro: no importa 'vscode'.
 */
import { promises as fs } from 'node:fs';
import * as nodePath from 'node:path';
import { buildRepoHashIndex } from '@magicode/metrics';
import { git, isProbablyBinary, parseNulList } from './git';
import type { Logger } from './log';

export const MAX_INDEXED_FILE_BYTES = 1024 * 1024;
const CONCURRENCY = 16;

export class RepoHashIndex {
  private readonly perFile = new Map<string, string[]>();
  private readonly counts = new Map<string, number>();
  private snapshotCache: Set<string> | undefined;
  private building: Promise<void> | undefined;
  private built = false;
  skipped = 0;

  constructor(
    private readonly salt: string,
    private readonly root: string,
    private readonly logger: Logger,
  ) {}

  get fileCount(): number {
    return this.perFile.size;
  }

  get ready(): boolean {
    return this.built;
  }

  /** Construye (una vez) o espera la construcción en curso. */
  ensureBuilt(): Promise<void> {
    if (this.built) return Promise.resolve();
    if (!this.building) {
      this.building = this.refresh().finally(() => {
        this.built = true;
        this.building = undefined;
      });
    }
    return this.building;
  }

  /** Re-lee `git ls-files`: agrega archivos nuevos y quita los que ya no están trackeados. */
  async refresh(): Promise<void> {
    const started = Date.now();
    let tracked: string[];
    try {
      tracked = parseNulList(await git(this.root, ['ls-files', '-z', '--cached']));
    } catch (err) {
      this.logger.warn(`No se pudo listar archivos trackeados: ${(err as Error).message}`);
      return;
    }
    const trackedSet = new Set(tracked);
    for (const p of [...this.perFile.keys()]) if (!trackedSet.has(p)) this.removeFile(p);
    const pending = tracked.filter((p) => !this.perFile.has(p));
    let i = 0;
    const worker = async () => {
      while (i < pending.length) {
        const p = pending[i++]!;
        const content = await this.readText(p);
        if (content !== undefined) this.setFile(p, content);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));
    this.logger.debug(`Índice de repo: ${this.perFile.size} archivos (${pending.length} nuevos, ${this.skipped} omitidos) en ${Date.now() - started} ms`);
  }

  private async readText(rel: string): Promise<string | undefined> {
    const abs = nodePath.join(this.root, rel);
    try {
      const st = await fs.stat(abs);
      if (!st.isFile() || st.size > MAX_INDEXED_FILE_BYTES) {
        this.skipped++;
        return undefined;
      }
      const buf = await fs.readFile(abs);
      if (isProbablyBinary(buf)) {
        this.skipped++;
        return undefined;
      }
      return buf.toString('utf8');
    } catch {
      return undefined;
    }
  }

  /** Reemplaza los hashes de un archivo (tras aceptar un cambio o guardar). */
  setFile(path: string, content: string): void {
    if (content.length > MAX_INDEXED_FILE_BYTES) return;
    this.removeFile(path);
    const hashes = [...buildRepoHashIndex(this.salt, [{ path, content }])];
    this.perFile.set(path, hashes);
    for (const h of hashes) this.counts.set(h, (this.counts.get(h) ?? 0) + 1);
    this.snapshotCache = undefined;
  }

  removeFile(path: string): void {
    const prev = this.perFile.get(path);
    if (!prev) return;
    for (const h of prev) {
      const c = (this.counts.get(h) ?? 1) - 1;
      if (c <= 0) this.counts.delete(h);
      else this.counts.set(h, c);
    }
    this.perFile.delete(path);
    this.snapshotCache = undefined;
  }

  /** Re-lee un archivo del disco si está trackeado. */
  async updateFromDisk(path: string): Promise<void> {
    if (!this.perFile.has(path)) return;
    const content = await this.readText(path);
    if (content === undefined) this.removeFile(path);
    else this.setFile(path, content);
  }

  has(path: string): boolean {
    return this.perFile.has(path);
  }

  snapshot(): ReadonlySet<string> {
    if (!this.snapshotCache) this.snapshotCache = new Set(this.counts.keys());
    return this.snapshotCache;
  }
}
