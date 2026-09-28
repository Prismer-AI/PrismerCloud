// release203/09 §7.5 — seed a "dev preset bundle" into a coding-agent workdir.
//
// When a coding-agent workdir is materialized (ensureWorkdir), the working
// directory should start with sensible defaults instead of being empty:
//   (a) an AGENTS.md + CLAUDE.md operating manual (managed block),
//   (b) the built-in skills with `scope ∈ {common, coding}` copied into
//       `<cwd>/.claude/skills/<slug>/`,
//   (c) `docs/agents/platform.md` + `docs/agents/domain.md`.
//
// Workdirs are coding-only by definition (persistence agents don't use cwd
// workdirs), so the category is ALWAYS 'coding' — seed `scope ∈ {common, coding}`.
//
// Safety / idempotency (§7.5.4):
//   - Only `init` (fresh empty dir) gets a FULL seed.
//   - An existing/external repo (`cloned`/`verified`) only gets the managed
//     block appended/updated in AGENTS.md + CLAUDE.md, and `.claude/skills/`
//     seeded ONLY when that dir is absent (never stomp an existing `.claude`).
//   - All writes live inside `prismer:managed` markers; content outside is
//     never touched. Existing skill dirs are never overwritten.
//   - Gated by env flag PRISMER_SEED_DEV_PRESET (default ON; OFF only when
//     explicitly 'false'/'0').

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { installCodingSkills } from '../adapters/coding/shared/coding-skill-set.js';
import type { EnsureWorkdirResult } from './workdir-materialize.js';

const MANAGED_START = '<!-- prismer:managed:start (auto-generated; edits outside this block are preserved) -->';
const MANAGED_END = '<!-- prismer:managed:end -->';

/** §7.5.3 — the managed operating-manual block (no persona; platform/tooling only). */
const MANAGED_BLOCK_BODY = `# Agent operating manual

You are a coding agent in a **Prismer sandbox** (local-first daemon). Your working
directory is repo-scoped: sessions / config / slash commands resolve here.

## Platform

- LLM access is **pre-configured via the Prismer gateway** — do NOT run \`claude login\` /
  \`codex login\`; proxy base_url + token are already injected.
- Persist results as **task-bound assets**: \`cloud task attach <file>\` (not loose files).
- Long-term memory & cross-session handoff: \`cloud memory\`.

## Skills (coding preset)

- \`.claude/skills/\` carries this agent's methodology skills (tdd / domain-modeling /
  codebase-design / diagnosing-bugs). Live slash catalog lists what's active.
- Prefer **skill + CLI** over MCP (MCP is third-party only).

## Project conventions (lazy)

- Domain glossary → CONTEXT.md · decisions → docs/adr/ — create when something real crystallizes.`;

const PLATFORM_DOC = `# Platform conventions (Prismer sandbox)

- **Gateway pre-configured**: LLM access is injected (proxy base_url + token). Never run
  \`claude login\` / \`codex login\`.
- **Deliver results as task-bound assets**: \`cloud task attach <file>\` — loose files in the
  workdir are not delivered.
- **Memory & handoff**: \`cloud memory\` for long-term memory and cross-session handoff.
`;

const DOMAIN_DOC = `# Domain notes (lazy)

Create these only when something real crystallizes — do not pre-fabricate.

- **Glossary** → \`CONTEXT.md\` at repo root.
- **Decisions** → \`docs/adr/NNNN-title.md\` (one ADR per decision).
`;

function log(line: string): void {
  process.stderr.write(`[seed-dev-preset] ${line}\n`);
}

/** Flag gate — default ON; OFF only when explicitly 'false'/'0'. */
function isEnabled(opts?: { enabled?: boolean }): boolean {
  if (opts?.enabled === false) return false;
  const raw = process.env.PRISMER_SEED_DEV_PRESET;
  if (raw === 'false' || raw === '0') return false;
  return true;
}

/**
 * Reconcile claude-code's `<cwd>/.claude/skills/` to the canonical coding skill
 * set (CRUD: install + update + evict). This replaces the legacy
 * `scope ∈ {common, coding}` copy that dumped the whole `common` bucket
 * (tasks-Kanban, prismer-im-collab, role/skill builders, agent-coordination, …)
 * onto every coder. `installCodingSkills` also evicts those legacy seeds.
 */
function seedSkills(cwd: string): void {
  const skillsDir = join(cwd, '.claude', 'skills');
  const result = installCodingSkills(skillsDir);
  if (!result) {
    log('built-in-skills root not resolvable; skipping skill install');
    return;
  }
  log(`coding skills reconciled → ${skillsDir} (installed=${result.installed} removed=${result.removed})`);
}

/**
 * Write/update the managed block in `filePath`.
 *   - absent file       → create with just the block.
 *   - has markers       → replace content between markers (update in place).
 *   - no markers        → append block at the end (preserve all existing content).
 * Content outside the markers is never touched.
 */
function writeManagedBlock(filePath: string, blockBody: string): void {
  const block = `${MANAGED_START}\n\n${blockBody}\n${MANAGED_END}`;

  if (!existsSync(filePath)) {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${block}\n`, 'utf8');
    return;
  }

  const existing = readFileSync(filePath, 'utf8');
  const startIdx = existing.indexOf(MANAGED_START);
  const endIdx = existing.indexOf(MANAGED_END);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    // Replace the whole managed region (markers included) in place.
    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx + MANAGED_END.length);
    writeFileSync(filePath, `${before}${block}${after}`, 'utf8');
    return;
  }

  // No markers → append, preserving all existing user content.
  const sep = existing.endsWith('\n') ? '\n' : '\n\n';
  writeFileSync(filePath, `${existing}${sep}${block}\n`, 'utf8');
}

/** §7.5.2 — write docs/agents/{platform,domain}.md (only when absent). Full seed only. */
function seedDocsAgents(cwd: string): void {
  const dir = join(cwd, 'docs', 'agents');
  const platform = join(dir, 'platform.md');
  const domain = join(dir, 'domain.md');
  if (!existsSync(platform) || !existsSync(domain)) {
    mkdirSync(dir, { recursive: true });
  }
  if (!existsSync(platform)) writeFileSync(platform, PLATFORM_DOC, 'utf8');
  if (!existsSync(domain)) writeFileSync(domain, DOMAIN_DOC, 'utf8');
}

/**
 * Seed the dev preset bundle into a materialized coding-agent workdir.
 *
 * Behavior by `action` (§7.5.4):
 *   - 'reused'              → no-op (seeded a prior time).
 *   - 'init'               → FULL seed: skills + manuals + docs/agents.
 *   - 'cloned' / 'verified' → APPEND-ONLY: managed block into AGENTS.md +
 *                            CLAUDE.md; skills only if `.claude/skills` absent.
 *
 * Never throws — callers (ensureWorkdir) treat seeding as best-effort.
 */
export async function seedDevPreset(
  cwd: string,
  action: EnsureWorkdirResult['action'],
  opts?: { enabled?: boolean },
): Promise<void> {
  if (!isEnabled(opts)) {
    log('disabled via PRISMER_SEED_DEV_PRESET; skipping');
    return;
  }
  // (b) coding skills — reconcile to the canonical coding set (install/update/
  //     evict), preserving user-authored skills. Runs on EVERY materialization
  //     (incl. 'reused') so coding-set changes propagate to existing workdirs —
  //     the "admin change reaches all devices" requirement. Idempotent + cheap.
  seedSkills(cwd);

  if (action === 'reused') return;

  const fullSeed = action === 'init';

  // (a) operating manual — both files get the same managed block.
  writeManagedBlock(join(cwd, 'AGENTS.md'), MANAGED_BLOCK_BODY);
  writeManagedBlock(join(cwd, 'CLAUDE.md'), MANAGED_BLOCK_BODY);

  // (c) docs/agents — full seed only.
  if (fullSeed) seedDocsAgents(cwd);

  log(`seeded preset (${action}) → ${cwd}`);
}
