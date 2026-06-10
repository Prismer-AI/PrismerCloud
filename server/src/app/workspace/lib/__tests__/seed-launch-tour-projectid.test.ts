/**
 * @vitest-environment jsdom
 *
 * release201 v2.0.8 UX A3 — projectId 继承.
 *
 * 用户在 simple mode 走完引导后, 期望看板上立刻能看到 "向我介绍 Prismer Cloud
 * 这个产品" 这张 demo task. 引导流程先调 `ensureSimpleModeProject` 把
 * "{org} 主项目" 的 id 写入 `prismer_active_project_<wsId>`, 之后 reloadTasks
 * 也带着这个 id 当 query 过滤. 如果 `seedLaunchTourContent` 创建 task 时不
 * 显式 forward projectId, task 落 NULL, board 视图按 active project 过滤把
 * 它过滤掉.
 *
 * 这个测试锁定 fix: seed 时从 localStorage 读 active filter, 真实项目 id
 * 直接 forward 给 createTask; sentinel ('all' / '__unscoped') 不 forward
 * (task 落 NULL, 在 "All" / "Unscoped" 两种过滤下仍可见).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// MUST be hoisted before importing the SUT — mutations.ts 模块级 import
// `imFetch` 必须 stub 在求值前.
vi.mock('../im-api', () => {
  const imFetch = vi.fn();
  return { imFetch };
});

// uploadAssetWithDirectFallback 走它自己的 imFetch 注入 — 这里 stub 防止
// asset 上传分支真发网络. 我们只关心 task 分支的 projectId 行为.
vi.mock('../asset-upload', () => ({
  uploadAssetWithDirectFallback: vi.fn(),
}));

import { seedLaunchTourContent } from '../mutations';
import { imFetch } from '../im-api';
import { uploadAssetWithDirectFallback } from '../asset-upload';
import { activeProjectStorageKey, PROJECT_FILTER_ALL, PROJECT_FILTER_UNSCOPED } from '../projects-api';

const WORKSPACE_ID = 'cmp_ws_test';
const CONVERSATION_ID = 'cmp_conv_test';
const AGENT_ID = 'cmp_agent_test';

type ImFetchMock = ReturnType<typeof vi.fn> & typeof imFetch;
const mockImFetch = imFetch as unknown as ImFetchMock;
const mockUploadAsset = uploadAssetWithDirectFallback as unknown as ReturnType<typeof vi.fn>;

function okEnvelope<T>(data: T) {
  return { ok: true, data };
}

beforeEach(() => {
  window.localStorage.clear();
  mockImFetch.mockReset();
  mockUploadAsset.mockReset();
  // 默认: createTask + 之后 file-row registration 都成功.
  mockImFetch.mockResolvedValue(okEnvelope({ id: 'task_stub', workspaceId: WORKSPACE_ID }));
  // asset 上传分支 stub — 与 task 分支并发, 必须返回合规 envelope 否则
  // 内部 `if (!res.ok)` 抛 TypeError, 污染 stderr.
  mockUploadAsset.mockResolvedValue(
    okEnvelope({
      id: 'asset_stub',
      workspaceId: WORKSPACE_ID,
      contentHash: 'sha-stub',
      sizeBytes: 0,
      mime: 'text/markdown',
      kind: 'file',
      createdAt: '2026-05-28T00:00:00Z',
      updatedAt: '2026-05-28T00:00:00Z',
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

function getTaskPostBody(): Record<string, unknown> | null {
  const taskCall = mockImFetch.mock.calls.find((args) => args[0] === '/tasks');
  if (!taskCall) return null;
  const init = taskCall[1] as { body?: string } | undefined;
  if (!init?.body) return null;
  return JSON.parse(init.body) as Record<string, unknown>;
}

describe('release201 v2.0.8 UX A3 — seedLaunchTourContent projectId 继承', () => {
  it('inherits active projectId from localStorage and forwards it to createTask', async () => {
    window.localStorage.setItem(activeProjectStorageKey(WORKSPACE_ID), 'p_main_xyz');

    const res = await seedLaunchTourContent({
      workspaceId: WORKSPACE_ID,
      conversationId: CONVERSATION_ID,
      agentIds: [AGENT_ID],
      organizationName: 'Acme',
    });

    expect(res).not.toBeNull();
    const body = getTaskPostBody();
    expect(body).not.toBeNull();
    expect(body!.projectId).toBe('p_main_xyz');
    expect(body!.workspaceId).toBe(WORKSPACE_ID);
    expect(body!.title).toBe('向我介绍 Prismer Cloud 这个产品');
  });

  it('omits projectId when active filter is the "all" sentinel (task lands NULL, visible in All)', async () => {
    window.localStorage.setItem(activeProjectStorageKey(WORKSPACE_ID), PROJECT_FILTER_ALL);

    await seedLaunchTourContent({
      workspaceId: WORKSPACE_ID,
      conversationId: CONVERSATION_ID,
      agentIds: [AGENT_ID],
      organizationName: 'Acme',
    });

    const body = getTaskPostBody();
    expect(body).not.toBeNull();
    expect(body!.projectId).toBeUndefined();
  });

  it('omits projectId when active filter is the "__unscoped" sentinel', async () => {
    window.localStorage.setItem(activeProjectStorageKey(WORKSPACE_ID), PROJECT_FILTER_UNSCOPED);

    await seedLaunchTourContent({
      workspaceId: WORKSPACE_ID,
      conversationId: CONVERSATION_ID,
      agentIds: [AGENT_ID],
      organizationName: 'Acme',
    });

    const body = getTaskPostBody();
    expect(body!.projectId).toBeUndefined();
  });

  it('omits projectId when no active filter is set (fresh storage, falls back to workspace-level)', async () => {
    // localStorage 已被 beforeEach 清空.

    await seedLaunchTourContent({
      workspaceId: WORKSPACE_ID,
      conversationId: CONVERSATION_ID,
      agentIds: [AGENT_ID],
      organizationName: 'Acme',
    });

    const body = getTaskPostBody();
    expect(body!.projectId).toBeUndefined();
  });

  it('honours injected reader (used by tests / future SSR contexts) over default localStorage path', async () => {
    // localStorage 反向值 — 注入的 reader 必须胜出, 锁死可注入契约.
    window.localStorage.setItem(activeProjectStorageKey(WORKSPACE_ID), 'p_should_be_ignored');

    await seedLaunchTourContent(
      {
        workspaceId: WORKSPACE_ID,
        conversationId: CONVERSATION_ID,
        agentIds: [AGENT_ID],
        organizationName: 'Acme',
      },
      () => 'p_injected_truth',
    );

    const body = getTaskPostBody();
    expect(body!.projectId).toBe('p_injected_truth');
  });
});
