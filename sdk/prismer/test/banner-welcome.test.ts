import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBannerCommand } from '../src/cli/commands/banner.js';

describe('prismer banner welcome line', () => {
  let stdout = '';
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdout = '';
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      stdout += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  // ── T0: exit code invariants ──────────────────────────────────
  // The banner command must always resolve cleanly (exit 0) in both
  // compact and non-compact modes.  A reject/throw means the CLI
  // entry point itself is broken — not a content problem.

  it('T0: exits with code 0 on non-compact call', async () => {
    const cmd = buildBannerCommand();
    await expect(cmd.parseAsync(['banner'], { from: 'user' })).resolves.toBeDefined();
  });

  it('T0: exits with code 0 on --compact call', async () => {
    const cmd = buildBannerCommand();
    await expect(cmd.parseAsync(['banner', '--compact'], { from: 'user' })).resolves.toBeDefined();
  });

  // ── T0: welcome line text contract ────────────────────────────
  // The welcome line is declared as a "local-feed OTA oracle" in
  // banner.ts (M4-2 comment) — its exact text and position are
  // stable contracts.  It must appear verbatim and be the very
  // first thing written to stdout (written before printBanner()).

  it('T0: welcome line "Welcome to Prismer Cloud" is first line of stdout', async () => {
    const cmd = buildBannerCommand();
    await cmd.parseAsync(['banner'], { from: 'user' });
    expect(stdout).toMatch(/^Welcome to Prismer Cloud\n/);
  });

  // ── T0: compact mode still produces output ────────────────────
  // --compact suppresses the welcome line but must still call
  // printBanner({compact:true}) → smallHeader → UI output.
  // Empty stdout on --compact means the banner subsystem is
  // silently dead.

  it('T0: compact mode still produces banner output (non-empty)', async () => {
    const cmd = buildBannerCommand();
    await cmd.parseAsync(['banner', '--compact'], { from: 'user' });
    expect(stdout.length).toBeGreaterThan(0);
  });

  // ── Content-level assertions (non-T0, descriptive) ───────────

  it('writes "Welcome to Prismer Cloud" on non-compact call', async () => {
    const cmd = buildBannerCommand();
    await cmd.parseAsync(['banner'], { from: 'user' });
    expect(stdout).toContain('Welcome to Prismer Cloud\n');
  });

  it('does NOT write "Welcome to Prismer Cloud" on --compact call', async () => {
    const cmd = buildBannerCommand();
    await cmd.parseAsync(['banner', '--compact'], { from: 'user' });
    expect(stdout).not.toContain('Welcome to Prismer Cloud');
  });
});
