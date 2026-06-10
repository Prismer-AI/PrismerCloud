/**
 * @vitest-environment jsdom
 *
 * Wave 3 C1 — useReconciledStream hook tests.
 *
 * The hook is the SoT for §4.1 reconcile semantics. Testing it directly
 * (instead of through `im-channel.tsx` which has hundreds of unrelated
 * dependencies) is the focused-blast-radius pattern other workspace
 * component tests already follow.
 *
 * Coverage:
 *   - im-channel-reconcile: SSE drops 1 event → gap detected → catchUp fires
 *     → buffered event drains → final state correct
 *   - im-channel-send-fail-5s: optimistic insert; no SSE echo arrives within
 *     simulated 5s → caller's watchdog fires patchLocal(failed=true)
 *   - im-channel-refresh-cursor: unmount + remount with same scope → cursor
 *     restored from localStorage, initialLoader's lastSeq is dominated
 */

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useReconciledStream,
  type ReconciledItem,
  type UseReconciledStreamResult,
} from '../use-reconciled-stream';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface MsgItem extends ReconciledItem {
  id: string;
  boundarySeq?: number | null;
  content: string;
  failed?: boolean;
  pending?: boolean;
  idempotencyKey?: string | null;
}

function mountHook<T>(
  factory: () => T,
): {
  current: () => T;
  unmount: () => Promise<void>;
} {
  const ref: { value: T | null } = { value: null };
  function Harness() {
    ref.value = factory();
    return null;
  }
  const host = document.createElement('div');
  document.body.appendChild(host);
  let root: Root | null = createRoot(host);
  // Initial render must be inside act() so effects flush deterministically.
  // We don't await this synchronously because tests typically await effects
  // via subsequent act() blocks themselves.
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  act(() => {
    root!.render(<Harness />);
  });
  return {
    current: () => ref.value as T,
    unmount: async () => {
      await act(async () => {
        root!.unmount();
        root = null;
      });
      host.remove();
    },
  };
}

beforeEach(() => {
  // Each test gets a clean localStorage so cursor leakage doesn't cross runs.
  window.localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useReconciledStream — Wave 3 C1', () => {
  it('im-channel-reconcile: SSE drops one event → catchUp fires → buffered event drains', async () => {
    const catchUp = vi.fn(async (afterSeq: number) => ({
      // Cloud returns the missing seq=2 event.
      items: [{ id: 'srv-2', boundarySeq: 2, content: 'lost-msg' } as MsgItem].filter(
        (e) => (e.boundarySeq ?? 0) > afterSeq,
      ),
    }));
    const initialLoader = vi.fn(async () => ({
      items: [{ id: 'srv-1', boundarySeq: 1, content: 'first' } as MsgItem],
      lastSeq: 1,
    }));

    const handle = mountHook<UseReconciledStreamResult<MsgItem>>(() =>
      useReconciledStream<MsgItem>({
        scope: { kind: 'conversation', id: 'cv-reconcile' },
        initialLoader,
        catchUp,
      }),
    );

    // Flush the initial load promise + effect.
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(handle.current().lastSeq).toBe(1);
    expect(handle.current().items.map((i) => i.id)).toEqual(['srv-1']);

    // SSE delivers seq=3 but seq=2 is missing → expect 'buffered'.
    let result: 'applied' | 'dropped' | 'buffered' | null = null;
    await act(async () => {
      result = handle.current().applyExternal({
        id: 'srv-3',
        boundarySeq: 3,
        content: 'after-gap',
      });
    });
    expect(result).toBe('buffered');
    expect(catchUp).toHaveBeenCalledTimes(1);
    expect(catchUp).toHaveBeenCalledWith(1);

    // Let the catchUp promise resolve and the buffered drain run.
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Final state: all three rows applied in seq order, cursor at 3.
    const ids = handle.current().items.map((i) => i.id);
    expect(ids).toEqual(['srv-1', 'srv-2', 'srv-3']);
    expect(handle.current().lastSeq).toBe(3);
    // Cursor persisted to localStorage.
    expect(window.localStorage.getItem('cursor:conversation:cv-reconcile')).toBe('3');

    await handle.unmount();
  });

  it('im-channel-send-fail-5s: optimistic insert + 5s timeout → patchLocal(failed=true) red badge', async () => {
    vi.useFakeTimers();
    const initialLoader = vi.fn(async () => ({ items: [], lastSeq: 0 }));
    const catchUp = vi.fn(async () => ({ items: [] }));

    const handle = mountHook<UseReconciledStreamResult<MsgItem>>(() =>
      useReconciledStream<MsgItem>({
        scope: { kind: 'conversation', id: 'cv-fail' },
        initialLoader,
        catchUp,
      }),
    );

    // Flush initial load.
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    // Simulate the im-channel.tsx send path: insert optimistic, arm 5s timer
    // that flips `failed: true` if no echo lands. This mirrors the arm5sTimeout
    // closure semantics — we replay them here without mounting the full UI.
    const idemKey = 'idem-abc-123';
    const optimistic: MsgItem = {
      id: idemKey,
      content: 'hello',
      pending: true,
      idempotencyKey: idemKey,
      boundarySeq: null,
    };
    await act(async () => {
      handle.current().markLocal(optimistic);
    });
    expect(handle.current().items[0].id).toBe(idemKey);
    expect(handle.current().items[0].pending).toBe(true);
    expect(handle.current().items[0].failed).toBeFalsy();

    const timer = setTimeout(() => {
      handle.current().patchLocal(idemKey, { pending: false, failed: true });
    }, 5_000);

    // Advance 4.9s — should still be pending.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_900);
    });
    expect(handle.current().items[0].failed).toBeFalsy();
    expect(handle.current().items[0].pending).toBe(true);

    // Advance past 5s.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(handle.current().items[0]).toMatchObject({ failed: true, pending: false });

    clearTimeout(timer);
    await handle.unmount();
  });

  it('im-channel-refresh-cursor: unmount + remount → cursor restored from localStorage', async () => {
    // First mount: apply seq=1..3, cursor persisted to localStorage.
    const initialLoader1 = vi.fn(async () => ({
      items: [
        { id: 'srv-1', boundarySeq: 1, content: 'a' } as MsgItem,
        { id: 'srv-2', boundarySeq: 2, content: 'b' } as MsgItem,
        { id: 'srv-3', boundarySeq: 3, content: 'c' } as MsgItem,
      ],
      lastSeq: 3,
    }));
    const catchUp1 = vi.fn(async () => ({ items: [] }));

    const handle1 = mountHook<UseReconciledStreamResult<MsgItem>>(() =>
      useReconciledStream<MsgItem>({
        scope: { kind: 'conversation', id: 'cv-refresh' },
        initialLoader: initialLoader1,
        catchUp: catchUp1,
      }),
    );

    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(handle1.current().lastSeq).toBe(3);
    expect(window.localStorage.getItem('cursor:conversation:cv-refresh')).toBe('3');

    // Simulate the user applying one more SSE event (seq=4) — cursor moves.
    await act(async () => {
      handle1.current().applyExternal({ id: 'srv-4', boundarySeq: 4, content: 'd' });
    });
    expect(handle1.current().lastSeq).toBe(4);
    expect(window.localStorage.getItem('cursor:conversation:cv-refresh')).toBe('4');

    await handle1.unmount();

    // Second mount: initialLoader claims lastSeq=3 (e.g. server pagination
    // didn't include the seq=4 row), but localStorage has 4. The hook should
    // honor the higher (localStorage) cursor.
    const initialLoader2 = vi.fn(async () => ({
      items: [
        { id: 'srv-1', boundarySeq: 1, content: 'a' } as MsgItem,
        { id: 'srv-2', boundarySeq: 2, content: 'b' } as MsgItem,
        { id: 'srv-3', boundarySeq: 3, content: 'c' } as MsgItem,
      ],
      lastSeq: 3,
    }));
    const catchUp2 = vi.fn(async () => ({ items: [] }));

    const handle2 = mountHook<UseReconciledStreamResult<MsgItem>>(() =>
      useReconciledStream<MsgItem>({
        scope: { kind: 'conversation', id: 'cv-refresh' },
        initialLoader: initialLoader2,
        catchUp: catchUp2,
      }),
    );

    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(handle2.current().lastSeq).toBe(4);

    // SSE delivers seq=5 next (the natural continuation). No gap should
    // be detected — cursor moves from 4 to 5.
    let result: 'applied' | 'dropped' | 'buffered' | null = null;
    await act(async () => {
      result = handle2.current().applyExternal({ id: 'srv-5', boundarySeq: 5, content: 'e' });
    });
    expect(result).toBe('applied');
    expect(catchUp2).not.toHaveBeenCalled();
    expect(handle2.current().lastSeq).toBe(5);

    // SSE re-delivers seq=4 (the one the user applied before unmount). The
    // hook should drop it as a dup since cursor is now 5.
    await act(async () => {
      result = handle2.current().applyExternal({ id: 'srv-4', boundarySeq: 4, content: 'd-dup' });
    });
    expect(result).toBe('dropped');
    expect(handle2.current().lastSeq).toBe(5);

    await handle2.unmount();
  });

  it('boundarySeq=null items apply by id only, do not advance cursor (legacy compat)', async () => {
    // Edge case: pre-§4.1 events have NULL boundarySeq. The hook must apply
    // them so legacy data isn't dropped, but must not perturb the cursor
    // (which would create false gaps).
    const initialLoader = vi.fn(async () => ({ items: [], lastSeq: 0 }));
    const catchUp = vi.fn(async () => ({ items: [] }));

    const handle = mountHook<UseReconciledStreamResult<MsgItem>>(() =>
      useReconciledStream<MsgItem>({
        scope: { kind: 'conversation', id: 'cv-legacy' },
        initialLoader,
        catchUp,
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });

    let result: 'applied' | 'dropped' | 'buffered' | null = null;
    await act(async () => {
      result = handle.current().applyExternal({
        id: 'legacy-1',
        boundarySeq: null,
        content: 'pre-§4.1',
      });
    });
    expect(result).toBe('applied');
    expect(handle.current().lastSeq).toBe(0);
    expect(handle.current().items[0].id).toBe('legacy-1');
    expect(catchUp).not.toHaveBeenCalled();

    await handle.unmount();
  });

  it('idempotencyKey echo match: optimistic + server twin → swap by removeLocal+markLocal', async () => {
    // Simulates the im-channel.tsx pattern: optimistic row keyed by
    // idempotencyKey, SSE echo arrives with the same idempotencyKey + a real
    // server id. The owner code calls removeLocal(optimisticId) THEN
    // applyExternal(serverRow); the hook should hold one row with the server id.
    const initialLoader = vi.fn(async () => ({ items: [], lastSeq: 0 }));
    const catchUp = vi.fn(async () => ({ items: [] }));

    const handle = mountHook<UseReconciledStreamResult<MsgItem>>(() =>
      useReconciledStream<MsgItem>({
        scope: { kind: 'conversation', id: 'cv-idem' },
        initialLoader,
        catchUp,
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });

    const idemKey = 'idem-uuid-001';
    await act(async () => {
      handle.current().markLocal({
        id: idemKey,
        content: 'hi',
        pending: true,
        idempotencyKey: idemKey,
        boundarySeq: null,
      });
    });
    expect(handle.current().items.length).toBe(1);
    expect(handle.current().items[0].id).toBe(idemKey);

    // SSE echo arrives with server id + boundarySeq.
    await act(async () => {
      handle.current().removeLocal(idemKey);
      handle.current().applyExternal({
        id: 'srv-real-id',
        content: 'hi',
        idempotencyKey: idemKey,
        boundarySeq: 1,
      });
    });

    expect(handle.current().items.length).toBe(1);
    expect(handle.current().items[0].id).toBe('srv-real-id');
    expect(handle.current().items[0].boundarySeq).toBe(1);
    expect(handle.current().lastSeq).toBe(1);

    await handle.unmount();
  });
});
