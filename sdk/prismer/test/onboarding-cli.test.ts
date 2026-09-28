import { describe, expect, it } from 'vitest';
import { buildPairCommand } from '../src/cli/commands/pair.js';
import { buildSetupCommand } from '../src/cli/commands/setup.js';

describe('runtime onboarding command semantics', () => {
  it('keeps setup as the canonical runtime binding command', () => {
    const cmd = buildSetupCommand();
    const help = cmd.helpInformation();

    expect(cmd.description()).toContain('bind it to Prismer Cloud');
    expect(help).toContain('Set up this local runtime');
    expect(help).toContain('Legacy QR approval setup path');
    expect(help).toContain('Automation/test only');
    expect(help).toContain('--no-browser');
    expect(help).toContain('--no-start');
  });

  it('keeps pair explicitly legacy so it cannot be mistaken for setup', () => {
    const cmd = buildPairCommand();
    const help = cmd.helpInformation();

    expect(cmd.description()).toContain('Legacy QR approval path');
    // v2.0: daemon CLI keeps `bin.prismer` (@prismer/runtime owns the canonical
    // `prismer` binary — daemon priority is higher than SDK). The user-facing
    // CLI (@prismer/sdk) was renamed `prismer` → `cloud`. The pair command's
    // description points users at the canonical setup verb, `prismer setup`.
    expect(cmd.description()).toContain('prismer setup');
    expect(help).toContain('Friendly name shown to the approver in mobile UI');
    expect(help).toContain('LAN-dev bypass');
  });
});
