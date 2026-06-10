import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryRuntime } from '../src/daemon/memory/runtime.js';
import { attachWsInvalidate } from '../src/daemon/memory/ws-invalidate.js';

let dir = '';
let runtime: MemoryRuntime;
let ws: EventEmitter;
let dispose: () => void;
const silentLog = { info: () => {}, warn: () => {} };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prismer-ws-inval-'));
  runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_x' });
  ws = new EventEmitter();
  dispose = attachWsInvalidate({ wsClient: ws, runtime, log: silentLog });
});

afterEach(() => {
  dispose?.();
  runtime.closeAll();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function seed(workspaceId: string, path: string): { id: string } {
  const slot = runtime.resolve(workspaceId);
  const page = slot.store.write({
    workspaceId,
    path,
    content: 'x',
    pageType: 'leaf',
    actorImUserId: 'im_seed',
    actorKind: 'human',
  });
  return { id: page.id };
}

describe('attachWsInvalidate', () => {
  it('memory.invalidate event removes the page from local SQLite', () => {
    const { id } = seed('ws_test', 'a.md');
    const slot = runtime.resolve('ws_test');
    expect(slot.store.loadById(id)).not.toBeNull();

    ws.emit('message', {
      type: 'memory.invalidate',
      payload: {
        workspaceId: 'ws_test',
        pageIds: [id],
        reason: 'soft_delete',
        createdAt: new Date().toISOString(),
      },
    });

    expect(slot.store.loadById(id)).toBeNull();
  });

  it('non-memory.invalidate WS messages are ignored', () => {
    const { id } = seed('ws_test', 'a.md');
    ws.emit('message', { type: 'message.new', payload: { foo: 'bar' } });
    expect(runtime.resolve('ws_test').store.loadById(id)).not.toBeNull();
  });

  it('invalidate for a workspace without a local store is a no-op (no implicit open)', () => {
    // No prior write to ws_other → no store opened.
    const before = runtime.workspaceIds();
    expect(before).not.toContain('ws_other');

    ws.emit('message', {
      type: 'memory.invalidate',
      payload: {
        workspaceId: 'ws_other',
        pageIds: ['page_xxx'],
        reason: 'soft_delete',
      },
    });

    const after = runtime.workspaceIds();
    expect(after).toEqual(before); // still no store for ws_other
  });

  it('malformed payload is logged + ignored without throwing', () => {
    const warnings: string[] = [];
    dispose(); // reattach with capturing log
    dispose = attachWsInvalidate({
      wsClient: ws,
      runtime,
      log: { info: () => {}, warn: (m) => warnings.push(m) },
    });

    ws.emit('message', {
      type: 'memory.invalidate',
      payload: { workspaceId: 'ws_test' /* missing pageIds */ },
    });
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('disposer removes the listener', () => {
    const { id } = seed('ws_test', 'a.md');
    dispose();
    ws.emit('message', {
      type: 'memory.invalidate',
      payload: { workspaceId: 'ws_test', pageIds: [id], reason: 'soft_delete' },
    });
    expect(runtime.resolve('ws_test').store.loadById(id)).not.toBeNull();
  });
});
