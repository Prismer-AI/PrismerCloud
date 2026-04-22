/**
 * Published-agents registry tests (Sprint A2.2).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadPublishedRegistry,
  savePublishedRegistry,
  upsertPublished,
  removePublished,
  findPublished,
  type PublishedAgent,
} from '../src/agents/published-registry';

let tmpDir: string;
let regFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prismer-pubreg-'));
  regFile = path.join(tmpDir, 'published-agents.toml');
});

describe('published-registry', () => {
  it('loadPublishedRegistry returns [] when file missing', () => {
    expect(loadPublishedRegistry(regFile)).toEqual([]);
  });

  it('loadPublishedRegistry returns [] on malformed TOML (corruption-tolerant)', () => {
    fs.writeFileSync(regFile, 'this is not = valid [toml]]]');
    expect(loadPublishedRegistry(regFile)).toEqual([]);
  });

  it('save → load round-trip preserves all fields', () => {
    const entries: PublishedAgent[] = [
      {
        name: 'claude-code',
        cloudAgentId: 'cmo0qzzxw011lvm01qplbgs1i',
        localAgentId: 'claude-code@MacBook-Pro',
        adapter: 'claude-code',
        publishedAt: '2026-04-20T10:30:00.000Z',
      },
      {
        name: 'openclaw',
        cloudAgentId: 'cmoaxxxx',
        publishedAt: '2026-04-20T10:31:00.000Z',
      },
    ];
    savePublishedRegistry(entries, regFile);
    const loaded = loadPublishedRegistry(regFile);
    expect(loaded).toEqual(entries);
  });

  it('upsertPublished adds when missing', () => {
    const entry: PublishedAgent = {
      name: 'hermes',
      cloudAgentId: 'h1',
      publishedAt: '2026-04-20T10:00:00.000Z',
    };
    upsertPublished(entry, regFile);
    expect(findPublished('hermes', regFile)).toEqual(entry);
  });

  it('upsertPublished replaces when name matches', () => {
    upsertPublished({ name: 'hermes', cloudAgentId: 'h1', publishedAt: '2026-04-20T10:00:00.000Z' }, regFile);
    upsertPublished({ name: 'hermes', cloudAgentId: 'h2', publishedAt: '2026-04-20T11:00:00.000Z' }, regFile);
    const all = loadPublishedRegistry(regFile);
    expect(all.length).toBe(1);
    expect(all[0].cloudAgentId).toBe('h2');
  });

  it('removePublished is no-op when name missing', () => {
    const result = removePublished('does-not-exist', regFile);
    expect(result).toEqual([]);
  });

  it('removePublished drops by name', () => {
    upsertPublished({ name: 'a', cloudAgentId: '1', publishedAt: '2026-04-20T10:00:00.000Z' }, regFile);
    upsertPublished({ name: 'b', cloudAgentId: '2', publishedAt: '2026-04-20T10:00:00.000Z' }, regFile);
    removePublished('a', regFile);
    const remaining = loadPublishedRegistry(regFile);
    expect(remaining.map((e) => e.name)).toEqual(['b']);
  });

  it('savePublishedRegistry uses 0600 permissions (file owner only)', () => {
    savePublishedRegistry(
      [{ name: 'x', cloudAgentId: 'x1', publishedAt: '2026-04-20T10:00:00.000Z' }],
      regFile,
    );
    const stat = fs.statSync(regFile);
    // Mask permission bits — on macOS / Linux the file should be readable
    // only by the daemon's UID. Skip on Windows where mode bits differ.
    if (process.platform !== 'win32') {
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it('atomic write: no .tmp file lingers after success', () => {
    savePublishedRegistry(
      [{ name: 'a', cloudAgentId: '1', publishedAt: '2026-04-20T10:00:00.000Z' }],
      regFile,
    );
    expect(fs.existsSync(regFile + '.tmp')).toBe(false);
  });

  it('schemaVersion field is written so future migrations can detect old files', () => {
    savePublishedRegistry(
      [{ name: 'a', cloudAgentId: '1', publishedAt: '2026-04-20T10:00:00.000Z' }],
      regFile,
    );
    const raw = fs.readFileSync(regFile, 'utf-8');
    expect(raw).toMatch(/schemaVersion\s*=\s*1/);
  });
});
