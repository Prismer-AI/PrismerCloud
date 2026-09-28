// Desktop-202 doc 18 §4c — Hermes MemoryProvider shell install.
//
// Verifies the provider shell (plugins/memory/prismer/) resolves on disk and
// copies into a profile's plugins dir. The full config.yaml `memory.provider:
// prismer` pin is exercised through ensureService (which spawns hermes) and is
// out of unit scope; this proves the install mechanism the config write gates on.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, cpSync, mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installMemoryProviderShell,
  resolveMemoryProviderShellSource,
} from '../src/adapters/persistence/hermes/index.js';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prismer-provider-'));
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('memory provider shell install (doc 18 §4)', () => {
  it('resolves the on-disk shell source (plugins/memory/prismer)', () => {
    const src = resolveMemoryProviderShellSource();
    expect(src).not.toBeNull();
    expect(existsSync(join(src!, '__init__.py'))).toBe(true);
    expect(existsSync(join(src!, 'plugin.yaml'))).toBe(true);
  });

  it('copies the shell into the profile plugins dir (the B-path正门 install)', () => {
    const ok = installMemoryProviderShell(dir);
    expect(ok).toBe(true);
    // Hermes's memory-provider scanner discovers USER providers at
    // `<profile>/plugins/<name>/` directly (the `memory/` segment is only for
    // BUNDLED providers). Installing under `plugins/memory/prismer/` is NEVER
    // discovered — verified live. The dest MUST be `plugins/prismer/`.
    const dest = join(dir, 'plugins', 'prismer', '__init__.py');
    expect(existsSync(dest)).toBe(true);
    // Guard against regressing to the undiscoverable nested layout.
    expect(existsSync(join(dir, 'plugins', 'memory', 'prismer', '__init__.py'))).toBe(false);
    const py = readFileSync(dest, 'utf8');
    // The shell registers the recall-tools正门 (memory_search / memory_load).
    expect(py).toContain('memory_search');
    expect(py).toContain('memory_load');
    expect(py).toContain('get_tool_schemas');
  });

  it('is a no-write success when a restored read-only profile already has the current shell', () => {
    expect(installMemoryProviderShell(dir)).toBe(true);
    const dest = join(dir, 'plugins', 'prismer');
    chmodSync(dest, 0o555);
    try {
      expect(installMemoryProviderShell(dir)).toBe(true);
    } finally {
      chmodSync(dest, 0o755);
    }
  });

  it('atomically upgrades changed shell bytes when checkpoint files are 0444', () => {
    expect(installMemoryProviderShell(dir)).toBe(true);
    const dest = join(dir, 'plugins', 'prismer');
    chmodSync(join(dest, '__init__.py'), 0o444);
    chmodSync(join(dest, 'plugin.yaml'), 0o444);

    const source = join(dir, 'next-provider');
    cpSync(resolveMemoryProviderShellSource()!, source, { recursive: true });
    writeFileSync(join(source, '__init__.py'), `${readFileSync(join(source, '__init__.py'), 'utf8')}\n# checkpoint-upgrade\n`);
    const previous = process.env.PRISMER_MEMORY_PROVIDER_SHELL;
    process.env.PRISMER_MEMORY_PROVIDER_SHELL = source;
    try {
      expect(installMemoryProviderShell(dir)).toBe(true);
      expect(readFileSync(join(dest, '__init__.py'), 'utf8')).toContain('# checkpoint-upgrade');
      expect(readdirSync(join(dir, 'plugins')).some((name) => name.startsWith('prismer.backup-'))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.PRISMER_MEMORY_PROVIDER_SHELL;
      else process.env.PRISMER_MEMORY_PROVIDER_SHELL = previous;
    }
  });

  it('falls back (returns false, no throw) when the shell source is unresolvable', () => {
    const prev = process.env.PRISMER_MEMORY_PROVIDER_SHELL;
    process.env.PRISMER_MEMORY_PROVIDER_SHELL = join(dir, 'does-not-exist');
    try {
      // cpSync of a missing src returns false via the catch — degrade-not-break.
      const ok = installMemoryProviderShell(dir);
      expect(ok).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.PRISMER_MEMORY_PROVIDER_SHELL;
      else process.env.PRISMER_MEMORY_PROVIDER_SHELL = prev;
    }
  });
});
