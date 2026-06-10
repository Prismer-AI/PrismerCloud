#!/usr/bin/env npx tsx
/**
 * Seed ACP role templates from docs/54release/template/*.json.
 *
 * Usage:
 *   DATABASE_URL="file:$(pwd)/prisma/data/dev.db" npx tsx scripts/migrate-role-templates.ts
 *   DATABASE_URL="..." npx tsx scripts/migrate-role-templates.ts --dry-run
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

type I18n = { zh?: string; en?: string };
type Role = {
  id: string;
  slug: string;
  displayName: I18n;
  corporateName?: I18n;
  agentType: 'orchestrator' | 'specialist' | 'support';
  primary?: boolean;
  rationale: I18n;
  appliesAtSize: string[];
  capabilities: string[];
  defaultIcon?: string;
};
type RolePack = {
  id: string;
  type: 'core' | 'pack';
  industryKey?: string;
  name: I18n;
  description: string;
  roles: Role[];
};

// 2026-05-19: docs/54release was archived to docs/archive/54release in
// the v200 doc reorg. Template seed files moved with it.
const TEMPLATE_DIR = path.resolve(process.cwd(), 'docs/archive/54release/template');
const DRY_RUN = process.argv.includes('--dry-run');

// v2.1 (release 201) — `skill_sync` legacy alias removed; no consumer in
// src/ or sdk/.../runtime/src/ requires it (only the regression test used
// to assert it, updated alongside this change).
const COMMON_TOOLS = [
  'prismer.conversation.listAgents',
  'prismer.agent.send',
  'prismer.message.send',
  'prismer.task.create',
  'prismer.task.list',
  'prismer.task.get',
  'prismer.task.update',
  'prismer.task.complete',
  'prismer.approval.request_human_approval',
  'prismer.skill.installed',
  'prismer.skill.sync',
  'prismer.memory.read',
  'prismer.memory.write',
  'prismer.memory.recall',
];
const ORCHESTRATOR_TOOLS = ['prismer.task.approve', 'prismer.task.reject', 'prismer.task.cancel'];

// v2.1 (release 201) — CEO is the single workspace orchestrator. coo /
// operations / pm were previously coerced to orchestrator via the slug
// allowlist; release 201 strips that for the same reason migration 425
// strips taskAuthority='orchestrator' from non-CEO active rows: multiple
// orchestrators caused dispatch divergence in the group chat. role.primary
// and explicit role.agentType='orchestrator' still win — those come from
// the pack manifest, not hard-coded slug heuristics.
function isOrchestrator(role: Role): boolean {
  return role.primary === true || role.agentType === 'orchestrator' || role.slug === 'ceo';
}

function readI18n(value: I18n | undefined, fallback: string): Required<I18n> {
  return {
    zh: value?.zh || value?.en || fallback,
    en: value?.en || value?.zh || fallback,
  };
}

export function buildTemplate(pack: RolePack, role: Role) {
  const name = readI18n(role.corporateName ?? role.displayName, role.slug);
  const description = readI18n(role.rationale, '');
  const taskAuthority = isOrchestrator(role) ? 'orchestrator' : 'executor';
  const mcpAllowlist = taskAuthority === 'orchestrator' ? [...COMMON_TOOLS, ...ORCHESTRATOR_TOOLS] : COMMON_TOOLS;
  const category = pack.type === 'core' ? 'core' : pack.industryKey || pack.id.replace(/^pack-/, '');
  const operatingPrinciples = {
    zh: [
      `[角色] ${name.zh}`,
      description.zh,
      '',
      '[行动原则]',
      '- 主动决策并推进；只有破坏性或不可逆操作才请求人工审批。',
      '- 可分派、可验收的工作必须创建 task，不要只停留在聊天计划中。',
      '- 需要人工签署时调用 request_human_approval，不要在聊天里临时 @ 人确认。',
      '- 协作委派使用 im_send_to_agent。',
    ].join('\n'),
    en: [
      `[Role] ${name.en}`,
      description.en,
      '',
      '[Operating principles]',
      '- Decide and act. Only request human approval for destructive or irreversible operations.',
      '- Track assignable work with tasks instead of leaving it as loose chat.',
      '- Use request_human_approval for human sign-off; do not inline-mention humans for approvals.',
      '- Use im_send_to_agent for verified delegation.',
    ].join('\n'),
  };

  return {
    slug: role.slug,
    version: '1.0.0',
    name,
    description,
    agentType: role.agentType === 'support' ? 'assistant' : role.agentType,
    category,
    tags: [...new Set([category, pack.id, ...role.capabilities])],
    baseSkillSet: 'prismer-base',
    requiredSkills: [],
    mcpServers: [
      {
        name: 'prismer-tasks',
        package: '@prismer/mcp-server',
        transport: 'stdio',
        toolsAllowlist: mcpAllowlist,
      },
    ],
    hermesConfig: {
      model: 'us-kimi-k2.6',
      autoStart: true,
      configurePrismerProvider: true,
      prismerProviderName: 'prismer',
    },
    openclawConfig: {},
    operatingPrinciples,
    taskAuthority,
    approvalPolicy: 'auto-low-risk',
    status: 'active',
  };
}

export async function readPacks(templateDir = TEMPLATE_DIR): Promise<RolePack[]> {
  const files = (await fs.readdir(templateDir)).filter((file) => file === 'core.json' || /^pack-.*\.json$/.test(file));
  const packs: RolePack[] = [];
  for (const file of files.sort()) {
    const raw = await fs.readFile(path.join(templateDir, file), 'utf8');
    packs.push(JSON.parse(raw) as RolePack);
  }
  return packs;
}

export function buildRoleTemplateMigrationPlan(packs: RolePack[]) {
  const bySlug = new Map<string, ReturnType<typeof buildTemplate>>();
  for (const pack of packs) {
    for (const role of pack.roles) {
      const next = buildTemplate(pack, role);
      const existing = bySlug.get(role.slug);
      if (!existing || pack.type === 'core') {
        bySlug.set(role.slug, next);
      } else {
        existing.category = existing.category === next.category ? existing.category : 'general';
        existing.tags = [...new Set([...existing.tags, ...next.tags])];
      }
    }
  }
  return [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

async function main() {
  const templates = buildRoleTemplateMigrationPlan(await readPacks());

  console.log(`[migrate-role-templates] ${DRY_RUN ? 'Would upsert' : 'Upserting'} ${templates.length} templates`);
  if (DRY_RUN) {
    for (const template of templates) {
      console.log(`  - ${template.slug} (${template.category}, ${template.taskAuthority})`);
    }
    return;
  }

  const { default: prisma } = await import('../src/im/db');
  try {
    for (const template of templates) {
      console.log(`  - ${template.slug} (${template.category}, ${template.taskAuthority})`);
      await (prisma as any).iMRoleTemplate.upsert({
        where: { slug: template.slug },
        create: {
          ...template,
          name: JSON.stringify(template.name),
          description: JSON.stringify(template.description),
          tags: JSON.stringify(template.tags),
          requiredSkills: JSON.stringify(template.requiredSkills),
          mcpServers: JSON.stringify(template.mcpServers),
          hermesConfig: JSON.stringify(template.hermesConfig),
          openclawConfig: JSON.stringify(template.openclawConfig),
          operatingPrinciples: JSON.stringify(template.operatingPrinciples),
        },
        update: {
          version: template.version,
          name: JSON.stringify(template.name),
          description: JSON.stringify(template.description),
          agentType: template.agentType,
          category: template.category,
          tags: JSON.stringify(template.tags),
          baseSkillSet: template.baseSkillSet,
          requiredSkills: JSON.stringify(template.requiredSkills),
          mcpServers: JSON.stringify(template.mcpServers),
          hermesConfig: JSON.stringify(template.hermesConfig),
          openclawConfig: JSON.stringify(template.openclawConfig),
          operatingPrinciples: JSON.stringify(template.operatingPrinciples),
          taskAuthority: template.taskAuthority,
          approvalPolicy: template.approvalPolicy,
          status: template.status,
        },
      });
    }
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[migrate-role-templates] failed:', err);
    process.exitCode = 1;
  });
}
