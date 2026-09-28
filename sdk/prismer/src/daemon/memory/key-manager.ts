// Per-workspace memory encryption key manager (memory202 doc 06 — DEVELOP MVP).
//
// Generates / persists / loads a per-workspace AES-256 key on the DAEMON's
// local filesystem. The key NEVER leaves the daemon: it is never placed in an
// outbox payload, never sent to the cloud, never exposed over RPC. Agent
// processes can only obtain decrypted *content* via daemon RPC — never the key
// (doc 18 M4 invariant).
//
// Storage layout: `<baseDir>/<workspaceSlug>/.memkey` (sibling to the
// workspace's `memory.db`), file mode 0600, parent dir 0700.
//
// ── Ephemeral-pod safety (MVP deferral, fail-closed) ──────────────────────
// agent-rt pods mount `~/.prismer` as an ephemeral emptyDir (see CLAUDE.md):
// any key written there is LOST on pod restart, which would orphan every
// ciphertext written this boot (encrypt-then-lose-the-key — unrecoverable).
//
// So when the daemon detects it cannot durably persist a key, it REFUSES to
// encrypt. Chosen signal (simple + documented):
//
//   PRISMER_EPHEMERAL_STORAGE=true   (entrypoint sets this on agent-rt pods)
//
// Chosen fail-closed behavior: `getKeyOrNull()` returns null in ephemeral mode.
// Callers (outbox flush) then write PLAINTEXT with a loud one-time warn rather
// than encrypting — the page is readable + cloud-FTS-searchable as today, the
// honest degradation. We NEVER encrypt-then-lose-the-key.
//
// Cross-device key exchange / rotation / re-encryption are explicitly OUT OF
// SCOPE for the MVP (doc 06). A second device that never had the key cannot
// read another device's ciphertext — handled fail-closed at the sync-down call
// site (mark unreadable; never show ciphertext as content), not here.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { MEMORY_KEY_BYTES } from './crypto-cipher.js';
import { capAllowsWorkspace, type MemoryCap } from './cap.js';

const MODULE = '[memory-keys]';
const KEY_FILENAME = '.memkey';

export interface MemoryKeyManagerOptions {
  /**
   * Root dir for per-workspace state — MUST match MemoryRuntime.baseDir so the
   * key lands beside that workspace's `memory.db`.
   */
  baseDir: string;
  log?: { info: (m: string) => void; warn: (m: string) => void };
}

/**
 * True when the daemon cannot durably persist a key (ephemeral storage). In
 * this mode encryption is refused (fail-closed) — see file header.
 */
export function isEphemeralStorage(): boolean {
  return process.env.PRISMER_EPHEMERAL_STORAGE === 'true';
}

/**
 * memory202 doc 06 — the at-rest encryption feature gate. Read dynamically
 * (Nacos async-load convention) and defaults OFF, so the live MVP is unaffected
 * until the flag is explicitly set. Mirrors the outbox-worker's flag check so
 * the activation policy (mark page encrypted) and the flush (encrypt payload)
 * gate on the exact same signal.
 */
export function isEncryptionEnabled(): boolean {
  return process.env.FF_MEMORY_ENCRYPTION_ENABLED === 'true';
}

export class MemoryKeyManager {
  private readonly baseDir: string;
  private readonly log: { info: (m: string) => void; warn: (m: string) => void };
  // Cache loaded keys per workspace so we don't re-read + re-decode on every
  // page flush. Keys are 32 bytes; the map is tiny.
  private readonly cache = new Map<string, Buffer>();
  // One-time warn dedup so an ephemeral pod doesn't spam a warn per page.
  private warnedEphemeral = new Set<string>();

  constructor(opts: MemoryKeyManagerOptions) {
    this.baseDir = opts.baseDir;
    this.log = opts.log ?? {
      info: (m) => process.stdout.write(`${m}\n`),
      warn: (m) => process.stderr.write(`${m}\n`),
    };
  }

  private keyPath(workspaceId: string): string {
    // Mirror MemoryRuntime.workspaceSlug: ':' → '_'. The runtime's workspaceId
    // regex already restricts the input to a safe filename charset.
    const slug = workspaceId.replace(/:/g, '_');
    return path.join(this.baseDir, slug, KEY_FILENAME);
  }

  /**
   * Return the per-workspace key, generating + persisting it on first need.
   *
   * Returns null (fail-closed, NOT throw) when storage is ephemeral — the
   * caller writes plaintext instead of encrypting, and we never produce a key
   * we'd immediately lose. The first refusal per workspace logs a loud warn.
   */
  /**
   * Capability-gated key access (memory203 doc 08 §2.3, F3). The cap MUST
   * authorize `workspaceId` (exact ws, or the daemon-internal system cap's
   * wildcard) or this returns null WITHOUT touching the filesystem — fail
   * closed, so a caller scoped to workspace A can never unseal workspace B's
   * ciphertext. This is the runtime enforcement of the 05 §5 "credential GATES
   * decryption" invariant; the AES key itself stays daemon-local (the cap only
   * authorizes, it is never the key). On pass, delegates to the raw loader.
   */
  getKey(workspaceId: string, cap: MemoryCap): Buffer | null {
    if (!capAllowsWorkspace(cap, workspaceId)) {
      this.log.warn(
        `${MODULE} ⚠️ key gate denied: cap(sub=${cap.sub}, ws=${cap.ws}) not authorized for workspace=${workspaceId} — refusing to load key (fail-closed)`,
      );
      return null;
    }
    return this.getKeyOrNull(workspaceId);
  }

  /**
   * Raw key loader (NO capability gate) — generates + persists on first need.
   * Daemon-internal lifecycle/test surface; production decryption paths MUST go
   * through `getKey(workspaceId, cap)` so workspace scope is enforced.
   */
  getKeyOrNull(workspaceId: string): Buffer | null {
    if (isEphemeralStorage()) {
      if (!this.warnedEphemeral.has(workspaceId)) {
        this.warnedEphemeral.add(workspaceId);
        this.log.warn(
          `${MODULE} ⚠️ ephemeral storage (PRISMER_EPHEMERAL_STORAGE=true) — refusing to encrypt workspace=${workspaceId}; ` +
            `pages flush as PLAINTEXT (a key written to emptyDir would be lost on restart, orphaning every ciphertext). ` +
            `Encrypted memory on ephemeral pods is deferred per doc 06.`,
        );
      }
      return null;
    }

    const cached = this.cache.get(workspaceId);
    if (cached) return cached;

    const keyFile = this.keyPath(workspaceId);
    const dir = path.dirname(keyFile);

    let key: Buffer | null = this.tryLoad(keyFile);
    if (!key) {
      key = this.generateAndPersist(workspaceId, dir, keyFile);
      if (!key) return null; // persistence failed → fail closed (caller writes plaintext)
    }
    this.cache.set(workspaceId, key);
    return key;
  }

  /** Load an existing key file; null if absent or malformed (caller regenerates). */
  private tryLoad(keyFile: string): Buffer | null {
    if (!fs.existsSync(keyFile)) return null;
    try {
      const raw = fs.readFileSync(keyFile, 'utf8').trim();
      const buf = Buffer.from(raw, 'base64');
      if (buf.length !== MEMORY_KEY_BYTES) {
        this.log.warn(`${MODULE} key file ${keyFile} has wrong length ${buf.length}; ignoring (will regenerate)`);
        return null;
      }
      return buf;
    } catch (err) {
      this.log.warn(`${MODULE} failed to read key file ${keyFile}: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Generate a random 32-byte key, write it 0600 (parent 0700), then read it
   * BACK and verify it round-trips before returning — durability gate. If the
   * write/verify fails we return null (fail-closed): the caller must NOT then
   * encrypt with an in-memory-only key, because that key would be lost on
   * restart and orphan the ciphertext.
   */
  private generateAndPersist(workspaceId: string, dir: string, keyFile: string): Buffer | null {
    const key = crypto.randomBytes(MEMORY_KEY_BYTES);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        fs.chmodSync(dir, 0o700);
      } catch {
        /* non-POSIX best-effort */
      }
      // Exclusive create (wx) so a concurrent generate doesn't clobber an
      // existing key; on EEXIST fall through to load the winner's key.
      fs.writeFileSync(keyFile, key.toString('base64'), { mode: 0o600, flag: 'wx' });
      try {
        fs.chmodSync(keyFile, 0o600);
      } catch {
        /* non-POSIX best-effort */
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        const winner = this.tryLoad(keyFile);
        if (winner) {
          this.log.info(`${MODULE} key for workspace=${workspaceId} created concurrently — loaded existing`);
          return winner;
        }
      }
      this.log.warn(
        `${MODULE} ⚠️ could not persist key for workspace=${workspaceId} at ${keyFile}: ${(err as Error).message} — ` +
          `refusing to encrypt (fail-closed; would orphan ciphertext)`,
      );
      return null;
    }

    // Durability verify: read back what we just wrote.
    const reloaded = this.tryLoad(keyFile);
    if (!reloaded || !reloaded.equals(key)) {
      this.log.warn(
        `${MODULE} ⚠️ key for workspace=${workspaceId} did not round-trip after write — refusing to encrypt (fail-closed)`,
      );
      return null;
    }
    this.log.info(`${MODULE} generated + persisted memory key for workspace=${workspaceId} (0600)`);
    return reloaded;
  }

  /** Test/ops helper: drop the in-memory cache (does not delete files). */
  clearCache(): void {
    this.cache.clear();
    this.warnedEphemeral.clear();
  }
}
