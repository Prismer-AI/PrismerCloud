#!/usr/bin/env npx tsx
/**
 * Import gstack SKILL.md files as im_skills entries (directory/catalog).
 *
 * This imports gstack skills into the Skill catalog (im_skills table),
 * NOT as evolution Genes. Skills are browsable/installable directory entries.
 *
 * Usage:
 *   PRISMER_API_KEY="sk-..." npx tsx scripts/import-gstack-to-skills.ts [--env test|prod|local] [--dry-run]
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
  envArg === 'prod'
    ? process.env.PRISMER_API_KEY || 'sk-prismer-live-REDACTED-SET-VIA-ENV'
    : process.env.PRISMER_API_KEY_TEST ||
      process.env.PRISMER_API_KEY ||
      'sk-prismer-live-REDACTED-SET-VIA-ENV';

const API_PREFIX = BASE_URL.includes('localhost:3200') ? '/api' : '/api/im';

// ─── Category Mapping ────────────────────────────────────────

const CATEGORY_MAP: Record<string, string> = {
  // Debug / Safety
  investigate: 'coding-agents-and-ides',
  careful: 'coding-agents-and-ides',
  freeze: 'coding-agents-and-ides',
  guard: 'coding-agents-and-ides',
  unfreeze: 'coding-agents-and-ides',

  // QA / Testing
  qa: 'coding-agents-and-ides',
  'qa-only': 'coding-agents-and-ides',
  benchmark: 'devops-and-cloud',

  // Security
  cso: 'security',

  // Design
  'design-consultation': 'general',
  'design-review': 'general',

  // Planning
  'office-hours': 'general',
  autoplan: 'general',
  'plan-ceo-review': 'general',
  'plan-eng-review': 'general',
  'plan-design-review': 'general',

  // Review
  review: 'coding-agents-and-ides',

  // Deploy / Ship
  ship: 'devops-and-cloud',
  'land-and-deploy': 'devops-and-cloud',
  canary: 'devops-and-cloud',
  'document-release': 'devops-and-cloud',
  'setup-deploy': 'devops-and-cloud',

  // Retro
  retro: 'general',

  // Browser
  browse: 'coding-agents-and-ides',
  'setup-browser-cookies': 'coding-agents-and-ides',

  // Meta
  codex: 'coding-agents-and-ides',
  'gstack-upgrade': 'general',
};

// Tags for search/discovery
const TAG_MAP: Record<string, string[]> = {
  investigate: ['debugging', 'root-cause', 'investigation'],
  careful: ['safety', 'destructive-command', 'guardrail'],
  freeze: ['scope-boundary', 'safety', 'guardrail'],
  guard: ['safety', 'protection', 'guardrail'],
  unfreeze: ['scope-unlock', 'safety'],
  qa: ['testing', 'quality-assurance', 'validation'],
  'qa-only': ['testing', 'quality-audit'],
  benchmark: ['performance', 'benchmarking', 'throughput'],
  cso: ['security', 'credential', 'owasp', 'audit'],
  'design-consultation': ['design', 'architecture', 'planning'],
  'design-review': ['design-review', 'ux'],
  'office-hours': ['brainstorm', 'planning', 'requirements'],
  autoplan: ['planning', 'decomposition', 'complexity'],
  'plan-ceo-review': ['review', 'stakeholder', 'alignment'],
  'plan-eng-review': ['review', 'engineering', 'feasibility'],
  'plan-design-review': ['review', 'design', 'ux'],
  review: ['code-review', 'quality'],
  ship: ['deploy', 'release', 'pull-request'],
  'land-and-deploy': ['deploy', 'merge', 'conflict-resolution'],
  canary: ['canary', 'deploy', 'regression-detection'],
  'document-release': ['release-notes', 'changelog', 'documentation'],
  'setup-deploy': ['ci-cd', 'deployment-setup'],
  retro: ['retrospective', 'postmortem', 'process-improvement'],
  browse: ['browser', 'automation', 'visual-verification'],
  'setup-browser-cookies': ['browser', 'authentication', 'cookies'],
  codex: ['codex', 'debugging'],
  'gstack-upgrade': ['upgrade', 'dependency'],
};

// ─── SKILL.md Parser ─────────────────────────────────────────

interface ParsedSkill {
  name: string;
  version: string;
  description: string;
  allowedTools: string[];
  body: string;
}

function parseSkillMd(content: string): ParsedSkill | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;

  const fm = fmMatch[1];
  const body = content.slice(fmMatch[0].length);

  const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim() || '';
  const version = fm.match(/^version:\s*(.+)$/m)?.[1]?.trim() || '1.0.0';

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

// ─── API Client ──────────────────────────────────────────────

let authToken = '';

async function register(): Promise<string> {
  const ts = Math.floor(Date.now() / 1000) % 100000;
  const resp = await fetch(`${BASE_URL}${API_PREFIX}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ username: `gstack_imp_${ts}`, displayName: 'gstack Skill Importer', type: 'agent' }),
  });
  const data = (await resp.json()) as any;
  if (!data.ok) throw new Error(`Registration failed: ${JSON.stringify(data)}`);
  console.log(`[Import] Registered as ${data.data.imUserId}`);
  return data.data.token;
}

async function bulkImportSkills(skills: any[]): Promise<any> {
  const resp = await fetch(`${BASE_URL}${API_PREFIX}/skills/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
    body: JSON.stringify({ skills }),
  });
  return resp.json();
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  console.log(`[Import] gstack → Prismer Skill Catalog Import`);
  console.log(`[Import] Source: ${GSTACK_DIR}`);
  console.log(`[Import] Target: ${BASE_URL} (${envArg})`);
  console.log(`[Import] Dry run: ${dryRun}\n`);

  // Find all SKILL.md files
  const skillDirs = fs
    .readdirSync(GSTACK_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .filter((name) => fs.existsSync(path.join(GSTACK_DIR, name, 'SKILL.md')));

  console.log(`[Import] Found ${skillDirs.length} skill directories\n`);

  // Parse and build import items
  const importItems: any[] = [];

  for (const dir of skillDirs) {
    const filePath = path.join(GSTACK_DIR, dir, 'SKILL.md');
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = parseSkillMd(content);

    if (!parsed) {
      console.log(`  ⚠️  ${dir}: parse failed, skipping`);
      continue;
    }

    // Generate display name from skill name
    const displayName = parsed.name
      .split('-')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');

    const category = CATEGORY_MAP[parsed.name] || 'general';
    const tags = TAG_MAP[parsed.name] || [];

    importItems.push({
      name: displayName,
      description: parsed.description,
      category,
      author: 'gstack',
      source: 'gstack',
      sourceUrl: `https://github.com/garry/gstack/tree/main/${dir}`,
      sourceId: `gstack:${parsed.name}`,
      tags,
      content, // full SKILL.md content for installSkill() to parse
    });

    console.log(`  ✅ ${parsed.name} → "${displayName}" [${category}] (${tags.join(', ')})`);
  }

  console.log(`\n[Import] ${importItems.length} skills ready for import\n`);

  if (dryRun) {
    console.log('=== DRY RUN ===\n');
    for (const item of importItems) {
      console.log(`${item.name} (${item.category})`);
      console.log(`  source: ${item.sourceId}`);
      console.log(`  tags: ${item.tags.join(', ')}`);
      console.log(`  desc: ${item.description.slice(0, 100)}...`);
      console.log('');
    }
    console.log(`Total: ${importItems.length} skills (dry run, nothing imported)`);
    return;
  }

  // Register agent for auth
  authToken = await register();

  // Bulk import (single API call, up to 5000)
  console.log(`[Import] Calling POST /skills/import with ${importItems.length} items...`);
  const result = await bulkImportSkills(importItems);

  if (result.ok) {
    console.log(`\n=== Import Complete ===`);
    console.log(`Imported: ${result.data.imported}`);
    console.log(`Skipped: ${result.data.skipped} (already exist)`);
    console.log(`Errors: ${result.data.errors}`);
  } else {
    console.error(`\n❌ Import failed: ${JSON.stringify(result)}`);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
