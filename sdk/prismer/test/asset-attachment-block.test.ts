// product209/18 Part A — dispatch 附件块带可执行地址。
//
// 背景（本地 kind pod 实测事故）：hermes text 模型收到 PDF 附件时只拿到
// `[Attached file] id=… multimodal adapters receive the bytes directly`
// 一句不可执行的面包屑，字节其实已在本地 asset-cache —— agent 用 17 条
// terminal 逆向 daemon 私有 local.db 才摸到文件。
//
// 契约：
//   - 有文件系统能力的适配器：块里必须给 prismer:// URI（引用）+ file:// 路径（读）。
//   - 无文件系统能力（纯聊天/terminal 被 toolsetScope 禁用）：只给 URI +
//     旧提醒句，不诱导文件系统访问。

import { describe, expect, it } from 'vitest';
import {
  adapterHasFilesystemTools,
  formatAttachmentReminderBlock,
} from '../src/daemon/dispatch.js';
import type { AssetRef } from '../src/types/im-events.js';

const ref: AssetRef = {
  assetId: 'cmsv27zif00fvxzjwl8ig1w9j',
  contentHash: '4d48478dc0b6222d9f74d7db10ee776449b1209eb112632336544d32a49db97f',
  mime: 'application/pdf',
  sizeBytes: 2140840,
  kind: 'file',
  workspaceId: 'ws-5d113b24-75e7-4827-9',
  role: 'attachment',
  filename: 'paper.pdf',
};

const localPath = '/home/user/.prismer/cache/4d/4d48478dc0b6222d9f74d7db10ee776449b1209eb112632336544d32a49db97f';

describe('formatAttachmentReminderBlock', () => {
  it('fsCapable=true 输出 prismer:// URI + file:// 路径', () => {
    const block = formatAttachmentReminderBlock(ref, ref.mime, localPath, true);
    expect(block).toContain('uri=prismer://workspace/ws-5d113b24-75e7-4827-9/asset/4d48478dc0b6222d9f74d7db10ee776449b1209eb112632336544d32a49db97f');
    expect(block).toContain(`path=file://${localPath}`);
    expect(block).toContain('read with your file/terminal tools');
    expect(block).toContain('name=paper.pdf');
  });

  it('fsCapable=false 只给 URI + 旧提醒句，不给 path', () => {
    const block = formatAttachmentReminderBlock(ref, ref.mime, localPath, false);
    expect(block).toContain('uri=prismer://workspace/ws-5d113b24-75e7-4827-9/asset/4d48478dc0b6222d9f74d7db10ee776449b1209eb112632336544d32a49db97f');
    expect(block).not.toContain('path=file://');
    expect(block).toContain('multimodal adapters receive the bytes directly');
  });

  it('无 filename 时省略 name 字段', () => {
    const block = formatAttachmentReminderBlock({ ...ref, filename: undefined }, ref.mime, localPath, true);
    expect(block).not.toContain('name=');
    expect(block).toContain('uri=prismer://');
  });
});

describe('adapterHasFilesystemTools', () => {
  const profile = (adapterName: string, config?: unknown) => ({
    id: 'p1',
    workspaceId: 'ws-1',
    adapterName,
    config: config ?? {},
  });

  it('hermes 默认（未禁用 terminal/file）→ true', () => {
    expect(adapterHasFilesystemTools(profile('hermes', { apiKey: 'k', autoStart: true }) as never)).toBe(true);
  });

  it('hermes toolsetScope 禁用 terminal → false', () => {
    expect(
      adapterHasFilesystemTools(
        profile('hermes', { apiKey: 'k', autoStart: true, toolsetScope: { mode: 'deny', toolsets: ['terminal'] } }) as never,
      ),
    ).toBe(false);
  });

  it('hermes toolsetScope 禁用 file → false', () => {
    expect(
      adapterHasFilesystemTools(
        profile('hermes', { apiKey: 'k', autoStart: true, toolsetScope: { mode: 'deny', toolsets: ['file'] } }) as never,
      ),
    ).toBe(false);
  });

  it('coding 适配器（claude-code/codex/opencode）→ true', () => {
    expect(adapterHasFilesystemTools(profile('claude-code') as never)).toBe(true);
    expect(adapterHasFilesystemTools(profile('codex') as never)).toBe(true);
    expect(adapterHasFilesystemTools(profile('opencode') as never)).toBe(true);
  });

  it('runtime210/09 §3.2 — pi-core 内嵌引擎 → true', () => {
    expect(adapterHasFilesystemTools(profile('pi-core') as never)).toBe(true);
  });

  it('非工具适配器 → false', () => {
    expect(adapterHasFilesystemTools(profile('openclaw') as never)).toBe(false);
    expect(adapterHasFilesystemTools(profile('unknown-adapter') as never)).toBe(false);
    expect(adapterHasFilesystemTools(profile('pi') as never)).toBe(false);
  });
});
