/**
 * Tier Enforcement CLI Commands
 *
 * Implements Tier-based permission checking and management for PARA adapters.
 *
 * Reference: docs/version190/04-sandbox-permissions.md §5.2
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';
import type { CliContext } from '../cli/context.js';
import type { UI } from '../cli/ui.js';
import { createCliContext } from '../cli/context.js';

// ============================================================
// Types
// ============================================================

interface TierInfo {
  tier: number;
  name: string;
  description: string;
  capabilities: string[];
  restrictions: string[];
}

interface TierConfig {
  activeTier: number;
  supportedTiers: number[];
  agentId?: string;
  adapter?: string;
}

interface PermissionRule {
  source: string;
  behavior: 'allow' | 'deny' | 'ask';
  value: {
    tool: string;
    pattern?: string;
  };
  tier?: number;
}

// ============================================================
// Tier Definitions (per §5.2)
// ============================================================

const TIERS: readonly TierInfo[] = [
  {
    tier: 1,
    name: 'Sandbox',
    description: 'Read-only preview, no side-effects',
    capabilities: ['read-files', 'search-files', 'list-files'],
    restrictions: ['write-files', 'execute-commands', 'network-access'],
  },
  {
    tier: 2,
    name: 'Trusted',
    description: 'Safe file edits and commands with approval',
    capabilities: ['read-files', 'search-files', 'list-files', 'edit-files', 'execute-commands'],
    restrictions: ['network-access', 'system-commands'],
  },
  {
    tier: 3,
    name: 'Privileged',
    description: 'Most operations with approval',
    capabilities: ['read-files', 'search-files', 'list-files', 'edit-files', 'write-files', 'execute-commands'],
    restrictions: ['system-commands', 'dangerous-commands'],
  },
  {
    tier: 4,
    name: 'Admin',
    description: 'All operations with approval',
    capabilities: ['read-files', 'search-files', 'list-files', 'edit-files', 'write-files', 'execute-commands', 'system-commands'],
    restrictions: ['dangerous-commands'],
  },
  {
    tier: 5,
    name: 'Unrestricted',
    description: 'All operations without approval',
    capabilities: ['read-files', 'search-files', 'list-files', 'edit-files', 'write-files', 'execute-commands', 'system-commands', 'dangerous-commands'],
    restrictions: [],
  },
] as const;

function readDaemonPort(): number {
  const portFile = path.join(os.homedir(), '.prismer', 'daemon.port');
  try {
    const raw = fs.readFileSync(portFile, 'utf-8').trim();
    const port = parseInt(raw, 10);
    if (Number.isFinite(port) && port > 0) return port;
  } catch {
    // Use default runtime port.
  }
  return 3210;
}

function requestJson(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const port = readDaemonPort();
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
        },
      },
      (res) => {
        let responseData = '';
        res.on('data', (chunk) => {
          responseData += chunk.toString('utf-8');
        });
        res.on('end', () => {
          if (!responseData) {
            resolve({});
            return;
          }

          try {
            const parsed = JSON.parse(responseData) as Record<string, unknown>;
            if ((res.statusCode ?? 500) >= 400) {
              const message =
                typeof parsed['message'] === 'string'
                  ? parsed['message']
                  : typeof parsed['error'] === 'string'
                    ? parsed['error']
                    : `HTTP ${res.statusCode ?? 500}`;
              reject(new Error(message));
              return;
            }
            resolve(parsed);
          } catch (err) {
            reject(
              new Error(
                err instanceof Error ? err.message : 'Invalid JSON response from daemon',
              ),
            );
          }
        });
      },
    );

    req.on('error', (err) => {
      reject(
        new Error(
          `daemon unreachable on 127.0.0.1:${port}; start it with "prismer daemon start" (${err.message})`,
        ),
      );
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// ============================================================
// Tier List Command
// ============================================================

async function tierList(ctx: CliContext, options: { agentId?: string }): Promise<void> {
  const payload = await requestJson('GET', `/api/v1/tier${options.agentId ? `?agentId=${encodeURIComponent(options.agentId)}` : ''}`);
  const config = payload as Record<string, unknown>;

  if (ctx.ui.mode === 'json') {
    ctx.ui.json({ ok: true, tiers: TIERS, config });
    return;
  }

  ctx.ui.header('Prismer Tier Configuration');
  ctx.ui.blank();

  // Display current configuration
  if (typeof config['activeTier'] === 'number') {
    const currentTier = TIERS.find((t) => t.tier === config['activeTier']);
    if (currentTier) {
      ctx.ui.success(`Current Tier: ${currentTier.tier} — ${currentTier.name}`);
      ctx.ui.secondary(`  ${currentTier.description}`);
    }
  }

  if (Array.isArray(config['supportedTiers'])) {
    ctx.ui.info(`Supported Tiers: ${(config['supportedTiers'] as number[]).join(', ')}`);
  }

  if (typeof config['agentId'] === 'string') {
    ctx.ui.info(`Agent ID: ${config['agentId']}`);
  }

  if (typeof config['adapter'] === 'string') {
    ctx.ui.info(`Adapter: ${config['adapter']}`);
  }

  ctx.ui.blank();
  ctx.ui.header('Available Tiers');
  ctx.ui.blank();

  // Display all tiers
  ctx.ui.table(
    TIERS.map((tier) => ({
      TIER: String(tier.tier),
      NAME: tier.name,
      CAPABILITIES: tier.capabilities.join(', '),
      RESTRICTIONS: tier.restrictions.join(', ') || 'None',
    })),
    { columns: ['TIER', 'NAME', 'CAPABILITIES', 'RESTRICTIONS'] },
  );
}

// ============================================================
// Tier Manage Command
// ============================================================

async function tierManage(
  ctx: CliContext,
  options: {
    agentId?: string;
    setTier?: number;
    enableCapability?: string;
    disableCapability?: string;
  },
): Promise<void> {
  if (!options.agentId) {
    ctx.ui.error('Agent ID is required for tier management');
    ctx.ui.tip('Use --agent-id <id> to specify the target agent');
    return;
  }

  if (options.setTier !== undefined) {
    const tier = TIERS.find((t) => t.tier === options.setTier);
    if (!tier) {
      ctx.ui.error(`Invalid tier: ${options.setTier}. Valid tiers: ${TIERS.map((t) => t.tier).join(', ')}`);
      return;
    }

    try {
      await requestJson('PATCH', `/api/v1/tier/${encodeURIComponent(options.agentId)}`, {
        tier: options.setTier,
      });
      ctx.ui.success(`Tier set to ${options.setTier} (${tier.name})`);
    } catch (err) {
      ctx.ui.error(`Failed to set tier: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  if (options.enableCapability) {
    try {
      await requestJson('POST', `/api/v1/tier/${encodeURIComponent(options.agentId)}/capabilities`, {
        capability: options.enableCapability,
        action: 'enable',
      });
      ctx.ui.success(`Enabled capability: ${options.enableCapability}`);
    } catch (err) {
      ctx.ui.error(`Failed to enable capability: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  if (options.disableCapability) {
    try {
      await requestJson('POST', `/api/v1/tier/${encodeURIComponent(options.agentId)}/capabilities`, {
        capability: options.disableCapability,
        action: 'disable',
      });
      ctx.ui.success(`Disabled capability: ${options.disableCapability}`);
    } catch (err) {
      ctx.ui.error(`Failed to disable capability: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  ctx.ui.error('No action specified');
  ctx.ui.tip('Use --set-tier <n>, --enable-capability <name>, or --disable-capability <name>');
}

// ============================================================
// Tier Debug Command
// ============================================================

async function tierDebug(
  ctx: CliContext,
  options: {
    agentId?: string;
    tool?: string;
    args?: string;
  },
): Promise<void> {
  if (!options.agentId) {
    ctx.ui.error('Agent ID is required for tier debug');
    ctx.ui.tip('Use --agent-id <id> to specify the target agent');
    return;
  }

  if (!options.tool) {
    ctx.ui.error('Tool name is required for tier debug');
    ctx.ui.tip('Use --tool <name> to specify the tool to test');
    return;
  }

  ctx.ui.header(`Tier Debug: ${options.tool}`);
  ctx.ui.blank();

  try {
    const payload = await requestJson('POST', `/api/v1/tier/${encodeURIComponent(options.agentId)}/debug`, {
      tool: options.tool,
      args: options.args,
    });
    const result = payload as Record<string, unknown>;

    if (ctx.ui.mode === 'json') {
      ctx.ui.json({ ok: true, result });
      return;
    }

    // Display permission decision
    const decision = typeof result['decision'] === 'string' ? result['decision'] : 'unknown';
    const reason = typeof result['reason'] === 'string' ? result['reason'] : 'no reason provided';
    const tier = typeof result['tier'] === 'number' ? result['tier'] : undefined;

    if (decision === 'allow') {
      ctx.ui.success(`Decision: ALLOW`);
    } else if (decision === 'deny') {
      ctx.ui.error(`Decision: DENY`);
    } else {
      ctx.ui.warn(`Decision: ASK`);
    }

    ctx.ui.info(`Reason: ${reason}`);

    if (tier !== undefined) {
      const tierInfo = TIERS.find((t) => t.tier === tier);
      if (tierInfo) {
        ctx.ui.info(`Current Tier: ${tier} (${tierInfo.name})`);
        ctx.ui.secondary(`  ${tierInfo.description}`);
      }
    }

    if (typeof result['matchedRule'] === 'object' && result['matchedRule'] !== null) {
      const rule = result['matchedRule'] as Record<string, unknown>;
      ctx.ui.info(`Matched Rule:`);
      if (typeof rule['source'] === 'string') {
        ctx.ui.secondary(`  Source: ${rule['source']}`);
      }
      if (typeof rule['behavior'] === 'string') {
        ctx.ui.secondary(`  Behavior: ${rule['behavior']}`);
      }
      if (typeof rule['value'] === 'object') {
        const value = rule['value'] as Record<string, unknown>;
        if (typeof value['tool'] === 'string') {
          ctx.ui.secondary(`  Tool: ${value['tool']}`);
        }
        if (typeof value['pattern'] === 'string') {
          ctx.ui.secondary(`  Pattern: ${value['pattern']}`);
        }
      }
    }

    if (typeof result['frozen'] === 'boolean' && result['frozen']) {
      ctx.ui.error('⚠️  File is FROZEN — permission cannot be overridden');
    }

  } catch (err) {
    ctx.ui.error(`Debug request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ============================================================
// Command Registration
// ============================================================

export function registerTierCommands(program: Command, ui: UI): void {
  const tierCmd = program.command('tier').description('Manage tier-based permissions');

  tierCmd
    .command('list')
    .option('--agent-id <id>', 'Filter by agent ID')
    .action(async (options: { agentId?: string }) => {
      const ctx = await createCliContext({ argv: process.argv, ui });
      await tierList(ctx, options);
    });

  tierCmd
    .command('manage')
    .option('--agent-id <id>', 'Target agent ID (required)')
    .option('--set-tier <n>', 'Set tier level (1-5)')
    .option('--enable-capability <name>', 'Enable a capability')
    .option('--disable-capability <name>', 'Disable a capability')
    .action(async (options: { agentId?: string; setTier?: string; enableCapability?: string; disableCapability?: string }) => {
      const ctx = await createCliContext({ argv: process.argv, ui });
      await tierManage(ctx, {
        agentId: options.agentId,
        setTier: options.setTier ? parseInt(options.setTier, 10) : undefined,
        enableCapability: options.enableCapability,
        disableCapability: options.disableCapability,
      });
    });

  tierCmd
    .command('debug')
    .option('--agent-id <id>', 'Target agent ID (required)')
    .option('--tool <name>', 'Tool name to test (required)')
    .option('--args <string>', 'Tool arguments to test')
    .action(async (options: { agentId?: string; tool?: string; args?: string }) => {
      const ctx = await createCliContext({ argv: process.argv, ui });
      await tierDebug(ctx, options);
    });
}
