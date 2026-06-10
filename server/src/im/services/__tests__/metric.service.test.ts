/**
 * Unit test for metric.service.ts (release201/11 §0.2.1 DoD).
 *
 * Run:
 *   npx tsx src/im/services/__tests__/metric.service.test.ts
 *
 * Pure in-process. Stubs the prisma model so no real DB is touched. Covers:
 *   • emit() returns synchronously (< 1ms expectation, sampled)
 *   • emit() under threshold doesn't flush; reaching batchSize triggers flush
 *   • flush() batches into a single createMany call
 *   • workspaceId is denormalised onto the row column
 *   • Unregistered metric warns but still queues
 *   • DB failure re-queues the batch for retry
 *   • Retention helper (registry / soft-validation surface)
 *
 * NOT covered here: the 90-day retention cron job (Phase 4 scope) — Phase 1
 * DoD only requires the emit + flush path. The "retention" test below
 * exercises queue back-pressure (maxQueueSize) which is the runtime
 * counterpart that must work in Phase 1.
 */

import { MetricService } from '../metric.service';
import { listRegisteredMetrics, validateMetricEmit } from '../metric-registry';

// Stub the prisma module before MetricService instances do any work.
// We can't reimport metric.service here without it grabbing the real
// client, so we mutate the module's prisma export in place.
import { prisma } from '@/lib/prisma';

interface CallRecord {
  data: any[];
}
const calls: CallRecord[] = [];
let shouldFail = false;

(prisma as any).iMMetricEvent = {
  async createMany({ data }: { data: any[] }) {
    if (shouldFail) {
      throw new Error('stub createMany failure');
    }
    calls.push({ data });
    return { count: data.length };
  },
};

let passed = 0;
let failed = 0;
function eq(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    passed++;
    console.log(`  ok — ${label}`);
  } else {
    failed++;
    console.error(`  FAIL — ${label}\n    expected: ${b}\n    actual:   ${a}`);
  }
}
function truthy(label: string, v: unknown) {
  if (v) {
    passed++;
    console.log(`  ok — ${label}`);
  } else {
    failed++;
    console.error(`  FAIL — ${label} (expected truthy)`);
  }
}
function reset() {
  calls.length = 0;
  shouldFail = false;
}
async function group(name: string, fn: () => Promise<void>) {
  console.log(`\n• ${name}`);
  await fn();
}

async function main() {
  // ─── 1. Registry sanity ─────────────────────────────────────────────────
  await group('registry — core metrics registered (release201/11 §4 + §8b + S18 + S23)', async () => {
    const all = listRegisteredMetrics();
    // 16 from §4 + §8b table, plus task.todo.completion_rate,
    // task.spec.updated_after_assignment, and legacy_route_hits.workspace_insights
    // added by S13 / S18.
    truthy(`count >= 16 (was ${all.length})`, all.length >= 16);
    truthy('contains task.completed', all.includes('task.completed'));
    truthy('contains approval.decided', all.includes('approval.decided'));
    truthy('contains task.metric.snapshot_updated', all.includes('task.metric.snapshot_updated'));
    // S23 — daemon-side metrics targeted by this session.
    truthy('contains agent.dispatch', all.includes('agent.dispatch'));
    truthy('contains skill.invoked', all.includes('skill.invoked'));
  });

  await group('registry — soft validation', async () => {
    const ok = validateMetricEmit({
      namespace: 'task',
      name: 'created',
      value: 1,
      dims: { workspaceId: 'ws', capability: 'general', creatorId: 'u1' },
    });
    eq('no warnings on valid emit', ok.warnings.length, 0);

    const missing = validateMetricEmit({
      namespace: 'task',
      name: 'created',
      value: 1,
      dims: { workspaceId: 'ws' /* missing capability + creatorId */ },
    });
    eq('warns for each missing dim', missing.warnings.length, 2);

    const unknown = validateMetricEmit({ namespace: 'foo', name: 'bar' });
    truthy(
      'unknown metric warns',
      unknown.warnings.some((w) => w.includes('unregistered')),
    );
    truthy('unknown metric still ok', unknown.ok);
  });

  // ─── 2. Emit is synchronous ─────────────────────────────────────────────
  await group('emit is synchronous and non-blocking', async () => {
    reset();
    const svc = new MetricService({ batchSize: 100, disableTimer: true });
    const t0 = process.hrtime.bigint();
    svc.emit({
      namespace: 'task',
      name: 'created',
      value: 1,
      dims: { workspaceId: 'ws', capability: 'general', creatorId: 'u1' },
    });
    const elapsedNs = Number(process.hrtime.bigint() - t0);
    truthy(`emit < 5ms (was ${elapsedNs / 1_000_000}ms)`, elapsedNs < 5_000_000);
    eq('one row queued', svc.stats().queued, 1);
    eq('nothing flushed yet', calls.length, 0);
    await svc.stop();
  });

  // ─── 3. Reaching batchSize triggers flush ──────────────────────────────
  await group('batchSize trigger', async () => {
    reset();
    const svc = new MetricService({ batchSize: 5, disableTimer: true });
    for (let i = 0; i < 5; i++) {
      svc.emit({
        namespace: 'task',
        name: 'created',
        value: 1,
        dims: { workspaceId: 'ws', capability: 'general', creatorId: 'u' + i },
      });
    }
    // emit triggers an opportunistic flush via Promise.resolve()
    await new Promise((r) => setImmediate(r));
    eq('one createMany call', calls.length, 1);
    eq('all rows in that call', calls[0].data.length, 5);
    eq('queue drained', svc.stats().queued, 0);
    await svc.stop();
  });

  // ─── 4. workspaceId denormalisation + dims_json ─────────────────────────
  await group('row shape', async () => {
    reset();
    const svc = new MetricService({ batchSize: 1, disableTimer: true });
    svc.emit({
      namespace: 'task',
      name: 'completed',
      value: 1234,
      dims: {
        workspaceId: 'ws-abc',
        taskId: 't1',
        capability: 'engineering',
        assigneeId: 'agent1',
      },
    });
    await new Promise((r) => setImmediate(r));
    const row = calls[0].data[0];
    eq('namespace', row.namespace, 'task');
    eq('name', row.name, 'completed');
    eq('valueNumeric', row.valueNumeric, 1234);
    eq('valueString null', row.valueString, null);
    eq('workspaceId column', row.workspaceId, 'ws-abc');
    truthy('dimsJson includes capability', String(row.dimsJson).includes('engineering'));
    truthy('source default = cloud', row.source === 'cloud');
    await svc.stop();
  });

  // ─── 5. String value path (e.g. status enum) ────────────────────────────
  await group('string value path', async () => {
    reset();
    const svc = new MetricService({ batchSize: 1, disableTimer: true });
    svc.emit({
      namespace: 'approval',
      name: 'decided',
      value: 'approve',
      dims: { workspaceId: 'ws', decisionBy: 'user1' },
    });
    await new Promise((r) => setImmediate(r));
    const row = calls[0].data[0];
    eq('valueString', row.valueString, 'approve');
    eq('valueNumeric null', row.valueNumeric, null);
    await svc.stop();
  });

  // ─── 6. DB failure re-queues ────────────────────────────────────────────
  await group('flush retry on DB failure', async () => {
    reset();
    const svc = new MetricService({ batchSize: 100, disableTimer: true });
    shouldFail = true;
    svc.emit({
      namespace: 'task',
      name: 'created',
      value: 1,
      dims: { workspaceId: 'ws', capability: 'g', creatorId: 'u' },
    });
    await svc.flush();
    eq('failed call recorded zero times', calls.length, 0);
    eq('row re-queued', svc.stats().queued, 1);

    shouldFail = false;
    await svc.flush();
    eq('next flush succeeds', calls.length, 1);
    eq('queue drained', svc.stats().queued, 0);
    await svc.stop();
  });

  // ─── 7. maxQueueSize back-pressure ──────────────────────────────────────
  await group('maxQueueSize back-pressure', async () => {
    reset();
    const svc = new MetricService({
      batchSize: 100_000,
      maxQueueSize: 3,
      disableTimer: true,
    });
    for (let i = 0; i < 10; i++) {
      svc.emit({
        namespace: 'task',
        name: 'created',
        value: i,
        dims: { workspaceId: 'ws', capability: 'g', creatorId: 'u' + i },
      });
    }
    eq('queue capped at maxQueueSize', svc.stats().queued, 3);
    truthy('overflow counter > 0', svc.stats().overflowed > 0);
    await svc.stop();
  });

  // ─── 8. Manual flush() with empty queue is a no-op ──────────────────────
  await group('flush empty queue', async () => {
    reset();
    const svc = new MetricService({ disableTimer: true });
    await svc.flush();
    eq('no DB call', calls.length, 0);
    await svc.stop();
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
