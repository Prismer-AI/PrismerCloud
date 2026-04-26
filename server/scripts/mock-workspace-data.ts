/**
 * Mock workspace data for visual testing.
 * Run: DATABASE_URL="file:./prisma/data/dev.db" npx tsx scripts/mock-workspace-data.ts
 */

// Use MySQL client if DATABASE_URL starts with mysql://, otherwise SQLite
const isMysql = process.env.DATABASE_URL?.startsWith('mysql://');
const { PrismaClient } = isMysql ? require('../prisma/generated/mysql') : require('@prisma/client');

const prisma = new PrismaClient();

const AGENT_ID = 'mock-agent-001';
const USER_ID = 'mock-user-001';

async function main() {
  console.log('Seeding workspace mock data...');

  // 1. User
  await prisma.iMUser.upsert({
    where: { id: USER_ID },
    update: {},
    create: {
      id: USER_ID,
      username: 'tom',
      role: 'human',
      displayName: 'Tom',
    },
  });

  // 2. Agent (linked to user via userId)
  await prisma.iMUser.upsert({
    where: { id: AGENT_ID },
    update: {},
    create: {
      id: AGENT_ID,
      username: 'cc-agent',
      role: 'agent',
      displayName: 'Claude Code Agent',
      userId: USER_ID,
    },
  });

  // 3. Agent Card
  await prisma.iMAgentCard.upsert({
    where: { imUserId: AGENT_ID },
    update: {
      metadata: JSON.stringify({
        personality: { rigor: 0.72, creativity: 0.55, risk_tolerance: 0.3 },
      }),
    },
    create: {
      imUserId: AGENT_ID,
      name: 'Claude Code Agent',
      agentType: 'claude-code',
      status: 'online',
      did: 'did:key:z6Mk8fQx3n7VpRcT9wMbK4jK2kYd5LmN',
      capabilities: JSON.stringify(['code_repair', 'test_generation', 'refactor', 'debugging']),
      metadata: JSON.stringify({
        personality: { rigor: 0.72, creativity: 0.55, risk_tolerance: 0.3 },
      }),
    },
  });

  // 4. Genes (strategies)
  const genes = [
    {
      id: 'gene-fix-timeout-v2',
      category: 'repair',
      title: 'fix_timeout_v2',
      description: 'Handles API timeout with exponential backoff retry',
      successCount: 119,
      failureCount: 8,
      breakerState: 'closed',
      qualityScore: 0.92,
    },
    {
      id: 'gene-null-guard-v3',
      category: 'repair',
      title: 'null_guard_v3',
      description: 'Prevents null reference in API response parsing',
      successCount: 5,
      failureCount: 3,
      breakerState: 'open',
      qualityScore: 0.45,
    },
    {
      id: 'gene-retry-backoff',
      category: 'optimize',
      title: 'retry_backoff',
      description: 'Exponential backoff with jitter for external API calls',
      successCount: 38,
      failureCount: 5,
      breakerState: 'closed',
      qualityScore: 0.78,
    },
    {
      id: 'gene-error-parse-recovery',
      category: 'repair',
      title: 'error_parse_recovery',
      description: 'Recovers from malformed JSON in API responses',
      successCount: 67,
      failureCount: 2,
      breakerState: 'closed',
      qualityScore: 0.88,
    },
    {
      id: 'gene-cache-invalidation',
      category: 'optimize',
      title: 'cache_invalidation',
      description: 'Smart cache invalidation based on content hash',
      successCount: 45,
      failureCount: 10,
      breakerState: 'half_open',
      qualityScore: 0.65,
    },
    {
      id: 'gene-test-gen-v1',
      category: 'innovate',
      title: 'test_gen_v1',
      description: 'Auto-generates unit tests from function signatures',
      successCount: 23,
      failureCount: 7,
      breakerState: 'closed',
      qualityScore: 0.7,
    },
    {
      id: 'gene-import-sorter',
      category: 'optimize',
      title: 'import_sorter',
      description: 'Sorts and deduplicates TypeScript imports',
      successCount: 89,
      failureCount: 1,
      breakerState: 'closed',
      qualityScore: 0.95,
    },
    {
      id: 'gene-dead-code-finder',
      category: 'innovate',
      title: 'dead_code_finder',
      description: 'Detects and removes unreachable code paths',
      successCount: 12,
      failureCount: 4,
      breakerState: 'closed',
      qualityScore: 0.6,
    },
    {
      id: 'gene-env-validator',
      category: 'repair',
      title: 'env_validator',
      description: 'Validates required environment variables at startup',
      successCount: 55,
      failureCount: 0,
      breakerState: 'closed',
      qualityScore: 0.97,
    },
    {
      id: 'gene-query-optimizer',
      category: 'optimize',
      title: 'query_optimizer',
      description: 'Rewrites N+1 Prisma queries to use include/select',
      successCount: 31,
      failureCount: 6,
      breakerState: 'closed',
      qualityScore: 0.73,
    },
    {
      id: 'gene-type-narrowing',
      category: 'innovate',
      title: 'type_narrowing',
      description: 'Adds TypeScript type guards to reduce runtime errors',
      successCount: 2,
      failureCount: 1,
      breakerState: 'closed',
      qualityScore: 0.4,
    },
    {
      id: 'gene-log-structured',
      category: 'optimize',
      title: 'log_structured',
      description: 'Converts console.log to structured pino logging',
      successCount: 18,
      failureCount: 2,
      breakerState: 'closed',
      qualityScore: 0.82,
    },
  ];

  // MySQL LONGTEXT fields need explicit values (no DEFAULT)
  const geneDefaults = {
    ownerAgentId: AGENT_ID,
    scope: 'global',
    strategySteps: '["Detect signal","Apply strategy","Log outcome"]',
    preconditions: '[]',
    constraints: '{}',
  };

  for (const g of genes) {
    await prisma.iMGene.upsert({
      where: { id: g.id },
      update: { ...g, ownerAgentId: AGENT_ID, scope: 'global' },
      create: { ...g, ...geneDefaults },
    });
  }

  // 5. Capsules (execution records for trend data — last 7 days)
  const now = Date.now();
  const DAY = 86400000;
  const capsulesToCreate: any[] = [];

  for (const g of genes) {
    for (let d = 6; d >= 0; d--) {
      const count = Math.floor(Math.random() * 4) + 1; // 1-4 capsules per day
      for (let c = 0; c < count; c++) {
        const success = Math.random() < g.successCount / (g.successCount + g.failureCount + 0.01);
        capsulesToCreate.push({
          geneId: g.id,
          ownerAgentId: AGENT_ID,
          signalKey: 'mock-signal',
          outcome: success ? 'success' : 'failed',
          score: success ? 0.7 + Math.random() * 0.3 : 0.1 + Math.random() * 0.3,
          summary: `Mock capsule for ${g.title}`,
          createdAt: new Date(now - d * DAY + Math.random() * DAY),
          scope: 'global',
        });
      }
    }
  }

  // Clear old mock capsules
  await prisma.iMEvolutionCapsule.deleteMany({
    where: { ownerAgentId: AGENT_ID, summary: { startsWith: 'Mock capsule' } },
  });

  for (const cap of capsulesToCreate) {
    await prisma.iMEvolutionCapsule.create({ data: cap });
  }
  console.log(`  Created ${capsulesToCreate.length} capsules`);

  // 6. Evolution edges
  const edgesToCreate = [
    { geneId: 'gene-fix-timeout-v2', signalKey: 'error:timeout', successCount: 80, failureCount: 5 },
    { geneId: 'gene-fix-timeout-v2', signalKey: 'error:network', successCount: 30, failureCount: 2 },
    { geneId: 'gene-null-guard-v3', signalKey: 'error:null_ref', successCount: 4, failureCount: 3 },
    { geneId: 'gene-retry-backoff', signalKey: 'error:rate_limit', successCount: 25, failureCount: 3 },
    { geneId: 'gene-error-parse-recovery', signalKey: 'error:json_parse', successCount: 60, failureCount: 2 },
    { geneId: 'gene-cache-invalidation', signalKey: 'perf:cache_miss', successCount: 30, failureCount: 8 },
  ];

  for (const e of edgesToCreate) {
    await prisma.iMEvolutionEdge.upsert({
      where: { id: `e-${e.geneId.slice(-8)}-${e.signalKey.slice(-8)}` },
      update: e,
      create: { id: `e-${e.geneId.slice(-8)}-${e.signalKey.slice(-8)}`, ownerAgentId: AGENT_ID, ...e },
    });
  }

  // 7. Knowledge links
  await prisma.iMKnowledgeLink.deleteMany({
    where: { sourceId: { startsWith: 'gene-' }, sourceType: 'gene' },
  });
  const links = [
    { sourceType: 'gene', sourceId: 'gene-fix-timeout-v2', targetType: 'gene', targetId: 'gene-retry-backoff' },
    { sourceType: 'gene', sourceId: 'gene-fix-timeout-v2', targetType: 'memory', targetId: 'patterns.md' },
    { sourceType: 'gene', sourceId: 'gene-null-guard-v3', targetType: 'gene', targetId: 'gene-error-parse-recovery' },
    { sourceType: 'gene', sourceId: 'gene-error-parse-recovery', targetType: 'memory', targetId: 'patterns.md' },
    { sourceType: 'gene', sourceId: 'gene-cache-invalidation', targetType: 'gene', targetId: 'gene-query-optimizer' },
  ];
  for (const l of links) {
    await prisma.iMKnowledgeLink.create({
      data: { ...l, strength: 0.7 + Math.random() * 0.3 },
    });
  }

  // 8. Skills (catalog)
  const skills = [
    { id: 'skill-web-search', slug: 'web-search', name: 'Web Search', category: 'general', source: 'clawhub' },
    { id: 'skill-code-repair', slug: 'code-repair', name: 'Code Repair', category: 'repair', source: 'community' },
    { id: 'skill-test-runner', slug: 'test-runner', name: 'Test Runner', category: 'testing', source: 'gstack' },
  ];

  for (const s of skills) {
    await prisma.iMSkill.upsert({
      where: { id: s.id },
      update: {},
      create: {
        ...s,
        description: `${s.name} skill`,
        content: `# ${s.name}\n\nA useful skill.`,
        author: 'prismer',
        tags: '[]',
      },
    });

    await prisma.iMAgentSkill.upsert({
      where: { agentId_skillId_scope: { agentId: AGENT_ID, skillId: s.id, scope: 'global' } },
      update: {},
      create: {
        agentId: AGENT_ID,
        skillId: s.id,
        scope: 'global',
        geneId: s.slug === 'web-search' ? 'gene-fix-timeout-v2' : null,
      },
    });
  }

  // 9. Memory files
  const memoryFiles = [
    {
      path: 'AGENTS.md',
      memoryType: 'instructions',
      description: 'Agent operating instructions',
      content:
        '# Agent Instructions\n\nFollow TDD. Write tests first.\nUse structured logging.\nNever commit .env files.',
    },
    {
      path: 'USER.md',
      memoryType: 'user',
      description: 'User role and preferences',
      content:
        '# User\n\nSenior backend engineer.\nPrefers Go but learning TypeScript.\nValues correctness over speed.',
    },
    {
      path: 'TOOLS.md',
      memoryType: 'tools',
      description: 'Local tool documentation',
      content: '# Tools\n\n- prisma: ORM for DB\n- tsx: TS runner\n- vitest: test framework',
    },
    {
      path: 'HEARTBEAT.md',
      memoryType: 'heartbeat',
      description: 'Session health checklist',
      content: '# Heartbeat\n\n- [ ] Check build passes\n- [ ] Run lint\n- [ ] Verify tests',
      stale: true,
    },
    {
      path: 'feedback_testing.md',
      memoryType: 'feedback',
      description: 'Integration tests must hit real database',
      content:
        '# Testing Feedback\n\nNever mock the database in integration tests.\nReason: prior incident where mock/prod divergence masked a broken migration.',
    },
    {
      path: 'project_strategy.md',
      memoryType: 'project',
      description: 'Pre-A fundraising strategy and priorities',
      content:
        '# Project Strategy\n\nv1.7.x focused on data loop + SDK friction reduction.\nKey metric: SDK install → first successful context load time.',
    },
    {
      path: 'reference_links.md',
      memoryType: 'reference',
      description: 'Pipeline bugs tracked in Linear INGEST project',
      content:
        '# References\n\n- Linear: INGEST project for pipeline bugs\n- Grafana: grafana.internal/d/api-latency for oncall',
    },
    {
      path: 'daily/2026-04-05.md',
      memoryType: 'daily',
      description: 'Daily notes for April 5',
      content:
        '# 2026-04-05\n\n- Redesigned workspace UI (Less is More)\n- Audited data pipeline\n- Fixed Recharts tooltip type error',
    },
    {
      path: 'daily/2026-04-04.md',
      memoryType: 'daily',
      description: 'Daily notes for April 4',
      content:
        '# 2026-04-04\n\n- Implemented workspace V1 superset API\n- Code review: 6 issues found and fixed\n- All 3 PRs merged, build passing',
    },
    {
      path: 'daily/2026-04-03.md',
      memoryType: 'daily',
      description: 'Daily notes for April 3',
      content:
        '# 2026-04-03\n\n- Designed workspace scope migration\n- Wrote DESIGN-v180-workspace-platform.md\n- Reviewed with Tom',
    },
    {
      path: 'SOUL.md',
      memoryType: 'soul',
      description: 'Agent personality and soul',
      content:
        'A methodical engineer who values correctness over speed, prefers explicit error handling, and documents decisions with rationale.',
    },
    {
      path: 'patterns.md',
      memoryType: 'insight',
      description: 'Recurring code patterns and fixes',
      content:
        '# Patterns\n\n## Error Handling\n- Always use exponential backoff for retries\n- Log error context before throwing\n- Never swallow errors silently\n\n## TypeScript\n- Use explicit (x: any) for Prisma map callbacks\n- PrismerGene uses snake_case fields',
    },
  ];

  for (const m of memoryFiles) {
    await prisma.iMMemoryFile.upsert({
      where: { ownerId_scope_path: { ownerId: AGENT_ID, scope: 'global', path: m.path } },
      update: {
        content: m.content,
        memoryType: m.memoryType,
        description: m.description,
        stale: (m as any).stale || false,
      },
      create: { ownerId: AGENT_ID, scope: 'global', ...m, stale: (m as any).stale || false },
    });
  }

  // 10. Credits (SQLite dev-only table — skip on MySQL)
  if (prisma.iMCredit) {
    await prisma.iMCredit.upsert({
      where: { imUserId: AGENT_ID },
      update: { balance: 8420, totalEarned: 12300, totalSpent: 3880 },
      create: { imUserId: AGENT_ID, balance: 8420, totalEarned: 12300, totalSpent: 3880 },
    });
  } else {
    console.log('  Skipping credits (MySQL — uses pc_user_credits via CloudCreditService)');
  }

  // 11. Tasks
  const tasks = [
    { title: 'Deploy staging', status: 'running', assigneeId: AGENT_ID },
    { title: 'Fix null guard breaker', status: 'pending', assigneeId: null },
    { title: 'Review PR #142', status: 'completed', assigneeId: AGENT_ID },
  ];
  await prisma.iMTask.deleteMany({ where: { creatorId: AGENT_ID, title: { in: tasks.map((t) => t.title) } } });
  for (const t of tasks) {
    await prisma.iMTask.create({
      data: { creatorId: AGENT_ID, scope: 'global', ...t },
    });
  }

  console.log('Done! Mock data seeded.');
  console.log(`  Agent: ${AGENT_ID}`);
  console.log(`  User: ${USER_ID}`);
  console.log(`  Genes: ${genes.length}`);
  console.log(`  Memory files: ${memoryFiles.length}`);
  console.log(`  Skills: ${skills.length}`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
