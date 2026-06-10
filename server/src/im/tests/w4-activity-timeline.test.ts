/**
 * Wave 3.5 W4 — Activity Timeline server-side integration test (P4a).
 *
 * Real MySQL + real WS message processing — NO mocks.
 *
 * Usage:
 *   DATABASE_URL="mysql://prismer:devpass@localhost:3307/prismer_cloud" \
 *     npx tsx src/im/tests/w4-activity-timeline.test.ts
 *
 * Optional env:
 *   IM_BASE_URL   — defaults to http://localhost:3300 (standalone IM server).
 *   IM_WS_URL     — defaults to ws://localhost:3300/ws.
 *
 * Spec: docs/release200/14-messaging-state-machine-reliability.md §4.4
 *
 * Acceptance grid (matches the task brief):
 *   1. Daemon push step → server writes im_task_run_steps + emits SSE event payload
 *   2. Re-sending the same (taskRunId, seq) is a no-op (no duplicate row)
 *   3. GET /tasks/:taskRunId/timeline returns steps sorted by seq
 *   4. A non-participant requester gets 403
 *   5. afterSeq filter excludes prior rows
 */

import WebSocket from 'ws';
import jwt from 'jsonwebtoken';

const BASE = process.env.IM_BASE_URL || 'http://localhost:3300';
const WS_URL = process.env.IM_WS_URL || 'ws://localhost:3300/ws';

// ─── Test infra ──────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err: any) {
    failed++;
    const msg = err?.message || String(err);
    failures.push(`${name}: ${msg}`);
    console.log(`  ❌ ${name}: ${msg}`);
  }
}
function assert(cond: any, msg: string) {
  if (!cond) throw new Error(msg);
}

// ─── Prisma (direct DB access for fixtures + assertions) ─────
import prisma from '../db';

// ─── Fixture: ensure a user + agent-card + task + run exist ──
//
// We use the existing tomwinshare IMUser as the creator+assignee — fits the
// JWT bound in the task brief and avoids polluting the schema with synthetic
// users (the worktree shares MySQL with the running cloud).
const CREATOR_ID = 'cmp1uhqwz0000xzwt6usm7m2e'; // tomwinshare
const OUTSIDER_USERNAME = 'w4_outsider_' + Date.now().toString(36);

// Matches the dev-stack secret (see /.env.local in the main repo). The
// standalone IM server boots without Nacos, so we control which secret it
// validates against via this env var.
const JWT_SECRET = process.env.JWT_SECRET || 'local-dev-secret-do-not-use-in-prod';

function signJwt(sub: string, username: string): string {
  return jwt.sign(
    { sub, username, role: 'human', numericId: 0, email: `${username}@example.test` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

async function ensureOutsider(): Promise<{ id: string; jwt: string }> {
  // Create a throwaway IM user so we can prove the 403 path.
  const existing = await prisma.iMUser.findFirst({ where: { username: OUTSIDER_USERNAME } });
  if (existing) return { id: existing.id, jwt: signJwt(existing.id, existing.username) };
  const outsider = await prisma.iMUser.create({
    data: {
      username: OUTSIDER_USERNAME,
      displayName: OUTSIDER_USERNAME,
      email: `${OUTSIDER_USERNAME}@example.test`,
      passwordHash: 'na',
      role: 'human',
    },
  });
  return { id: outsider.id, jwt: signJwt(outsider.id, outsider.username) };
}

async function createTaskAndRun(): Promise<{ taskId: string; runId: string }> {
  const task = await prisma.iMTask.create({
    data: {
      title: `W4 timeline fixture ${Date.now()}`,
      description: 'Wave 3.5 W4 P4a test fixture — safe to delete',
      creatorId: CREATOR_ID,
      assigneeId: CREATOR_ID,
      status: 'running',
    },
  });
  const run = await prisma.iMTaskRun.create({
    data: {
      taskId: task.id,
      creatorId: CREATOR_ID,
      assigneeId: CREATOR_ID,
      status: 'running',
      input: '{}',
      metadata: '{}',
    },
  });
  return { taskId: task.id, runId: run.id };
}

async function cleanupTaskAndRun(taskId: string, runId: string) {
  await prisma.$executeRaw`DELETE FROM im_task_run_steps WHERE taskRunId = ${runId}`;
  await prisma.iMTaskRun.deleteMany({ where: { id: runId } }).catch(() => {});
  await prisma.iMTask.deleteMany({ where: { id: taskId } }).catch(() => {});
}

// ─── HTTP helper ─────────────────────────────────────────────
async function http(method: string, path: string, token?: string, body?: any) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}/api/im${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, data };
}

// ─── WS helper ───────────────────────────────────────────────
function openWs(token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
    const timer = setTimeout(() => reject(new Error('WS open timeout')), 10_000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function send(ws: WebSocket, msg: object) {
  ws.send(JSON.stringify(msg));
}

function close(ws: WebSocket) {
  return new Promise<void>((resolve) => {
    ws.once('close', () => resolve());
    ws.close();
  });
}

// ─── Wait helper ─────────────────────────────────────────────
async function waitFor<T>(fn: () => Promise<T | null | undefined>, timeoutMs = 3000): Promise<T> {
  const start = Date.now();
  let last: T | null | undefined;
  while (Date.now() - start < timeoutMs) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error(`waitFor timed out (last=${JSON.stringify(last)})`);
}

// ─── Tests ───────────────────────────────────────────────────
async function main() {
  console.log('Wave 3.5 W4 — Activity Timeline server-side integration');
  console.log(`Base: ${BASE}`);

  const creatorJwt = signJwt(CREATOR_ID, 'tomwinshare');
  const outsider = await ensureOutsider();

  // Sanity: server is up
  const health = await fetch(`${BASE}/api/health`).catch(() => null);
  if (!health || !health.ok) {
    console.error(`❌ IM server not reachable at ${BASE}. Boot with: IM_PORT=3300 npx tsx src/im/start.ts`);
    process.exit(1);
  }

  // Fresh task + run for the suite
  const { taskId, runId } = await createTaskAndRun();
  console.log(`Fixture taskId=${taskId} runId=${runId}`);

  try {
    // ─── 1. WS task.step.append → DB row + SyncEvent ─────────
    await test('1. daemon push step → server writes im_task_run_steps row', async () => {
      const ws = await openWs(creatorJwt);
      try {
        send(ws, {
          type: 'task.step.append',
          payload: {
            taskRunId: runId,
            step: {
              seq: 1,
              kind: 'phase_change',
              payload: { phase: 'thinking' },
              occurredAt: Date.now(),
            },
          },
        });
        const row = await waitFor(async () => {
          const rows: any[] = await prisma.$queryRaw`
            SELECT id, seq, kind FROM im_task_run_steps WHERE taskRunId = ${runId} AND seq = 1
          `;
          return rows[0] ?? null;
        });
        assert(row.kind === 'phase_change', `expected kind=phase_change, got ${row.kind}`);
      } finally {
        await close(ws);
      }
    });

    await test('1b. SyncEvent task.step.appended row written', async () => {
      const ev = await waitFor(async () => {
        const rows: any[] = await prisma.$queryRaw`
          SELECT id, type, data FROM im_sync_events
          WHERE type = 'task.step.appended'
            AND JSON_EXTRACT(data, '$.taskRunId') = ${runId}
          ORDER BY id DESC LIMIT 1
        `;
        return rows[0] ?? null;
      });
      const parsed = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
      assert(parsed.taskRunId === runId, `event.taskRunId mismatch: ${parsed.taskRunId}`);
      assert(parsed.step && parsed.step.seq === 1, `event.step.seq expected 1, got ${parsed.step?.seq}`);
      assert(parsed.step.kind === 'phase_change', `event.step.kind expected phase_change`);
    });

    // ─── 2. Idempotency on duplicate (taskRunId, seq) ────────
    await test('2. duplicate seq is silently dropped (no second row)', async () => {
      const ws = await openWs(creatorJwt);
      try {
        send(ws, {
          type: 'task.step.append',
          payload: {
            taskRunId: runId,
            step: {
              seq: 1,
              kind: 'phase_change',
              payload: { phase: 'thinking_DUPLICATE' },
              occurredAt: Date.now(),
            },
          },
        });
        // small grace window
        await new Promise((r) => setTimeout(r, 400));
        const rows: any[] = await prisma.$queryRaw`
          SELECT COUNT(*) AS n FROM im_task_run_steps WHERE taskRunId = ${runId} AND seq = 1
        `;
        const n = Number(rows[0].n);
        assert(n === 1, `expected exactly 1 row for (runId, seq=1), got ${n}`);
      } finally {
        await close(ws);
      }
    });

    // ─── 3. Append a few more steps then list via endpoint ───
    await test('3. multiple steps land then list via GET /timeline (sorted by seq)', async () => {
      const ws = await openWs(creatorJwt);
      try {
        for (const seq of [2, 3, 4]) {
          send(ws, {
            type: 'task.step.append',
            payload: {
              taskRunId: runId,
              step: {
                seq,
                kind: seq === 3 ? 'tool_call' : 'progress',
                payload: { step: `s${seq}` },
                occurredAt: Date.now() + seq,
              },
            },
          });
          // Tiny inter-send gap so the server's async handler chain doesn't
          // get starved by an immediate close. Without this the WS frames
          // buffer but close() races the async handler.
          await new Promise((r) => setTimeout(r, 30));
        }
        await waitFor(async () => {
          const rows: any[] = await prisma.$queryRaw`
            SELECT COUNT(*) AS n FROM im_task_run_steps WHERE taskRunId = ${runId}
          `;
          return Number(rows[0].n) >= 4 ? true : null;
        }, 5000);
      } finally {
        await close(ws);
      }
      const res = await http('GET', `/tasks/${runId}/timeline`, creatorJwt);
      assert(res.status === 200, `GET status expected 200, got ${res.status}`);
      assert(res.data?.ok === true, `response ok flag missing`);
      const steps = res.data.data.steps;
      // DB-side verification — what does the table actually hold?
      const dbRows: any[] = await prisma.$queryRaw`
        SELECT seq, kind FROM im_task_run_steps WHERE taskRunId = ${runId} ORDER BY seq
      `;
      assert(
        steps.length === 4,
        `expected 4 steps, got ${steps.length}; dbRows=${JSON.stringify(
          dbRows.map((r) => ({ seq: Number(r.seq), kind: r.kind })),
        )}; endpoint=${JSON.stringify(res.data.data)}`,
      );
      for (let i = 0; i < steps.length - 1; i++) {
        assert(steps[i].seq < steps[i + 1].seq, `not sorted: ${steps[i].seq} >= ${steps[i + 1].seq}`);
      }
      assert(steps[0].seq === 1, `first seq expected 1, got ${steps[0].seq}`);
      assert(steps[3].seq === 4, `last seq expected 4, got ${steps[3].seq}`);
      assert(typeof steps[0].payloadJson === 'object', `payloadJson should be parsed object`);
    });

    // ─── 4. afterSeq filter ──────────────────────────────────
    await test('4. afterSeq filter excludes prior rows', async () => {
      const res = await http('GET', `/tasks/${runId}/timeline?afterSeq=2`, creatorJwt);
      assert(res.status === 200, `GET status expected 200, got ${res.status}`);
      const steps = res.data.data.steps;
      assert(steps.length === 2, `expected 2 steps after seq>2, got ${steps.length}`);
      assert(steps[0].seq === 3, `first seq expected 3, got ${steps[0].seq}`);
      assert(steps[1].seq === 4, `second seq expected 4, got ${steps[1].seq}`);
    });

    // ─── 5. Non-participant 403 ──────────────────────────────
    await test('5. non-participant requester is denied', async () => {
      const res = await http('GET', `/tasks/${runId}/timeline`, outsider.jwt);
      assert(
        res.status === 403 || res.status === 404,
        `expected 403 (or 404 — both are valid TaskAccessError surfaces), got ${res.status}: ${JSON.stringify(res.data)}`,
      );
    });

    // ─── 6. limit pagination ─────────────────────────────────
    await test('6. limit pagination + cursor', async () => {
      const res = await http('GET', `/tasks/${runId}/timeline?limit=2`, creatorJwt);
      assert(res.status === 200, `GET status expected 200, got ${res.status}`);
      const data = res.data.data;
      assert(data.steps.length === 2, `expected 2 steps with limit=2, got ${data.steps.length}`);
      assert(data.hasMore === true, `hasMore should be true`);
      assert(data.cursor === 2, `cursor expected 2, got ${data.cursor}`);
      const res2 = await http('GET', `/tasks/${runId}/timeline?limit=10&afterSeq=${data.cursor}`, creatorJwt);
      assert(res2.data.data.steps.length === 2, `paginated 2nd page expected 2, got ${res2.data.data.steps.length}`);
      assert(res2.data.data.hasMore === false, `hasMore should be false at end`);
    });
  } finally {
    await cleanupTaskAndRun(taskId, runId);
    // Outsider may have an auto-created workspace + participant rows; nuke
    // those first so the FK cascade lets the user row drop.
    await prisma
      .$executeRaw`DELETE FROM im_workspaces WHERE ownerImUserId = ${outsider.id}`
      .catch(() => {});
    await prisma.iMUser.deleteMany({ where: { id: outsider.id } }).catch(() => {});
  }

  console.log('\n─── Summary ───');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('Unhandled test failure:', err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
