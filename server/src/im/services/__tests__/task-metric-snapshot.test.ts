/**
 * release201/11 §4 #16 — S23 unit test for task.service.updateTaskMetricSnapshot.
 *
 * Verifies the emit path lands correctly even before any cloud-side caller is
 * wired (caller TODO is v2.0.8 per S23 DoD). Covers:
 *
 *   - emit() lands one row with namespace='task.metric' name='snapshot_updated'
 *   - value_string carries the status enum (passing|failing|unknown)
 *   - dims include workspaceId / taskId / metricId / name (required keys)
 *   - new snapshot ID is appended to metadata.metricsSnapshot[]
 *   - existing snapshot ID is replaced in-place (no duplicates)
 *
 * Run:
 *   npx tsx src/im/services/__tests__/task-metric-snapshot.test.ts
 */

import { TaskService } from '../task.service';
import { MetricService, __setMetricServiceForTests } from '../metric.service';
import { prisma } from '@/lib/prisma';
import dbPrisma from '../../db';

type TaskRow = {
  id: string;
  title: string;
  workspaceId: string;
  creatorId: string;
  metadata: string;
  status: string;
  assigneeId: string | null;
  projectId: string | null;
  createdAt: Date;
  updatedAt: Date;
  conversationId: string | null;
  capability: string | null;
  acceptanceStatus: string | null;
};

const tasks: TaskRow[] = [];
const metricRows: Array<{ namespace: string; name: string; valueString: string | null; dimsJson: string | null }> = [];

// TaskModel uses `../db` (default export); TaskService.parseJson uses
// @/lib/prisma indirectly through metric.service.ts. Stub both to be safe.
const stubIMTask = {
  async findUnique({ where }: { where: { id: string } }) {
    return tasks.find((t) => t.id === where.id) ?? null;
  },
  async update({ where, data }: { where: { id: string }; data: Partial<TaskRow> }) {
    const t = tasks.find((row) => row.id === where.id);
    if (!t) throw new Error('not found');
    Object.assign(t, data, { updatedAt: new Date() });
    return t;
  },
};
(prisma as any).iMTask = stubIMTask;
(dbPrisma as any).iMTask = stubIMTask;

(prisma as any).iMMetricEvent = {
  async createMany({ data }: { data: any[] }) {
    for (const row of data) {
      metricRows.push({
        namespace: row.namespace,
        name: row.name,
        valueString: row.valueString,
        dimsJson: row.dimsJson,
      });
    }
    return { count: data.length };
  },
};

function makeSvc(): TaskService {
  // TaskService takes a deps bag; supply just enough that the snapshot
  // method can run. No messageService / creditService is touched here
  // (updateTaskMetricSnapshot doesn't notify or charge).
  return new TaskService({
    messageService: { sendMessage: async () => undefined } as any,
  } as any);
}

async function run(): Promise<void> {
  let passed = 0;
  let failed = 0;
  function ok(label: string, cond: unknown): void {
    if (cond) {
      passed++;
      console.log(`  ok — ${label}`);
    } else {
      failed++;
      console.error(`  FAIL — ${label}`);
    }
  }
  function eq(label: string, actual: unknown, expected: unknown): void {
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

  const metricSvc = new MetricService({ batchSize: 1, disableTimer: true });
  __setMetricServiceForTests(metricSvc);

  // ── Seed one task ────────────────────────────────────────────────────
  tasks.push({
    id: 't-1',
    title: 'Test',
    workspaceId: 'ws-1',
    creatorId: 'u-1',
    metadata: '{}',
    status: 'pending',
    assigneeId: null,
    projectId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    conversationId: null,
    capability: 'general',
    acceptanceStatus: null,
  });

  const svc = makeSvc();

  console.log('\n• updateTaskMetricSnapshot — first update appends new entry');
  const result1 = await svc.updateTaskMetricSnapshot('t-1', {
    id: 'm-readme',
    name: 'README delivered',
    target: 1,
    source: 'task_result',
    current: 1,
    status: 'passing',
  });
  // Force flush — batchSize is 1 so the queue should already have drained,
  // but stop() guarantees the in-flight row reaches the stub.
  await metricSvc.stop();
  eq('result.status', result1.status, 'passing');
  eq('result.id', result1.id, 'm-readme');
  ok('lastUpdatedAt is ISO', /\d{4}-\d{2}-\d{2}T/.test(result1.lastUpdatedAt));

  const meta1 = JSON.parse(tasks[0]!.metadata);
  ok('metadata.metricsSnapshot is array', Array.isArray(meta1.metricsSnapshot));
  eq('snapshot length = 1', meta1.metricsSnapshot.length, 1);
  eq('snapshot id', meta1.metricsSnapshot[0].id, 'm-readme');
  eq('snapshot status', meta1.metricsSnapshot[0].status, 'passing');

  eq('one metric row emitted', metricRows.length, 1);
  eq('namespace', metricRows[0]!.namespace, 'task.metric');
  eq('name', metricRows[0]!.name, 'snapshot_updated');
  eq('valueString = status', metricRows[0]!.valueString, 'passing');
  const dims1 = JSON.parse(metricRows[0]!.dimsJson ?? '{}');
  eq('dim workspaceId', dims1.workspaceId, 'ws-1');
  eq('dim taskId', dims1.taskId, 't-1');
  eq('dim metricId', dims1.metricId, 'm-readme');
  eq('dim name', dims1.name, 'README delivered');

  console.log('\n• updateTaskMetricSnapshot — second update replaces same id in-place');
  const metricSvc2 = new MetricService({ batchSize: 1, disableTimer: true });
  __setMetricServiceForTests(metricSvc2);
  const result2 = await svc.updateTaskMetricSnapshot('t-1', {
    id: 'm-readme',
    name: 'README delivered',
    target: 1,
    source: 'task_result',
    current: 0,
    status: 'failing',
  });
  await metricSvc2.stop();
  eq('result.status', result2.status, 'failing');
  const meta2 = JSON.parse(tasks[0]!.metadata);
  eq('snapshot length still 1 (replaced not appended)', meta2.metricsSnapshot.length, 1);
  eq('snapshot status updated', meta2.metricsSnapshot[0].status, 'failing');
  eq('total emitted rows', metricRows.length, 2);
  eq('latest emit value_string', metricRows[1]!.valueString, 'failing');

  console.log('\n• updateTaskMetricSnapshot — adding different id appends new entry');
  const metricSvc3 = new MetricService({ batchSize: 1, disableTimer: true });
  __setMetricServiceForTests(metricSvc3);
  await svc.updateTaskMetricSnapshot('t-1', {
    id: 'm-sections',
    name: 'required_sections_present',
    target: true,
    source: 'asset_analysis',
    current: false,
    status: 'failing',
  });
  await metricSvc3.stop();
  const meta3 = JSON.parse(tasks[0]!.metadata);
  eq('snapshot length grew to 2', meta3.metricsSnapshot.length, 2);
  eq('new entry id', meta3.metricsSnapshot[1].id, 'm-sections');
  eq('total emitted rows', metricRows.length, 3);
  const dims3 = JSON.parse(metricRows[2]!.dimsJson ?? '{}');
  eq('new emit metricId', dims3.metricId, 'm-sections');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
