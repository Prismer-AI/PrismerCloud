/**
 * Task result materializer — release201/3x acceptance tests.
 *
 * "任务结果 = asset" 无条件成立. On completion, when a task answered with
 * substantive inline markdown but produced NO file deliverable, the
 * materializer mirrors that text into a TASK-BOUND markdown IMAsset so the
 * digest产物列表 / drawer Artifacts / editor light up automatically.
 *
 * Contract (gating — ALL must hold to materialize):
 *   1. status === 'completed' (enforced by the caller; the materializer is
 *      only invoked on completion — see emitTaskStatusChat).
 *   2. existing deliverable assets empty (0 file产物).
 *   3. inline output is substantive markdown (trimmed ≥ 200 chars).
 *   4. idempotent — not already materialized (metadata marker + content hash).
 *
 * On success: one IMAsset with boundKind='task-bound', sourceTaskId,
 * mime='text/markdown', metadata.materializedFromOutput=true; the task's
 * metadata.outputAssetIds gains the id.
 *
 * Test counts: 7 cases.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: {
    iMTask: { findUnique: vi.fn(), update: vi.fn() },
    iMAsset: { findFirst: vi.fn(), create: vi.fn() },
    iMWorkspace: { findUnique: vi.fn() },
    iMAssetIndexCounter: { upsert: vi.fn() },
  },
}));

vi.mock('../db', () => ({ default: mocks.prisma }));
vi.mock('@/lib/prisma', () => ({ default: mocks.prisma }));
// S3 not used (filesystem backend), but s3.client imports config/AWS at load.
vi.mock('../services/s3.client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/s3.client')>();
  return { ...actual, isS3Available: () => false };
});
vi.mock('../config', () => ({
  config: { s3: { region: 'us-east-1', bucket: 'b', accessKeyId: '', secretAccessKey: '', endpoint: undefined }, cdn: { domain: '' } },
}));

import { materializeTaskResultIfNeeded, MATERIALIZE_MIN_OUTPUT_CHARS } from '../services/result-materializer';

const TMP_DIR = path.join(os.tmpdir(), `prismer-mat-test-${process.pid}`);

const LONG_OUTPUT =
  '# 战略建议\n\n' +
  '本季度我们应聚焦三个方向，并在每条上配套可度量的指标与负责人。\n\n'.repeat(12) +
  '1. 提升留存\n2. 扩展企业客户\n3. 优化单位经济模型\n';

function freshTaskRow(over: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    title: 'CEO 季度战略',
    workspaceId: 'ws-1',
    result: null,
    metadata: '{}',
    creatorId: 'user-1',
    ...over,
  };
}

describe('materializeTaskResultIfNeeded', () => {
  beforeAll(() => {
    process.env.ASSET_STORAGE_BACKEND = 'filesystem';
    process.env.ASSET_STORAGE_DIR = TMP_DIR;
  });
  afterAll(() => {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
    delete process.env.ASSET_STORAGE_DIR;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.iMWorkspace.findUnique.mockResolvedValue({ ownerImUserId: 'owner-1' });
    mocks.prisma.iMAssetIndexCounter.upsert.mockResolvedValue({ nextSeq: BigInt(5) });
    mocks.prisma.iMAsset.findFirst.mockResolvedValue(null);
    mocks.prisma.iMTask.update.mockResolvedValue({});
    let created = 0;
    mocks.prisma.iMAsset.create.mockImplementation(async () => ({ id: `asset-${++created}` }));
  });

  it('materializes substantive inline output into a task-bound markdown asset', async () => {
    mocks.prisma.iMTask.findUnique.mockResolvedValue(freshTaskRow());

    const outcome = await materializeTaskResultIfNeeded({
      taskId: 'task-1',
      output: LONG_OUTPUT,
      existingResultAssetIds: [],
    });

    expect(outcome.reason).toBe('created');
    expect(outcome.assetId).toBe('asset-1');

    expect(mocks.prisma.iMAsset.create).toHaveBeenCalledTimes(1);
    const createData = mocks.prisma.iMAsset.create.mock.calls[0][0].data;
    expect(createData.boundKind).toBe('task-bound');
    expect(createData.mime).toBe('text/markdown');
    expect(createData.sourceTaskId).toBe('task-1');
    expect(createData.ingestStatus).toBe('asset-only');
    expect(createData.kind).toBe('agent-output');
    expect(createData.filename).toMatch(/\.md$/);
    expect(createData.assetIndexSeq).toBe(BigInt(4)); // nextSeq(5) - 1
    expect(JSON.parse(createData.metadata).materializedFromOutput).toBe(true);
    expect(typeof createData.contentHash).toBe('string');
    expect(createData.contentHash).toHaveLength(64);

    // appended to task.metadata.outputAssetIds
    expect(mocks.prisma.iMTask.update).toHaveBeenCalledTimes(1);
    const updateData = mocks.prisma.iMTask.update.mock.calls[0][0].data;
    expect(JSON.parse(updateData.metadata).outputAssetIds).toEqual(['asset-1']);

    // bytes actually landed on the filesystem backend
    const sharded = path.join(TMP_DIR, createData.contentHash.slice(0, 2), createData.contentHash.slice(2, 4), createData.contentHash);
    expect(fs.existsSync(sharded)).toBe(true);
  });

  it('does NOT materialize when output is too short', async () => {
    mocks.prisma.iMTask.findUnique.mockResolvedValue(freshTaskRow());
    const outcome = await materializeTaskResultIfNeeded({
      taskId: 'task-1',
      output: 'done',
      existingResultAssetIds: [],
    });
    expect(outcome.reason).toBe('output-too-short');
    expect(outcome.assetId).toBeNull();
    expect(mocks.prisma.iMAsset.create).not.toHaveBeenCalled();
  });

  it('does NOT materialize when the task already has file deliverables', async () => {
    // Gate 2 short-circuits BEFORE any DB lookup.
    const outcome = await materializeTaskResultIfNeeded({
      taskId: 'task-1',
      output: LONG_OUTPUT,
      existingResultAssetIds: ['existing-file-asset'],
    });
    expect(outcome.reason).toBe('has-deliverables');
    expect(outcome.assetId).toBeNull();
    expect(mocks.prisma.iMTask.findUnique).not.toHaveBeenCalled();
    expect(mocks.prisma.iMAsset.create).not.toHaveBeenCalled();
  });

  it('is idempotent — returns existing asset when already materialized (metadata marker)', async () => {
    mocks.prisma.iMTask.findUnique.mockResolvedValue(freshTaskRow());
    mocks.prisma.iMAsset.findFirst.mockResolvedValue({ id: 'asset-prev' });

    const outcome = await materializeTaskResultIfNeeded({
      taskId: 'task-1',
      output: LONG_OUTPUT,
      existingResultAssetIds: [],
    });
    expect(outcome.reason).toBe('already-materialized');
    expect(outcome.assetId).toBe('asset-prev');
    expect(mocks.prisma.iMAsset.create).not.toHaveBeenCalled();
  });

  it('repeated completion / re-emit produces exactly one asset (idempotent across calls)', async () => {
    // First call: no prior materialization → creates.
    let taskMeta = '{}';
    mocks.prisma.iMTask.findUnique.mockImplementation(async () => freshTaskRow({ metadata: taskMeta }));
    mocks.prisma.iMTask.update.mockImplementation(async (args: any) => {
      taskMeta = args.data.metadata;
      return {};
    });
    // findFirst checks the materialized marker; reflect what we created.
    let materializedAssetId: string | null = null;
    mocks.prisma.iMAsset.findFirst.mockImplementation(async () =>
      materializedAssetId ? { id: materializedAssetId } : null,
    );
    mocks.prisma.iMAsset.create.mockImplementation(async () => {
      materializedAssetId = 'asset-once';
      return { id: 'asset-once' };
    });

    const first = await materializeTaskResultIfNeeded({ taskId: 'task-1', output: LONG_OUTPUT, existingResultAssetIds: [] });
    expect(first.reason).toBe('created');

    // Second call mirrors the WS2 re-emit: outputAssetIds now contains the
    // materialized id, so the caller passes it as an existing deliverable →
    // gate 2 short-circuits. But even if it didn't, the marker check guards.
    const second = await materializeTaskResultIfNeeded({
      taskId: 'task-1',
      output: LONG_OUTPUT,
      existingResultAssetIds: ['asset-once'],
    });
    expect(second.reason).toBe('has-deliverables');
    expect(mocks.prisma.iMAsset.create).toHaveBeenCalledTimes(1);
  });

  it('falls back to persisted IMTask.result (string output) when opts.output is null', async () => {
    mocks.prisma.iMTask.findUnique.mockResolvedValue(freshTaskRow({ result: JSON.stringify(LONG_OUTPUT) }));
    const outcome = await materializeTaskResultIfNeeded({
      taskId: 'task-1',
      output: null,
      existingResultAssetIds: [],
    });
    expect(outcome.reason).toBe('created');
    expect(mocks.prisma.iMAsset.create).toHaveBeenCalledTimes(1);
  });

  it('does NOT materialize a typed object result with no prose body', async () => {
    mocks.prisma.iMTask.findUnique.mockResolvedValue(
      freshTaskRow({ result: JSON.stringify({ assetIds: [], score: 0.9, verdict: 'pass' }) }),
    );
    const outcome = await materializeTaskResultIfNeeded({
      taskId: 'task-1',
      output: null,
      existingResultAssetIds: [],
    });
    expect(outcome.reason).toBe('output-too-short');
    expect(mocks.prisma.iMAsset.create).not.toHaveBeenCalled();
  });

  it('exposes the threshold constant', () => {
    expect(MATERIALIZE_MIN_OUTPUT_CHARS).toBe(200);
    expect(LONG_OUTPUT.trim().length).toBeGreaterThanOrEqual(MATERIALIZE_MIN_OUTPUT_CHARS);
  });
});
