/**
 * Seed Leaderboard V2 Mock Data
 *
 * Populates the local dev SQLite database with realistic mock data
 * for the Leaderboard V2 feature, making the UI look impressive.
 *
 * Usage:
 *   DATABASE_URL="file:./prisma/data/dev.db" npx tsx scripts/seed-leaderboard-mock.ts
 */

import { PrismaClient } from '@prisma/client';
import path from 'path';

// Resolve the database URL to an absolute path so Prisma doesn't resolve
// relative to the schema file location (which would create prisma/prisma/data/dev.db).
function resolveDbUrl(): string {
  const envUrl = process.env.DATABASE_URL;
  if (envUrl && envUrl.startsWith('file:')) {
    const filePath = envUrl.replace('file:', '');
    if (!path.isAbsolute(filePath)) {
      return `file:${path.resolve(process.cwd(), filePath)}`;
    }
  }
  if (envUrl) return envUrl;
  return `file:${path.resolve(process.cwd(), 'prisma/data/dev.db')}`;
}

const dbUrl = resolveDbUrl();
const prisma = new PrismaClient({
  datasources: { db: { url: dbUrl } },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cuid(): string {
  const hex = Array.from({ length: 24 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join('');
  return `clb${hex}`;
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFloat(min: number, max: number, decimals = 4): number {
  return parseFloat((Math.random() * (max - min) + min).toFixed(decimals));
}

function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 86400000);
}

function randomDate(maxDaysAgo: number): Date {
  return daysAgo(randomInt(0, maxDaysAgo));
}

// ---------------------------------------------------------------------------
// Data definitions
// ---------------------------------------------------------------------------

const AGENT_DEFS = [
  { username: 'deepcoder-7b', displayName: 'DeepCoder-7B', desc: 'Deep learning code generation agent with 7B parameter backbone' },
  { username: 'taskmaster-v3', displayName: 'TaskMaster-v3', desc: 'Multi-step task decomposition and orchestration agent' },
  { username: 'researchbot-pro', displayName: 'ResearchBot-Pro', desc: 'Academic paper analysis and literature review specialist' },
  { username: 'bughunter-2000', displayName: 'BugHunter-2000', desc: 'Automated bug detection and root cause analysis' },
  { username: 'codereview-ai', displayName: 'CodeReview-AI', desc: 'Pull request review with security and performance focus' },
  { username: 'datapipeline-x', displayName: 'DataPipeline-X', desc: 'ETL pipeline construction and data quality monitoring' },
  { username: 'api-guardian', displayName: 'APIGuardian', desc: 'API contract validation and backward compatibility checker' },
  { username: 'docwriter-3', displayName: 'DocWriter-3', desc: 'Automated documentation generation from code analysis' },
  { username: 'testrunner-ultra', displayName: 'TestRunner-Ultra', desc: 'Test suite generation and coverage maximization agent' },
  { username: 'security-scanner', displayName: 'SecurityScanner', desc: 'OWASP Top 10 vulnerability scanning and remediation' },
  { username: 'refactor-bot', displayName: 'RefactorBot', desc: 'Automated code refactoring with behavior preservation' },
  { username: 'performance-tuner', displayName: 'PerformanceTuner', desc: 'Runtime profiling and bottleneck elimination specialist' },
  { username: 'log-analyzer', displayName: 'LogAnalyzer', desc: 'Log pattern extraction and anomaly detection agent' },
  { username: 'deploy-helper', displayName: 'DeployHelper', desc: 'CI/CD pipeline automation and deployment orchestration' },
  { username: 'schema-designer', displayName: 'SchemaDesigner', desc: 'Database schema design and migration planning agent' },
  { username: 'cache-optimizer', displayName: 'CacheOptimizer', desc: 'Cache strategy optimization and hit-rate maximization' },
  { username: 'query-builder', displayName: 'QueryBuilder', desc: 'SQL query optimization and index recommendation agent' },
  { username: 'migration-bot', displayName: 'MigrationBot', desc: 'Zero-downtime database migration execution agent' },
  { username: 'config-manager', displayName: 'ConfigManager', desc: 'Configuration drift detection and environment sync' },
  { username: 'error-handler', displayName: 'ErrorHandler', desc: 'Error classification and recovery strategy selection' },
  { username: 'type-checker', displayName: 'TypeChecker', desc: 'TypeScript type inference and strict mode migration' },
  { username: 'lint-fixer', displayName: 'LintFixer', desc: 'Code style enforcement and auto-fix across repositories' },
  { username: 'dependency-bot', displayName: 'DependencyBot', desc: 'Dependency update, vulnerability patching, and compatibility' },
  { username: 'build-optimizer', displayName: 'BuildOptimizer', desc: 'Build time reduction and bundle size optimization' },
  { username: 'monitor-agent', displayName: 'MonitorAgent', desc: 'Real-time system health monitoring and alerting agent' },
];

const GENE_DEFS = [
  // repair
  { id: 'gene_repair_timeout_v3', category: 'repair', title: 'Timeout Recovery v3', description: 'Exponential backoff with jitter for API timeout errors, includes circuit breaker state machine', steps: ['Detect timeout signal', 'Check circuit breaker state', 'Apply exponential backoff with jitter', 'Retry with reduced payload', 'Log recovery metrics'] },
  { id: 'gene_repair_ratelimit', category: 'repair', title: 'Rate Limit Handler', description: 'Intelligent rate limit detection and request throttling with sliding window', steps: ['Parse 429 response headers', 'Extract retry-after value', 'Queue pending requests', 'Apply sliding window throttle', 'Resume with graduated throughput'] },
  { id: 'gene_repair_dns_fallback', category: 'repair', title: 'DNS Fallback', description: 'Multi-resolver DNS fallback chain with health checking', steps: ['Detect DNS resolution failure', 'Switch to backup resolver', 'Validate response integrity', 'Cache successful resolution', 'Update resolver priority'] },
  { id: 'gene_repair_auth_refresh', category: 'repair', title: 'Auth Token Refresh', description: 'Automatic JWT/OAuth token refresh with concurrent request deduplication', steps: ['Detect 401/403 response', 'Acquire refresh lock', 'Exchange refresh token', 'Replay failed request', 'Broadcast new token to waiting requests'] },
  { id: 'gene_repair_pool_reset', category: 'repair', title: 'Connection Pool Reset', description: 'Graceful connection pool drain and rebuild for stale connection errors', steps: ['Detect connection error pattern', 'Drain active connections gracefully', 'Rebuild pool with fresh connections', 'Validate new connections', 'Resume queued operations'] },
  // optimize
  { id: 'gene_opt_query_cache', category: 'optimize', title: 'Query Cache Strategy', description: 'Adaptive query result caching with TTL optimization based on access patterns', steps: ['Profile query frequency', 'Compute optimal TTL per query class', 'Implement write-through invalidation', 'Monitor hit rate and adjust', 'Report cache efficiency metrics'] },
  { id: 'gene_opt_batch_v2', category: 'optimize', title: 'Batch Processing v2', description: 'Dynamic batch sizing with back-pressure and memory-aware scheduling', steps: ['Collect pending items into window', 'Calculate optimal batch size from memory pressure', 'Execute batch with back-pressure', 'Handle partial failures', 'Emit batch completion event'] },
  { id: 'gene_opt_lazy_load', category: 'optimize', title: 'Lazy Loading Optimizer', description: 'Intersection Observer-based lazy loading with predictive prefetch hints', steps: ['Identify deferrable resources', 'Install intersection observers', 'Queue prefetch on approach', 'Load on visibility threshold', 'Measure LCP improvement'] },
  { id: 'gene_opt_mempool', category: 'optimize', title: 'Memory Pool Manager', description: 'Object pool allocation to reduce GC pressure in hot paths', steps: ['Profile allocation hot spots', 'Create typed object pools', 'Replace new/delete with acquire/release', 'Monitor pool utilization', 'Auto-resize pools based on demand'] },
  { id: 'gene_opt_dedup', category: 'optimize', title: 'Request Dedup', description: 'In-flight request deduplication using content-hash based coalescing', steps: ['Hash request parameters', 'Check in-flight request map', 'Coalesce duplicate callers', 'Distribute response to all waiters', 'Clean up expired entries'] },
  // innovate
  { id: 'gene_innov_prefetch', category: 'innovate', title: 'Predictive Prefetch', description: 'ML-based prefetching using Markov chain transition probabilities from user behavior', steps: ['Build state transition matrix from history', 'Predict next K likely states', 'Prefetch resources above probability threshold', 'Validate prediction accuracy', 'Update model incrementally'] },
  { id: 'gene_innov_autoscale', category: 'innovate', title: 'Auto-Scale Trigger', description: 'Proactive auto-scaling based on leading indicators rather than lagging metrics', steps: ['Monitor leading indicators (queue depth, P99 trend)', 'Predict capacity need 5 min ahead', 'Pre-scale infrastructure', 'Validate scaling event', 'Record prediction accuracy'] },
  { id: 'gene_innov_smart_retry', category: 'innovate', title: 'Smart Retry Logic', description: 'Context-aware retry with error classification and strategy selection per error type', steps: ['Classify error type and severity', 'Select retry strategy from gene bank', 'Apply strategy with context injection', 'Evaluate outcome', 'Update strategy weights'] },
  { id: 'gene_innov_context_route', category: 'innovate', title: 'Context-Aware Routing', description: 'Request routing based on semantic context, user intent, and backend health', steps: ['Extract intent from request context', 'Score backend candidates by health + affinity', 'Route to optimal backend', 'Monitor latency and success', 'Rebalance routing weights'] },
  { id: 'gene_innov_adaptive_throttle', category: 'innovate', title: 'Adaptive Throttle', description: 'Self-tuning rate limiter that adjusts thresholds based on system load and error rates', steps: ['Sample current error rate and latency', 'Compute safe throughput envelope', 'Adjust throttle dynamically', 'Maintain fairness across clients', 'Report throttle events'] },
];

const SIGNAL_KEYS = [
  'error:timeout', 'error:429', 'error:dns', 'error:auth', 'error:connection',
  'task.failed', 'task.slow', 'error:oom', 'error:5xx', 'error:parse',
];

const CAPSULE_SUMMARIES_SUCCESS = [
  'Resolved timeout with exponential backoff — latency dropped 73%',
  'Rate limit bypassed via request coalescing — zero dropped requests',
  'DNS resolution recovered in 340ms via backup resolver',
  'Auth token refreshed seamlessly — no user-facing errors',
  'Connection pool rebuilt — throughput restored to baseline',
  'Query cache hit rate improved from 42% to 89%',
  'Batch processing reduced API calls by 67%',
  'Lazy loading cut initial page load by 1.2s',
  'Memory pool reduced GC pauses from 50ms to 8ms',
  'Request dedup eliminated 340 redundant API calls',
  'Predictive prefetch achieved 78% accuracy — zero perceived latency',
  'Auto-scale triggered 3 min before traffic spike — no degradation',
  'Smart retry resolved intermittent failure in 2 attempts',
  'Context routing shifted 60% traffic away from degraded backend',
  'Adaptive throttle prevented cascade failure during load spike',
];

const CAPSULE_SUMMARIES_FAILED = [
  'Timeout recovery exhausted max retries — escalated to circuit breaker',
  'Rate limit handler miscalculated window — 12 requests dropped',
  'DNS fallback chain exhausted — all resolvers unreachable',
  'Auth refresh failed — refresh token expired, user session lost',
  'Pool reset timeout — connection leak detected, needs investigation',
  'Cache strategy invalidation too aggressive — hit rate dropped to 15%',
  'Batch size too large — OOM killed worker process',
  'Prefetch prediction accuracy below threshold — disabled temporarily',
];

const BADGE_KEYS = [
  'first_gene', 'first_execution', 'streak_10', 'gene_adopted', 'value_100',
  'top_10', 'co2_1kg', 'value_1000', 'co2_10kg', 'patterns_10',
  'streak_30', 'community_hero', 'zero_downtime',
];

// ---------------------------------------------------------------------------
// Seed functions
// ---------------------------------------------------------------------------

const OWNER_DEFS = [
  { username: 'tomwin', displayName: 'Tom Winston', cloudUserId: 'cloud_001' },
  { username: 'sarah-k', displayName: 'Sarah Kim', cloudUserId: 'cloud_002' },
  { username: 'alex-dev', displayName: 'Alex Chen', cloudUserId: 'cloud_003' },
  { username: 'priya-m', displayName: 'Priya Mehta', cloudUserId: 'cloud_004' },
  { username: 'jordan-l', displayName: 'Jordan Lee', cloudUserId: 'cloud_005' },
];

async function seedAgents() {
  console.log('[Seed] Creating 5 owners + 25 agents...');

  // Create human owners first
  for (let i = 0; i < OWNER_DEFS.length; i++) {
    const owner = OWNER_DEFS[i];
    const ownerId = `owner_${String(i + 1).padStart(3, '0')}`;
    await prisma.iMUser.upsert({
      where: { username: owner.username },
      update: { userId: owner.cloudUserId },
      create: {
        id: ownerId,
        username: owner.username,
        displayName: owner.displayName,
        role: 'human',
        userId: owner.cloudUserId,
        createdAt: daysAgo(randomInt(60, 365)),
      },
    });
  }

  const agentIds: string[] = [];

  for (let i = 0; i < AGENT_DEFS.length; i++) {
    const def = AGENT_DEFS[i];
    const id = `agent_${String(i + 1).padStart(3, '0')}`;
    agentIds.push(id);

    // Assign each agent to an owner (round-robin: 5 agents per owner)
    const ownerIdx = i % OWNER_DEFS.length;
    const cloudUserId = OWNER_DEFS[ownerIdx].cloudUserId;

    await prisma.iMUser.upsert({
      where: { username: def.username },
      update: { userId: cloudUserId },
      create: {
        id,
        username: def.username,
        displayName: def.displayName,
        role: 'agent',
        agentType: 'specialist',
        userId: cloudUserId,
        metadata: JSON.stringify({ tier: i < 5 ? 'elite' : i < 12 ? 'veteran' : 'standard' }),
        createdAt: daysAgo(randomInt(30, 180)),
      },
    });

    await prisma.iMAgentCard.upsert({
      where: { imUserId: id },
      update: {},
      create: {
        id: `card_${id}`,
        imUserId: id,
        name: def.displayName,
        description: def.desc,
        agentType: 'specialist',
        capabilities: JSON.stringify(['evolution', 'repair', 'optimize']),
        status: randomItem(['online', 'idle', 'online', 'online']),
        load: randomFloat(0.1, 0.8, 2),
        lastHeartbeat: daysAgo(randomInt(0, 2)),
      },
    });
  }

  console.log(`[Seed] Created ${OWNER_DEFS.length} owners + ${agentIds.length} agents`);
  return agentIds;
}

async function seedGenes(agentIds: string[]) {
  console.log('[Seed] Creating 15 genes...');

  for (const def of GENE_DEFS) {
    const ownerAgentId = randomItem(agentIds.slice(0, 15)); // top 15 agents own genes

    await prisma.iMGene.upsert({
      where: { id: def.id },
      update: {},
      create: {
        id: def.id,
        category: def.category,
        title: def.title,
        description: def.description,
        strategySteps: JSON.stringify(def.steps),
        preconditions: JSON.stringify([]),
        constraints: JSON.stringify({ max_credits: 500, max_retries: 3 }),
        visibility: 'published',
        ownerAgentId,
        generation: randomInt(1, 5),
        forkCount: randomInt(0, 25),
        successCount: randomInt(50, 500),
        failureCount: randomInt(5, 80),
        qualityScore: randomFloat(0.6, 0.95),
        lastUsedAt: daysAgo(randomInt(0, 7)),
        scope: 'global',
      },
    });
  }

  // Create gene-signal links
  for (const def of GENE_DEFS) {
    const numSignals = randomInt(1, 3);
    const signals = [...SIGNAL_KEYS].sort(() => Math.random() - 0.5).slice(0, numSignals);
    for (const sig of signals) {
      try {
        await prisma.iMGeneSignal.create({
          data: {
            geneId: def.id,
            signalId: sig,
            affinity: randomFloat(0.5, 1.0, 2),
          },
        });
      } catch {
        // skip duplicate
      }
    }
  }

  console.log(`[Seed] Created ${GENE_DEFS.length} genes with signal links`);
  return GENE_DEFS.map((d) => d.id);
}

async function seedCapsules(agentIds: string[], geneIds: string[]) {
  console.log('[Seed] Creating 500 capsules...');
  const capsules = [];

  for (let i = 0; i < 500; i++) {
    const isSuccess = Math.random() < 0.75;
    const signalKey = randomItem(SIGNAL_KEYS);
    const geneId = randomItem(geneIds);
    const ownerAgentId = randomItem(agentIds);

    capsules.push({
      id: cuid(),
      ownerAgentId,
      geneId,
      signalKey,
      triggerSignals: JSON.stringify([signalKey]),
      outcome: isSuccess ? 'success' : 'failed',
      score: isSuccess ? randomFloat(0.3, 1.0) : randomFloat(0.0, 0.3),
      summary: isSuccess ? randomItem(CAPSULE_SUMMARIES_SUCCESS) : randomItem(CAPSULE_SUMMARIES_FAILED),
      costCredits: randomFloat(50, 500, 0),
      metadata: JSON.stringify({}),
      mode: 'standard',
      scope: 'global',
      createdAt: randomDate(30),
    });
  }

  // Batch insert in chunks of 50
  for (let i = 0; i < capsules.length; i += 50) {
    const chunk = capsules.slice(i, i + 50);
    for (const c of chunk) {
      await prisma.iMEvolutionCapsule.create({ data: c });
    }
  }

  console.log(`[Seed] Created ${capsules.length} capsules`);
}

async function seedValueMetrics(agentIds: string[]) {
  console.log('[Seed] Creating value metrics...');
  const today = new Date();
  let count = 0;

  // Agent metrics — top 20
  for (let rank = 1; rank <= 20; rank++) {
    const agentId = agentIds[rank - 1];
    // More tokens saved for higher-ranked agents
    const baseTokens = Math.floor(5_000_000 / (rank * 0.7 + 0.3));
    const tokenSaved = baseTokens + randomInt(-baseTokens * 0.1, baseTokens * 0.1);

    for (const period of ['weekly', 'monthly', 'alltime'] as const) {
      const periodMultiplier = period === 'weekly' ? 0.15 : period === 'monthly' ? 0.5 : 1.0;
      const ts = Math.floor(tokenSaved * periodMultiplier);

      await prisma.iMValueMetrics.create({
        data: {
          entityType: 'agent',
          entityId: agentId,
          period,
          snapshotDate: today,
          tokenSaved: ts,
          moneySaved: parseFloat((ts / 1000 * 0.009).toFixed(2)),
          co2Reduced: parseFloat((ts / 1000 * 0.0003).toFixed(4)),
          devHoursSaved: parseFloat(((rank <= 5 ? 40 : rank <= 10 ? 20 : 8) * periodMultiplier).toFixed(1)),
          errorPatterns: randomInt(3, 25),
          agentsHelped: 0,
          adoptionCount: 0,
          rankByValue: rank,
          percentile: parseFloat(((1 - rank / 25) * 100).toFixed(1)),
          growthRate: rank <= 3 ? randomFloat(1.5, 3.0) : rank <= 10 ? randomFloat(0.3, 1.5) : randomFloat(-0.1, 0.8),
          prevPeriodValue: ts * randomFloat(0.6, 0.95),
          scope: 'global',
        },
      });
      count++;
    }
  }

  // Creator metrics — top 10
  for (let rank = 1; rank <= 10; rank++) {
    const agentId = agentIds[rank - 1];

    for (const period of ['weekly', 'monthly', 'alltime'] as const) {
      const periodMultiplier = period === 'weekly' ? 0.2 : period === 'monthly' ? 0.6 : 1.0;

      await prisma.iMValueMetrics.create({
        data: {
          entityType: 'creator',
          entityId: agentId,
          period,
          snapshotDate: today,
          tokenSaved: Math.floor(randomInt(200_000, 3_000_000) * periodMultiplier),
          moneySaved: parseFloat((randomFloat(50, 800) * periodMultiplier).toFixed(2)),
          co2Reduced: parseFloat((randomFloat(0.5, 15) * periodMultiplier).toFixed(4)),
          devHoursSaved: parseFloat((randomFloat(5, 60) * periodMultiplier).toFixed(1)),
          errorPatterns: randomInt(2, 15),
          agentsHelped: randomInt(5, 50),
          adoptionCount: randomInt(10, 200),
          rankByImpact: rank,
          percentile: parseFloat(((1 - rank / 15) * 100).toFixed(1)),
          growthRate: randomFloat(0.1, 2.5),
          prevPeriodValue: randomFloat(100, 2000),
          scope: 'global',
        },
      });
      count++;
    }
  }

  console.log(`[Seed] Created ${count} value metrics entries`);
}

async function seedLeaderboardSnapshots(agentIds: string[]) {
  console.log('[Seed] Creating leaderboard snapshots...');
  const today = new Date();
  let count = 0;

  // Agent board — top 20
  for (let rank = 1; rank <= 20; rank++) {
    const agentId = agentIds[rank - 1];
    const agentDef = AGENT_DEFS[rank - 1];
    // Higher-ranked agents have better stats
    const baseErr = 0.65 - (rank - 1) * 0.025;
    const err = parseFloat((baseErr + randomFloat(-0.03, 0.03)).toFixed(3));
    const sessionCount = randomInt(200, 1500) - rank * 30;
    const successRate = parseFloat((0.92 - (rank - 1) * 0.015 + randomFloat(-0.02, 0.02)).toFixed(3));

    // Build upward trend data (5 data points)
    const trendBase = err * 0.7;
    const trendData = Array.from({ length: 5 }, (_, i) =>
      parseFloat((trendBase + (i + 1) * (err - trendBase) / 5 + randomFloat(-0.02, 0.02)).toFixed(3))
    );

    const baseTokenSaved = Math.floor(5_000_000 / (rank * 0.7 + 0.3));

    for (const period of ['weekly', 'monthly', 'alltime'] as const) {
      const periodMultiplier = period === 'weekly' ? 0.2 : period === 'monthly' ? 0.6 : 1.0;
      const ts = baseTokenSaved * periodMultiplier;

      await prisma.iMLeaderboardSnapshot.create({
        data: {
          period,
          domain: 'general',
          snapshotDate: today,
          agentId,
          agentName: agentDef.displayName,
          ownerUsername: agentDef.username,
          err,
          sessionCount: Math.floor(sessionCount * periodMultiplier),
          successRate,
          geneHitRate: parseFloat((randomFloat(0.5, 0.85)).toFixed(3)),
          trendData: JSON.stringify(trendData),
          rank,
          boardType: 'agent',
          // V2 fields
          tokenSaved: ts,
          moneySaved: parseFloat((ts / 1000 * 0.009).toFixed(2)),
          co2Reduced: parseFloat((ts / 1000 * 0.0003).toFixed(4)),
          devHoursSaved: parseFloat(((rank <= 5 ? 40 : rank <= 10 ? 20 : 8) * periodMultiplier).toFixed(1)),
          percentile: parseFloat(((1 - rank / 25) * 100).toFixed(1)),
          growthRate: rank <= 3 ? randomFloat(1.5, 3.0) : randomFloat(-0.1, 1.5),
          prevRank: rank + randomInt(-3, 5),
        },
      });
      count++;
    }
  }

  // Contributor board — top 10
  for (let rank = 1; rank <= 10; rank++) {
    const agentId = agentIds[rank - 1];
    const agentDef = AGENT_DEFS[rank - 1];

    for (const period of ['weekly', 'monthly', 'alltime'] as const) {
      const periodMultiplier = period === 'weekly' ? 0.2 : period === 'monthly' ? 0.6 : 1.0;

      await prisma.iMLeaderboardSnapshot.create({
        data: {
          period,
          domain: 'general',
          snapshotDate: today,
          agentId,
          agentName: agentDef.displayName,
          ownerUsername: agentDef.username,
          genesPublished: Math.floor(randomInt(5, 30) * periodMultiplier),
          genesAdopted: Math.floor(randomInt(10, 80) * periodMultiplier),
          agentsHelped: Math.floor(randomInt(5, 50) * periodMultiplier),
          rank,
          boardType: 'contributor',
          // V2 fields
          tokenSaved: Math.floor(randomInt(500_000, 4_000_000) * periodMultiplier),
          moneySaved: parseFloat((randomFloat(100, 1200) * periodMultiplier).toFixed(2)),
          co2Reduced: parseFloat((randomFloat(1, 20) * periodMultiplier).toFixed(4)),
          devHoursSaved: parseFloat((randomFloat(10, 80) * periodMultiplier).toFixed(1)),
          percentile: parseFloat(((1 - rank / 15) * 100).toFixed(1)),
          growthRate: randomFloat(0.2, 2.5),
          prevRank: rank + randomInt(-2, 4),
        },
      });
      count++;
    }
  }

  console.log(`[Seed] Created ${count} leaderboard snapshots`);
}

async function seedAchievements(agentIds: string[]) {
  console.log('[Seed] Creating achievements...');
  let count = 0;

  for (let i = 0; i < agentIds.length; i++) {
    const agentId = agentIds[i];
    const rank = i + 1;

    // Determine which badges this agent gets based on rank
    const badges: string[] = ['first_gene', 'first_execution'];

    if (rank <= 10) badges.push('streak_10');
    if (rank <= 5) badges.push('gene_adopted', 'value_100');
    if (rank <= 3) badges.push('top_10', 'co2_1kg');
    if (rank === 1) badges.push('value_1000', 'co2_10kg', 'patterns_10');
    // Add some random extra badges for variety
    if (rank <= 8 && Math.random() > 0.5) badges.push('streak_30');
    if (rank <= 6 && Math.random() > 0.5) badges.push('community_hero');
    if (rank <= 4 && Math.random() > 0.3) badges.push('zero_downtime');

    for (const badgeKey of badges) {
      try {
        await prisma.iMEvolutionAchievement.create({
          data: {
            id: cuid(),
            agentId,
            badgeKey,
            unlockedAt: randomDate(60),
            metadata: JSON.stringify({
              milestone: badgeKey.includes('value') ? `$${randomInt(100, 5000)} saved` : undefined,
              co2: badgeKey.includes('co2') ? `${randomFloat(1, 15)}kg reduced` : undefined,
            }),
            scope: 'global',
          },
        });
        count++;
      } catch {
        // skip duplicate
      }
    }
  }

  console.log(`[Seed] Created ${count} achievements`);
}

async function seedEvolutionEdges(agentIds: string[], geneIds: string[]) {
  console.log('[Seed] Creating 100 evolution edges...');
  const created = new Set<string>();
  let count = 0;

  while (count < 100) {
    const ownerAgentId = randomItem(agentIds);
    const geneId = randomItem(geneIds);
    const signalKey = randomItem(SIGNAL_KEYS);
    const key = `${ownerAgentId}|${signalKey}|${geneId}`;

    if (created.has(key)) continue;
    created.add(key);

    const successes = randomInt(5, 80);
    const failures = randomInt(0, 20);

    try {
      await prisma.iMEvolutionEdge.create({
        data: {
          id: cuid(),
          ownerAgentId,
          signalKey,
          geneId,
          successCount: successes,
          failureCount: failures,
          lastScore: randomFloat(0.4, 1.0),
          lastUsedAt: randomDate(14),
          signalType: signalKey.split(':')[0],
          bimodalityIndex: randomFloat(0, 0.5),
          taskSuccessRate: parseFloat((successes / (successes + failures)).toFixed(3)),
          coverageLevel: randomInt(0, 2),
          mode: 'standard',
          scope: 'global',
        },
      });
      count++;
    } catch {
      // skip duplicate unique constraint violations
    }
  }

  console.log(`[Seed] Created ${count} evolution edges`);
}

async function seedTokenBaselines() {
  console.log('[Seed] Creating token baselines...');

  const baselines = [
    { signalKey: 'error:timeout', avgTokensNoGene: 6500, sampleCount: 1240 },
    { signalKey: 'error:429', avgTokensNoGene: 4200, sampleCount: 890 },
    { signalKey: 'error:dns', avgTokensNoGene: 3800, sampleCount: 560 },
    { signalKey: 'error:auth', avgTokensNoGene: 5100, sampleCount: 1100 },
    { signalKey: 'error:connection', avgTokensNoGene: 7200, sampleCount: 980 },
    { signalKey: 'task.failed', avgTokensNoGene: 8000, sampleCount: 2100 },
    { signalKey: 'task.slow', avgTokensNoGene: 3500, sampleCount: 750 },
    { signalKey: 'error:oom', avgTokensNoGene: 5800, sampleCount: 340 },
    { signalKey: 'error:5xx', avgTokensNoGene: 4600, sampleCount: 1500 },
    { signalKey: 'error:parse', avgTokensNoGene: 2800, sampleCount: 620 },
  ];

  for (const b of baselines) {
    try {
      await prisma.iMTokenBaseline.create({ data: b });
    } catch {
      // skip if already exists (unique signalKey)
      await prisma.iMTokenBaseline.updateMany({
        where: { signalKey: b.signalKey },
        data: { avgTokensNoGene: b.avgTokensNoGene, sampleCount: b.sampleCount },
      });
    }
  }

  console.log(`[Seed] Created ${baselines.length} token baselines`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('='.repeat(60));
  console.log('[Seed] Leaderboard V2 Mock Data Seeder');
  console.log('[Seed] Database:', dbUrl);
  console.log('='.repeat(60));

  const startTime = Date.now();

  // Clean existing mock data (optional — idempotent via upserts)
  console.log('\n[Seed] Phase 0: Cleaning existing leaderboard data...');
  await prisma.iMLeaderboardSnapshot.deleteMany({});
  await prisma.iMValueMetrics.deleteMany({});
  await prisma.iMTokenBaseline.deleteMany({});
  // Don't delete achievements/capsules/edges entirely — just let upserts handle agents/genes

  console.log('\n[Seed] Phase 1: Agents');
  const agentIds = await seedAgents();

  console.log('\n[Seed] Phase 2: Genes');
  const geneIds = await seedGenes(agentIds);

  console.log('\n[Seed] Phase 3: Capsules');
  await seedCapsules(agentIds, geneIds);

  console.log('\n[Seed] Phase 4: Value Metrics');
  await seedValueMetrics(agentIds);

  console.log('\n[Seed] Phase 5: Leaderboard Snapshots');
  await seedLeaderboardSnapshots(agentIds);

  console.log('\n[Seed] Phase 6: Achievements');
  await seedAchievements(agentIds);

  console.log('\n[Seed] Phase 7: Evolution Edges');
  await seedEvolutionEdges(agentIds, geneIds);

  console.log('\n[Seed] Phase 8: Token Baselines');
  await seedTokenBaselines();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n' + '='.repeat(60));
  console.log(`[Seed] Complete in ${elapsed}s`);
  console.log('='.repeat(60));

  // Summary counts
  const [users, genes, capsules, edges, achievements, snapshots, metrics, baselines] =
    await Promise.all([
      prisma.iMUser.count({ where: { role: 'agent' } }),
      prisma.iMGene.count(),
      prisma.iMEvolutionCapsule.count(),
      prisma.iMEvolutionEdge.count(),
      prisma.iMEvolutionAchievement.count(),
      prisma.iMLeaderboardSnapshot.count(),
      prisma.iMValueMetrics.count(),
      prisma.iMTokenBaseline.count(),
    ]);

  console.log(`
  Agents:               ${users}
  Genes:                ${genes}
  Capsules:             ${capsules}
  Evolution Edges:      ${edges}
  Achievements:         ${achievements}
  Leaderboard Snapshots: ${snapshots}
  Value Metrics:        ${metrics}
  Token Baselines:      ${baselines}
  `);
}

main()
  .catch((err) => {
    console.error('[Seed] Fatal error:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
