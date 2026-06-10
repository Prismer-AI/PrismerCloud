// release201/30 §7 Phase 3 — daemon trace helper smoke tests.
//
// Focused on the helper itself (no full dispatch.ts import) so the test
// avoids the @iarna/toml SDK-install requirement.

import { describe, expect, it, vi } from 'vitest';
import {
  generateDaemonFallbackTraceId,
  makeTraceStderr,
  resolveDispatchTraceId,
} from '../src/daemon/trace.js';

describe('daemon trace helper', () => {
  it('generateDaemonFallbackTraceId emits the documented prefix', () => {
    const id = generateDaemonFallbackTraceId();
    expect(id.startsWith('daemon-fallback-')).toBe(true);
    expect(id.length).toBeGreaterThan('daemon-fallback-'.length);
  });

  it('resolveDispatchTraceId returns cloud id when shape-valid', () => {
    expect(resolveDispatchTraceId('trace_abc123')).toBe('trace_abc123');
    expect(resolveDispatchTraceId('trace_s_xy0987')).toBe('trace_s_xy0987');
  });

  it('resolveDispatchTraceId falls back when missing / malformed', () => {
    expect(resolveDispatchTraceId(undefined).startsWith('daemon-fallback-')).toBe(true);
    expect(resolveDispatchTraceId(null).startsWith('daemon-fallback-')).toBe(true);
    expect(resolveDispatchTraceId('').startsWith('daemon-fallback-')).toBe(true);
    expect(resolveDispatchTraceId('bad value/with spaces').startsWith('daemon-fallback-')).toBe(
      true,
    );
    expect(resolveDispatchTraceId('a'.repeat(50)).startsWith('daemon-fallback-')).toBe(true);
  });

  it('makeTraceStderr prefixes lines and guarantees newline', () => {
    const captured: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      captured.push(String(chunk));
      return true;
    });

    try {
      const write = makeTraceStderr('trace_t1');
      write('[daemon] hello');
      write('[daemon] world\n');
      expect(captured).toEqual(['[trace=trace_t1] [daemon] hello\n', '[trace=trace_t1] [daemon] world\n']);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
