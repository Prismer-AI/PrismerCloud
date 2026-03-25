import { Command } from 'commander';
import { PrismerClient } from '../index';

type ClientFactory = () => PrismerClient;

/**
 * Parse signals from a CLI option value.
 * Accepts either a JSON array string or a comma-separated list of strings.
 */
function parseSignals(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // fall through to comma-split
    }
  }
  return trimmed.split(',').map((s) => s.trim()).filter(Boolean);
}

function handleError(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

function printResult(res: { ok?: boolean; data?: unknown; error?: unknown }, label?: string): void {
  if (!res.ok) {
    const errMsg =
      res.error && typeof res.error === 'object' && 'message' in res.error
        ? (res.error as { message: string }).message
        : JSON.stringify(res.error);
    process.stderr.write(`Error: ${errMsg || 'Unknown error'}\n`);
    process.exit(1);
  }
  if (label) {
    process.stdout.write(`${label}\n`);
  }
}

export function register(parent: Command, getIMClient: ClientFactory, _getAPIClient: ClientFactory): void {
  const evolve = parent
    .command('evolve')
    .description('Evolution engine — analyze signals, manage genes, track learning');

  // ---------------------------------------------------------------------------
  // 1. evolve analyze
  // ---------------------------------------------------------------------------
  evolve
    .command('analyze')
    .description('Analyze signals to find matching evolution strategies')
    .option('-e, --error <msg>', 'error message to analyze')
    .option('-s, --signals <signals>', 'signals as JSON array or comma-separated list')
    .option('--task-status <status>', 'task status (e.g. failed, timeout)')
    .option('--provider <name>', 'provider name (e.g. openai, exa)')
    .option('--stage <stage>', 'pipeline stage')
    .option('--severity <level>', 'severity level (low, medium, high, critical)')
    .option('--tags <tags>', 'comma-separated tags')
    .option('--scope <scope>', 'evolution scope (default: global)')
    .option('--json', 'output raw JSON response')
    .action(async (opts: {
      error?: string;
      signals?: string;
      taskStatus?: string;
      provider?: string;
      stage?: string;
      severity?: string;
      tags?: string;
      scope?: string;
      json?: boolean;
    }) => {
      const client = getIMClient();
      try {
        const signals = parseSignals(opts.signals);
        const tags = opts.tags ? opts.tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined;

        const res = await client.im.evolution.analyze({
          signals,
          error: opts.error,
          task_status: opts.taskStatus,
          provider: opts.provider,
          stage: opts.stage,
          severity: opts.severity,
          tags,
          scope: opts.scope,
        });

        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }

        printResult(res);
        const data = res.data as Record<string, unknown> | undefined;
        if (data) {
          const matches = data.matches as unknown[] | undefined;
          const count = matches?.length ?? 0;
          process.stdout.write(`Matched ${count} gene(s)\n`);
          if (matches && count > 0) {
            for (const m of matches as Array<Record<string, unknown>>) {
              const id = m.gene_id ?? m.id ?? '?';
              const title = m.title ?? m.name ?? '';
              const score = m.score !== undefined ? ` (score: ${m.score})` : '';
              process.stdout.write(`  • ${id}${title ? ` — ${title}` : ''}${score}\n`);
            }
          }
        }
      } catch (err) {
        handleError(err);
      }
    });

  // ---------------------------------------------------------------------------
  // 2. evolve record
  // ---------------------------------------------------------------------------
  evolve
    .command('record')
    .description('Record an outcome against an evolution gene')
    .requiredOption('-g, --gene <id>', 'gene ID to record against')
    .requiredOption('-o, --outcome <outcome>', 'outcome: success, failure, partial')
    .option('-s, --signals <signals>', 'signals as JSON array or comma-separated list')
    .option('--score <n>', 'outcome score (0-1)')
    .option('--summary <text>', 'brief summary of the outcome')
    .option('--scope <scope>', 'evolution scope (default: global)')
    .option('--json', 'output raw JSON response')
    .action(async (opts: {
      gene: string;
      outcome: string;
      signals?: string;
      score?: string;
      summary?: string;
      scope?: string;
      json?: boolean;
    }) => {
      const client = getIMClient();
      try {
        const signals = parseSignals(opts.signals);
        const score = opts.score !== undefined ? parseFloat(opts.score) : undefined;

        const res = await client.im.evolution.record({
          gene_id: opts.gene,
          signals,
          outcome: opts.outcome,
          score,
          summary: opts.summary,
          scope: opts.scope,
        });

        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }

        printResult(res, `Recorded outcome "${opts.outcome}" for gene ${opts.gene}`);
      } catch (err) {
        handleError(err);
      }
    });

  // ---------------------------------------------------------------------------
  // 3. evolve report
  // ---------------------------------------------------------------------------
  evolve
    .command('report')
    .description('Submit a full evolution report (error + status context)')
    .requiredOption('-e, --error <msg>', 'raw error message or context')
    .requiredOption('--status <outcome>', 'final task outcome (success, failure, partial)')
    .option('--task <context>', 'task context description')
    .option('--wait', 'poll for report completion (max 60s)')
    .option('--json', 'output raw JSON response')
    .action(async (opts: {
      error: string;
      status: string;
      task?: string;
      wait?: boolean;
      json?: boolean;
    }) => {
      const client = getIMClient();
      try {
        const res = await client.im.evolution.submitReport({
          rawContext: opts.error,
          outcome: opts.status,
          taskContext: opts.task,
        });

        if (opts.json && !opts.wait) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }

        if (!res.ok) {
          const errMsg =
            res.error && typeof res.error === 'object' && 'message' in res.error
              ? (res.error as { message: string }).message
              : JSON.stringify(res.error);
          process.stderr.write(`Error: ${errMsg || 'Unknown error'}\n`);
          process.exit(1);
        }

        const submitData = res.data as { trace_id?: string; fast_signals?: unknown[] } | undefined;
        const traceId = submitData?.trace_id;

        if (!opts.wait || !traceId) {
          if (opts.json) {
            process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          } else {
            process.stdout.write(`Report submitted. trace_id: ${traceId ?? 'unknown'}\n`);
            if (submitData?.fast_signals) {
              process.stdout.write(`Fast signals: ${JSON.stringify(submitData.fast_signals)}\n`);
            }
          }
          return;
        }

        // Poll for completion
        if (!opts.json) {
          process.stdout.write(`Waiting for report ${traceId} `);
        }

        const maxIterations = 30;
        let lastStatus: unknown;
        for (let i = 0; i < maxIterations; i++) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          if (!opts.json) process.stdout.write('.');

          const statusRes = await client.im.evolution.getReportStatus(traceId);
          if (!statusRes.ok) break;

          const statusData = statusRes.data as { status?: string; extracted_signals?: unknown; root_cause?: string } | undefined;
          lastStatus = statusData;

          if (statusData?.status === 'done' || statusData?.status === 'complete' || statusData?.status === 'completed') {
            if (!opts.json) {
              process.stdout.write('\n');
              process.stdout.write(`Status: ${statusData.status}\n`);
              if (statusData.root_cause) process.stdout.write(`Root cause: ${statusData.root_cause}\n`);
              if (statusData.extracted_signals) process.stdout.write(`Extracted signals: ${JSON.stringify(statusData.extracted_signals)}\n`);
            } else {
              process.stdout.write(JSON.stringify({ trace_id: traceId, ...statusData }, null, 2) + '\n');
            }
            return;
          }
        }

        if (!opts.json) {
          process.stdout.write('\n');
          process.stdout.write(`Timed out waiting for report. Last status: ${JSON.stringify(lastStatus)}\n`);
        } else {
          process.stdout.write(JSON.stringify({ trace_id: traceId, status: 'timeout', last: lastStatus }, null, 2) + '\n');
        }
        process.exit(1);
      } catch (err) {
        handleError(err);
      }
    });

  // ---------------------------------------------------------------------------
  // 4. evolve report-status <trace-id>
  // ---------------------------------------------------------------------------
  evolve
    .command('report-status <trace-id>')
    .description('Check the status of a submitted evolution report')
    .option('--json', 'output raw JSON response')
    .action(async (traceId: string, opts: { json?: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.evolution.getReportStatus(traceId);

        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }

        printResult(res);
        const data = res.data as { status?: string; extracted_signals?: unknown; root_cause?: string } | undefined;
        process.stdout.write(`trace_id: ${traceId}\n`);
        process.stdout.write(`status:   ${data?.status ?? 'unknown'}\n`);
        if (data?.root_cause) process.stdout.write(`root_cause: ${data.root_cause}\n`);
        if (data?.extracted_signals) process.stdout.write(`extracted_signals: ${JSON.stringify(data.extracted_signals)}\n`);
      } catch (err) {
        handleError(err);
      }
    });

  // ---------------------------------------------------------------------------
  // 5. evolve create
  // ---------------------------------------------------------------------------
  evolve
    .command('create')
    .description('Create a new evolution gene')
    .requiredOption('-c, --category <cat>', 'gene category')
    .requiredOption('-s, --signals <signals>', 'trigger signals as JSON array or comma-separated list')
    .requiredOption('--strategy <steps...>', 'strategy steps (variadic)')
    .option('-n, --name <title>', 'gene title / display name')
    .option('--scope <scope>', 'evolution scope (default: global)')
    .option('--json', 'output raw JSON response')
    .action(async (opts: {
      category: string;
      signals: string;
      strategy: string[];
      name?: string;
      scope?: string;
      json?: boolean;
    }) => {
      const client = getIMClient();
      try {
        const signals_match = parseSignals(opts.signals) ?? [];

        const res = await client.im.evolution.createGene({
          category: opts.category,
          signals_match,
          strategy: opts.strategy,
          title: opts.name,
          scope: opts.scope,
        });

        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }

        printResult(res);
        const data = res.data as { gene_id?: string; id?: string } | undefined;
        const id = data?.gene_id ?? data?.id ?? 'unknown';
        process.stdout.write(`Gene created: ${id}\n`);
        if (opts.name) process.stdout.write(`Title: ${opts.name}\n`);
        process.stdout.write(`Category: ${opts.category}\n`);
      } catch (err) {
        handleError(err);
      }
    });

  // ---------------------------------------------------------------------------
  // 6. evolve genes
  // ---------------------------------------------------------------------------
  evolve
    .command('genes')
    .description('List your own evolution genes')
    .option('--scope <scope>', 'filter by evolution scope')
    .option('--json', 'output raw JSON response')
    .action(async (opts: { scope?: string; json?: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.evolution.listGenes(undefined, opts.scope);

        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }

        printResult(res);
        const data = res.data as { genes?: unknown[]; items?: unknown[] } | unknown[] | undefined;
        const genes: unknown[] = Array.isArray(data)
          ? data
          : ((data as Record<string, unknown>)?.genes as unknown[] | undefined)
            ?? ((data as Record<string, unknown>)?.items as unknown[] | undefined)
            ?? [];

        if (genes.length === 0) {
          process.stdout.write('No genes found.\n');
          return;
        }

        process.stdout.write(`${genes.length} gene(s):\n`);
        for (const g of genes as Array<Record<string, unknown>>) {
          const id = g.gene_id ?? g.id ?? '?';
          const title = g.title ?? g.name ?? '';
          const category = g.category ? ` [${g.category}]` : '';
          const scope = g.scope ? ` (${g.scope})` : '';
          process.stdout.write(`  • ${id}${title ? ` — ${title}` : ''}${category}${scope}\n`);
        }
      } catch (err) {
        handleError(err);
      }
    });

  // ---------------------------------------------------------------------------
  // 7. evolve stats
  // ---------------------------------------------------------------------------
  evolve
    .command('stats')
    .description('Show public evolution statistics')
    .option('--json', 'output raw JSON response')
    .action(async (opts: { json?: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.evolution.getStats();

        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }

        printResult(res);
        const data = res.data as Record<string, unknown> | undefined;
        if (data) {
          for (const [key, val] of Object.entries(data)) {
            process.stdout.write(`${key}: ${JSON.stringify(val)}\n`);
          }
        }
      } catch (err) {
        handleError(err);
      }
    });

  // ---------------------------------------------------------------------------
  // 8. evolve metrics
  // ---------------------------------------------------------------------------
  evolve
    .command('metrics')
    .description('Show A/B experiment metrics')
    .option('--json', 'output raw JSON response')
    .action(async (opts: { json?: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.evolution.getMetrics();

        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }

        printResult(res);
        const data = res.data as Record<string, unknown> | undefined;
        if (data) {
          for (const [key, val] of Object.entries(data)) {
            process.stdout.write(`${key}: ${JSON.stringify(val)}\n`);
          }
        }
      } catch (err) {
        handleError(err);
      }
    });

  // ---------------------------------------------------------------------------
  // 9. evolve achievements
  // ---------------------------------------------------------------------------
  evolve
    .command('achievements')
    .description('Show your evolution achievements')
    .option('--json', 'output raw JSON response')
    .action(async (opts: { json?: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.evolution.getAchievements();

        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }

        printResult(res);
        const data = res.data as { achievements?: unknown[]; items?: unknown[] } | unknown[] | undefined;
        const achievements: unknown[] = Array.isArray(data)
          ? data
          : ((data as Record<string, unknown>)?.achievements as unknown[] | undefined)
            ?? ((data as Record<string, unknown>)?.items as unknown[] | undefined)
            ?? [];

        if (achievements.length === 0) {
          process.stdout.write('No achievements yet.\n');
          return;
        }

        process.stdout.write(`${achievements.length} achievement(s):\n`);
        for (const a of achievements as Array<Record<string, unknown>>) {
          const id = a.id ?? '?';
          const title = a.title ?? a.name ?? '';
          const desc = a.description ? ` — ${a.description}` : '';
          process.stdout.write(`  • ${id}${title ? ` ${title}` : ''}${desc}\n`);
        }
      } catch (err) {
        handleError(err);
      }
    });

  // ---------------------------------------------------------------------------
  // 10. evolve sync
  // ---------------------------------------------------------------------------
  evolve
    .command('sync')
    .description('Get a sync snapshot of recent evolution data')
    .option('--json', 'output raw JSON response')
    .action(async (opts: { json?: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.evolution.getSyncSnapshot();

        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }

        printResult(res);
        const data = res.data as Record<string, unknown> | undefined;
        if (data) {
          const since = data.since ?? data.timestamp ?? data.generated_at;
          if (since) process.stdout.write(`Snapshot since: ${since}\n`);
          const genes = data.genes as unknown[] | undefined;
          const signals = data.signals as unknown[] | undefined;
          if (genes !== undefined) process.stdout.write(`Genes: ${genes.length}\n`);
          if (signals !== undefined) process.stdout.write(`Signals: ${signals.length}\n`);
        }
      } catch (err) {
        handleError(err);
      }
    });

  // ---------------------------------------------------------------------------
  // 11. evolve export-skill <gene-id>
  // ---------------------------------------------------------------------------
  evolve
    .command('export-skill <gene-id>')
    .description('Export a gene as a reusable skill')
    .option('--slug <slug>', 'skill slug identifier')
    .option('--name <displayName>', 'skill display name')
    .option('--json', 'output raw JSON response')
    .action(async (geneId: string, opts: { slug?: string; name?: string; json?: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.evolution.exportAsSkill(geneId, {
          slug: opts.slug,
          displayName: opts.name,
        });

        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }

        printResult(res);
        const data = res.data as { skill_id?: string; slug?: string; display_name?: string } | undefined;
        process.stdout.write(`Skill exported from gene: ${geneId}\n`);
        if (data?.skill_id) process.stdout.write(`skill_id: ${data.skill_id}\n`);
        if (data?.slug) process.stdout.write(`slug: ${data.slug}\n`);
        if (data?.display_name) process.stdout.write(`display_name: ${data.display_name}\n`);
      } catch (err) {
        handleError(err);
      }
    });

  // ---------------------------------------------------------------------------
  // 12. evolve scopes
  // ---------------------------------------------------------------------------
  evolve
    .command('scopes')
    .description('List available evolution scopes')
    .option('--json', 'output raw JSON response')
    .action(async (opts: { json?: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.evolution.listScopes();

        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }

        printResult(res);
        const data = res.data as { scopes?: unknown[]; items?: unknown[] } | unknown[] | undefined;
        const scopes: unknown[] = Array.isArray(data)
          ? data
          : ((data as Record<string, unknown>)?.scopes as unknown[] | undefined)
            ?? ((data as Record<string, unknown>)?.items as unknown[] | undefined)
            ?? [];

        if (scopes.length === 0) {
          process.stdout.write('No scopes found.\n');
          return;
        }

        process.stdout.write(`${scopes.length} scope(s):\n`);
        for (const s of scopes as Array<string | Record<string, unknown>>) {
          if (typeof s === 'string') {
            process.stdout.write(`  • ${s}\n`);
          } else {
            const name = s.name ?? s.scope ?? s.id ?? JSON.stringify(s);
            process.stdout.write(`  • ${name}\n`);
          }
        }
      } catch (err) {
        handleError(err);
      }
    });

  // ---------------------------------------------------------------------------
  // 13. evolve browse
  // ---------------------------------------------------------------------------
  evolve
    .command('browse')
    .description('Browse published evolution genes')
    .option('-c, --category <cat>', 'filter by category')
    .option('--search <query>', 'full-text search query')
    .option('--sort <field>', 'sort field (e.g. score, created_at)')
    .option('-n, --limit <n>', 'max results to return', '20')
    .option('--json', 'output raw JSON response')
    .action(async (opts: {
      category?: string;
      search?: string;
      sort?: string;
      limit?: string;
      json?: boolean;
    }) => {
      const client = getIMClient();
      try {
        const limit = parseInt(opts.limit ?? '20', 10);

        const res = await client.im.evolution.browseGenes({
          category: opts.category,
          search: opts.search,
          sort: opts.sort,
          limit,
        });

        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }

        printResult(res);
        const data = res.data as { genes?: unknown[]; items?: unknown[]; results?: unknown[] } | unknown[] | undefined;
        const genes: unknown[] = Array.isArray(data)
          ? data
          : ((data as Record<string, unknown>)?.genes as unknown[] | undefined)
            ?? ((data as Record<string, unknown>)?.items as unknown[] | undefined)
            ?? ((data as Record<string, unknown>)?.results as unknown[] | undefined)
            ?? [];

        if (genes.length === 0) {
          process.stdout.write('No genes found.\n');
          return;
        }

        process.stdout.write(`${genes.length} gene(s):\n`);
        for (const g of genes as Array<Record<string, unknown>>) {
          const id = g.gene_id ?? g.id ?? '?';
          const title = g.title ?? g.name ?? '';
          const category = g.category ? ` [${g.category}]` : '';
          const score = g.score !== undefined ? ` score=${g.score}` : '';
          process.stdout.write(`  • ${id}${title ? ` — ${title}` : ''}${category}${score}\n`);
        }
      } catch (err) {
        handleError(err);
      }
    });

  // ---------------------------------------------------------------------------
  // 14. evolve import <gene-id>
  // ---------------------------------------------------------------------------
  evolve
    .command('import <gene-id>')
    .description('Import a published gene into your collection')
    .option('--json', 'output raw JSON response')
    .action(async (geneId: string, opts: { json?: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.evolution.importGene(geneId);

        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }

        printResult(res, `Gene imported: ${geneId}`);
      } catch (err) {
        handleError(err);
      }
    });

  // ---------------------------------------------------------------------------
  // 15. evolve distill
  // ---------------------------------------------------------------------------
  evolve
    .command('distill')
    .description('Trigger gene distillation (consolidate learnings)')
    .option('--dry-run', 'preview distillation without applying changes')
    .option('--json', 'output raw JSON response')
    .action(async (opts: { dryRun?: boolean; json?: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.evolution.distill(opts.dryRun);

        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }

        printResult(res);
        const data = res.data as Record<string, unknown> | undefined;
        if (opts.dryRun) {
          process.stdout.write('Dry-run distillation preview:\n');
        } else {
          process.stdout.write('Distillation triggered.\n');
        }
        if (data) {
          for (const [key, val] of Object.entries(data)) {
            process.stdout.write(`  ${key}: ${JSON.stringify(val)}\n`);
          }
        }
      } catch (err) {
        handleError(err);
      }
    });
}
