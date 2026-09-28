/**
 * Deposit-dedup journal (runtime210/01 experiment).
 *
 * ContextCacheService.deposit is a BLIND upsert (src/lib/context-cache.service.ts
 * deposit) — a public entry can be overwritten by anyone. Without a journal,
 * two agents reading the same URL would keep overwriting each other's cache
 * entries. The journal records which URLs THIS daemon already deposited, so
 * each URL is written at most once per daemon (cross-source overwrite of
 * load_api entries is accepted for the experiment; see design doc §6.1).
 *
 * JSON file: {"urls": ["...", ...]}. Atomic persist: write tmp + rename.
 * Sync on purpose — mirrors the daemon's better-sqlite3 sync style; add() is
 * called from the fire-and-forget deposit path, never on the hot loop.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export class SeenJournal {
  readonly filePath: string;
  private urls = new Set<string>();

  constructor(filePath: string) {
    this.filePath = filePath;
    this.urls = this.load();
  }

  private load(): Set<string> {
    if (!existsSync(this.filePath)) return new Set();
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as { urls?: unknown };
      if (Array.isArray(parsed.urls)) {
        return new Set(parsed.urls.filter((u): u is string => typeof u === 'string'));
      }
    } catch {
      // corrupted file → treat as empty (never crash the daemon)
    }
    return new Set();
  }

  has(url: string): boolean {
    return this.urls.has(url);
  }

  add(urls: string[]): void {
    const fresh = urls.filter((u) => !this.urls.has(u));
    if (fresh.length === 0) return;
    for (const u of fresh) this.urls.add(u);
    this.persist();
  }

  private persist(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ urls: [...this.urls] }), 'utf8');
    renameSync(tmp, this.filePath);
  }

  /**
   * Default location ~/.prismer/cache/headless-deposited.json (PRISMER_HOME
   * overrides the home root; cacheDir overrides everything — tests).
   */
  static open(cacheDir?: string): SeenJournal {
    return new SeenJournal(path.join(cacheDir ?? defaultPrismerCacheDir(), 'headless-deposited.json'));
  }
}

/** Shared cache-dir resolution (headless script + journal). */
export function defaultPrismerCacheDir(): string {
  return path.join(process.env.PRISMER_HOME || path.join(os.homedir(), '.prismer'), 'cache');
}
