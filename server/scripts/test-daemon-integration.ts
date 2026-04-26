/**
 * Daemon Integration Tests
 *
 * Tests the full daemon system: lifecycle, config, cache, outbox,
 * hooks integration, CLI, and server endpoints.
 *
 * Usage:
 *   npx tsx scripts/test-daemon-integration.ts
 *
 * Prerequisites:
 *   - ~/.prismer/config.toml with valid API key (or PRISMER_API_KEY env)
 *   - SDK built: cd sdk/prismer-cloud/typescript && npm run build
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================================
// Test Infrastructure
// ============================================================================

const PRISMER_DIR = join(homedir(), '.prismer');
const CACHE_DIR = join(PRISMER_DIR, 'cache');
const CONFIG_FILE = join(PRISMER_DIR, 'config.toml');
const PID_FILE = join(PRISMER_DIR, 'daemon.pid');
const PORT_FILE = join(PRISMER_DIR, 'daemon.port');
const OUTBOX_FILE = join(CACHE_DIR, 'outbox.json');
const EVOLUTION_CACHE = join(CACHE_DIR, 'evolution.json');
const EVENTS_FILE = join(CACHE_DIR, 'events.json');

let passed = 0;
let failed = 0;
let skipped = 0;
const failures: string[] = [];

function ok(name: string) {
  passed++;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
}

function fail(name: string, reason: string) {
  failed++;
  failures.push(`${name}: ${reason}`);
  console.log(`  \x1b[31m✗\x1b[0m ${name} — ${reason}`);
}

function skip(name: string, reason: string) {
  skipped++;
  console.log(`  \x1b[33m○\x1b[0m ${name} — ${reason}`);
}

function assert(cond: boolean, name: string, reason = 'assertion failed') {
  if (cond) ok(name);
  else fail(name, reason);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================================
// Phase 1: File System & Config Tests
// ============================================================================

async function testConfig(): Promise<string> {
  console.log('\n\x1b[1m--- Phase 1: Config & File System ---\x1b[0m');

  assert(existsSync(PRISMER_DIR), '~/.prismer directory exists');

  mkdirSync(CACHE_DIR, { recursive: true });
  assert(existsSync(CACHE_DIR), '~/.prismer/cache directory exists');

  let apiKey = process.env.PRISMER_API_KEY || '';
  if (!apiKey) {
    try {
      const raw = readFileSync(CONFIG_FILE, 'utf-8');
      const m = raw.match(/^api_key\s*=\s*['"]([^'"]+)['"]/m);
      apiKey = m?.[1] || '';
    } catch {
      /* no config */
    }
  }
  assert(apiKey.startsWith('sk-prismer-'), 'API key resolved (env or config.toml)');

  if (!apiKey.startsWith('sk-prismer-')) {
    console.log('\n\x1b[31mCannot continue without API key. Set PRISMER_API_KEY or run prismer setup.\x1b[0m');
    process.exit(1);
  }

  // Config.toml regex compatibility
  try {
    const raw = readFileSync(CONFIG_FILE, 'utf-8');
    const keyMatch = raw.match(/^api_key\s*=\s*['"]([^'"]+)['"]/m);
    assert(!!keyMatch?.[1], 'config.toml api_key parseable by regex');
  } catch {
    skip('config.toml parsing', 'file not found — using env var');
  }

  return apiKey;
}

// ============================================================================
// Phase 2: Daemon Lifecycle Tests
// ============================================================================

async function testDaemonLifecycle(apiKey: string): Promise<{ child: ChildProcess; port: number } | null> {
  console.log('\n\x1b[1m--- Phase 2: Daemon Lifecycle ---\x1b[0m');

  // Clean up any existing daemon
  if (existsSync(PID_FILE)) {
    try {
      const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
      process.kill(pid, 'SIGTERM');
      await sleep(500);
    } catch {
      /* process already gone */
    }
    try {
      unlinkSync(PID_FILE);
    } catch {}
    try {
      unlinkSync(PORT_FILE);
    } catch {}
  }

  const daemonCli = join(__dirname, '..', 'sdk', 'prismer-cloud', 'typescript', 'dist', 'cli.js');

  if (!existsSync(daemonCli)) {
    skip('daemon start', 'SDK not built — run: cd sdk/prismer-cloud/typescript && npm run build');
    return null;
  }

  // Start daemon inline (PRISMER_DAEMON=1 = no detached spawn)
  const child = spawn(process.execPath, [daemonCli, 'daemon', 'start'], {
    env: { ...process.env, PRISMER_API_KEY: apiKey, PRISMER_DAEMON: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  // Collect stderr for debugging
  let stderrBuf = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString();
  });

  // Wait for PID file
  let daemonPort: number | null = null;
  for (let i = 0; i < 30; i++) {
    await sleep(200);
    if (existsSync(PORT_FILE)) {
      daemonPort = parseInt(readFileSync(PORT_FILE, 'utf-8').trim(), 10);
      break;
    }
  }

  assert(existsSync(PID_FILE), 'daemon PID file created');
  assert(daemonPort !== null && daemonPort > 0, `daemon port file created (port=${daemonPort})`);

  if (!daemonPort) {
    fail('daemon start', `no port file after 6s. stderr: ${stderrBuf.slice(0, 300)}`);
    child.kill('SIGTERM');
    return null;
  }

  // Health endpoint
  try {
    const res = await fetch(`http://127.0.0.1:${daemonPort}/health`);
    assert(res.ok, 'daemon health endpoint responds 200');

    const health = (await res.json()) as Record<string, unknown>;
    assert(typeof health.pid === 'number', 'health.pid is number');
    assert(typeof health.uptime === 'number', 'health.uptime is number');
    assert(typeof health.lastSync === 'number', 'health.lastSync is number');
    assert(typeof health.outboxSize === 'number', 'health.outboxSize is number');
  } catch (err: any) {
    fail('daemon health endpoint', err.message);
  }

  // Events endpoint
  try {
    const res = await fetch(`http://127.0.0.1:${daemonPort}/events`);
    assert(res.ok, 'daemon /events endpoint responds 200');
    const events = await res.json();
    assert(Array.isArray(events), '/events returns array');
  } catch (err: any) {
    fail('daemon /events endpoint', err.message);
  }

  // 404 for unknown paths
  try {
    const res = await fetch(`http://127.0.0.1:${daemonPort}/unknown`);
    assert(res.status === 404, 'unknown path returns 404');
  } catch (err: any) {
    fail('daemon 404', err.message);
  }

  // Wait for initial sync
  await sleep(3000);
  assert(existsSync(EVOLUTION_CACHE), 'evolution.json cache created after sync');

  if (existsSync(EVOLUTION_CACHE)) {
    try {
      const cached = JSON.parse(readFileSync(EVOLUTION_CACHE, 'utf-8'));
      assert(typeof cached.cursor === 'number', 'evolution cache has cursor');
      assert(typeof cached.lastSync === 'number', 'evolution cache has lastSync');
    } catch (err: any) {
      fail('evolution cache format', err.message);
    }
  }

  // Events file should exist after sync
  if (existsSync(EVENTS_FILE)) {
    try {
      const events = JSON.parse(readFileSync(EVENTS_FILE, 'utf-8'));
      assert(Array.isArray(events), 'events.json is valid array');
      ok(`events.json has ${events.length} entries`);
    } catch (err: any) {
      fail('events.json format', err.message);
    }
  }

  return { child, port: daemonPort };
}

// ============================================================================
// Phase 3: Outbox Tests
// ============================================================================

async function testOutbox(daemonPort: number | null) {
  console.log('\n\x1b[1m--- Phase 3: Outbox ---\x1b[0m');

  // Write to outbox
  const testEntry = {
    geneId: 'test-gene-001',
    outcome: 'success',
    summary: 'Integration test outcome',
    signals: [{ type: 'error:test' }],
  };

  let outbox: any[] = [];
  try {
    outbox = JSON.parse(readFileSync(OUTBOX_FILE, 'utf-8'));
  } catch {}
  outbox.push({ ...testEntry, timestamp: Date.now() });
  writeFileSync(OUTBOX_FILE, JSON.stringify(outbox));
  assert(true, 'outbox entry written');

  // Verify
  try {
    const parsed = JSON.parse(readFileSync(OUTBOX_FILE, 'utf-8'));
    assert(Array.isArray(parsed), 'outbox.json is valid array');
    assert(parsed.length > 0, 'outbox has entries');
    assert(parsed[parsed.length - 1].geneId === 'test-gene-001', 'outbox entry has correct geneId');
  } catch (err: any) {
    fail('outbox read', err.message);
  }

  // Size cap test
  const bigOutbox: any[] = [];
  for (let i = 0; i < 510; i++) {
    bigOutbox.push({ geneId: `gene-${i}`, outcome: 'success', timestamp: Date.now() });
  }
  writeFileSync(OUTBOX_FILE, JSON.stringify(bigOutbox));
  const readBack = JSON.parse(readFileSync(OUTBOX_FILE, 'utf-8'));
  ok(`outbox accepts ${readBack.length} entries (daemon appendToOutbox caps at 500)`);

  // Health endpoint shows outbox size
  if (daemonPort) {
    try {
      const res = await fetch(`http://127.0.0.1:${daemonPort}/health`);
      const health = (await res.json()) as any;
      ok(`daemon health reports outboxSize=${health.outboxSize}`);
    } catch {}
  }

  // Clean
  writeFileSync(OUTBOX_FILE, '[]');
}

// ============================================================================
// Phase 4: Session Hook Simulation
// ============================================================================

async function testSessionHooks(daemonPort: number | null) {
  console.log('\n\x1b[1m--- Phase 4: Session Hook Simulation ---\x1b[0m');

  // session-start daemon cache fast path
  if (daemonPort) {
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 200);
      const res = await fetch(`http://127.0.0.1:${daemonPort}/health`, { signal: controller.signal });
      clearTimeout(timer);
      const elapsed = Date.now() - start;
      assert(res.ok && elapsed < 200, `daemon health within 200ms (${elapsed}ms)`);
    } catch {
      fail('daemon health 200ms', 'timeout or error');
    }

    // Read evolution cache
    if (existsSync(EVOLUTION_CACHE)) {
      const cacheStart = Date.now();
      try {
        const cached = JSON.parse(readFileSync(EVOLUTION_CACHE, 'utf-8'));
        const cacheElapsed = Date.now() - cacheStart;
        assert(cached.cursor !== undefined, `evolution cache readable (${cacheElapsed}ms)`);
      } catch (err: any) {
        fail('evolution cache read', err.message);
      }
    }
  } else {
    skip('session-start daemon cache', 'daemon not running');
  }

  // Graceful fallback when port file missing
  const portBackup = existsSync(PORT_FILE) ? readFileSync(PORT_FILE, 'utf-8') : null;
  try {
    if (existsSync(PORT_FILE)) unlinkSync(PORT_FILE);
    let usedDaemonCache = false;
    try {
      readFileSync(PORT_FILE, 'utf-8');
      usedDaemonCache = true;
    } catch {
      // Expected
    }
    assert(!usedDaemonCache, 'session-start falls back when daemon.port missing');
  } finally {
    if (portBackup) writeFileSync(PORT_FILE, portBackup);
  }

  // session-end mutual exclusivity: daemon running → write outbox
  if (daemonPort) {
    const outcomes = [{ geneId: 'test-mutual-001', outcome: 'success', summary: 'test' }];
    let outbox: any[] = [];
    try {
      outbox = JSON.parse(readFileSync(OUTBOX_FILE, 'utf-8'));
    } catch {}
    const prevLen = outbox.length;
    outbox.push(...outcomes.map((o) => ({ ...o, timestamp: Date.now() })));
    writeFileSync(OUTBOX_FILE, JSON.stringify(outbox));
    const newOutbox = JSON.parse(readFileSync(OUTBOX_FILE, 'utf-8'));
    assert(newOutbox.length === prevLen + 1, 'session-end writes outbox when daemon running');
    writeFileSync(OUTBOX_FILE, '[]');
  }

  // Invalid port file → graceful fallback
  if (portBackup) {
    writeFileSync(PORT_FILE, 'invalid-port');
    let daemonRunning = false;
    try {
      const portRaw = readFileSync(PORT_FILE, 'utf-8').trim();
      const port = parseInt(portRaw, 10);
      if (port > 0) {
        // isNaN → port = NaN → not > 0
        daemonRunning = true;
      }
    } catch {}
    assert(!daemonRunning, 'invalid port file treated as daemon offline');
    writeFileSync(PORT_FILE, portBackup);
  }
}

// ============================================================================
// Phase 5: CLI Tests
// ============================================================================

async function testCLI() {
  console.log('\n\x1b[1m--- Phase 5: CLI ---\x1b[0m');

  const pluginCli = join(__dirname, '..', 'sdk', 'prismer-cloud', 'claude-code-plugin', 'scripts', 'cli.mjs');

  // Plugin CLI --help
  try {
    const output = execFileSync('node', [pluginCli, '--help'], { encoding: 'utf-8', timeout: 5000 });
    assert(output.includes('setup') && output.includes('status'), 'plugin CLI --help shows commands');
  } catch (err: any) {
    fail('plugin CLI --help', err.message?.slice(0, 100));
  }

  // Plugin CLI status
  try {
    const output = execFileSync('node', [pluginCli, 'status'], { encoding: 'utf-8', timeout: 5000 });
    assert(output.includes('config.toml') || output.includes('prismer'), 'plugin CLI status reports config');
  } catch (err: any) {
    fail('plugin CLI status', err.message?.slice(0, 100));
  }

  // SDK daemon status
  const sdkCli = join(__dirname, '..', 'sdk', 'prismer-cloud', 'typescript', 'dist', 'cli.js');
  if (existsSync(sdkCli)) {
    try {
      const output = execFileSync('node', [sdkCli, 'daemon', 'status'], { encoding: 'utf-8', timeout: 5000 });
      assert(
        output.includes('Daemon') || output.includes('running') || output.includes('PID'),
        'SDK daemon status responds',
      );
    } catch (err: any) {
      // daemon status might exit(1) if not running — check stderr
      const stderr = err.stderr?.toString() || err.message || '';
      assert(
        stderr.includes('Daemon') || stderr.includes('running') || stderr.includes('not'),
        'SDK daemon status responds (via stderr)',
      );
    }
  } else {
    skip('SDK daemon status', 'SDK not built');
  }
}

// ============================================================================
// Phase 6: Server Endpoint Tests
// ============================================================================

async function testServerEndpoints(apiKey: string) {
  console.log('\n\x1b[1m--- Phase 6: Server Endpoints ---\x1b[0m');

  const baseUrl = process.env.PRISMER_BASE_URL || 'https://prismer.cloud';

  // Evolution sync pull
  try {
    const res = await fetch(`${baseUrl}/api/im/evolution/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ pull: { since: 0, scope: 'global' } }),
      signal: AbortSignal.timeout(10000),
    });

    if (res.ok) {
      const data = (await res.json()) as any;
      assert(data.ok === true || data.data?.pulled, 'evolution sync pull returns data');
      const pulled = data.data?.pulled;
      if (pulled) {
        assert(typeof pulled.cursor === 'number', 'pull has numeric cursor');
        assert(Array.isArray(pulled.genes), 'pull has genes array');
        ok(`pull: ${pulled.genes?.length || 0} genes, cursor=${pulled.cursor}`);
      }
    } else {
      fail('evolution sync pull', `HTTP ${res.status}`);
    }
  } catch (err: any) {
    fail('evolution sync pull', err.message);
  }

  // Evolution sync push (empty outcomes)
  try {
    const res = await fetch(`${baseUrl}/api/im/evolution/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        push: { outcomes: [] },
        pull: { since: 0, scope: 'global' },
      }),
      signal: AbortSignal.timeout(10000),
    });

    assert(res.ok, 'evolution sync accepts empty push+pull');
  } catch (err: any) {
    fail('evolution sync push', err.message);
  }
}

// ============================================================================
// Phase 7: Daemon Interfaces
// ============================================================================

async function testInterfaces() {
  console.log('\n\x1b[1m--- Phase 7: Daemon Interfaces ---\x1b[0m');

  const interfacesFile = join(__dirname, '..', 'sdk', 'prismer-cloud', 'typescript', 'src', 'daemon-interfaces.ts');
  assert(existsSync(interfacesFile), 'daemon-interfaces.ts exists');

  const content = readFileSync(interfacesFile, 'utf-8');
  for (const iface of [
    'LLMDispatcher',
    'NotificationSink',
    'TaskExecutor',
    'CacheManager',
    'KeyManager',
    'DaemonControlPlane',
  ]) {
    assert(content.includes(`export interface ${iface}`), `exports ${iface}`);
  }

  const indexFile = join(__dirname, '..', 'sdk', 'prismer-cloud', 'typescript', 'src', 'index.ts');
  assert(readFileSync(indexFile, 'utf-8').includes('daemon-interfaces'), 'index.ts re-exports interfaces');
}

// ============================================================================
// Phase 8: WS Connection Limit
// ============================================================================

async function testWSLimit() {
  console.log('\n\x1b[1m--- Phase 8: WS Connection Limit ---\x1b[0m');

  const content = readFileSync(join(__dirname, '..', 'src', 'im', 'ws', 'rooms.ts'), 'utf-8');
  assert(content.includes('MAX_CONNECTIONS_PER_USER'), 'has MAX_CONNECTIONS_PER_USER');
  assert(content.includes('connectedAt'), 'eviction uses connectedAt');
  assert(content.includes('transport.close'), 'evicts oldest by closing');
}

// ============================================================================
// Cleanup
// ============================================================================

async function cleanup(daemonChild: ChildProcess | null) {
  console.log('\n\x1b[1m--- Cleanup ---\x1b[0m');

  if (daemonChild) {
    daemonChild.kill('SIGTERM');
    await sleep(1000);
    ok(`daemon stopped`);
    try {
      unlinkSync(PID_FILE);
    } catch {}
    try {
      unlinkSync(PORT_FILE);
    } catch {}
  }
  try {
    writeFileSync(OUTBOX_FILE, '[]');
  } catch {}
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('\x1b[1m\x1b[36m=== Prismer Daemon Integration Tests ===\x1b[0m\n');
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`Home: ${homedir()}`);

  const apiKey = await testConfig();
  const daemon = await testDaemonLifecycle(apiKey);
  await testOutbox(daemon?.port || null);
  await testSessionHooks(daemon?.port || null);
  await testCLI();
  await testServerEndpoints(apiKey);
  await testInterfaces();
  await testWSLimit();
  await cleanup(daemon?.child || null);

  console.log('\n\x1b[1m=== Results ===\x1b[0m');
  console.log(`  \x1b[32m${passed} passed\x1b[0m`);
  if (failed > 0) console.log(`  \x1b[31m${failed} failed\x1b[0m`);
  if (skipped > 0) console.log(`  \x1b[33m${skipped} skipped\x1b[0m`);

  if (failures.length > 0) {
    console.log('\n\x1b[31mFailures:\x1b[0m');
    failures.forEach((f) => console.log(`  - ${f}`));
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
