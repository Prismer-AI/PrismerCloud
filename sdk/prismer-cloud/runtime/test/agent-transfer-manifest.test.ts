// release201/09 §9.7.1 — transfer-manifest signature verify.
//
// SDK CLI is in `sdk/prismer-cloud/typescript/src/commands/agent.ts` (not
// directly importable from runtime/), so this test reproduces the same
// merkle + HMAC compute steps and asserts:
//
//   1. Computed sha256 over sorted "path:hash" lines matches expected merkle
//   2. HMAC_SHA256(apiKey, sha256) round-trips (sign on source, verify on target
//      with same apiKey)
//   3. Tampering with a single file invalidates the signature

import { describe, expect, it } from 'vitest';
import { createHash, createHmac } from 'node:crypto';

interface FileEntry {
  rel: string;
  bytes: Buffer;
}

function shaBuf(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}

function manifestMerkle(files: FileEntry[]): string {
  const lines = files
    .map((f) => ({ rel: f.rel, sha: shaBuf(f.bytes) }))
    .sort((a, b) => a.rel.localeCompare(b.rel))
    .map((f) => `${f.rel}:${f.sha}`)
    .join('\n');
  return createHash('sha256').update(lines).digest('hex');
}

function signManifest(apiKey: string, sha256: string): string {
  return createHmac('sha256', apiKey).update(sha256).digest('hex');
}

describe('release201/09 §9.7.1 — transfer-manifest signature', () => {
  const apiKey = 'sk-prismer-test-key';

  it('merkle is deterministic for same files regardless of input order', () => {
    const a: FileEntry[] = [
      { rel: 'profile.json', bytes: Buffer.from('{"a":1}') },
      { rel: 'skills/tasks/SKILL.md', bytes: Buffer.from('# tasks') },
    ];
    const b: FileEntry[] = [
      { rel: 'skills/tasks/SKILL.md', bytes: Buffer.from('# tasks') },
      { rel: 'profile.json', bytes: Buffer.from('{"a":1}') },
    ];
    expect(manifestMerkle(a)).toBe(manifestMerkle(b));
  });

  it('HMAC signature round-trips between source and target with same key', () => {
    const files: FileEntry[] = [
      { rel: 'profile.json', bytes: Buffer.from('{"name":"COO"}') },
      { rel: 'skills/tasks/SKILL.md', bytes: Buffer.from('# Tasks') },
      { rel: 'outbox/metrics.jsonl', bytes: Buffer.from('{"k":"v"}\n') },
    ];
    const sha = manifestMerkle(files);
    const sig = signManifest(apiKey, sha);

    // Target re-signs with same key + sha → must match.
    const recomputed = signManifest(apiKey, sha);
    expect(recomputed).toBe(sig);
  });

  it('tampering with a file invalidates the signature', () => {
    const files: FileEntry[] = [
      { rel: 'profile.json', bytes: Buffer.from('{"name":"COO"}') },
      { rel: 'skills/tasks/SKILL.md', bytes: Buffer.from('# Tasks') },
    ];
    const sha = manifestMerkle(files);
    const sig = signManifest(apiKey, sha);

    // Attacker swaps profile.json content but keeps the original manifest+sig.
    const tampered = [{ ...files[0]!, bytes: Buffer.from('{"name":"HACK"}') }, files[1]!];
    const tamperedSha = manifestMerkle(tampered);
    expect(tamperedSha).not.toBe(sha);

    const reSig = signManifest(apiKey, tamperedSha);
    expect(reSig).not.toBe(sig);
  });

  it('different apiKey yields different signature for same sha', () => {
    const sha = 'a'.repeat(64);
    const s1 = signManifest('sk-prismer-A', sha);
    const s2 = signManifest('sk-prismer-B', sha);
    expect(s1).not.toBe(s2);
  });
});
