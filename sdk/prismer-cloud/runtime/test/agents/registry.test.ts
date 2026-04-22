import { describe, expect, it } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { AGENT_CATALOG } from '../../src/agents/registry.js';

describe('AGENT_CATALOG install metadata', () => {
  it('points Hermes and OpenClaw at public-network install commands (Docker-reproducible)', () => {
    // v1.9.0 B.3: install commands switched from local-workspace `cd ~/workspace/agent/...`
    // forms to public network installers so Docker / CI hosts (without the dev worktree)
    // can still provision these agents. localSourcePath is kept for the install-agent
    // smoke-test step that verifies the adapter / hook config landed.
    const sourceRoot = process.env['PRISMER_AGENT_SOURCE_ROOT'] ?? path.join(os.homedir(), 'workspace', 'agent');
    const hermes = AGENT_CATALOG.find((entry) => entry.name === 'hermes');
    const openclaw = AGENT_CATALOG.find((entry) => entry.name === 'openclaw');

    expect(hermes?.localSourcePath).toBe(path.join(sourceRoot, 'hermes-agent'));
    expect(hermes?.installCommand).toBe('curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash -s -- --skip-setup');

    expect(openclaw?.localSourcePath).toBe(path.join(sourceRoot, 'openclaw'));
    expect(openclaw?.installCommand).toBe('npm install -g openclaw@latest');
  });
});
