import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { MemoryDB } from '../src/memory-db.js';
import QRCode from 'qrcode';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'perf-test-'));
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort
  }
}

/**
 * Calculate p95 from an array of numeric durations.
 * Sorts ascending and returns the element at the 95th percentile index.
 */
function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.floor(0.95 * sorted.length);
  return sorted[Math.min(idx, sorted.length - 1)];
}

/**
 * Generate lorem-like filler content of variable length.
 */
function loremContent(index: number): string {
  const words = [
    'prismer', 'evolution', 'agent', 'memory', 'context', 'knowledge',
    'daemon', 'runtime', 'signal', 'gene', 'capsule', 'hypergraph',
    'relay', 'pairing', 'sandbox', 'credential', 'identity', 'session',
    'benchmark', 'leaderboard', 'community', 'skill', 'task', 'binding',
  ];
  const lines: string[] = [];
  // Generate 5-15 lines of content per file to simulate realistic memory files
  const lineCount = 5 + (index % 11);
  for (let l = 0; l < lineCount; l++) {
    const wordCount = 8 + (index + l) % 7;
    const line = Array.from({ length: wordCount }, (_, w) =>
      words[(index * 7 + l * 3 + w) % words.length],
    ).join(' ');
    lines.push(line);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Performance smoke tests
// ---------------------------------------------------------------------------

describe('Performance smoke tests', () => {
  const tempDirs: string[] = [];

  afterAll(() => {
    for (const dir of tempDirs) {
      cleanupDir(dir);
    }
  });

  // -----------------------------------------------------------------------
  // 1. Memory recall performance
  // -----------------------------------------------------------------------
  describe('Memory recall performance', () => {
    let db: MemoryDB;

    beforeAll(() => {
      const tmpDir = makeTempDir();
      tempDirs.push(tmpDir);
      const storePath = path.join(tmpDir, 'memory.db');

      db = new MemoryDB({ enabled: false }, { filePath: storePath });

      // Seed 1000 memory files
      for (let i = 0; i < 1000; i++) {
        db.writeMemoryFile({
          ownerId: `owner-${i % 10}`,
          ownerType: 'agent',
          scope: `scope-${i % 5}`,
          path: `docs/file-${i}.md`,
          content: loremContent(i),
          memoryType: i % 3 === 0 ? 'note' : 'reference',
          description: `Memory file number ${i} about ${i % 2 === 0 ? 'evolution' : 'context'}`,
        });
      }
    }, 30_000);

    it('should search 1000 files in < 50ms p95', () => {
      const searchTerms = [
        'evolution', 'agent', 'memory', 'context', 'knowledge',
        'daemon', 'runtime', 'signal', 'gene', 'capsule',
        'hypergraph', 'relay', 'pairing', 'sandbox', 'credential',
        'identity', 'session', 'benchmark', 'leaderboard', 'community',
      ];

      const durations: number[] = [];

      for (let i = 0; i < 20; i++) {
        const keyword = searchTerms[i % searchTerms.length];
        const start = performance.now();
        db.searchMemoryFiles(keyword, { limit: 20 });
        const elapsed = performance.now() - start;
        durations.push(elapsed);
      }

      const p95Value = p95(durations);
      const avg = durations.reduce((s, v) => s + v, 0) / durations.length;

      console.log(
        `[Performance] Memory recall: p95=${p95Value.toFixed(2)}ms, avg=${avg.toFixed(2)}ms, ` +
        `min=${Math.min(...durations).toFixed(2)}ms, max=${Math.max(...durations).toFixed(2)}ms`,
      );

      expect(p95Value).toBeLessThan(50);
    });
  });

  // -----------------------------------------------------------------------
  // 2. QR generation performance
  // -----------------------------------------------------------------------
  describe('QR generation performance', () => {
    it('should generate QR code in < 1000ms', async () => {
      const uri = `prismer://pair?offer=${crypto.randomUUID()}&relay=wss://cloud.prismer.dev`;

      const start = performance.now();
      const qr = await QRCode.toString(uri, { type: 'terminal', small: true });
      const elapsed = performance.now() - start;

      console.log(
        `[Performance] QR generation: ${elapsed.toFixed(2)}ms (${qr.length} chars)`,
      );

      expect(qr.length).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(1000);
    });
  });

  // -----------------------------------------------------------------------
  // 3. MemoryDB cold start
  // -----------------------------------------------------------------------
  describe('MemoryDB cold start', () => {
    it('should initialize with 1000 files in < 2s', () => {
      const tmpDir = makeTempDir();
      tempDirs.push(tmpDir);
      const storePath = path.join(tmpDir, 'memory-cold.db');

      // Pre-build a SQLite DB with 1000 files on disk
      const seedDb = new MemoryDB({ enabled: false }, { filePath: storePath });
      for (let i = 0; i < 1000; i++) {
        seedDb.writeMemoryFile({
          ownerId: `owner-${i % 10}`,
          ownerType: 'agent',
          scope: `scope-${i % 5}`,
          path: `docs/file-${i}.md`,
          content: loremContent(i),
          memoryType: i % 3 === 0 ? 'note' : 'reference',
          description: `Memory file number ${i}`,
        });
      }
      seedDb.close();

      // Measure cold start: constructor opens existing SQLite DB + schema check
      const start = performance.now();
      const db = new MemoryDB({ enabled: false }, { filePath: storePath });
      const elapsed = performance.now() - start;

      console.log(
        `[Performance] MemoryDB cold start (1000 files): ${elapsed.toFixed(2)}ms`,
      );

      // Sanity: the DB loaded all files
      const stats = db.getStats();
      expect(stats.fileCount).toBe(1000);

      expect(elapsed).toBeLessThan(2000);

      db.close();
    }, 30_000);
  });
});
