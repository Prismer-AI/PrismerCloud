// product204/34 Track 1 M0 — persona-role capability boundary, verified at the
// CONFIG-PROJECTION layer (no live daemon / no LLM).
//
// The `persona` role template (SS-02) must give a persona-agent a discussion-only
// boundary that is a REAL gate, not prompt text:
//   • toolsetScope.deny → config.yaml `agent.disabled_toolsets` REMOVES the toolsets
//     an agent would use to create tasks (kanban/delegation) or run the `cloud
//     task|skill|pay` CLIs (terminal/code_execution) or manage skills (skills).
//   • mcpAllowlist (roleTemplate.mcpServers[@prismer/mcp-server].toolsAllowlist) →
//     config.yaml MCP allowlist OMITS the task.create / skill.install / publish MCP
//     tools while KEEPING the discussion tools (memory recall, asset read, message).
//
// Side-effect oracle = the COMPUTED projection (disabled_toolsets list + resolved
// mcp allowlist), never prose. Negative control = tamper the role config (empty
// the deny / widen the allowlist) and the projection stops gating → RED.
//
// Capabilities that are ALREADY enforced at the service layer are asserted as such,
// not double-encoded as a fake toolset deny (see the STEP-1 mapping in the M0 report):
//   • publish  → owner-approval marketplace gate (createApproval) — MCP omit here is
//                defense-in-depth, the real gate is service authz.
//   • spend    → payment-mandate authz + `wechat-pay` skill not granted + no terminal.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  computeDisabledToolsets,
  resolveToolsetScope,
  resolveMcpAllowlist,
} from '../src/adapters/persistence/hermes/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PERSONA_ROLE_PATH = join(
  __dirname,
  '../../cloud/catalog/roles/persona.json',
);

type PersonaRole = {
  slug: string;
  operatingPrinciples: unknown;
  toolsetScope?: { mode: 'allow' | 'deny'; toolsets?: string[] } | null;
  mcpServers?: unknown;
};

function loadPersonaRole(): PersonaRole {
  return JSON.parse(readFileSync(PERSONA_ROLE_PATH, 'utf8')) as PersonaRole;
}

// The four capabilities a persona must NOT have → the toolsets that carry them.
// (kanban_create / delegate_task / cloud-CLI-over-terminal / skill_manage.)
const CAPABILITY_TOOLSETS = ['kanban', 'delegation', 'terminal', 'code_execution', 'skills'] as const;
// Speaking / reasoning / citing — these must stay enabled.
const DISCUSSION_TOOLSETS = ['web', 'search', 'memory', 'session_search', 'clarify', 'vision'] as const;
// The Prismer MCP tools that DO the four capabilities — must be omitted from the allowlist.
const DENIED_MCP_TOOLS = [
  'prismer.task.create',
  'prismer.skill.install',
  'prismer.evolve.publish',
  'prismer.community.post',
] as const;
// Discussion MCP tools — must survive.
const ALLOWED_MCP_TOOLS = ['prismer.memory.recall', 'prismer.asset.read'] as const;

describe('persona-role — RO-7 compliance (avoids the seed landmine)', () => {
  it('operatingPrinciples is a single markdown STRING, not an {en,zh} object', () => {
    const role = loadPersonaRole();
    expect(typeof role.operatingPrinciples).toBe('string');
    expect((role.operatingPrinciples as string).length).toBeGreaterThan(200);
  });
});

describe('persona-role — toolsetScope projection is a REAL gate', () => {
  it('disabled_toolsets CONTAINS every capability toolset and NONE of the discussion toolsets', () => {
    const role = loadPersonaRole();
    const scope = resolveToolsetScope({ roleTemplate: role as never });
    expect(scope).not.toBeNull();
    const disabled = computeDisabledToolsets(scope);

    for (const cap of CAPABILITY_TOOLSETS) {
      expect(disabled, `capability toolset "${cap}" must be disabled`).toContain(cap);
    }
    for (const talk of DISCUSSION_TOOLSETS) {
      expect(disabled, `discussion toolset "${talk}" must stay enabled`).not.toContain(talk);
    }
  });

  it('NEGATIVE CONTROL: emptying the deny list re-opens the boundary (projection no longer gates)', () => {
    const role = loadPersonaRole();
    // Tamper: same role, but the toolsetScope carries no toolsets (the exact
    // regression M0 must catch — "someone deleted the deny").
    const tampered: PersonaRole = {
      ...role,
      toolsetScope: { mode: 'deny', toolsets: [] },
    };
    const disabled = computeDisabledToolsets(
      resolveToolsetScope({ roleTemplate: tampered as never }),
    );
    // With the deny gone, NONE of the capabilities are gated anymore → the
    // discussion-only boundary is open. This is the RED the positive test guards.
    for (const cap of CAPABILITY_TOOLSETS) {
      expect(disabled).not.toContain(cap);
    }
  });
});

describe('persona-role — mcpAllowlist projection omits the four capabilities MCP tools', () => {
  it('persona MCP surface keeps discussion tools and omits capability tools', () => {
    const role = loadPersonaRole();
    expect(Array.isArray((role as { mcpServers?: unknown[] }).mcpServers)).toBe(true);
    expect((role as { mcpServers: unknown[] }).mcpServers).toHaveLength(1);
    const allow = resolveMcpAllowlist({ roleTemplate: role as never });
    expect(allow).toEqual(expect.arrayContaining(ALLOWED_MCP_TOOLS));
    expect(allow).not.toEqual(expect.arrayContaining(DENIED_MCP_TOOLS));
  });

  it('NEGATIVE CONTROL: widening the allowlist to include task.create re-opens the MCP path', () => {
    const role = loadPersonaRole();
    // Tamper: replace the @prismer/mcp-server allowlist with an all-tools list.
    const tampered: PersonaRole = {
      ...role,
      mcpServers: [
        {
          name: 'prismer-tasks',
          package: '@prismer/mcp-server',
          toolsAllowlist: [...DENIED_MCP_TOOLS, ...ALLOWED_MCP_TOOLS],
        },
      ],
    };
    const allow = resolveMcpAllowlist({ roleTemplate: tampered as never });
    // With the widened allowlist, task.create is now reachable via MCP → open.
    expect(allow).toContain('prismer.task.create');
  });
});
