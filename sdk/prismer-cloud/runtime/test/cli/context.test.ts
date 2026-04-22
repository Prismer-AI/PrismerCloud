import { describe, it, expect } from 'vitest';
import { createCliContext } from '../../src/cli/context.js';
import { UI } from '../../src/cli/ui.js';

// ============================================================
// CTX-1: argv-driven UI mode
// ============================================================

describe('createCliContext', () => {
  it('CTX-1: argv --json produces context with ui.mode === json', async () => {
    const ctx = await createCliContext({ argv: ['node', 'prismer', '--json'] });
    expect(ctx.ui.mode).toBe('json');
  });

  it('CTX-2: injected ui is used as-is (not replaced by argv parsing)', async () => {
    const stream = {
      write: () => true,
      isTTY: false,
    } as unknown as NodeJS.WritableStream;
    const injected = new UI({ mode: 'quiet', color: false, stream, errStream: stream });
    const ctx = await createCliContext({ argv: ['node', 'prismer', '--json'], ui: injected });
    expect(ctx.ui).toBe(injected);
    expect(ctx.ui.mode).toBe('quiet'); // injected UI, not replaced by --json
  });

  it('CTX-3: cwd is set to process.cwd()', async () => {
    const ctx = await createCliContext({ argv: ['node', 'prismer'] });
    expect(ctx.cwd).toBe(process.cwd());
  });

  it('CTX-4: argv is stored on context', async () => {
    const argv = ['node', 'prismer', '--quiet'];
    const ctx = await createCliContext({ argv });
    expect(ctx.argv).toBe(argv);
  });

  it('CTX-5: config is not on the context (use loadConfig() explicitly)', async () => {
    const ctx = await createCliContext({ argv: ['node', 'prismer'] });
    // config field was removed from CliContext (Q9); use loadConfig() directly.
    expect('config' in ctx).toBe(false);
  });

  it('CTX-6: keychain instance is provided', async () => {
    const ctx = await createCliContext({ argv: ['node', 'prismer'] });
    expect(ctx.keychain).toBeDefined();
  });
});
