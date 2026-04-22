/**
 * Prismer CLI — Evolution Commands
 *
 * v1.9.0 Evolution Gateway CLI: analyze signals, record outcomes, create genes.
 *
 * Commands:
 * - prismer evolution analyze <signals> [options] — Analyze signals and recommend gene
 * - prismer evolution record <geneId> <outcome> [options] — Record gene execution outcome
 * - prismer evolution create-gene <category> <signals> <strategy> [options] — Create new gene
 * - prismer evolution genes [options] — List available genes
 * - prismer evolution personality [options] — Get agent personality
 * - prismer evolution unmatched [options] — Get unmatched signals
 * - prismer evolution distill [options] — Trigger gene distillation
 */

import type { CliContext } from '../cli/context.js';
import type { UI } from '../cli/ui.js';
import { Command } from 'commander';
import { createCliContext, loadCliConfig } from '../cli/context.js';

// ============================================================
// Public Types
// ============================================================

export interface AnalyzeOptions {
  signals: string[];
  taskCapability?: string;
  provider?: string;
  stage?: string;
  severity?: string;
  cloudBaseUrl?: string;
  apiToken?: string;
  agentId?: string;
}

export interface RecordOptions {
  geneId: string;
  outcome: 'success' | 'failed';
  signals?: string[];
  score?: number;
  summary?: string;
  costCredits?: number;
  transitionReason?: 'gene_applied' | 'fallback_relaxed' | 'fallback_neighbor' | 'baseline';
  cloudBaseUrl?: string;
  apiToken?: string;
  agentId?: string;
}

export interface CreateGeneOptions {
  category: 'repair' | 'optimize' | 'innovate' | 'diagnostic';
  signals: string[];
  strategy: string[];
  preconditions?: string[];
  constraints?: {
    maxCredits?: number;
    maxRetries?: number;
    maxExecutionTime?: number;
  };
  cloudBaseUrl?: string;
  apiToken?: string;
  agentId?: string;
}

async function requestJson<T>(
  method: 'GET' | 'POST',
  url: URL,
  headers: Record<string, string>,
  body?: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const responseData = await response.text();

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${responseData}`);
  }

  const json = responseData ? JSON.parse(responseData) : {};
  if (json.ok && json.data !== undefined) {
    return json.data as T;
  }
  throw new Error(json.error?.message || json.error || 'Unknown error');
}

// ============================================================
// Command: analyze
// ============================================================

export async function cmdEvolutionAnalyze(
  ctx: CliContext,
  ui: UI,
  args: {
    signals?: string;
    taskCapability?: string;
    provider?: string;
    stage?: string;
    severity?: string;
  },
): Promise<void> {
  const { signals } = args;

  if (!signals) {
    if (ui.mode === 'json') {
      ui.json({ ok: false, error: 'MISSING_ARGUMENT', message: 'Missing required argument: signals' });
    } else {
      ui.error('Missing required argument: signals');
      ui.info('Usage: prismer evolution analyze <signals> [--taskCapability=...] [--provider=...] [--stage=...] [--severity=...]');
    }
    process.exit(1);
  }

  const config = await loadCliConfig(ctx);

  const spinner = ui.spinner('Analyzing signals...');

  try {
    const result = await analyzeSignals({
      signals: signals.split(',').map((s) => s.trim()),
      taskCapability: args.taskCapability,
      provider: args.provider,
      stage: args.stage,
      severity: args.severity,
      cloudBaseUrl: config.cloudBaseUrl,
      apiToken: config.apiToken,
      agentId: config.agentId,
    });

    spinner.stop();

    if (ui.mode === 'json') {
      ui.json({ ok: true, ...result });
      return;
    }

    ui.success('Analysis complete!');
    ui.table({
      columns: ['Field', 'Value'],
      rows: [
        { Field: 'Action', Value: result.advice.action },
        { Field: 'Confidence', Value: result.advice.confidence.toFixed(2) },
        { Field: 'Gene ID', Value: result.advice.gene_id || 'N/A' },
        { Field: 'Gene Title', Value: result.advice.gene?.title || 'N/A' },
        { Field: 'Matched Signals', Value: String(result.advice.signals?.length || 0) },
      ],
    });

    if (result.advice.reason) {
      ui.info(`Reason: ${result.advice.reason}`);
    }

    if (result.advice.alternatives && result.advice.alternatives.length > 0) {
      ui.info('Alternatives:');
      ui.table({
        columns: ['Gene ID', 'Confidence'],
        rows: result.advice.alternatives.map((alt) => ({
          'Gene ID': alt.gene_id,
          Confidence: alt.confidence.toFixed(2),
        })),
      });
    }
  } catch (err: unknown) {
    spinner.stop();
    const message = err instanceof Error ? err.message : String(err);
    if (ui.mode === 'json') {
      ui.json({ ok: false, error: 'ANALYZE_FAILED', message });
    } else {
      ui.error(`Failed to analyze signals: ${message}`);
    }
    process.exit(1);
  }
}

async function analyzeSignals(options: AnalyzeOptions): Promise<{
  advice: {
    action: string;
    gene_id?: string;
    gene?: { title?: string };
    confidence: number;
    signals?: unknown[];
    reason?: string;
    alternatives?: Array<{ gene_id: string; confidence: number }>;
  };
}> {
  const baseUrl = options.cloudBaseUrl || 'https://prismer.cloud/api';
  const url = new URL('/api/im/evolution/analyze', baseUrl);
  const advice = await requestJson<{
    action: string;
    gene_id?: string;
    gene?: { title?: string };
    confidence: number;
    signals?: unknown[];
    reason?: string;
    alternatives?: Array<{ gene_id: string; confidence: number }>;
  }>('POST', url, {
    ...(options.apiToken && { Authorization: `Bearer ${options.apiToken}` }),
    ...(options.agentId && { 'X-Prismer-AgentId': options.agentId }),
  }, {
      signals: options.signals,
      task_capability: options.taskCapability,
      tags: [],
      provider: options.provider,
      stage: options.stage,
      severity: options.severity,
  });
  return { advice };
}

// ============================================================
// Command: record
// ============================================================

export async function cmdEvolutionRecord(
  ctx: CliContext,
  ui: UI,
  args: {
    geneId?: string;
    outcome?: string;
    signals?: string;
    score?: string;
    summary?: string;
    costCredits?: string;
    transitionReason?: string;
  },
): Promise<void> {
  const { geneId, outcome } = args;

  if (!geneId || !outcome) {
    if (ui.mode === 'json') {
      ui.json({ ok: false, error: 'MISSING_ARGUMENT', message: 'Missing required arguments: geneId, outcome' });
    } else {
      ui.error('Missing required arguments: geneId, outcome');
      ui.info('Usage: prismer evolution record <geneId> <outcome> [--signals=...] [--score=...] [--summary=...] [--costCredits=...] [--transitionReason=...]');
    }
    process.exit(1);
  }

  if (outcome !== 'success' && outcome !== 'failed') {
    if (ui.mode === 'json') {
      ui.json({ ok: false, error: 'INVALID_ARGUMENT', message: 'Invalid outcome: must be "success" or "failed"' });
    } else {
      ui.error('Invalid outcome: must be "success" or "failed"');
    }
    process.exit(1);
  }

  const config = await loadCliConfig(ctx);

  const spinner = ui.spinner('Recording outcome...');

  try {
    const result = await recordOutcome({
      geneId,
      outcome: outcome as 'success' | 'failed',
      signals: args.signals?.split(',').map((s) => s.trim()),
      score: args.score ? parseFloat(args.score) : undefined,
      summary: args.summary,
      costCredits: args.costCredits ? parseFloat(args.costCredits) : undefined,
      transitionReason: args.transitionReason as 'gene_applied' | 'fallback_relaxed' | 'fallback_neighbor' | 'baseline' | undefined,
      cloudBaseUrl: config.cloudBaseUrl,
      apiToken: config.apiToken,
      agentId: config.agentId,
    });

    spinner.stop();

    if (ui.mode === 'json') {
      ui.json({ ok: true, ...result });
      return;
    }

    ui.success('Outcome recorded!');
    ui.table({
      columns: ['Field', 'Value'],
      rows: [
        { Field: 'Edge Updated', Value: result.edgeUpdated ? 'Yes' : 'No' },
        { Field: 'Personality Adjusted', Value: result.personalityAdjusted ? 'Yes' : 'No' },
        { Field: 'Distill Ready', Value: result.distillReady ? 'Yes' : 'No' },
      ],
    });

    if (result.personality) {
      ui.info('Updated personality:');
      const personality = result.personality as {
        rigor?: number;
        creativity?: number;
        risk_tolerance?: number;
      };
      ui.table({
        columns: ['Dimension', 'Value'],
        rows: [
          { Dimension: 'Rigor', Value: typeof personality.rigor === 'number' ? personality.rigor.toFixed(2) : 'N/A' },
          { Dimension: 'Creativity', Value: typeof personality.creativity === 'number' ? personality.creativity.toFixed(2) : 'N/A' },
          { Dimension: 'Risk Tolerance', Value: typeof personality.risk_tolerance === 'number' ? personality.risk_tolerance.toFixed(2) : 'N/A' },
        ],
      });
    }
  } catch (err: unknown) {
    spinner.stop();
    const message = err instanceof Error ? err.message : String(err);
    if (ui.mode === 'json') {
      ui.json({ ok: false, error: 'RECORD_FAILED', message });
    } else {
      ui.error(`Failed to record outcome: ${message}`);
    }
    process.exit(1);
  }
}

async function recordOutcome(options: RecordOptions): Promise<{
  edgeUpdated: boolean;
  personalityAdjusted: boolean;
  distillReady: boolean;
  personality?: unknown;
}> {
  const baseUrl = options.cloudBaseUrl || 'https://prismer.cloud/api';
  const url = new URL('/api/im/evolution/record', baseUrl);
  const result = await requestJson<Record<string, unknown>>('POST', url, {
    ...(options.apiToken && { Authorization: `Bearer ${options.apiToken}` }),
    ...(options.agentId && { 'X-Prismer-AgentId': options.agentId }),
  }, {
      gene_id: options.geneId,
      signals: options.signals || [],
      outcome: options.outcome,
      score: options.score,
      summary: options.summary ?? `${options.outcome} via runtime CLI`,
      cost_credits: options.costCredits,
      transition_reason: options.transitionReason,
  });

  return {
    edgeUpdated: Boolean(result['edgeUpdated'] ?? result['edge_updated']),
    personalityAdjusted: Boolean(result['personalityAdjusted'] ?? result['personality_adjusted']),
    distillReady: Boolean(result['distillReady'] ?? result['distill_ready']),
    personality: result['personality'],
  };
}

// ============================================================
// Command: create-gene
// ============================================================

export async function cmdEvolutionCreateGene(
  ctx: CliContext,
  ui: UI,
  args: {
    category?: string;
    signals?: string;
    strategy?: string;
    preconditions?: string;
    constraints?: string;
  },
): Promise<void> {
  const { category, signals, strategy } = args;

  if (!category || !signals || !strategy) {
    if (ui.mode === 'json') {
      ui.json({ ok: false, error: 'MISSING_ARGUMENT', message: 'Missing required arguments: category, signals, strategy' });
    } else {
      ui.error('Missing required arguments: category, signals, strategy');
      ui.info('Usage: prismer evolution create-gene <category> <signals> <strategy> [--preconditions=...] [--constraints=...]');
    }
    process.exit(1);
  }

  if (!['repair', 'optimize', 'innovate', 'diagnostic'].includes(category)) {
    if (ui.mode === 'json') {
      ui.json({ ok: false, error: 'INVALID_ARGUMENT', message: 'Invalid category: must be repair, optimize, innovate, or diagnostic' });
    } else {
      ui.error('Invalid category: must be repair, optimize, innovate, or diagnostic');
    }
    process.exit(1);
  }

  const config = await loadCliConfig(ctx);

  const spinner = ui.spinner('Creating gene...');

  try {
    const gene = await createGene({
      category: category as 'repair' | 'optimize' | 'innovate' | 'diagnostic',
      signals: signals.split(',').map((s) => s.trim()),
      strategy: strategy.split(',').map((s) => s.trim()),
      preconditions: args.preconditions?.split(',').map((s) => s.trim()),
      cloudBaseUrl: config.cloudBaseUrl,
      apiToken: config.apiToken,
      agentId: config.agentId,
    });

    spinner.stop();

    if (ui.mode === 'json') {
      ui.json({ ok: true, gene });
      return;
    }

    ui.success('Gene created!');
    ui.table({
      columns: ['Field', 'Value'],
      rows: [
        { Field: 'Gene ID', Value: gene.id },
        { Field: 'Category', Value: gene.category },
        { Field: 'Title', Value: gene.title || 'N/A' },
        { Field: 'Signals Match', Value: String(gene.signals_match.length) },
        { Field: 'Strategy Steps', Value: String(gene.strategy.length) },
        { Field: 'Created At', Value: gene.created_at },
      ],
    });
  } catch (err: unknown) {
    spinner.stop();
    const message = err instanceof Error ? err.message : String(err);
    if (ui.mode === 'json') {
      ui.json({ ok: false, error: 'CREATE_GENE_FAILED', message });
    } else {
      ui.error(`Failed to create gene: ${message}`);
    }
    process.exit(1);
  }
}

async function createGene(options: CreateGeneOptions): Promise<{
  id: string;
  category: string;
  title?: string;
  signals_match: unknown[];
  strategy: string[];
  created_at: string;
}> {
  const baseUrl = options.cloudBaseUrl || 'https://prismer.cloud/api';
  const url = new URL('/api/im/evolution/genes', baseUrl);
  return await requestJson<{
    id: string;
    category: string;
    title?: string;
    signals_match: unknown[];
    strategy: string[];
    created_at: string;
  }>('POST', url, {
    ...(options.apiToken && { Authorization: `Bearer ${options.apiToken}` }),
    ...(options.agentId && { 'X-Prismer-AgentId': options.agentId }),
  }, {
      category: options.category,
      signals_match: options.signals,
      strategy: options.strategy,
      preconditions: options.preconditions || [],
  });
}

// ============================================================
// Command: genes (list)
// ============================================================

export async function cmdEvolutionGenes(
  ctx: CliContext,
  ui: UI,
  args: {},
): Promise<void> {
  const config = await loadCliConfig(ctx);

  const spinner = ui.spinner('Fetching genes...');

  try {
    const genes = await queryGenes({
      cloudBaseUrl: config.cloudBaseUrl,
      apiToken: config.apiToken,
      agentId: config.agentId,
    });

    spinner.stop();

    if (ui.mode === 'json') {
      ui.json({ ok: true, genes });
      return;
    }

    ui.success(`Found ${genes.length} genes`);

    if (genes.length === 0) {
      ui.info('No genes found. Create one with: prismer evolution create-gene <category> <signals> <strategy>');
      return;
    }

    ui.table({
      columns: ['Gene ID', 'Category', 'Title', 'Success Rate', 'Used At'],
      rows: genes.map((gene: unknown) => {
        const successRate = (
          (gene as { success_count: number; failure_count: number }).success_count /
          ((gene as { success_count: number; failure_count: number }).success_count +
           (gene as { success_count: number; failure_count: number }).failure_count) || 1
        ).toFixed(2);

        return {
          'Gene ID': (gene as { id: string }).id,
          Category: (gene as { category: string }).category,
          Title: (gene as { title?: string }).title || 'N/A',
          'Success Rate': successRate,
          'Used At': (gene as { last_used_at: string | null }).last_used_at || 'Never',
        };
      }),
    });
  } catch (err: unknown) {
    spinner.stop();
    const message = err instanceof Error ? err.message : String(err);
    if (ui.mode === 'json') {
      ui.json({ ok: false, error: 'GENES_FETCH_FAILED', message });
    } else {
      ui.error(`Failed to fetch genes: ${message}`);
    }
    process.exit(1);
  }
}

async function queryGenes(options: {
  cloudBaseUrl?: string;
  apiToken?: string;
  agentId?: string;
}): Promise<unknown[]> {
  const baseUrl = options.cloudBaseUrl || 'https://prismer.cloud/api';
  const url = new URL('/api/im/evolution/genes', baseUrl);
  return await requestJson<unknown[]>('GET', url, {
    ...(options.apiToken && { Authorization: `Bearer ${options.apiToken}` }),
    ...(options.agentId && { 'X-Prismer-AgentId': options.agentId }),
  });
}

// ============================================================
// Command: personality
// ============================================================

export async function cmdEvolutionPersonality(
  ctx: CliContext,
  ui: UI,
  args: {},
): Promise<void> {
  const config = await loadCliConfig(ctx);

  const spinner = ui.spinner('Fetching personality...');

  try {
    const personality = await getPersonality({
      cloudBaseUrl: config.cloudBaseUrl,
      apiToken: config.apiToken,
      agentId: config.agentId,
    });

    spinner.stop();

    if (ui.mode === 'json') {
      ui.json({ ok: true, personality });
      return;
    }

    ui.success('Personality retrieved!');
    ui.table({
      columns: ['Dimension', 'Value'],
      rows: [
        { Dimension: 'Rigor', Value: (personality as { rigor: number }).rigor.toFixed(2) },
        { Dimension: 'Creativity', Value: (personality as { creativity: number }).creativity.toFixed(2) },
        { Dimension: 'Risk Tolerance', Value: (personality as { risk_tolerance: number }).risk_tolerance.toFixed(2) },
      ],
    });
  } catch (err: unknown) {
    spinner.stop();
    const message = err instanceof Error ? err.message : String(err);
    if (ui.mode === 'json') {
      ui.json({ ok: false, error: 'PERSONALITY_FETCH_FAILED', message });
    } else {
      ui.error(`Failed to fetch personality: ${message}`);
    }
    process.exit(1);
  }
}

async function getPersonality(options: {
  cloudBaseUrl?: string;
  apiToken?: string;
  agentId?: string;
}): Promise<unknown> {
  if (!options.agentId) {
    throw new Error('agentId is required to fetch evolution personality');
  }
  const baseUrl = options.cloudBaseUrl || 'https://prismer.cloud/api';
  const url = new URL(`/api/im/evolution/personality/${encodeURIComponent(options.agentId)}`, baseUrl);
  const result = await requestJson<unknown>('GET', url, {
    ...(options.apiToken && { Authorization: `Bearer ${options.apiToken}` }),
    ...(options.agentId && { 'X-Prismer-AgentId': options.agentId }),
  });
  return (result as { personality?: unknown }).personality ?? result;
}

// ============================================================
// Command: distill
// ============================================================

export async function cmdEvolutionDistill(
  ctx: CliContext,
  ui: UI,
  args: { dryRun?: string },
): Promise<void> {
  const config = await loadCliConfig(ctx);

  const spinner = ui.spinner('Triggering distillation...');

  try {
    const result = await triggerDistillation({
      dryRun: args.dryRun === 'true',
      cloudBaseUrl: config.cloudBaseUrl,
      apiToken: config.apiToken,
      agentId: config.agentId,
    });

    spinner.stop();

    if (ui.mode === 'json') {
      ui.json({ ok: true, triggered: result.triggered });
      return;
    }

    if (result.triggered) {
      ui.success('Distillation triggered successfully!');
      ui.info('Check back later for new genes created from successful patterns.');
    } else {
      ui.warn('Distillation not triggered. Not enough success capsules accumulated.');
    }
  } catch (err: unknown) {
    spinner.stop();
    const message = err instanceof Error ? err.message : String(err);
    if (ui.mode === 'json') {
      ui.json({ ok: false, error: 'DISTILL_FAILED', message });
    } else {
      ui.error(`Failed to trigger distillation: ${message}`);
    }
    process.exit(1);
  }
}

async function triggerDistillation(options: {
  dryRun?: boolean;
  cloudBaseUrl?: string;
  apiToken?: string;
  agentId?: string;
}): Promise<{ triggered: boolean }> {
  const baseUrl = options.cloudBaseUrl || 'https://prismer.cloud/api';
  const url = new URL('/api/im/evolution/distill', baseUrl);
  if (options.dryRun) {
    url.searchParams.set('dry_run', 'true');
  }
  const result = await requestJson<unknown>('POST', url, {
    ...(options.apiToken && { Authorization: `Bearer ${options.apiToken}` }),
    ...(options.agentId && { 'X-Prismer-AgentId': options.agentId }),
  });
  if (typeof result === 'boolean') {
    return { triggered: result };
  }
  const data = result as Record<string, unknown>;
  return { triggered: Boolean(data['triggered'] ?? data['distillTriggered'] ?? data['created_gene_id'] ?? data['gene']) };
}

// ============================================================
// Command: unmatched
// ============================================================

export async function cmdEvolutionUnmatched(
  ctx: CliContext,
  ui: UI,
  args: { limit?: string },
): Promise<void> {
  const config = await loadCliConfig(ctx);
  const limit = args.limit ? parseInt(args.limit) : 20;

  const spinner = ui.spinner('Fetching unmatched signals...');

  try {
    const unmatched = await getUnmatchedSignals({
      limit,
      cloudBaseUrl: config.cloudBaseUrl,
    });

    spinner.stop();

    if (ui.mode === 'json') {
      ui.json({ ok: true, unmatched });
      return;
    }

    ui.success(`Found ${unmatched.length} unmatched signals`);

    if (unmatched.length === 0) {
      ui.info('No unmatched signals. Evolution frontier is clean!');
      return;
    }

    ui.table({
      columns: ['Signal Key', 'First Seen', 'Occurrence Count'],
      rows: unmatched.map((s: unknown) => ({
        'Signal Key': (s as { signalKey: string }).signalKey,
        'First Seen': (s as { firstSeenAt: string }).firstSeenAt,
        'Occurrence Count': String((s as { occurrenceCount: number }).occurrenceCount),
      })),
    });
  } catch (err: unknown) {
    spinner.stop();
    const message = err instanceof Error ? err.message : String(err);
    if (ui.mode === 'json') {
      ui.json({ ok: false, error: 'UNMATCHED_FETCH_FAILED', message });
    } else {
      ui.error(`Failed to fetch unmatched signals: ${message}`);
    }
    process.exit(1);
  }
}

async function getUnmatchedSignals(options: {
  limit: number;
  cloudBaseUrl?: string;
}): Promise<unknown[]> {
  const baseUrl = options.cloudBaseUrl || 'https://prismer.cloud/api';
  const url = new URL('/api/im/evolution/public/unmatched', baseUrl);
  url.searchParams.set('limit', String(options.limit));
  return await requestJson<unknown[]>('GET', url, {});
}

// ============================================================
// Register Commands
// ============================================================

export function registerEvolutionCommands(program: Command, ui: UI): void {
  const evolutionCmd = program
    .command('evolution')
    .description('Analyze signals and manage evolution genes');

  evolutionCmd
    .command('analyze')
    .argument('<signals>', 'Comma-separated signals')
    .option('--taskCapability <capability>', 'Task capability')
    .option('--provider <provider>', 'Preferred provider')
    .option('--stage <stage>', 'Execution stage')
    .option('--severity <severity>', 'Signal severity')
    .action(async (
      signals: string,
      options: {
        taskCapability?: string;
        provider?: string;
        stage?: string;
        severity?: string;
      },
    ) => {
      const ctx = await createCliContext({ argv: process.argv, ui });
      await cmdEvolutionAnalyze(ctx, ui, { signals, ...options });
    });

  evolutionCmd
    .command('record')
    .argument('<geneId>', 'Gene ID')
    .argument('<outcome>', 'Execution outcome: success|failed')
    .option('--signals <signals>', 'Comma-separated signals')
    .option('--score <score>', 'Outcome score')
    .option('--summary <summary>', 'Outcome summary')
    .option('--costCredits <credits>', 'Credits consumed')
    .option('--transitionReason <reason>', 'Transition reason')
    .action(async (
      geneId: string,
      outcome: string,
      options: {
        signals?: string;
        score?: string;
        summary?: string;
        costCredits?: string;
        transitionReason?: string;
      },
    ) => {
      const ctx = await createCliContext({ argv: process.argv, ui });
      await cmdEvolutionRecord(ctx, ui, { geneId, outcome, ...options });
    });

  evolutionCmd
    .command('create-gene')
    .argument('<category>', 'Gene category')
    .argument('<signals>', 'Comma-separated signals')
    .argument('<strategy>', 'Comma-separated strategy steps')
    .option('--preconditions <items>', 'Comma-separated preconditions')
    .option('--constraints <json>', 'JSON constraints object')
    .action(async (
      category: string,
      signals: string,
      strategy: string,
      options: { preconditions?: string; constraints?: string },
    ) => {
      const ctx = await createCliContext({ argv: process.argv, ui });
      await cmdEvolutionCreateGene(ctx, ui, {
        category,
        signals,
        strategy,
        ...options,
      });
    });

  evolutionCmd
    .command('genes')
    .description('List available genes')
    .action(async () => {
      const ctx = await createCliContext({ argv: process.argv, ui });
      await cmdEvolutionGenes(ctx, ui, {});
    });

  evolutionCmd
    .command('personality')
    .description('Show current agent personality')
    .action(async () => {
      const ctx = await createCliContext({ argv: process.argv, ui });
      await cmdEvolutionPersonality(ctx, ui, {});
    });

  evolutionCmd
    .command('distill')
    .option('--dry-run', 'Preview without creating genes')
    .action(async (options: { dryRun?: boolean }) => {
      const ctx = await createCliContext({ argv: process.argv, ui });
      await cmdEvolutionDistill(ctx, ui, {
        dryRun: options.dryRun ? 'true' : undefined,
      });
    });

  evolutionCmd
    .command('unmatched')
    .option('--limit <n>', 'Maximum unmatched signals', '20')
    .action(async (options: { limit?: string }) => {
      const ctx = await createCliContext({ argv: process.argv, ui });
      await cmdEvolutionUnmatched(ctx, ui, options);
    });
}
