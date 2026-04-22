/**
 * Integration test: MemoryDB + memory-db-crypto opt-in encryption.
 *
 * Covers the full wire-up from env-var activation through write/read/FTS,
 * plus the two key correctness invariants:
 *   1. Lazy migration — a DB with mixed plaintext + ciphertext rows stays
 *      readable after encryption is turned on.
 *   2. Tamper detection — mutating a ciphertext byte causes decryption
 *      to throw (AES-GCM authTag check).
 *
 * NOTE: these tests mutate process.env to flip encryption on/off. vitest
 * runs each describe block in an isolated v8 context, but within a block
 * we save/restore env explicitly to avoid cross-test leakage.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MemoryDB } from '../src/memory-db.js';
import { generateKey } from '../src/memory-db-crypto.js';

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-db-enc-'));
  return path.join(dir, 'memory.db');
}

/** Read all three WAL files (db + wal + shm) concatenated — gives us the
 *  actual on-disk content regardless of whether WAL has been checkpointed.
 *  Needed because better-sqlite3 uses WAL journal mode and writes go to .db-wal
 *  first. */
function readAllBytes(dbPath: string): Buffer {
  const parts: Buffer[] = [];
  for (const suffix of ['', '-wal', '-shm']) {
    const p = dbPath + suffix;
    if (fs.existsSync(p)) parts.push(fs.readFileSync(p));
  }
  return Buffer.concat(parts);
}

describe('MemoryDB × encryption (opt-in)', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    delete process.env['PRISMER_DB_ENCRYPTION'];
    delete process.env['PRISMER_DB_KEY'];
    delete process.env['PRISMER_DB_KEY_FILE'];
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('plaintext by default — content column is raw', () => {
    const dbPath = tmpDbPath();
    const db = new MemoryDB({ enabled: false }, { filePath: dbPath });
    db.writeMemoryFile({
      ownerId: 'u1',
      ownerType: 'user',
      path: 'notes/one.md',
      content: 'hello world',
    });

    // Raw bytes contain "hello world" as substring (SQLite stores TEXT inline).
    const raw = readAllBytes(dbPath);
    expect(raw.includes(Buffer.from('hello world'))).toBe(true);
  });

  it('opt-in encryption: plaintext does NOT appear on disk', () => {
    process.env['PRISMER_DB_ENCRYPTION'] = '1';
    process.env['PRISMER_DB_KEY'] = generateKey();

    const dbPath = tmpDbPath();
    const db = new MemoryDB({ enabled: true }, { filePath: dbPath });
    const plaintext = 'supersecret-key-XYZ123';
    db.writeMemoryFile({
      ownerId: 'u1',
      ownerType: 'user',
      path: 'notes/secret.md',
      content: plaintext,
    });

    const raw = readAllBytes(dbPath);
    expect(raw.includes(Buffer.from(plaintext))).toBe(false);
    // Envelope prefix DOES appear
    expect(raw.includes(Buffer.from('ENC:v1:'))).toBe(true);

    // And decrypting via the same instance returns the plaintext.
    const file = db.getMemoryFileById(
      db.listMemoryFiles({ ownerId: 'u1' })[0].id,
    );
    expect(file?.content).toBe(plaintext);
  });

  it('lazy migration: plaintext written before, ciphertext written after — both readable', () => {
    const dbPath = tmpDbPath();

    // Phase 1 — write a row in plaintext mode.
    {
      const db = new MemoryDB({ enabled: false }, { filePath: dbPath });
      db.writeMemoryFile({
        ownerId: 'u1',
        ownerType: 'user',
        path: 'notes/plain.md',
        content: 'plaintext row',
      });
    }

    // Phase 2 — turn encryption on, write a second row.
    process.env['PRISMER_DB_ENCRYPTION'] = '1';
    process.env['PRISMER_DB_KEY'] = generateKey();

    const db2 = new MemoryDB({ enabled: true }, { filePath: dbPath });
    db2.writeMemoryFile({
      ownerId: 'u1',
      ownerType: 'user',
      path: 'notes/secret.md',
      content: 'ciphertext row',
    });

    // Both rows readable through the same instance — plaintext passes through,
    // ciphertext gets decrypted.
    const files = db2.listMemoryFiles({ ownerId: 'u1' });
    expect(files).toHaveLength(2);
    const plain = files.find((f) => f.path === 'notes/plain.md');
    const secret = files.find((f) => f.path === 'notes/secret.md');
    expect(plain?.content).toBe('plaintext row');
    expect(secret?.content).toBe('ciphertext row');
  });

  it('tamper detection: flipping a ciphertext byte causes decryption to throw', () => {
    process.env['PRISMER_DB_ENCRYPTION'] = '1';
    process.env['PRISMER_DB_KEY'] = generateKey();

    const dbPath = tmpDbPath();
    const db = new MemoryDB({ enabled: true }, { filePath: dbPath });
    db.writeMemoryFile({
      ownerId: 'u1',
      ownerType: 'user',
      path: 'notes/t.md',
      content: 'plain',
    });
    // Close to flush WAL into the main .db file — otherwise the envelope
    // lives in .db-wal and our mutation might hit a checkpointed copy.
    db.close();

    // Flip a byte inside the envelope in the .db file.
    const raw = fs.readFileSync(dbPath);
    const prefixIdx = raw.indexOf(Buffer.from('ENC:v1:'));
    expect(prefixIdx).toBeGreaterThan(0);
    const mutated = Buffer.from(raw);
    // Move past the prefix + nonce + authTag sections into the ciphertext.
    // Envelope format: ENC:v1:<nonce_b64>:<authTag_b64>:<ciphertext_b64>
    // We want a ciphertext byte — search forward for the last ':' after prefixIdx.
    const prefixEnd = prefixIdx + 'ENC:v1:'.length;
    let colons = 0;
    let cipherStart = prefixEnd;
    for (let i = prefixEnd; i < Math.min(raw.length, prefixEnd + 200); i++) {
      if (raw[i] === 0x3a /* ':' */) {
        colons++;
        if (colons === 2) {
          cipherStart = i + 1;
          break;
        }
      }
    }
    mutated[cipherStart + 4] = mutated[cipherStart + 4] ^ 0x01;
    fs.writeFileSync(dbPath, mutated);

    // New DB instance, same key
    const db2 = new MemoryDB({ enabled: true }, { filePath: dbPath });
    expect(() =>
      db2.listMemoryFiles({ ownerId: 'u1' }),
    ).toThrow(); // GCM auth tag mismatch
  });

  it('missing key when encryption enabled — throws loudly (fails closed)', () => {
    process.env['PRISMER_DB_ENCRYPTION'] = '1';
    // No PRISMER_DB_KEY / PRISMER_DB_KEY_FILE
    expect(() => new MemoryDB({ enabled: true }, { filePath: tmpDbPath() }))
      .toThrow(/PRISMER_DB_KEY/);
  });

  it('wrong-size key rejected', () => {
    process.env['PRISMER_DB_ENCRYPTION'] = '1';
    process.env['PRISMER_DB_KEY'] = Buffer.from('too-short').toString('base64');
    expect(() => new MemoryDB({ enabled: true }, { filePath: tmpDbPath() }))
      .toThrow(/32 bytes/);
  });

  it('different key cannot decrypt — tamper-equivalent failure', () => {
    const dbPath = tmpDbPath();

    // Write with key A
    process.env['PRISMER_DB_ENCRYPTION'] = '1';
    const keyA = crypto.randomBytes(32).toString('base64');
    process.env['PRISMER_DB_KEY'] = keyA;
    {
      const db = new MemoryDB({ enabled: true }, { filePath: dbPath });
      db.writeMemoryFile({
        ownerId: 'u1',
        ownerType: 'user',
        path: 'notes/a.md',
        content: 'locked',
      });
    }

    // Try to read with key B
    const keyB = crypto.randomBytes(32).toString('base64');
    process.env['PRISMER_DB_KEY'] = keyB;
    const db2 = new MemoryDB({ enabled: true }, { filePath: dbPath });
    expect(() => db2.listMemoryFiles({ ownerId: 'u1' })).toThrow();
  });
});
