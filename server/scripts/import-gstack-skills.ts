#!/usr/bin/env npx tsx
/**
 * Import gstack skills as Prismer Evolution genes.
 *
 * Usage:
 *   PRISMER_API_KEY="sk-..." npx tsx scripts/import-gstack-skills.ts [--env test|prod|local] [--dry-run]
 */

import * as fs from 'fs';
import * as path from 'path';

// ─── Config ──────────────────────────────────────────────────

const GSTACK_DIR = process.env.GSTACK_DIR || '/Users/prismer/workspace/gstack';

const ENV_MAP: Record<string, string> = {
  test: 'https://cloud.prismer.dev',
  prod: 'https://prismer.cloud',
  local: 'http://localhost:3200',
};

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const envArg =
  args.find((a) => a.startsWith('--env='))?.split('=')[1] ||
  (args.includes('--env') ? args[args.indexOf('--env') + 1] : 'test');
const BASE_URL = ENV_MAP[envArg] || ENV_MAP.test;

const API_KEY =
  process.env.PRISMER_API_KEY ||
  process.env.PRISMER_API_KEY_TEST ||
  'sk-prismer-live-REDACTED-SET-VIA-ENV';

// Use /api/im/ prefix for Next.js proxy, /api/ for standalone
const API_PREFIX = BASE_URL.includes('localhost:3200') ? '/api' : '/api/im';

// ─── Types ───────────────────────────────────────────────────

interface SignalTag {
  type: string;
  provider?: string;
  stage?: string;
}

interface GenePayload {
  category: 'repair' | 'optimize' | 'innovate' | 'diagnostic';
  signals_match: SignalTag[];
  strategy: string[];
  preconditions?: string[];
  constraints?: { max_credits?: number; max_retries?: number };
  title?: string;
  description?: string;
}

interface SkillData {
  name: string;
  version: string;
  description: string;
  allowedTools: string[];
  body: string;
}

// ─── Skill → Gene Mapping ────────────────────────────────────

const SKILL_MAPPING: Record<string, { category: GenePayload['category']; signals: SignalTag[] }> = {
  // Debug / Repair
  investigate: {
    category: 'repair',
    signals: [
      { type: 'error:generic' },
      { type: 'error:unexpected_behavior' },
      { type: 'task:debug' },
      { type: 'task:root_cause_analysis' },
    ],
  },
  careful: {
    category: 'repair',
    signals: [{ type: 'security:destructive_command' }, { type: 'error:accidental_deletion' }],
  },
  freeze: {
    category: 'repair',
    signals: [{ type: 'security:scope_boundary' }, { type: 'error:unintended_edit' }],
  },
  guard: {
    category: 'repair',
    signals: [{ type: 'security:destructive_command' }, { type: 'security:scope_boundary' }],
  },
  unfreeze: {
    category: 'repair',
    signals: [{ type: 'error:scope_locked' }],
  },

  // QA / Testing
  qa: {
    category: 'optimize',
    signals: [
      { type: 'quality:validation_failed' },
      { type: 'task:test' },
      { type: 'task:qa' },
      { type: 'quality:low_score' },
    ],
  },
  'qa-only': {
    category: 'optimize',
    signals: [{ type: 'task:test' }, { type: 'quality:audit' }],
  },
  benchmark: {
    category: 'optimize',
    signals: [{ type: 'perf:slow_response' }, { type: 'task:benchmark' }, { type: 'perf:throughput_drop' }],
  },

  // Security
  cso: {
    category: 'optimize',
    signals: [
      { type: 'security:credential_exposed' },
      { type: 'security:data_leakage' },
      { type: 'security:secret_leaked' },
      { type: 'task:security_audit' },
      { type: 'quality:owasp_violation' },
    ],
  },

  // Design
  'design-consultation': {
    category: 'innovate',
    signals: [{ type: 'task:design' }, { type: 'task:architecture' }],
  },
  'design-review': {
    category: 'optimize',
    signals: [{ type: 'quality:design_review' }, { type: 'task:review', stage: 'design' }],
  },

  // Planning
  'office-hours': {
    category: 'innovate',
    signals: [{ type: 'task:brainstorm' }, { type: 'task:plan' }, { type: 'task:requirements' }],
  },
  autoplan: {
    category: 'innovate',
    signals: [{ type: 'task:plan' }, { type: 'task:decompose' }, { type: 'error:complexity' }],
  },
  'plan-ceo-review': {
    category: 'optimize',
    signals: [{ type: 'task:review', stage: 'plan' }, { type: 'quality:stakeholder_alignment' }],
  },
  'plan-eng-review': {
    category: 'optimize',
    signals: [{ type: 'task:review', stage: 'engineering' }, { type: 'quality:technical_feasibility' }],
  },
  'plan-design-review': {
    category: 'optimize',
    signals: [{ type: 'task:review', stage: 'design' }, { type: 'quality:ux_review' }],
  },

  // Review
  review: {
    category: 'optimize',
    signals: [{ type: 'task:code_review' }, { type: 'quality:code_review' }, { type: 'quality:low_output' }],
  },

  // Deploy / Ship
  ship: {
    category: 'optimize',
    signals: [{ type: 'task:deploy' }, { type: 'task:release' }, { type: 'task:create_pr' }],
  },
  'land-and-deploy': {
    category: 'optimize',
    signals: [{ type: 'task:deploy', stage: 'merge' }, { type: 'task:release' }, { type: 'error:merge_conflict' }],
  },
  canary: {
    category: 'optimize',
    signals: [{ type: 'task:deploy', stage: 'canary' }, { type: 'perf:regression_detection' }],
  },
  'document-release': {
    category: 'optimize',
    signals: [{ type: 'task:release', stage: 'documentation' }, { type: 'quality:changelog' }],
  },
  'setup-deploy': {
    category: 'optimize',
    signals: [{ type: 'task:deploy', stage: 'setup' }, { type: 'task:ci_cd' }],
  },

  // Retro
  retro: {
    category: 'innovate',
    signals: [{ type: 'task:retrospective' }, { type: 'task:postmortem' }, { type: 'quality:process_improvement' }],
  },

  // Browser / Tools
  browse: {
    category: 'optimize',
    signals: [{ type: 'capability:browser' }, { type: 'task:web_automation' }, { type: 'task:visual_verification' }],
  },
  'setup-browser-cookies': {
    category: 'optimize',
    signals: [
      { type: 'capability:browser', stage: 'setup' },
      { type: 'error:authentication_failure', provider: 'browser' },
    ],
  },

  // Meta / Utility
  codex: {
    category: 'optimize',
    signals: [{ type: 'task:debug', provider: 'codex' }, { type: 'capability:codex' }],
  },
  'gstack-upgrade': {
    category: 'optimize',
    signals: [{ type: 'task:upgrade' }, { type: 'error:dependency_missing' }],
  },
};

// ─── SKILL.md Parser ─────────────────────────────────────────

function parseSkillMd(content: string): SkillData | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;

  const fm = fmMatch[1];
  const body = content.slice(fmMatch[0].length);

  const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim() || '';
  const version = fm.match(/^version:\s*(.+)$/m)?.[1]?.trim() || '';

  let description = '';
  const descMatch = fm.match(/^description:\s*\|?\s*\n([\s\S]*?)(?=\nallowed-tools:|\nhooks:|\n[a-z])/m);
  if (descMatch) {
    description = descMatch[1].replace(/^\s{2}/gm, '').trim();
  } else {
    description = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim() || '';
  }

  const toolsSection = fm.match(/allowed-tools:\n((?:\s+-\s+.+\n?)*)/);
  const allowedTools = toolsSection
    ? toolsSection[1].match(/-\s+(.+)/g)?.map((t: string) => t.replace(/^-\s+/, '').trim()) || []
    : [];

  if (!name) return null;
  return { name, version, description, allowedTools, body };
}

/** Boilerplate H2 sections present in every gstack SKILL.md — skip these. */
const BOILERPLATE_SECTIONS = new Set([
  'Preamble (run first)',
  'AskUserQuestion Format',
  'Completeness Principle — Boil the Lake',
  'Repo Ownership Mode — See Something, Say Something',
  'Search Before Building',
  'Contributor Mode',
  'Completion Status Protocol',
  'Telemetry (run last)',
  'Steps to reproduce',
  'Raw output',
  'What would make this a 10',
]);

function isBoilerplateSection(title: string): boolean {
  if (BOILERPLATE_SECTIONS.has(title)) return true;
  // Fuzzy match for variations
  const lower = title.toLowerCase();
  return (
    lower.includes('preamble') ||
    lower.includes('telemetry') ||
    lower.includes('askuserquestion') ||
    lower.includes('completeness principle') ||
    lower.includes('contributor mode') ||
    lower.includes('repo ownership') ||
    lower.includes('search before') ||
    lower.includes('completion status') ||
    lower.includes('scope lock')
  );
}

function extractStrategy(body: string): string[] {
  const lines = body.split('\n');
  const steps: string[] = [];
  let inRealSection = false;
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    // Track sections: only extract from non-boilerplate H2 sections
    if (line.startsWith('## ')) {
      const title = line.replace(/^#+\s*/, '').trim();
      if (isBoilerplateSection(title)) {
        inRealSection = false;
        continue;
      }
      inRealSection = true;
      // Use the section title itself as a strategy step
      steps.push(title);
      continue;
    }

    if (!inRealSection) continue;

    // Extract numbered steps and meaningful bullets
    const numbered = line.match(/^\d+\.\s+\*?\*?(.+?)\*?\*?\s*$/);
    const bullet = line.match(/^[-*]\s+\*?\*?(.+?)\*?\*?\s*$/);
    if (numbered && numbered[1].length > 10 && numbered[1].length < 200) {
      steps.push(numbered[1].replace(/\*\*/g, '').trim());
    } else if (bullet && bullet[1].length > 15 && bullet[1].length < 200) {
      steps.push(bullet[1].replace(/\*\*/g, '').trim());
    }
  }

  const unique = [...new Set(steps)].filter(
    (s) =>
      s.length > 5 &&
      !s.toLowerCase().includes('gstack') &&
      !s.includes('telemetry') &&
      !s.includes('PROACTIVE') &&
      !s.includes('touch ~') &&
      !s.includes('AskUserQuestion') &&
      !s.includes('RECOMMENDATION') &&
      !s.includes('Completeness:'),
  );
  return unique.slice(0, 8);
}

// ─── API Client ──────────────────────────────────────────────

let authToken = '';

async function register(): Promise<string> {
  const ts = Date.now();
  const resp = await fetch(`${BASE_URL}${API_PREFIX}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ username: `gstack_importer_${ts}`, displayName: 'gstack Skill Importer', type: 'agent' }),
  });
  const data = (await resp.json()) as any;
  if (!data.ok) throw new Error(`Registration failed: ${JSON.stringify(data)}`);
  console.log(`[Import] Registered as ${data.data.imUserId}`);
  return data.data.token;
}

async function createGene(gene: GenePayload): Promise<any> {
  const resp = await fetch(`${BASE_URL}${API_PREFIX}/evolution/genes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
    body: JSON.stringify(gene),
  });
  return resp.json();
}

async function publishGene(geneId: string): Promise<any> {
  const resp = await fetch(`${BASE_URL}${API_PREFIX}/evolution/genes/${geneId}/publish`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${authToken}` },
  });
  return resp.json();
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  console.log(`[Import] gstack → Prismer Gene Import`);
  console.log(`[Import] Source: ${GSTACK_DIR}`);
  console.log(`[Import] Target: ${BASE_URL} (${envArg})`);
  console.log(`[Import] Dry run: ${dryRun}\n`);

  // Find all SKILL.md files
  const skillDirs = fs
    .readdirSync(GSTACK_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .filter((name) => fs.existsSync(path.join(GSTACK_DIR, name, 'SKILL.md')));

  console.log(`[Import] Found ${skillDirs.length} skill directories`);

  // Parse all skills
  const skills: Array<{ dir: string; data: SkillData; mapping: (typeof SKILL_MAPPING)[string] | null }> = [];
  for (const dir of skillDirs) {
    const content = fs.readFileSync(path.join(GSTACK_DIR, dir, 'SKILL.md'), 'utf-8');
    const data = parseSkillMd(content);
    if (!data) {
      console.log(`  ⚠️  ${dir}: parse failed, skipping`);
      continue;
    }
    skills.push({ dir, data, mapping: SKILL_MAPPING[data.name] || null });
  }

  console.log(`[Import] Parsed ${skills.length} skills (${skills.filter((s) => s.mapping).length} with mappings)\n`);

  const unmapped = skills.filter((s) => !s.mapping);
  if (unmapped.length > 0) {
    console.log(`[Import] Unmapped skills (skipped):`);
    for (const s of unmapped) console.log(`  - ${s.data.name}: ${s.data.description.slice(0, 80)}...`);
    console.log('');
  }

  // Build gene payloads
  const genes: Array<{ name: string; payload: GenePayload }> = [];
  for (const skill of skills) {
    if (!skill.mapping) continue;
    let strategy = extractStrategy(skill.data.body);
    if (strategy.length === 0) {
      strategy = skill.data.description
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 10 && !l.startsWith('Use when') && !l.startsWith('Proactively'))
        .slice(0, 4);
    }
    if (strategy.length === 0) {
      console.log(`  ⚠️  ${skill.data.name}: no strategy, skipping`);
      continue;
    }

    // Generate a human-readable title from skill name
    const title = skill.data.name
      .split('-')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');

    genes.push({
      name: skill.data.name,
      payload: {
        category: skill.mapping.category,
        signals_match: skill.mapping.signals,
        strategy,
        title,
        description: skill.data.description.split('\n')[0].trim().slice(0, 200),
        constraints: { max_credits: 50, max_retries: 2 },
      },
    });
  }

  console.log(`[Import] ${genes.length} genes ready for import\n`);

  if (dryRun) {
    console.log('=== DRY RUN ===\n');
    for (const g of genes) {
      console.log(`${g.name} (${g.payload.category})`);
      console.log(`  signals: ${g.payload.signals_match.map((s) => s.type).join(', ')}`);
      console.log(`  strategy (${g.payload.strategy.length} steps): ${g.payload.strategy[0]}...`);
      console.log('');
    }
    console.log(`Total: ${genes.length} genes (dry run, nothing imported)`);
    return;
  }

  // Register agent
  authToken = await register();

  let created = 0,
    published = 0,
    failed = 0;

  for (let i = 0; i < genes.length; i++) {
    const gene = genes[i];
    console.log(`[${i + 1}/${genes.length}] Creating: ${gene.name} (${gene.payload.category})...`);

    let result = await createGene(gene.payload);
    const errStr = typeof result.error === 'string' ? result.error : JSON.stringify(result.error || '');
    if (!result.ok && errStr.includes('RATE_LIMITED')) {
      const retryMatch = errStr.match(/Retry in (\d+)s/);
      const wait = retryMatch ? (parseInt(retryMatch[1]) + 2) * 1000 : 35000;
      console.log(`  ⏳ Rate limited, waiting ${wait / 1000}s...`);
      await new Promise((r) => setTimeout(r, wait));
      result = await createGene(gene.payload);
    }

    if (!result.ok) {
      const err2 = typeof result.error === 'string' ? result.error : JSON.stringify(result.error || '');
      console.log(`  ❌ Failed: ${err2}`);
      failed++;
      continue;
    }

    const geneId = result.data?.id;
    console.log(`  ✅ Created: ${geneId}`);
    created++;

    if (geneId) {
      // Wait before publish (also rate-limited as tool_call)
      console.log(`  ⏳ Waiting 32s before publish...`);
      await new Promise((r) => setTimeout(r, 32000));
      const pub = await publishGene(geneId);
      if (pub.ok) {
        console.log(`  📢 Published`);
        published++;
      } else {
        const pubErr = typeof pub.error === 'string' ? pub.error : JSON.stringify(pub.error || pub);
        if (pubErr.includes('RATE_LIMITED')) {
          console.log(`  ⏳ Publish rate limited, waiting 35s...`);
          await new Promise((r) => setTimeout(r, 35000));
          const pub2 = await publishGene(geneId);
          if (pub2.ok) {
            console.log(`  📢 Published (retry)`);
            published++;
          } else console.log(`  ⚠️  Publish failed after retry`);
        } else {
          console.log(`  ⚠️  Publish failed: ${pubErr}`);
        }
      }
    }

    // Rate limit: create is rate-limited at 2/min, wait 32s between creates
    if (i < genes.length - 1) {
      console.log(`  ⏳ Waiting 32s...`);
      await new Promise((r) => setTimeout(r, 32000));
    }
  }

  console.log(`\n=== Import Complete ===`);
  console.log(`Created: ${created}/${genes.length}`);
  console.log(`Published: ${published}`);
  console.log(`Failed: ${failed}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
