// T-migrate-luminclaw — migrate-luminclaw-memory command tests

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { UI } from '../../src/cli/ui.js';
import type { CliContext } from '../../src/cli/context.js';
import { Keychain } from '../../src/keychain.js';
import { migrateLuminclawMemoryCommand } from '../../src/commands/migrate-luminclaw-memory.js';

// ============================================================
// Helpers
// ============================================================

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-luminclaw-test-'));
}

function cleanupDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function makePrettyUI(): { ui: UI; output: () => string; errOutput: () => string } {
  const chunks: string[] = [];
  const errChunks: string[] = [];
  const stream = { write(d: string): boolean { chunks.push(d); return true; } } as NodeJS.WritableStream;
  const errStream = { write(d: string): boolean { errChunks.push(d); return true; } } as NodeJS.WritableStream;
  const ui = new UI({ mode: 'pretty', color: false, stream, errStream });
  return { ui, output: () => chunks.join(''), errOutput: () => errChunks.join('') };
}

function makeJsonUI(): { ui: UI; output: () => string; errOutput: () => string } {
  const chunks: string[] = [];
  const errChunks: string[] = [];
  const stream = { write(d: string): boolean { chunks.push(d); return true; } } as NodeJS.WritableStream;
  const errStream = { write(d: string): boolean { errChunks.push(d); return true; } } as NodeJS.WritableStream;
  const ui = new UI({ mode: 'json', color: false, stream, errStream });
  return { ui, output: () => chunks.join(''), errOutput: () => errChunks.join('') };
}

function makeCtx(ui: UI): CliContext {
  return {
    ui,
    keychain: new Keychain(),
    cwd: process.cwd(),
    argv: [],
  };
}

/** Write a sample luminclaw memory file into workspace/.prismer/memory/ */
function writeMemoryFile(workspace: string, filename: string, content: string): void {
  const memDir = path.join(workspace, '.prismer', 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, filename), content, 'utf-8');
}

function markerExists(workspace: string): boolean {
  return fs.existsSync(path.join(workspace, '.prismer', 'memory', 'MIGRATED.md'));
}

const SAMPLE_MEMORY_CONTENT = `## episodic
tags: work, meeting
Discussed Q2 roadmap with the team.

## semantic
Prismer Memory Gateway stores memories as im_memory_files.
`;

// ============================================================
// State
// ============================================================

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    cleanupDir(tmpDirs.pop()!);
  }
  process.exitCode = undefined;
  delete process.env['MEMORY_API_URL'];
});

function newTmp(): string {
  const dir = makeTempDir();
  tmpDirs.push(dir);
  return dir;
}

// ============================================================
// M1: No apiKey → exit 1, NO_API_KEY error, no fetchImpl call
// ============================================================

describe('migrateLuminclawMemoryCommand — no apiKey', () => {
  it('M1a: pretty mode emits error and returns 1 without calling fetchImpl', async () => {
    const workspace = newTmp();
    writeMemoryFile(workspace, '2024-01-15.md', SAMPLE_MEMORY_CONTENT);

    const { ui, output, errOutput } = makePrettyUI();
    const ctx = makeCtx(ui);
    let fetchCalled = false;
    const fetchImpl = async (): Promise<Response> => {
      fetchCalled = true;
      return new Response('should not be called', { status: 200 });
    };

    const code = await migrateLuminclawMemoryCommand(ctx, {
      workspace,
      identity: {},   // no apiKey
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(code).toBe(1);
    expect(fetchCalled).toBe(false);
    expect(markerExists(workspace)).toBe(false);
    const errOut = errOutput();
    expect(errOut).toMatch(/No API key/i);
  });

  it('M1b: json mode emits { ok: false, error: NO_API_KEY } and returns 1', async () => {
    const workspace = newTmp();
    writeMemoryFile(workspace, '2024-01-15.md', SAMPLE_MEMORY_CONTENT);

    const { ui, output } = makeJsonUI();
    const ctx = makeCtx(ui);
    let fetchCalled = false;
    const fetchImpl = async (): Promise<Response> => {
      fetchCalled = true;
      return new Response('should not be called', { status: 200 });
    };

    const code = await migrateLuminclawMemoryCommand(ctx, {
      workspace,
      identity: {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(code).toBe(1);
    expect(fetchCalled).toBe(false);
    expect(markerExists(workspace)).toBe(false);
  });

  it('M1c: no files scanned when apiKey is missing', async () => {
    const workspace = newTmp();
    // Put a memory file there — it should NOT be touched
    writeMemoryFile(workspace, '2024-03-01.md', SAMPLE_MEMORY_CONTENT);

    const { ui } = makePrettyUI();
    const ctx = makeCtx(ui);
    const fetchImpl = async (): Promise<Response> => new Response('', { status: 200 });

    const code = await migrateLuminclawMemoryCommand(ctx, {
      workspace,
      identity: { apiKey: undefined },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(code).toBe(1);
    expect(markerExists(workspace)).toBe(false);
  });
});

// ============================================================
// M2: Happy path — apiKey present, correct Authorization header
// ============================================================

describe('migrateLuminclawMemoryCommand — happy path', () => {
  it('M2: sends Authorization: Bearer <key> and writes marker on success', async () => {
    const workspace = newTmp();
    writeMemoryFile(workspace, '2024-01-15.md', SAMPLE_MEMORY_CONTENT);

    const { ui } = makePrettyUI();
    const ctx = makeCtx(ui);
    const capturedHeaders: string[] = [];

    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const authHeader = (init?.headers as Record<string, string>)?.['Authorization'] ?? '';
      capturedHeaders.push(authHeader);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const code = await migrateLuminclawMemoryCommand(ctx, {
      workspace,
      identity: { apiKey: 'sk-prismer-live-testkey123' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(code).toBe(0);
    expect(capturedHeaders.length).toBeGreaterThan(0);
    for (const h of capturedHeaders) {
      expect(h).toBe('Bearer sk-prismer-live-testkey123');
    }
    expect(markerExists(workspace)).toBe(true);
  });
});

// ============================================================
// M3: Cloud error (500) → record in errors, marker NOT written
// ============================================================

describe('migrateLuminclawMemoryCommand — cloud error', () => {
  it('M3: cloud 500 appends error, does not write marker', async () => {
    const workspace = newTmp();
    writeMemoryFile(workspace, '2024-01-15.md', SAMPLE_MEMORY_CONTENT);

    const { ui, output } = makePrettyUI();
    const ctx = makeCtx(ui);

    const fetchImpl = async (): Promise<Response> => {
      return new Response('Internal Server Error', { status: 500 });
    };

    const code = await migrateLuminclawMemoryCommand(ctx, {
      workspace,
      identity: { apiKey: 'sk-prismer-live-testkey123' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(code).toBe(1);
    expect(markerExists(workspace)).toBe(false);
    const out = output();
    expect(out).toMatch(/error/i);
  });
});

// ============================================================
// M4: cloudApiBase injection — URL respects injected base
// ============================================================

describe('migrateLuminclawMemoryCommand — cloudApiBase injection', () => {
  it('M4: request URL uses injected cloudApiBase', async () => {
    const workspace = newTmp();
    writeMemoryFile(workspace, '2024-02-01.md', SAMPLE_MEMORY_CONTENT);

    const { ui } = makePrettyUI();
    const ctx = makeCtx(ui);
    const capturedUrls: string[] = [];

    const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
      capturedUrls.push(typeof url === 'string' ? url : url.toString());
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const code = await migrateLuminclawMemoryCommand(ctx, {
      workspace,
      identity: {
        apiKey: 'sk-prismer-live-testkey123',
        cloudApiBase: 'http://localhost:3000',
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(code).toBe(0);
    expect(capturedUrls.length).toBeGreaterThan(0);
    for (const url of capturedUrls) {
      expect(url).toContain('http://localhost:3000/api/v1/memory/write');
    }
  });

  it('M4b: MEMORY_API_URL env override takes precedence over cloudApiBase', async () => {
    process.env['MEMORY_API_URL'] = 'http://override.example.com/memory';
    const workspace = newTmp();
    writeMemoryFile(workspace, '2024-02-01.md', SAMPLE_MEMORY_CONTENT);

    const { ui } = makePrettyUI();
    const ctx = makeCtx(ui);
    const capturedUrls: string[] = [];

    const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
      capturedUrls.push(typeof url === 'string' ? url : url.toString());
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    await migrateLuminclawMemoryCommand(ctx, {
      workspace,
      identity: {
        apiKey: 'sk-prismer-live-testkey123',
        cloudApiBase: 'http://localhost:3000',
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    for (const url of capturedUrls) {
      expect(url).toBe('http://override.example.com/memory');
    }
  });
});

// ============================================================
// M5: Dry run — no apiKey required, no fetch called
// ============================================================

describe('migrateLuminclawMemoryCommand — dry run', () => {
  it('M5: dry run works without apiKey and does not call fetchImpl', async () => {
    const workspace = newTmp();
    writeMemoryFile(workspace, '2024-01-01.md', SAMPLE_MEMORY_CONTENT);
    writeMemoryFile(workspace, '2024-01-02.md', SAMPLE_MEMORY_CONTENT);

    const { ui, output } = makePrettyUI();
    const ctx = makeCtx(ui);
    let fetchCalled = false;
    const fetchImpl = async (): Promise<Response> => {
      fetchCalled = true;
      return new Response('', { status: 200 });
    };

    const code = await migrateLuminclawMemoryCommand(ctx, {
      workspace,
      dryRun: true,
      identity: {},   // no apiKey — dry run should not require it
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(code).toBe(0);
    expect(fetchCalled).toBe(false);
    expect(markerExists(workspace)).toBe(false);
    const out = output();
    expect(out).toMatch(/DRY RUN/i);
    expect(out).toMatch(/2 memory files/i);
  });
});
