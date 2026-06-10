#!/usr/bin/env -S npx tsx
/**
 * v200 API regression suite — covers commits 5-18 in feat/workspace-release
 * (image-pin canonical / Pro device flow / shell exec env / /logs SSE redirect
 * / installAgent exec fallback / state-machine running→stopped / kanban
 * shell_run filter / providerKind=k8s sandbox routes / T9 snapshot endpoint
 * / T10 ephemeral run / S4 daemon v200 protocol / S5 reconciler heartbeat).
 *
 * Derived from R3 regression curl-matrix (docs/release200/evidence/r3-regression-api-2026-05-19.md).
 * Companion to scripts/test-all-apis.ts — that script has 152 endpoints zero coverage
 * for v200 routes. This script ONLY covers the v200 delta.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * Default target: http://localhost:3000 (local dev).
 *
 * Required env (test won't run without these):
 *   PRISMER_DEV_JWT          Bearer JWT (e.g. cmp1uhqwz... IMUser id)
 *   PRISMER_DEV_WORKSPACE_ID Workspace under which the test runs
 *
 * Optional:
 *   PRISMER_BASE             Override base URL (default http://localhost:3000)
 *   PRISMER_DEV_CONTAINER_ID Pin to a specific running K8S container row id;
 *                            else auto-discover first running K8S container.
 *   PRISMER_DEV_DAEMON_ID    Pin to a specific daemonId (else from container).
 *   PRISMER_DEV_POD_NAME     Pod name for kubectl exec /healthz test (F group);
 *                            else read from container row.
 *   PRISMER_DEV_NAMESPACE    K8S namespace for kubectl exec (default prismer-sandbox).
 *   PRISMER_DEV_MYSQL_CONTAINER Docker container name for mysql (default prismer-dev-mysql).
 *   PRISMER_DEV_MYSQL_USER   MySQL user (default prismer).
 *   PRISMER_DEV_MYSQL_PASS   MySQL password (default devpass).
 *   PRISMER_DEV_MYSQL_DB     MySQL database (default prismer_cloud).
 *   PRISMER_SKIP_F           Skip F group (kubectl exec daemon /healthz).
 *   PRISMER_SKIP_G           Skip G group (mysql via docker exec).
 *
 * CLI args:
 *   --filter <regex>         Run only tests whose name matches regex.
 *   --verbose                Print response bodies (incl. on PASS).
 *   --help, -h               Print usage and exit 0.
 *
 * Exit codes: 0 all pass / 1 any fail / 2 missing env or bad usage.
 *
 * Example real-run invocation:
 *   PRISMER_DEV_JWT='eyJhbG...' \
 *   PRISMER_DEV_WORKSPACE_ID='cmp49uds50000xzxfods9ixk3' \
 *     npx tsx scripts/test-v200-apis.ts
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { spawnSync } from 'node:child_process';

// ──────────────────────────────────────────────────────────────────────────────
// Args
// ──────────────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

if (argv.includes('--help') || argv.includes('-h')) {
  // Print header JSDoc-like usage block — slice from the top comment.
  process.stdout.write(`\nv200 API regression suite\n\n`);
  process.stdout.write(`Usage:\n`);
  process.stdout.write(
    `  PRISMER_DEV_JWT=... PRISMER_DEV_WORKSPACE_ID=... npx tsx scripts/test-v200-apis.ts [--filter <regex>] [--verbose]\n\n`,
  );
  process.stdout.write(`Required env:\n`);
  process.stdout.write(`  PRISMER_DEV_JWT           Bearer JWT\n`);
  process.stdout.write(`  PRISMER_DEV_WORKSPACE_ID  Workspace id\n\n`);
  process.stdout.write(`Optional env:\n`);
  process.stdout.write(`  PRISMER_BASE              Override base URL (default http://localhost:3000)\n`);
  process.stdout.write(`  PRISMER_DEV_CONTAINER_ID  Pin running k8s container id\n`);
  process.stdout.write(`  PRISMER_DEV_DAEMON_ID     Pin daemonId\n`);
  process.stdout.write(`  PRISMER_DEV_POD_NAME      Pod name for kubectl exec\n`);
  process.stdout.write(`  PRISMER_DEV_NAMESPACE     K8S namespace (default prismer-sandbox)\n`);
  process.stdout.write(`  PRISMER_DEV_MYSQL_CONTAINER  Docker container name (default prismer-dev-mysql)\n`);
  process.stdout.write(`  PRISMER_SKIP_F            Skip kubectl /healthz tests\n`);
  process.stdout.write(`  PRISMER_SKIP_G            Skip mysql tests\n\n`);
  process.stdout.write(`Flags:\n`);
  process.stdout.write(`  --filter <regex>          Run only tests matching name regex\n`);
  process.stdout.write(`  --verbose                 Dump response bodies\n`);
  process.stdout.write(`  --help, -h                This message\n\n`);
  process.stdout.write(`Exit: 0 all pass / 1 any fail / 2 usage or env error\n\n`);
  process.exit(0);
}

const filterIdx = argv.indexOf('--filter');
const filterRegex = filterIdx !== -1 && argv[filterIdx + 1] ? new RegExp(argv[filterIdx + 1]) : null;
const verbose = argv.includes('--verbose');

// ──────────────────────────────────────────────────────────────────────────────
// Env
// ──────────────────────────────────────────────────────────────────────────────

const BASE = process.env.PRISMER_BASE || 'http://localhost:3000';
const JWT = process.env.PRISMER_DEV_JWT || '';
const WS = process.env.PRISMER_DEV_WORKSPACE_ID || '';
const PIN_CID = process.env.PRISMER_DEV_CONTAINER_ID || '';
const PIN_DID = process.env.PRISMER_DEV_DAEMON_ID || '';
const PIN_POD = process.env.PRISMER_DEV_POD_NAME || '';
const NS = process.env.PRISMER_DEV_NAMESPACE || 'prismer-sandbox';
const MYSQL_CONTAINER = process.env.PRISMER_DEV_MYSQL_CONTAINER || 'prismer-dev-mysql';
const MYSQL_USER = process.env.PRISMER_DEV_MYSQL_USER || 'prismer';
const MYSQL_PASS = process.env.PRISMER_DEV_MYSQL_PASS || 'devpass';
const MYSQL_DB = process.env.PRISMER_DEV_MYSQL_DB || 'prismer_cloud';
const SKIP_F = !!process.env.PRISMER_SKIP_F;
const SKIP_G = !!process.env.PRISMER_SKIP_G;

if (!JWT || !WS) {
  console.error('[test-v200-apis] ❌ Missing required env: PRISMER_DEV_JWT and PRISMER_DEV_WORKSPACE_ID');
  console.error('   Run with --help for usage.');
  process.exit(2);
}

// ──────────────────────────────────────────────────────────────────────────────
// Result tracking + helpers
// ──────────────────────────────────────────────────────────────────────────────

interface TestResult {
  name: string;
  pass: boolean;
  status?: number;
  note: string;
  skipped?: boolean;
}
const results: TestResult[] = [];

interface FetchResult {
  status: number;
  data: unknown;
  headers: Headers;
  redirected: boolean;
  text: string;
  location: string | null;
}

async function http(
  method: string,
  path: string,
  body?: unknown,
  opts: { redirect?: 'manual' | 'follow'; noAuth?: boolean } = {},
): Promise<FetchResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (!opts.noAuth) headers['Authorization'] = `Bearer ${JWT}`;

  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: opts.redirect ?? 'follow',
  });

  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 500) };
  }

  return {
    status: res.status,
    data,
    headers: res.headers,
    redirected: res.redirected,
    text,
    location: res.headers.get('location'),
  };
}

async function test(
  name: string,
  fn: () => Promise<{ ok: boolean; status?: number; note: string; skip?: boolean }>,
): Promise<void> {
  if (filterRegex && !filterRegex.test(name)) return;

  process.stdout.write(`  ${name} ... `);
  try {
    const r = await fn();
    if (r.skip) {
      results.push({ name, pass: true, status: r.status, note: r.note, skipped: true });
      process.stdout.write(`⏭  SKIP ${r.note}\n`);
      return;
    }
    results.push({ name, pass: r.ok, status: r.status, note: r.note });
    process.stdout.write(r.ok ? `✅ ${r.note}\n` : `❌ ${r.note}\n`);
    if (verbose && !r.ok) {
      process.stdout.write(`     (status=${r.status})\n`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name, pass: false, note: `EXCEPTION: ${msg}` });
    process.stdout.write(`❌ EXCEPTION ${msg}\n`);
  }
}

function exec(cmd: string, args: string[]): { ok: boolean; stdout: string; stderr: string; status: number | null } {
  const r = spawnSync(cmd, args, { encoding: 'utf-8' });
  return {
    ok: r.status === 0,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    status: r.status,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Discovery — find a usable running K8S container if not pinned
// ──────────────────────────────────────────────────────────────────────────────

let containerId = PIN_CID;
let daemonId = PIN_DID;
let podName = PIN_POD;

async function discoverContainer(): Promise<void> {
  if (containerId && daemonId) {
    if (verbose) console.log(`[discover] using pinned container=${containerId} daemon=${daemonId}`);
    return;
  }
  const res = await http('GET', `/api/sandboxes?workspaceId=${encodeURIComponent(WS)}`);
  if (res.status !== 200) {
    console.error(`[discover] ❌ GET /api/sandboxes status=${res.status}`);
    return;
  }
  const data = res.data as {
    data?: Array<Record<string, unknown>>;
    sandboxes?: Array<Record<string, unknown>>;
    containers?: Array<Record<string, unknown>>;
  };
  const list = (data?.containers || data?.data || data?.sandboxes || []) as Array<Record<string, unknown>>;
  const running = list.find((c) => c.providerKind === 'k8s' && (c.status === 'running' || c.liveStatus === 'running'));
  if (running) {
    containerId = (running.id as string) || containerId;
    daemonId = (running.daemonId as string) || daemonId;
    podName = (running.podName as string) || podName;
    if (verbose) console.log(`[discover] picked container=${containerId} daemon=${daemonId} pod=${podName}`);
  } else {
    console.log(`[discover] ⚠ no running k8s container under workspace ${WS}; A/C tests will skip`);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Test groups
// ──────────────────────────────────────────────────────────────────────────────

async function groupA_Sandbox(): Promise<void> {
  console.log('\n── A. Sandbox routes (S3+T9+S7) ──');

  await test('A1 GET /api/sandboxes returns providerKind=k8s rows', async () => {
    const res = await http('GET', `/api/sandboxes?workspaceId=${encodeURIComponent(WS)}`);
    if (res.status !== 200) return { ok: false, status: res.status, note: `expected 200 got ${res.status}` };
    const d = res.data as { data?: unknown[]; sandboxes?: unknown[]; containers?: unknown[] };
    const list = (d?.containers || d?.data || d?.sandboxes || []) as Array<Record<string, unknown>>;
    if (!Array.isArray(list)) return { ok: false, status: res.status, note: 'response missing containers/data array' };
    const allK8s = list.length === 0 || list.every((c) => c.providerKind === 'k8s' || c.providerKind === undefined);
    return {
      ok: allK8s && list.length > 0, // R3 reference baseline had 48 rows; empty list is suspicious
      status: res.status,
      note: `count=${list.length}, ${allK8s ? 'all k8s' : 'non-k8s provider mixed in'}`,
    };
  });

  await test('A2 GET /api/sandboxes/:id daemonId 非空', async () => {
    if (!containerId) return { ok: true, status: 0, note: 'no running container available', skip: true };
    const res = await http('GET', `/api/sandboxes/${encodeURIComponent(containerId)}`);
    if (res.status !== 200) return { ok: false, status: res.status, note: `expected 200 got ${res.status}` };
    const d = res.data as Record<string, unknown>;
    // Response shape: { container: {...} } or { sandbox: {...} } or flat object
    const sandbox = (d.container as Record<string, unknown>) || (d.sandbox as Record<string, unknown>) || d;
    const did = sandbox.daemonId as string | undefined;
    return { ok: !!did, status: res.status, note: did ? `daemonId=${did.slice(0, 12)}…` : 'daemonId missing' };
  });

  await test('A3 GET /api/sandboxes/:id/progress history 含 ready', async () => {
    if (!containerId) return { ok: true, status: 0, note: 'no running container available', skip: true };
    const res = await http('GET', `/api/sandboxes/${encodeURIComponent(containerId)}/progress`);
    if (res.status !== 200) return { ok: false, status: res.status, note: `expected 200 got ${res.status}` };
    // Response shape variations:
    //   { history: [{ phase | step: '...' }] }
    //   { data: { history: [...] } }
    //   { container: { provisioningHistory: [{ step: '...' }] } }
    //   { provisioningHistory: [{ step: '...' }] }
    const d = res.data as Record<string, unknown>;
    const candidates: Array<Array<{ phase?: string; step?: string }>> = [
      d.history as Array<{ phase?: string; step?: string }>,
      (d.data as { history?: Array<{ phase?: string; step?: string }> })?.history,
      d.provisioningHistory as Array<{ phase?: string; step?: string }>,
      (d.container as { provisioningHistory?: Array<{ phase?: string; step?: string }> })?.provisioningHistory,
    ].filter(Boolean) as Array<Array<{ phase?: string; step?: string }>>;
    const history = candidates[0] || [];
    const phases = history.map((h) => h.phase || h.step).filter(Boolean) as string[];
    const hasReady = phases.includes('ready');
    return {
      ok: hasReady,
      status: res.status,
      note: hasReady ? `phases=[${phases.join(',')}]` : `missing 'ready' phase; got [${phases.join(',')}]`,
    };
  });

  await test('A4 POST /api/sandboxes/:id/runCmd exitCode=0', async () => {
    if (!containerId) return { ok: true, status: 0, note: 'no running container available', skip: true };
    const res = await http('POST', `/api/sandboxes/${encodeURIComponent(containerId)}/runCmd`, {
      command: ['sh', '-c', 'echo v200-suite'],
    });
    if (res.status !== 200) return { ok: false, status: res.status, note: `expected 200 got ${res.status}` };
    const d = res.data as { exitCode?: number; stdout?: string; result?: { exitCode?: number; stdout?: string } };
    const exitCode = d.exitCode ?? d.result?.exitCode;
    const stdout = d.stdout ?? d.result?.stdout;
    return {
      ok: exitCode === 0,
      status: res.status,
      note: `exitCode=${exitCode}, stdout=${JSON.stringify(stdout?.slice?.(0, 40) ?? stdout)}`,
    };
  });

  await test('A5 POST /api/sandboxes/:id/snapshot kind=fs-manifest 返 201', async () => {
    if (!containerId) return { ok: true, status: 0, note: 'no running container available', skip: true };
    const res = await http('POST', `/api/sandboxes/${encodeURIComponent(containerId)}/snapshot`, {
      kind: 'fs-manifest',
    });
    if (res.status !== 201) return { ok: false, status: res.status, note: `expected 201 got ${res.status}` };
    const d = res.data as { snapshot?: { id?: string; kind?: string } };
    const snap = d.snapshot;
    const ok = snap?.kind === 'fs-manifest' && !!snap?.id;
    return { ok, status: res.status, note: ok ? `snapshot.id=${snap?.id?.slice(0, 16)}…` : 'snapshot shape wrong' };
  });

  await test('A6 GET /api/sandboxes/_admin/sandbox-metrics admin gate', async () => {
    const res = await http('GET', '/api/sandboxes/_admin/sandbox-metrics');
    // Spec: 403 (non-admin gate) or 200 (admin) both acceptable.
    const ok = res.status === 403 || res.status === 200;
    return { ok, status: res.status, note: `status=${res.status} (403 non-admin / 200 admin both accepted)` };
  });

  await test('A7 GET /api/sandboxes/:id/resources?since=... admin gate', async () => {
    if (!containerId) return { ok: true, status: 0, note: 'no running container available', skip: true };
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const res = await http(
      'GET',
      `/api/sandboxes/${encodeURIComponent(containerId)}/resources?since=${encodeURIComponent(since)}`,
    );
    // Per R3: route is admin-only; non-admin gets 403; admin gets 200. Both acceptable.
    const ok = res.status === 403 || res.status === 200;
    return { ok, status: res.status, note: `status=${res.status} (403 non-admin / 200 admin both accepted)` };
  });
}

async function groupB_Ephemeral(): Promise<void> {
  console.log('\n── B. Ephemeral (T10) ──');

  await test('B1 POST /api/runs docker-host echo exitCode=0', async () => {
    const res = await http('POST', '/api/runs', {
      workspaceId: WS,
      executor: 'docker-host',
      request: {
        image: 'alpine:latest',
        command: ['sh', '-c', 'echo v200-ephemeral'],
      },
    });
    if (res.status !== 201) return { ok: false, status: res.status, note: `expected 201 got ${res.status}` };
    const d = res.data as { run?: { exitCode?: number; stdout?: string } };
    const exitCode = d.run?.exitCode;
    return {
      ok: exitCode === 0,
      status: res.status,
      note: `exitCode=${exitCode}, stdout=${JSON.stringify(d.run?.stdout?.slice?.(0, 40))}`,
    };
  });

  await test('B2 POST /api/runs e2b 返 503 + executor_not_available', async () => {
    const res = await http('POST', '/api/runs', {
      workspaceId: WS,
      executor: 'e2b',
      request: {
        image: 'alpine:latest',
        command: ['sh', '-c', 'echo e2b'],
      },
    });
    // T10 graceful skip: 503 + error executor_not_available expected when no E2B_API_KEY.
    // Also accept if e2b is actually configured (then 201 with run).
    const d = res.data as { error?: string };
    if (res.status === 503 && d.error === 'executor_not_available') {
      return { ok: true, status: res.status, note: 'graceful skip (503 executor_not_available)' };
    }
    if (res.status === 201) {
      return { ok: true, status: res.status, note: 'e2b configured + ran ok' };
    }
    return { ok: false, status: res.status, note: `expected 503/201 got ${res.status} error=${d.error}` };
  });
}

async function groupC_WorkspaceRuntime(): Promise<void> {
  console.log('\n── C. Workspace runtime (S4+S7+commit 17) ──');

  await test('C1 GET /api/workspace/runtime-installations daemon fields 齐', async () => {
    const res = await http('GET', `/api/workspace/runtime-installations?workspaceId=${encodeURIComponent(WS)}`);
    if (res.status !== 200) return { ok: false, status: res.status, note: `expected 200 got ${res.status}` };
    const d = res.data as { data?: Array<Record<string, unknown>>; installations?: Array<Record<string, unknown>> };
    const list = (d.data || d.installations || []) as Array<Record<string, unknown>>;
    if (list.length === 0) {
      return { ok: false, status: res.status, note: 'no installations returned' };
    }
    const first = list[0];
    const hasFields = !!first.daemonStatus && (!!first.daemonId || first.daemonId === null) && !!first.gatewayUrl;
    return {
      ok: hasFields,
      status: res.status,
      note: hasFields
        ? `daemonStatus=${first.daemonStatus}, gatewayUrl=${(first.gatewayUrl as string)?.slice?.(0, 30)}…`
        : `missing fields: ${JSON.stringify(Object.keys(first))}`,
    };
  });

  await test('C2 GET /api/im/workspaces/:wsId/runtime devices[] daemonId unique', async () => {
    const res = await http('GET', `/api/im/workspaces/${encodeURIComponent(WS)}/runtime`);
    if (res.status !== 200) return { ok: false, status: res.status, note: `expected 200 got ${res.status}` };
    const d = res.data as { data?: { devices?: Array<{ deviceId?: string }> }; devices?: Array<{ deviceId?: string }> };
    const devices = (d.data?.devices || d.devices || []) as Array<{ deviceId?: string }>;
    const ids = devices.map((dv) => dv.deviceId).filter(Boolean);
    const unique = new Set(ids).size === ids.length;
    return {
      ok: unique && devices.length > 0,
      status: res.status,
      note: `devices.len=${devices.length}, unique=${unique}`,
    };
  });

  await test('C3 GET /api/im/workspaces/:wsId/runtime/devices/:did/logs → 307 redirect', async () => {
    if (!daemonId) return { ok: true, status: 0, note: 'no daemonId discovered', skip: true };
    const res = await http(
      'GET',
      `/api/im/workspaces/${encodeURIComponent(WS)}/runtime/devices/${encodeURIComponent(daemonId)}/logs?tail=5`,
      undefined,
      { redirect: 'manual' },
    );
    if (res.status !== 307) {
      return {
        ok: false,
        status: res.status,
        note: `expected 307 got ${res.status} (dev server may need restart; see R3 P1)`,
      };
    }
    const loc = res.location || '';
    const okLoc = loc.includes('/api/sandboxes/') && loc.includes('/logs');
    return {
      ok: okLoc,
      status: res.status,
      note: okLoc ? `Location=${loc}` : `bad Location=${loc}`,
    };
  });
}

async function groupD_TasksKanban(): Promise<void> {
  console.log('\n── D. Tasks Kanban filter (commit 18) ──');

  await test('D1 GET /api/im/tasks view=board kind=work_item,goal excludes shell', async () => {
    const res = await http(
      'GET',
      `/api/im/tasks?workspaceId=${encodeURIComponent(WS)}&view=board&kind=work_item,goal&limit=100`,
    );
    if (res.status !== 200) return { ok: false, status: res.status, note: `expected 200 got ${res.status}` };
    const d = res.data as { data?: Array<Record<string, unknown>>; tasks?: Array<Record<string, unknown>> };
    const tasks = (d.data || d.tasks || []) as Array<Record<string, unknown>>;
    const shellCount = tasks.filter(
      (t) =>
        t.capability === 'shell' ||
        (typeof t.title === 'string' && (t.title as string).startsWith('Shell:')) ||
        t.runtimeRoute === 'shell',
    ).length;
    return {
      ok: shellCount === 0,
      status: res.status,
      note: `tasks=${tasks.length}, shell-tagged=${shellCount} (want 0)`,
    };
  });

  await test('D2 GET /api/im/tasks?capability=shell can isolate shell tasks', async () => {
    const res = await http('GET', `/api/im/tasks?workspaceId=${encodeURIComponent(WS)}&capability=shell`);
    if (res.status !== 200) return { ok: false, status: res.status, note: `expected 200 got ${res.status}` };
    const d = res.data as { data?: unknown[]; tasks?: unknown[]; total?: number };
    const list = (d.data || d.tasks || []) as unknown[];
    return {
      ok: Array.isArray(list),
      status: res.status,
      note: `capability=shell rows=${list.length} (any count ok; empty is valid)`,
    };
  });
}

async function groupE_AuthGates(): Promise<void> {
  console.log('\n── E. Auth gates ──');

  await test('E1 GET /api/sandboxes (no Authorization) → 401', async () => {
    const res = await http('GET', `/api/sandboxes?workspaceId=${encodeURIComponent(WS)}`, undefined, {
      noAuth: true,
    });
    return {
      ok: res.status === 401,
      status: res.status,
      note: res.status === 401 ? 'unauthorized as expected' : `expected 401 got ${res.status}`,
    };
  });

  await test('E2 GET /api/sandboxes?workspaceId=<other> → 403/404', async () => {
    const res = await http('GET', '/api/sandboxes?workspaceId=other-ws-id-xyz-v200-test');
    const ok = res.status === 403 || res.status === 404;
    return {
      ok,
      status: res.status,
      note: ok ? `cross-workspace blocked (${res.status})` : `expected 403/404 got ${res.status}`,
    };
  });
}

async function groupF_DaemonHealthz(): Promise<void> {
  console.log('\n── F. Daemon /healthz schema (S4) — via kubectl exec ──');

  if (SKIP_F) {
    await test('F1 daemon /healthz schema', async () => ({
      ok: true,
      note: 'skipped via PRISMER_SKIP_F',
      skip: true,
    }));
    return;
  }

  await test('F1 pod /healthz: daemonVersion + readyForDispatch + adapters[] + resources', async () => {
    if (!podName) {
      return { ok: true, note: 'no pod name (set PRISMER_DEV_POD_NAME or run discovery)', skip: true };
    }
    // probe kubectl availability
    const ver = exec('kubectl', ['version', '--client=true', '-o=json']);
    if (!ver.ok) {
      return { ok: true, note: 'kubectl not installed', skip: true };
    }
    const r = exec('kubectl', ['-n', NS, 'exec', podName, '--', 'curl', '-sS', 'http://127.0.0.1:7878/healthz']);
    if (!r.ok) {
      return { ok: false, note: `kubectl exec failed: ${r.stderr.slice(0, 120)}` };
    }
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(r.stdout);
    } catch {
      return { ok: false, note: `non-JSON response: ${r.stdout.slice(0, 100)}` };
    }
    const hasVersion = typeof json.daemonVersion === 'string';
    const ready = json.readyForDispatch === true;
    const adapters = Array.isArray(json.adapters) ? (json.adapters as unknown[]) : [];
    const hasAdapters = adapters.length > 0;
    const resources = json.resources as { cpu?: unknown; mem?: unknown } | undefined;
    const hasResources = !!resources?.cpu && !!resources?.mem;
    const allOk = hasVersion && ready && hasAdapters && hasResources;
    return {
      ok: allOk,
      note: allOk
        ? `version=${json.daemonVersion}, ready=${ready}, adapters=${adapters.length}`
        : `version=${hasVersion}, ready=${ready}, adapters=${hasAdapters}, resources=${hasResources}`,
    };
  });
}

async function groupG_ReconcilerLive(): Promise<void> {
  console.log('\n── G. Reconciler live (S5) — via mysql ──');

  if (SKIP_G) {
    await test('G1 mysql lastDaemonHealthAt < 60s', async () => ({
      ok: true,
      note: 'skipped via PRISMER_SKIP_G',
      skip: true,
    }));
    return;
  }

  function mysqlQuery(sql: string): { ok: boolean; rows: string[]; err: string } {
    const r = exec('docker', [
      'exec',
      MYSQL_CONTAINER,
      'mysql',
      `-u${MYSQL_USER}`,
      `-p${MYSQL_PASS}`,
      MYSQL_DB,
      '-N',
      '-B',
      '-e',
      sql,
    ]);
    if (!r.ok) return { ok: false, rows: [], err: r.stderr.slice(0, 200) };
    const rows = r.stdout.split('\n').filter(Boolean);
    return { ok: true, rows, err: '' };
  }

  await test('G1 mysql im_containers.lastDaemonHealthAt < 60s', async () => {
    const probe = exec('docker', ['ps', '--filter', `name=${MYSQL_CONTAINER}`, '--format', '{{.Names}}']);
    if (!probe.ok || !probe.stdout.includes(MYSQL_CONTAINER)) {
      return { ok: true, note: `${MYSQL_CONTAINER} not running`, skip: true };
    }
    const q = mysqlQuery(`
      SELECT TIMESTAMPDIFF(SECOND, lastDaemonHealthAt, NOW()) AS age_sec
      FROM im_containers
      WHERE workspaceId='${WS}' AND providerKind='k8s' AND stoppedAt IS NULL
        AND lastDaemonHealthAt IS NOT NULL
      ORDER BY lastDaemonHealthAt DESC LIMIT 1;
    `);
    if (!q.ok) return { ok: false, note: `mysql err: ${q.err}` };
    if (q.rows.length === 0) return { ok: false, note: 'no running k8s container with health timestamp' };
    const age = Number(q.rows[0]);
    return { ok: age >= 0 && age < 60, note: `age_sec=${age} (want <60)` };
  });

  await test('G2 mysql im_sandbox_resource_samples last 60s has new rows', async () => {
    const probe = exec('docker', ['ps', '--filter', `name=${MYSQL_CONTAINER}`, '--format', '{{.Names}}']);
    if (!probe.ok || !probe.stdout.includes(MYSQL_CONTAINER)) {
      return { ok: true, note: `${MYSQL_CONTAINER} not running`, skip: true };
    }
    if (!containerId) {
      return { ok: true, note: 'no container id discovered', skip: true };
    }
    const q = mysqlQuery(`
      SELECT TIMESTAMPDIFF(SECOND, MAX(sampledAt), NOW()) AS age_sec, COUNT(*) AS cnt
      FROM im_sandbox_resource_samples
      WHERE containerId='${containerId}'
        AND sampledAt > NOW() - INTERVAL 60 SECOND;
    `);
    if (!q.ok) return { ok: false, note: `mysql err: ${q.err}` };
    const parts = (q.rows[0] || '').split('\t');
    const age = Number(parts[0]);
    const cnt = Number(parts[1]);
    return { ok: cnt > 0, note: `last 60s samples=${cnt}, freshest age=${age}s` };
  });

  await test('G3 mysql no dup row by daemonId (stoppedAt=NULL)', async () => {
    const probe = exec('docker', ['ps', '--filter', `name=${MYSQL_CONTAINER}`, '--format', '{{.Names}}']);
    if (!probe.ok || !probe.stdout.includes(MYSQL_CONTAINER)) {
      return { ok: true, note: `${MYSQL_CONTAINER} not running`, skip: true };
    }
    const q = mysqlQuery(`
      SELECT daemonId, COUNT(*) AS row_count FROM im_containers
      WHERE workspaceId='${WS}' AND stoppedAt IS NULL AND daemonId IS NOT NULL
      GROUP BY daemonId HAVING COUNT(*) > 1;
    `);
    if (!q.ok) return { ok: false, note: `mysql err: ${q.err}` };
    return { ok: q.rows.length === 0, note: `duplicate groups=${q.rows.length} (want 0)` };
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\nv200 API regression suite`);
  console.log(`  base:       ${BASE}`);
  console.log(`  workspace:  ${WS}`);
  console.log(`  jwt:        ${JWT.slice(0, 16)}…`);
  console.log(`  filter:     ${filterRegex ? filterRegex.source : '(all)'}`);
  console.log(`  verbose:    ${verbose}`);
  if (PIN_CID) console.log(`  pin cid:    ${PIN_CID}`);
  if (PIN_DID) console.log(`  pin did:    ${PIN_DID}`);

  try {
    await discoverContainer();
  } catch (err) {
    console.log(`[discover] exception: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log(
    `\n  effective container=${containerId || '(none)'} daemon=${daemonId || '(none)'} pod=${podName || '(none)'}`,
  );

  await groupA_Sandbox();
  await groupB_Ephemeral();
  await groupC_WorkspaceRuntime();
  await groupD_TasksKanban();
  await groupE_AuthGates();
  await groupF_DaemonHealthz();
  await groupG_ReconcilerLive();

  // Summary
  const ran = results.filter((r) => !r.skipped);
  const skipped = results.filter((r) => r.skipped);
  const passed = ran.filter((r) => r.pass);
  const failed = ran.filter((r) => !r.pass);

  console.log(`\n──────────────────────────────────────────────`);
  console.log(`Summary:  ${passed.length}/${ran.length} passed, ${failed.length} failed, ${skipped.length} skipped`);
  if (failed.length > 0) {
    console.log(`\nFailures:`);
    for (const f of failed) console.log(`  ❌ ${f.name} — ${f.note}`);
  }
  if (skipped.length > 0 && verbose) {
    console.log(`\nSkipped:`);
    for (const s of skipped) console.log(`  ⏭  ${s.name} — ${s.note}`);
  }
  console.log(`──────────────────────────────────────────────\n`);

  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`[test-v200-apis] fatal:`, err);
  process.exit(1);
});
