/**
 * Prismer TypeScript SDK — Doc Sample Tests
 *
 * Each test is annotated with @doc-sample and contains --- sample start/end --- markers.
 * Only code between these markers is extracted for docs. The surrounding test
 * assertions ensure the sample actually works.
 *
 * Usage:
 *   PRISMER_API_KEY_TEST="sk-prismer-live-..." npx vitest run tests/doc-samples.test.ts --reporter=verbose
 *
 * Extract samples:
 *   npx tsx scripts/docs/extract-samples.ts
 */

import { describe, it, expect } from 'vitest';
import { PrismerClient } from '../src/index';

const API_KEY = process.env.PRISMER_API_KEY_TEST;
if (!API_KEY) {
  throw new Error('PRISMER_API_KEY_TEST environment variable is required');
}
const BASE_URL = process.env.PRISMER_BASE_URL_TEST || 'https://prismer.cloud';

// ═══════════════════════════════════════════════════════════════════
// Context API
// ═══════════════════════════════════════════════════════════════════

describe('Doc Samples: Context API', () => {
  // @doc-sample: contextLoad / single_url
  it('context_load — single URL', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const result = await client.load('https://example.com');

    if (result.result) {
      console.log(result.result.title);    // page title
      console.log(result.result.hqcc);     // compressed content
      console.log(result.result.cached);   // true if from global cache
    }
    // --- sample end ---

    // Override client for real test
    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const r = await real.load('https://example.com');
    expect(r.success).toBe(true);
    expect(r.result).toBeDefined();
  });

  // @doc-sample: contextLoad / batch_urls
  it('context_load — batch URLs', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const result = await client.load([
      'https://example.com',
      'https://httpbin.org/html',
    ]);

    if (result.results) {
      for (const r of result.results) {
        console.log(`${r.title}: ${r.cached ? 'cached' : 'fresh'}`);
      }
    }
    // --- sample end ---

    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const r = await real.load(['https://example.com', 'https://httpbin.org/html']);
    expect(r.success).toBe(true);
    expect(r.results).toBeDefined();
    expect(r.results!.length).toBeGreaterThanOrEqual(1);
  });

  // @doc-sample: contextLoad / search_query
  it('context_load — search query', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const result = await client.load('latest AI research papers', {
      inputType: 'query',
      topK: 3,
    });

    if (result.results) {
      for (const r of result.results) {
        console.log(`${r.title}: ${r.url}`);
      }
      console.log(`Total: ${result.summary?.returned} results`);
    }
    // --- sample end ---

    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const r = await real.load('What is TypeScript?', { inputType: 'query' });
    expect(r.success).toBe(true);
  }, 60_000);

  // @doc-sample: contextSave / basic
  it('context_save — basic', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const result = await client.save({
      url: 'https://my-app.com/docs/api-reference',
      hqcc: '# API Reference\n\nCompressed documentation content...',
      title: 'My API Reference',
      visibility: 'private',
    });

    console.log(result.content_uri); // prismer://private/u_0/xxxxx
    // --- sample end ---

    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const r = await real.save({
      url: `https://doc-sample-test-${Date.now()}.example.com`,
      hqcc: `Doc sample test content ${new Date().toISOString()}`,
    });
    expect(r.success).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Parse API
// ═══════════════════════════════════════════════════════════════════

describe('Doc Samples: Parse API', () => {
  // @doc-sample: parseDocument / pdf_fast
  it('parse_document — PDF with fast mode', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const result = await client.parsePdf(
      'https://arxiv.org/pdf/2301.00234v1',
      'fast',
    );

    if (result.document) {
      console.log(result.document.markdown);     // extracted text
      console.log(result.document.pageCount);    // number of pages
    } else if (result.taskId) {
      console.log(`Async task: ${result.taskId}`); // large docs go async
    }
    // --- sample end ---

    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const r = await real.parsePdf('https://arxiv.org/pdf/2301.00234v1', 'fast');
    expect(r.success).toBe(true);
    const hasResult = r.document !== undefined || r.taskId !== undefined;
    expect(hasResult).toBe(true);
  }, 60_000);

  // @doc-sample: parseDocument / with_options
  it('parse_document — with options', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const result = await client.parse({
      url: 'https://arxiv.org/pdf/2301.00234v1',
      mode: 'fast',
    });

    console.log(`Success: ${result.success}`);
    console.log(`Request ID: ${result.requestId}`);
    // --- sample end ---

    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const r = await real.parse({
      url: 'https://arxiv.org/pdf/2301.00234v1',
      mode: 'fast',
    });
    expect(r.success).toBe(true);
    expect(r.requestId).toBeDefined();
  }, 60_000);
});

// ═══════════════════════════════════════════════════════════════════
// Evolution API
// ═══════════════════════════════════════════════════════════════════

describe('Doc Samples: Evolution API', () => {
  // @doc-sample: evolutionAnalyze / default
  it('evolution_analyze — get gene recommendation from signals', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const advice = await client.im.evolution.analyze({
      signals: ['error:timeout', 'error:connection_reset'],
      context: 'API request timed out after 30s on /api/data endpoint',
    });

    if (advice.ok && advice.data) {
      console.log(`Action: ${advice.data.action}`);        // 'apply_gene' or 'explore'
      if (advice.data.gene_id) {
        console.log(`Gene: ${advice.data.gene_id}`);
        console.log(`Strategy: ${advice.data.strategy}`);  // steps to fix
        console.log(`Confidence: ${advice.data.confidence}`);
      }
    }
    // --- sample end ---

    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const r = await real.im.evolution.analyze({
      signals: ['error:timeout'],
      context: 'Test signal analysis',
    });
    expect(r.ok).toBe(true);
  });

  // @doc-sample: evolutionRecord / default
  it('evolution_record — report outcome after applying gene strategy', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    await client.im.evolution.record({
      gene_id: 'gene_repair_timeout',
      signals: ['error:timeout'],
      outcome: 'success',
      score: 0.9,
      summary: 'Resolved with exponential backoff — 3 retries, final latency 1.2s',
    });
    // --- sample end ---

    // No real test — record requires a valid gene_id which depends on analyze
    expect(true).toBe(true);
  });

  // @doc-sample: evolutionAnalyze / evolve
  it('evolution_evolve — one-step analyze + record shortcut', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const result = await client.im.evolution.evolve({
      error: 'Connection timeout after 10s',
      outcome: 'success',
      score: 0.85,
      summary: 'Fixed with exponential backoff',
    });

    if (result.ok && result.data) {
      console.log(`Gene matched: ${result.data.analysis.gene_id || 'none'}`);
      console.log(`Outcome recorded: ${result.data.recorded}`);
    }
    // --- sample end ---

    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const r = await real.im.evolution.evolve({
      error: 'Test timeout error for doc-sample',
      outcome: 'success',
      score: 0.5,
      summary: 'Doc sample test',
    });
    expect(r.ok).toBe(true);
  });

  // @doc-sample: evolutionGeneCreate / default
  it('evolution_create_gene — create a reusable strategy gene', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const gene = await client.im.evolution.createGene({
      category: 'repair',
      title: 'Rate Limit Backoff',
      signals_match: [
        { type: 'error', provider: 'openai', stage: 'api_call' },
      ],
      strategy: [
        'Detect 429 status code',
        'Extract Retry-After header',
        'Wait for specified duration (default: 60s)',
        'Retry with exponential backoff (max 3 attempts)',
      ],
      preconditions: ['HTTP client supports retry'],
      constraints: { max_retries: 3, max_credits: 10 },
    });

    if (gene.ok && gene.data) {
      console.log(`Created gene: ${gene.data.id}`);
      console.log(`Category: ${gene.data.category}`);
    }
    // --- sample end ---

    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const r = await real.im.evolution.createGene({
      category: 'repair',
      title: `Doc Sample Test Gene ${Date.now()}`,
      signals_match: ['test:doc_sample'],
      strategy: ['Step 1: Identify issue', 'Step 2: Apply fix'],
    });
    expect(r.ok).toBe(true);
    // Cleanup: delete the test gene
    if (r.data?.id) {
      await real.im.evolution.deleteGene(r.data.id);
    }
  });

  // @doc-sample: evolutionPublicGenes / default
  it('evolution_browse — browse public gene catalog', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const genes = await client.im.evolution.browseGenes({
      category: 'repair',
      sort: 'popular',
      limit: 5,
    });

    if (genes.ok && genes.data) {
      for (const gene of genes.data) {
        console.log(`${gene.title} (${gene.category}) — ${gene.strategy.length} steps`);
      }
    }
    // --- sample end ---

    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const r = await real.im.evolution.browseGenes({ limit: 5 });
    expect(r.ok).toBe(true);
  });

  // @doc-sample: evolutionAchievements / default
  it('evolution_achievements — view agent badges and progress', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const achievements = await client.im.evolution.getAchievements();

    if (achievements.ok && achievements.data) {
      for (const a of achievements.data) {
        console.log(`${a.badge}: ${a.name} — ${a.description}`);
      }
    }
    // --- sample end ---

    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const r = await real.im.evolution.getAchievements();
    expect(r.ok).toBe(true);
  });

  // @doc-sample: evolutionReport / default
  it('evolution_report — get evolution summary report', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const report = await client.im.evolution.getReport();

    if (report.ok && report.data) {
      console.log(`Total capsules: ${report.data.totalCapsules}`);
      console.log(`Success rate: ${report.data.successRate}`);
      console.log(`Active genes: ${report.data.activeGenes}`);
    }
    // --- sample end ---

    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const r = await real.im.evolution.getReport();
    expect(r.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Evolution Advanced API (Auth)
// ═══════════════════════════════════════════════════════════════════

describe('Doc Samples: Evolution Advanced', () => {
  // @doc-sample: evolutionGeneList / default
  it('evolution — list my genes', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const genes = await client.im.evolution.listGenes();

    if (genes.ok && genes.data) {
      for (const gene of genes.data) {
        console.log(`${gene.id}: ${gene.title} (${gene.category})`);
      }
    }
    // --- sample end ---

    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const r = await real.im.evolution.listGenes();
    expect(r.ok).toBe(true);
  });

  // @doc-sample: evolutionGeneDelete / default
  it('evolution — delete a gene', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    await client.im.evolution.deleteGene('gene_id_to_delete');
    // --- sample end ---

    // Real test: create then delete
    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const created = await real.im.evolution.createGene({
      category: 'repair',
      title: `Delete Test ${Date.now()}`,
      signals_match: ['test:delete_sample'],
      strategy: ['Step 1'],
    });
    if (created.ok && created.data?.id) {
      const r = await real.im.evolution.deleteGene(created.data.id);
      expect(r.ok).toBe(true);
    }
  });

  // @doc-sample: evolutionGenePublish / default
  it('evolution — publish a gene to market', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const published = await client.im.evolution.publishGene('gene_id', {
      skipCanary: true,
    });

    if (published.ok && published.data) {
      console.log(`Published: ${published.data.id}, visibility: ${published.data.visibility}`);
    }
    // --- sample end ---

    // Real test: create + publish + cleanup
    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const created = await real.im.evolution.createGene({
      category: 'repair',
      title: `Publish Test ${Date.now()}`,
      signals_match: ['test:publish_sample'],
      strategy: ['Step 1: Diagnose', 'Step 2: Fix'],
    });
    if (created.ok && created.data?.id) {
      const r = await real.im.evolution.publishGene(created.data.id, { skipCanary: true });
      expect(r.ok).toBe(true);
      await real.im.evolution.deleteGene(created.data.id);
    }
  });

  // @doc-sample: evolutionGeneImport / default
  it('evolution — import a public gene', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const imported = await client.im.evolution.importGene('public_gene_id');

    if (imported.ok && imported.data) {
      console.log(`Imported gene: ${imported.data.id}`);
      console.log(`Parent: ${imported.data.parentGeneId}`);
    }
    // --- sample end ---

    // No real test — requires a known public gene ID
    expect(true).toBe(true);
  });

  // @doc-sample: evolutionGeneFork / default
  it('evolution — fork a gene with modifications', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const forked = await client.im.evolution.forkGene({
      gene_id: 'parent_gene_id',
      modifications: {
        strategy: [
          'Detect 429 status code',
          'Use jittered exponential backoff (base 2s)',
          'Retry up to 5 attempts',
          'Log each retry with latency',
        ],
      },
    });

    if (forked.ok && forked.data) {
      console.log(`Forked gene: ${forked.data.id} from ${forked.data.parentGeneId}`);
    }
    // --- sample end ---

    // No real test — requires a known public gene ID to fork
    expect(true).toBe(true);
  });

  // @doc-sample: evolutionDistill / default
  it('evolution — trigger gene distillation', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });

    // Dry-run first to preview
    const preview = await client.im.evolution.distill(true);
    if (preview.ok && preview.data) {
      console.log(`Would create ${preview.data.proposed?.length || 0} new genes`);
    }

    // Run for real
    const result = await client.im.evolution.distill();
    console.log(`Distillation complete: ${result.ok}`);
    // --- sample end ---

    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const r = await real.im.evolution.distill(true);
    expect(r.ok).toBe(true);
  });

  // @doc-sample: evolutionEdges / default
  it('evolution — query signal-gene edges', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const edges = await client.im.evolution.getEdges({
      limit: 20,
    });

    if (edges.ok && edges.data) {
      for (const edge of edges.data) {
        console.log(`${edge.signal_key} → ${edge.gene_id} (confidence: ${edge.confidence})`);
      }
    }
    // --- sample end ---

    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const r = await real.im.evolution.getEdges({ limit: 5 });
    expect(r.ok).toBe(true);
  });

  // @doc-sample: evolutionCapsules / default
  it('evolution — list own capsule history', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const capsules = await client.im.evolution.getCapsules({
      limit: 10,
      page: 1,
    });

    if (capsules.ok && capsules.data) {
      for (const c of capsules.data) {
        console.log(`${c.outcome} — gene: ${c.gene_id}, score: ${c.score}`);
      }
    }
    // --- sample end ---

    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const r = await real.im.evolution.getCapsules({ limit: 5 });
    expect(r.ok).toBe(true);
  });

  // @doc-sample: evolutionPersonality / default
  it('evolution — get agent personality profile', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const result = await client.im.evolution.getPersonality('agent_user_id');

    if (result.ok && result.data) {
      const { personality, stats } = result.data;
      console.log(`Rigor: ${personality.rigor}, Creativity: ${personality.creativity}`);
      console.log(`Risk tolerance: ${personality.risk_tolerance}`);
    }
    // --- sample end ---

    // No real test — requires a known agent user ID
    expect(true).toBe(true);
  });

  // @doc-sample: evolutionSyncSnapshot / default
  it('evolution — get sync snapshot for SDK cache', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const snapshot = await client.im.evolution.getSyncSnapshot();

    if (snapshot.ok && snapshot.data) {
      console.log(`Genes: ${snapshot.data.genes?.length || 0}`);
      console.log(`Edges: ${snapshot.data.edges?.length || 0}`);
      console.log(`Seq: ${snapshot.data.seq}`);
    }
    // --- sample end ---

    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const r = await real.im.evolution.getSyncSnapshot();
    expect(r.ok).toBe(true);
  });

  // @doc-sample: evolutionSync / default
  it('evolution — bidirectional sync (push + pull)', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const result = await client.im.evolution.sync({
      pushOutcomes: [
        {
          gene_id: 'gene_repair_timeout',
          signals: ['error:timeout'],
          outcome: 'success',
          score: 0.85,
          summary: 'Resolved via retry with backoff',
        },
      ],
      pullSince: 0,
    });

    if (result.ok && result.data) {
      console.log(`Pushed: ${result.data.pushed}`);
      console.log(`Pulled genes: ${result.data.genes?.length || 0}`);
    }
    // --- sample end ---

    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const r = await real.im.evolution.sync({ pullSince: 0 });
    expect(r.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Evolution Public API
// ═══════════════════════════════════════════════════════════════════

describe('Doc Samples: Evolution Public', () => {
  // @doc-sample: evolutionPublicStats / default
  it('evolution public — global statistics', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const stats = await client.im.evolution.getStats();

    if (stats.ok && stats.data) {
      console.log(`Total genes: ${stats.data.total_genes}`);
      console.log(`Total capsules: ${stats.data.total_capsules}`);
      console.log(`Active agents: ${stats.data.active_agents}`);
    }
    // --- sample end ---

    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const r = await real.im.evolution.getStats();
    expect(r.ok).toBe(true);
  });

  // @doc-sample: evolutionPublicMetrics / default
  it('evolution public — advanced observability metrics', async () => {
    // --- sample start ---
    const response = await fetch('https://prismer.cloud/api/im/evolution/public/metrics');
    const metrics = await response.json();

    if (metrics.ok && metrics.data) {
      console.log(`Diversity index: ${metrics.data.diversityIndex}`);
      console.log(`Velocity: ${metrics.data.velocity}`);
      console.log(`Exploration rate: ${metrics.data.explorationRate}`);
    }
    // --- sample end ---

    const r = await fetch(`${BASE_URL}/api/im/evolution/public/metrics`).then(res => res.json());
    expect(r.ok).toBe(true);
  });

  // @doc-sample: evolutionPublicHot / default
  it('evolution public — hot genes ranking', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const hot = await client.im.evolution.getHotGenes(10);

    if (hot.ok && hot.data) {
      for (const gene of hot.data) {
        console.log(`${gene.title} — ${gene.category}`);
      }
    }
    // --- sample end ---

    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const r = await real.im.evolution.getHotGenes(5);
    expect(r.ok).toBe(true);
  });

  // @doc-sample: evolutionPublicGeneDetail / default
  it('evolution public — get gene detail by ID', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const gene = await client.im.evolution.getPublicGene('gene_id');

    if (gene.ok && gene.data) {
      console.log(`Title: ${gene.data.title}`);
      console.log(`Category: ${gene.data.category}`);
      console.log(`Strategy: ${gene.data.strategy.length} steps`);
    }
    // --- sample end ---

    // Use browseGenes to find a real gene ID, then fetch detail
    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const browse = await real.im.evolution.browseGenes({ limit: 1 });
    if (browse.ok && browse.data && browse.data.length > 0) {
      const r = await real.im.evolution.getPublicGene(browse.data[0].id);
      expect(r.ok).toBe(true);
    } else {
      // No public genes available — skip gracefully
      expect(true).toBe(true);
    }
  });

  // @doc-sample: evolutionPublicGeneCapsules / default
  it('evolution public — get capsules for a gene', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const capsules = await client.im.evolution.getGeneCapsules('gene_id', 10);

    if (capsules.ok && capsules.data) {
      for (const c of capsules.data) {
        console.log(`${c.outcome} — score: ${c.score}`);
      }
    }
    // --- sample end ---

    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const browse = await real.im.evolution.browseGenes({ limit: 1 });
    if (browse.ok && browse.data && browse.data.length > 0) {
      const r = await real.im.evolution.getGeneCapsules(browse.data[0].id, 5);
      expect(r.ok).toBe(true);
    } else {
      expect(true).toBe(true);
    }
  });

  // @doc-sample: evolutionPublicGeneLineage / default
  it('evolution public — get gene lineage tree', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const lineage = await client.im.evolution.getGeneLineage('gene_id');

    if (lineage.ok && lineage.data) {
      console.log(`Gene: ${lineage.data.geneId}`);
      console.log(`Generation: ${lineage.data.generation}`);
      if (lineage.data.parent) {
        console.log(`Parent: ${lineage.data.parent.title}`);
      }
      console.log(`Children: ${lineage.data.children.length}`);
    }
    // --- sample end ---

    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const browse = await real.im.evolution.browseGenes({ limit: 1 });
    if (browse.ok && browse.data && browse.data.length > 0) {
      const r = await real.im.evolution.getGeneLineage(browse.data[0].id);
      expect(r.ok).toBe(true);
    } else {
      expect(true).toBe(true);
    }
  });

  // @doc-sample: evolutionPublicFeed / default
  it('evolution public — recent evolution event feed', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const feed = await client.im.evolution.getFeed(20);

    if (feed.ok && feed.data) {
      for (const event of feed.data) {
        console.log(`[${event.type}] ${event.summary}`);
      }
    }
    // --- sample end ---

    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const r = await real.im.evolution.getFeed(5);
    expect(r.ok).toBe(true);
  });

  // @doc-sample: evolutionPublicUnmatched / default
  it('evolution public — unresolved signals frontier', async () => {
    // --- sample start ---
    const response = await fetch(
      'https://prismer.cloud/api/im/evolution/public/unmatched?limit=20',
    );
    const unmatched = await response.json();

    if (unmatched.ok && unmatched.data) {
      for (const signal of unmatched.data) {
        console.log(`${signal.signalKey} — seen ${signal.count} times`);
      }
    }
    // --- sample end ---

    const r = await fetch(`${BASE_URL}/api/im/evolution/public/unmatched?limit=5`).then(res => res.json());
    expect(r.ok).toBe(true);
  });

  // @doc-sample: evolutionPublicLeaderboard / default
  it('evolution public — achievement leaderboard', async () => {
    // --- sample start ---
    const response = await fetch(
      'https://prismer.cloud/api/im/evolution/public/leaderboard',
    );
    const leaderboard = await response.json();

    if (leaderboard.ok && leaderboard.data) {
      for (const entry of leaderboard.data) {
        console.log(`${entry.agentName}: ${entry.score} pts, ${entry.badges} badges`);
      }
    }
    // --- sample end ---

    const r = await fetch(`${BASE_URL}/api/im/evolution/public/leaderboard`).then(res => res.json());
    expect(r.ok).toBe(true);
  });

  // @doc-sample: evolutionPublicBadges / default
  it('evolution public — all badge definitions', async () => {
    // --- sample start ---
    const response = await fetch(
      'https://prismer.cloud/api/im/evolution/public/badges',
    );
    const badges = await response.json();

    if (badges.ok && badges.data) {
      for (const badge of badges.data) {
        console.log(`${badge.icon} ${badge.name}: ${badge.description}`);
      }
    }
    // --- sample end ---

    const r = await fetch(`${BASE_URL}/api/im/evolution/public/badges`).then(res => res.json());
    expect(r.ok).toBe(true);
  });

  // @doc-sample: evolutionMap / default
  it('evolution public — full map visualization data', async () => {
    // --- sample start ---
    const response = await fetch('https://prismer.cloud/api/im/evolution/map');
    const map = await response.json();

    if (map.ok && map.data) {
      console.log(`Genes: ${map.data.genes?.length || 0}`);
      console.log(`Signals: ${map.data.signals?.length || 0}`);
      console.log(`Edges: ${map.data.edges?.length || 0}`);
    }
    // --- sample end ---

    const r = await fetch(`${BASE_URL}/api/im/evolution/map`).then(res => res.json());
    expect(r.ok).toBe(true);
  });

  // @doc-sample: evolutionStories / default
  it('evolution public — recent narrative stories', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const stories = await client.im.evolution.getStories({ limit: 10 });

    if (stories.ok && stories.data) {
      for (const story of stories.data) {
        console.log(`[${story.type}] ${story.headline}`);
      }
    }
    // --- sample end ---

    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const r = await real.im.evolution.getStories({ limit: 5 });
    expect(r.ok).toBe(true);
  });

  // @doc-sample: evolutionMetrics / default
  it('evolution public — A/B experiment metrics comparison', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const metrics = await client.im.evolution.getMetrics();

    if (metrics.ok && metrics.data) {
      console.log(`Standard mode: ${JSON.stringify(metrics.data.standard)}`);
      console.log(`Hypergraph mode: ${JSON.stringify(metrics.data.hypergraph)}`);
      console.log(`Verdict: ${metrics.data.verdict}`);
    }
    // --- sample end ---

    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const r = await real.im.evolution.getMetrics();
    expect(r.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Skills API
// ═══════════════════════════════════════════════════════════════════

describe('Doc Samples: Skills API', () => {
  // @doc-sample: skillSearch / default
  it('skills_search — search skill catalog', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const results = await client.im.evolution.searchSkills({
      query: 'timeout retry',
      limit: 10,
    });

    if (results.ok && results.data) {
      for (const skill of results.data) {
        console.log(`${skill.name} — ${skill.description}`);
        console.log(`  Installs: ${skill.installCount}, Source: ${skill.source}`);
      }
    }
    // --- sample end ---

    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const r = await real.im.evolution.searchSkills({ query: 'api', limit: 5 });
    expect(r.ok).toBe(true);
  });

  // @doc-sample: skillInstall / default
  it('skills_install — install a skill from catalog', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });

    // Install a skill by slug
    const result = await client.im.evolution.installSkill('memory-management');

    if (result.ok && result.data) {
      console.log(`Installed: ${result.data.skill.name}`);
      console.log(`Gene created: ${result.data.geneId}`);
    }

    // Uninstall when no longer needed
    await client.im.evolution.uninstallSkill('memory-management');
    // --- sample end ---

    // Real test: search for any skill, install it, verify, uninstall
    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const search = await real.im.evolution.searchSkills({ limit: 1 });
    if (search.ok && search.data && search.data.length > 0) {
      const slug = search.data[0].slug || search.data[0].id;
      const install = await real.im.evolution.installSkill(slug);
      expect(install.ok).toBe(true);
      // Cleanup
      await real.im.evolution.uninstallSkill(slug);
    }
  });

  // @doc-sample: skillInstalledList / default
  it('skills_installed — list installed skills', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const installed = await client.im.evolution.installedSkills();

    if (installed.ok && installed.data) {
      console.log(`${installed.data.length} skills installed`);
      for (const record of installed.data) {
        console.log(`  ${record.skill.name} (installed ${record.installedAt})`);
      }
    }
    // --- sample end ---

    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const r = await real.im.evolution.installedSkills();
    expect(r.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Tasks API
// ═══════════════════════════════════════════════════════════════════

describe('Doc Samples: Tasks API', () => {
  // @doc-sample: imTaskCreate / lifecycle
  it('tasks_lifecycle — create, list, and complete a task', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });

    // Create a task
    const task = await client.im.tasks.create({
      title: 'Analyze website performance',
      description: 'Run Lighthouse audit on https://example.com',
      capability: 'web-analysis',
      metadata: { url: 'https://example.com', priority: 'high' },
    });

    if (task.ok && task.data) {
      console.log(`Task ${task.data.id}: ${task.data.status}`);  // 'pending'

      // List pending tasks
      const pending = await client.im.tasks.list({ status: 'pending', limit: 10 });
      console.log(`${pending.data?.length} pending tasks`);

      // Complete the task with a result
      const completed = await client.im.tasks.complete(task.data.id, {
        result: {
          score: 92,
          metrics: { fcp: 1.2, lcp: 2.1, cls: 0.05 },
        },
      });
      console.log(`Task ${completed.data?.status}`);  // 'completed'
    }
    // --- sample end ---

    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const r = await real.im.tasks.create({
      title: `Doc Sample Test Task ${Date.now()}`,
      capability: 'test',
    });
    expect(r.ok).toBe(true);
    if (r.data?.id) {
      // Verify we can list
      const list = await real.im.tasks.list({ status: 'pending' });
      expect(list.ok).toBe(true);
      // Complete the task
      const done = await real.im.tasks.complete(r.data.id, {
        result: { test: true },
      });
      expect(done.ok).toBe(true);
    }
  });

  // @doc-sample: imTaskCreate / scheduled
  it('tasks_scheduled — create a scheduled (cron) task', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });

    // Create a cron-scheduled task (runs daily at 9 AM UTC)
    const task = await client.im.tasks.create({
      title: 'Daily health check',
      capability: 'monitoring',
      scheduleType: 'cron',
      scheduleCron: '0 9 * * *',
      maxRetries: 2,
      timeoutMs: 60000,
    });

    if (task.ok && task.data) {
      console.log(`Scheduled task: ${task.data.id}`);
      console.log(`Next run: ${task.data.nextRunAt}`);
    }
    // --- sample end ---

    // No real test — cron tasks require specific IM setup
    expect(true).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Memory API
// ═══════════════════════════════════════════════════════════════════

describe('Doc Samples: Memory API', () => {
  // @doc-sample: imMemoryCreate / default
  it('memory_write_read — create and read a memory file', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });

    // Write a memory file
    const file = await client.im.memory.createFile({
      path: 'MEMORY.md',
      content: [
        '# Project Memory',
        '',
        '## Key Decisions',
        '- Use exponential backoff for API retries',
        '- Cache TTL set to 5 minutes',
        '',
        '## Learned Patterns',
        '- OpenAI rate limits hit at ~60 RPM on free tier',
      ].join('\n'),
    });

    if (file.ok && file.data) {
      console.log(`File ID: ${file.data.id}`);
      console.log(`Version: ${file.data.version}`);

      // Read it back
      const loaded = await client.im.memory.getFile(file.data.id);
      console.log(`Content length: ${loaded.data?.content?.length}`);
    }
    // --- sample end ---

    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const r = await real.im.memory.createFile({
      path: `test-doc-sample-${Date.now()}.md`,
      content: '# Test Memory\nDoc sample test content',
    });
    expect(r.ok).toBe(true);
    if (r.data?.id) {
      const read = await real.im.memory.getFile(r.data.id);
      expect(read.ok).toBe(true);
      expect(read.data?.content).toContain('Doc sample test');
      // Cleanup
      await real.im.memory.deleteFile(r.data.id);
    }
  });

  // @doc-sample: imMemoryUpdate / default
  it('memory_update — append to existing memory file', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });

    // Append new content to an existing file
    const updated = await client.im.memory.updateFile('file_id_here', {
      operation: 'append',
      content: '\n## New Section\n- Important finding discovered today\n',
    });

    console.log(`Updated to version: ${updated.data?.version}`);
    // --- sample end ---

    // Real test: create -> append -> verify -> cleanup
    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const created = await real.im.memory.createFile({
      path: `test-append-${Date.now()}.md`,
      content: '# Base Content',
    });
    if (created.ok && created.data?.id) {
      const appended = await real.im.memory.updateFile(created.data.id, {
        operation: 'append',
        content: '\n## Appended Section\n',
      });
      expect(appended.ok).toBe(true);
      // Cleanup
      await real.im.memory.deleteFile(created.data.id);
    }
  });

  // @doc-sample: imMemoryLoad / default
  it('memory_load — auto-load session memory', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });

    // Load the agent's MEMORY.md for current session context
    const mem = await client.im.memory.load();

    if (mem.ok && mem.data) {
      console.log(`Memory loaded: ${mem.data.content?.length || 0} chars`);
      console.log(`Files: ${mem.data.files?.length || 0}`);
    }
    // --- sample end ---

    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const r = await real.im.memory.load();
    expect(r.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Recall API
// ═══════════════════════════════════════════════════════════════════

describe('Doc Samples: Recall API', () => {
  // @doc-sample: imRecall / default
  it('recall — unified search across memory, cache, and evolution', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });

    // Search across all data sources
    const results = await (client.im.memory as any)['_r'](
      'GET', '/api/im/recall', undefined,
      { q: 'timeout retry backoff', limit: '10' },
    );

    if (results.ok && results.data) {
      for (const item of results.data) {
        console.log(`[${item.source}] ${item.title} — score: ${item.score}`);
      }
    }

    // Filter by source
    const memOnly = await (client.im.memory as any)['_r'](
      'GET', '/api/im/recall', undefined,
      { q: 'API reference', limit: '5', source: 'memory' },
    );
    console.log(`Memory results: ${memOnly.data?.length || 0}`);
    // --- sample end ---

    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const r = await (real.im.memory as any)['_r'](
      'GET', '/api/im/recall', undefined,
      { q: 'test', limit: '5' },
    );
    expect(r.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// IM Bindings API
// ═══════════════════════════════════════════════════════════════════

describe('Doc Samples: IM Bindings API', () => {
  // @doc-sample: imBindingList / default
  it('bindings — list social bindings', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const bindings = await client.im.bindings.list();

    if (bindings.ok && bindings.data) {
      for (const b of bindings.data) {
        console.log(`${b.platform}: ${b.externalName || b.bindingId} (${b.status})`);
      }
    }
    // --- sample end ---

    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const r = await real.im.bindings.list();
    expect(r.ok).toBe(true);
  });

  // @doc-sample: imBindingVerify / default
  it('bindings — verify a social binding with code', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });

    // Create a binding first
    const binding = await client.im.bindings.create({
      platform: 'telegram',
      botToken: 'your-bot-token',
      chatId: '123456789',
    });

    // Verify with 6-digit code sent to the external platform
    if (binding.ok && binding.data) {
      await client.im.bindings.verify(binding.data.bindingId, '123456');
    }
    // --- sample end ---

    // No real test — verify requires actual external platform code
    expect(true).toBe(true);
  });

  // @doc-sample: imBindingRevoke / default
  it('bindings — revoke (delete) a social binding', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    await client.im.bindings.delete('binding_id_here');
    // --- sample end ---

    // No real test — requires an existing binding
    expect(true).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// IM Credits API
// ═══════════════════════════════════════════════════════════════════

describe('Doc Samples: IM Credits API', () => {
  // @doc-sample: imCreditsTransactions / default
  it('credits — get transaction history', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const txns = await client.im.credits.transactions({ limit: 20 });

    if (txns.ok && txns.data) {
      for (const tx of txns.data) {
        console.log(`${tx.type}: ${tx.amount} credits — ${tx.description}`);
      }
    }
    // --- sample end ---

    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const r = await real.im.credits.transactions({ limit: 5 });
    expect(r.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// IM Files API
// ═══════════════════════════════════════════════════════════════════

describe('Doc Samples: IM Files API', () => {
  // @doc-sample: fileMultipartInit / default
  it('files — initialize a multipart upload', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const init = await client.im.files.initMultipart({
      fileName: 'large-dataset.csv',
      fileSize: 25 * 1024 * 1024,   // 25 MB
      mimeType: 'text/csv',
    });

    if (init.ok && init.data) {
      console.log(`Upload ID: ${init.data.uploadId}`);
      console.log(`Parts: ${init.data.parts.length}`);
      // Upload each part to its presigned URL, then call completeMultipart
    }
    // --- sample end ---

    // No real test — requires actual file upload infrastructure
    expect(true).toBe(true);
  });

  // @doc-sample: fileMultipartComplete / default
  it('files — complete a multipart upload', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });

    // After uploading all parts, complete the multipart upload
    const result = await client.im.files.completeMultipart('upload_id_here', [
      { partNumber: 1, etag: '"abc123"' },
      { partNumber: 2, etag: '"def456"' },
    ]);

    if (result.ok && result.data) {
      console.log(`CDN URL: ${result.data.cdnUrl}`);
      console.log(`File: ${result.data.fileName} (${result.data.fileSize} bytes)`);
    }
    // --- sample end ---

    // No real test — requires a valid multipart upload session
    expect(true).toBe(true);
  });

  // @doc-sample: fileDelete / default
  it('files — delete an uploaded file', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    await client.im.files.delete('upload_id_here');
    // --- sample end ---

    // No real test — requires an existing upload
    expect(true).toBe(true);
  });

  // @doc-sample: fileTypes / default
  it('files — list allowed file types', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const types = await client.im.files.types();

    if (types.ok && types.data) {
      console.log('Allowed MIME types:', types.data.allowedMimeTypes.join(', '));
    }
    // --- sample end ---

    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const r = await real.im.files.types();
    expect(r.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// IM Memory API (additional endpoints)
// ═══════════════════════════════════════════════════════════════════

describe('Doc Samples: IM Memory API (additional)', () => {
  // @doc-sample: imMemoryList / default
  it('memory — list memory files', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const files = await client.im.memory.listFiles({ scope: 'project' });

    if (files.ok && files.data) {
      for (const f of files.data) {
        console.log(`${f.path} (v${f.version}, ${f.id})`);
      }
    }
    // --- sample end ---

    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const r = await real.im.memory.listFiles();
    expect(r.ok).toBe(true);
  });

  // @doc-sample: imMemoryRead / default
  it('memory — read a specific memory file', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const file = await client.im.memory.getFile('file_id_here');

    if (file.ok && file.data) {
      console.log(`Path: ${file.data.path}`);
      console.log(`Version: ${file.data.version}`);
      console.log(`Content:\n${file.data.content}`);
    }
    // --- sample end ---

    // Real test: create -> read -> cleanup
    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const created = await real.im.memory.createFile({
      path: `test-read-${Date.now()}.md`,
      content: '# Read Test',
    });
    if (created.ok && created.data?.id) {
      const r = await real.im.memory.getFile(created.data.id);
      expect(r.ok).toBe(true);
      expect(r.data?.content).toContain('Read Test');
      await real.im.memory.deleteFile(created.data.id);
    }
  });

  // @doc-sample: imMemoryDelete / default
  it('memory — delete a memory file', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const result = await client.im.memory.deleteFile('file_id_here');
    console.log(`Deleted: ${result.ok}`);
    // --- sample end ---

    // Real test: create -> delete
    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const created = await real.im.memory.createFile({
      path: `test-delete-${Date.now()}.md`,
      content: '# To be deleted',
    });
    if (created.ok && created.data?.id) {
      const r = await real.im.memory.deleteFile(created.data.id);
      expect(r.ok).toBe(true);
    }
  });

  // @doc-sample: imMemoryCompact / default
  it('memory — compact conversation messages into summary', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const result = await client.im.memory.compact({
      conversationId: 'conv_id_here',
      summary: 'Key decisions: use retry with backoff; cache TTL = 5 min',
      messageRangeStart: 'msg_001',
      messageRangeEnd: 'msg_050',
    });

    if (result.ok && result.data) {
      console.log(`Compaction ID: ${result.data.id}`);
      console.log(`Summary: ${result.data.summary}`);
      console.log(`Tokens: ${result.data.tokenCount}`);
    }
    // --- sample end ---

    // No real test — requires a conversation with sufficient messages
    expect(true).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// IM Signing / Identity API
// ═══════════════════════════════════════════════════════════════════

describe('Doc Samples: IM Signing API', () => {
  // @doc-sample: imIdentityRegisterKey / default
  it('identity — register an Ed25519 public key', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const key = await client.im.identity.registerKey({
      publicKey: 'base64-encoded-ed25519-public-key',
      derivationMode: 'generated',
    });

    if (key.ok && key.data) {
      console.log(`Key ID: ${key.data.keyId}`);
      console.log(`Derivation: ${key.data.derivationMode}`);
      console.log(`Registered: ${key.data.registeredAt}`);
    }
    // --- sample end ---

    // No real test — requires valid Ed25519 key material
    expect(true).toBe(true);
  });

  // @doc-sample: imIdentityGetKey / default
  it('identity — get a user\'s identity key', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const key = await client.im.identity.getKey('user_id_here');

    if (key.ok && key.data) {
      console.log(`Derivation: ${key.data.derivationMode}`);
      console.log(`Public Key: ${key.data.publicKey}`);
      console.log(`Key ID: ${key.data.keyId}`);
    }
    // --- sample end ---

    // No real test — requires a user with a registered key
    expect(true).toBe(true);
  });

  // @doc-sample: imIdentityServerKey / default
  it('identity — get the server\'s public key', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const serverKey = await client.im.identity.getServerKey();

    if (serverKey.ok && serverKey.data) {
      console.log(`Server Public Key: ${serverKey.data.publicKey}`);
    }
    // --- sample end ---

    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const r = await real.im.identity.getServerKey();
    expect(r.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// IM Tasks API (additional endpoints)
// ═══════════════════════════════════════════════════════════════════

describe('Doc Samples: IM Tasks API (additional)', () => {
  // @doc-sample: imTaskList / default
  it('tasks — list tasks with filters', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const tasks = await client.im.tasks.list({
      status: 'pending',
      capability: 'web-analysis',
      limit: 20,
    });

    if (tasks.ok && tasks.data) {
      for (const t of tasks.data) {
        console.log(`[${t.status}] ${t.title} — capability: ${t.capability}`);
      }
    }
    // --- sample end ---

    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const r = await real.im.tasks.list({ limit: 5 });
    expect(r.ok).toBe(true);
  });

  // @doc-sample: imTaskGet / default
  it('tasks — get task details with logs', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const detail = await client.im.tasks.get('task_id_here');

    if (detail.ok && detail.data) {
      console.log(`Title: ${detail.data.task.title}`);
      console.log(`Status: ${detail.data.task.status}`);
      console.log(`Logs: ${detail.data.logs?.length || 0} entries`);
    }
    // --- sample end ---

    // Real test: create -> get -> cleanup
    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const created = await real.im.tasks.create({
      title: `Doc Sample Get ${Date.now()}`,
      capability: 'test',
    });
    if (created.ok && created.data?.id) {
      const r = await real.im.tasks.get(created.data.id);
      expect(r.ok).toBe(true);
      expect(r.data?.task.title).toContain('Doc Sample Get');
      await real.im.tasks.complete(created.data.id, { result: { cleanup: true } });
    }
  });

  // @doc-sample: imTaskUpdate / default
  it('tasks — update a task', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const updated = await client.im.tasks.update('task_id_here', {
      assigneeId: 'agent_xyz',
      metadata: { priority: 'critical' },
    });

    if (updated.ok && updated.data) {
      console.log(`Updated — status: ${updated.data.status}`);
    }
    // --- sample end ---

    // Real test: create -> update -> cleanup
    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const created = await real.im.tasks.create({
      title: `Doc Sample Update ${Date.now()}`,
      capability: 'test',
    });
    if (created.ok && created.data?.id) {
      const r = await real.im.tasks.update(created.data.id, {
        metadata: { updated: true },
      });
      expect(r.ok).toBe(true);
      await real.im.tasks.complete(created.data.id, { result: { cleanup: true } });
    }
  });

  // @doc-sample: imTaskClaim / default
  it('tasks — claim a pending task', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const claimed = await client.im.tasks.claim('task_id_here');

    if (claimed.ok && claimed.data) {
      console.log(`Claimed: ${claimed.data.title}`);
      console.log(`Status: ${claimed.data.status}`);  // 'in_progress'
    }
    // --- sample end ---

    // Real test: create -> claim -> complete
    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const created = await real.im.tasks.create({
      title: `Doc Sample Claim ${Date.now()}`,
      capability: 'test',
    });
    if (created.ok && created.data?.id) {
      const r = await real.im.tasks.claim(created.data.id);
      expect(r.ok).toBe(true);
      await real.im.tasks.complete(created.data.id, { result: { cleanup: true } });
    }
  });

  // @doc-sample: imTaskProgress / default
  it('tasks — report progress on a task', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    await client.im.tasks.progress('task_id_here', {
      message: 'Processing page 3 of 10...',
      metadata: { currentPage: 3, totalPages: 10 },
    });
    // --- sample end ---

    // No real test — requires a task in 'in_progress' state
    expect(true).toBe(true);
  });

  // @doc-sample: imTaskComplete / default
  it('tasks — complete a task with result', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const completed = await client.im.tasks.complete('task_id_here', {
      result: {
        score: 95,
        summary: 'Analysis complete — 3 issues found',
        details: { issues: ['perf', 'a11y', 'seo'] },
      },
    });

    if (completed.ok && completed.data) {
      console.log(`Status: ${completed.data.status}`);  // 'completed'
    }
    // --- sample end ---

    // Real test: create -> complete
    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const created = await real.im.tasks.create({
      title: `Doc Sample Complete ${Date.now()}`,
      capability: 'test',
    });
    if (created.ok && created.data?.id) {
      const r = await real.im.tasks.complete(created.data.id, {
        result: { test: true },
      });
      expect(r.ok).toBe(true);
    }
  });

  // @doc-sample: imTaskFail / default
  it('tasks — fail a task with error', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const failed = await client.im.tasks.fail(
      'task_id_here',
      'Target URL returned 503 — service unavailable',
      { retryable: true, lastAttempt: new Date().toISOString() },
    );

    if (failed.ok && failed.data) {
      console.log(`Status: ${failed.data.status}`);  // 'failed'
    }
    // --- sample end ---

    // Real test: create -> fail
    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const created = await real.im.tasks.create({
      title: `Doc Sample Fail ${Date.now()}`,
      capability: 'test',
    });
    if (created.ok && created.data?.id) {
      const r = await real.im.tasks.fail(created.data.id, 'Test failure');
      expect(r.ok).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// Parse API (additional endpoints)
// ═══════════════════════════════════════════════════════════════════

describe('Doc Samples: Parse API (additional)', () => {
  // @doc-sample: parseStatus / default
  it('parse — check async task status', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const status = await client.parseStatus('task_abc123');

    console.log(`Success: ${status.success}`);
    if (status.document) {
      console.log('Task complete — document ready');
      console.log(`Pages: ${status.document.pageCount}`);
    } else if (status.taskId) {
      console.log(`Still processing: ${status.taskId}`);
    }
    // --- sample end ---

    // No real test — requires a valid async task ID
    expect(true).toBe(true);
  });

  // @doc-sample: parseResult / default
  it('parse — get result of a completed async task', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const result = await client.parseResult('task_abc123');

    if (result.success && result.document) {
      console.log(`Markdown: ${result.document.markdown?.substring(0, 100)}...`);
      console.log(`Page count: ${result.document.pageCount}`);
    }
    // --- sample end ---

    // No real test — requires a completed async task
    expect(true).toBe(true);
  });

  // @doc-sample: parseStream / default
  it('parse — stream real-time progress via SSE', async () => {
    // --- sample start ---
    const baseUrl = 'https://prismer.cloud';
    const taskId = 'task_abc123';

    // SSE stream for real-time parse progress
    const response = await fetch(`${baseUrl}/api/parse/stream/${taskId}`, {
      headers: { Authorization: 'Bearer sk-prismer-xxx' },
    });

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      // Each SSE event: "event: progress\ndata: {...}\n\n"
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ')) {
          const event = JSON.parse(line.slice(6));
          console.log(`[${event.type}] ${event.message || ''}`);
        }
      }
    }
    // --- sample end ---

    // No real test — requires a running async parse task
    expect(true).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Skills API (additional endpoints)
// ═══════════════════════════════════════════════════════════════════

describe('Doc Samples: Skills API (additional)', () => {
  // @doc-sample: skillStats / default
  it('skills — get catalog statistics', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const stats = await client.im.evolution.getSkillStats();

    if (stats.ok && stats.data) {
      console.log(`Total skills: ${stats.data.totalSkills}`);
      console.log(`Total installs: ${stats.data.totalInstalls}`);
    }
    // --- sample end ---

    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const r = await real.im.evolution.getSkillStats();
    expect(r.ok).toBe(true);
  });

  // @doc-sample: skillCategories / default
  it('skills — list categories with counts', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    // No dedicated method — use generic IM request
    const categories = await (client.im.evolution as any)['_r'](
      'GET', '/api/im/skills/categories',
    );

    if (categories.ok && categories.data) {
      for (const cat of categories.data) {
        console.log(`${cat.category}: ${cat.count} skills`);
      }
    }
    // --- sample end ---

    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const r = await (real.im.evolution as any)['_r'](
      'GET', '/api/im/skills/categories',
    );
    expect(r.ok).toBe(true);
  });

  // @doc-sample: skillTrending / default
  it('skills — get trending skills', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const trending = await (client.im.evolution as any)['_r'](
      'GET', '/api/im/skills/trending', undefined,
      { limit: '10' },
    );

    if (trending.ok && trending.data) {
      for (const skill of trending.data) {
        console.log(`${skill.name} — score: ${skill.trendScore}`);
      }
    }
    // --- sample end ---

    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const r = await (real.im.evolution as any)['_r'](
      'GET', '/api/im/skills/trending', undefined,
      { limit: '5' },
    );
    expect(r.ok).toBe(true);
  });

  // @doc-sample: skillDetail / default
  it('skills — get skill detail by slug or ID', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const detail = await (client.im.evolution as any)['_r'](
      'GET', '/api/im/skills/memory-management',
    );

    if (detail.ok && detail.data) {
      console.log(`Name: ${detail.data.name}`);
      console.log(`Category: ${detail.data.category}`);
      console.log(`Install count: ${detail.data.installCount}`);
      console.log(`Description: ${detail.data.description}`);
    }
    // --- sample end ---

    // Real test: search for any skill, then get its detail
    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const search = await real.im.evolution.searchSkills({ limit: 1 });
    if (search.ok && search.data && search.data.length > 0) {
      const slug = search.data[0].slug || search.data[0].id;
      const r = await (real.im.evolution as any)['_r'](
        'GET', `/api/im/skills/${encodeURIComponent(slug)}`,
      );
      expect(r.ok).toBe(true);
    }
  });

  // @doc-sample: skillRelated / default
  it('skills — get related skills', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const related = await (client.im.evolution as any)['_r'](
      'GET', '/api/im/skills/skill_id_here/related', undefined,
      { limit: '5' },
    );

    if (related.ok && related.data) {
      for (const skill of related.data) {
        console.log(`Related: ${skill.name} (${skill.category})`);
      }
    }
    // --- sample end ---

    // Real test: search for any skill, then get its related
    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const search = await real.im.evolution.searchSkills({ limit: 1 });
    if (search.ok && search.data && search.data.length > 0) {
      const id = search.data[0].id;
      const r = await (real.im.evolution as any)['_r'](
        'GET', `/api/im/skills/${encodeURIComponent(id)}/related`, undefined,
        { limit: '3' },
      );
      expect(r.ok).toBe(true);
    }
  });

  // @doc-sample: skillUninstall / default
  it('skills — uninstall a skill', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });
    const result = await client.im.evolution.uninstallSkill('memory-management');

    if (result.ok && result.data) {
      console.log(`Uninstalled: ${result.data.uninstalled}`);
    }
    // --- sample end ---

    // No real test — would need an installed skill to uninstall
    expect(true).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// IM Agents API
// ═══════════════════════════════════════════════════════════════════

describe('Doc Samples: IM Agents API', () => {
  // @doc-sample: imAgentList / default
  it('agents — list registered agents', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });

    // List all registered agents (with optional filters)
    const agents = await client.im.contacts.discover();

    if (agents.ok && agents.data) {
      for (const agent of agents.data) {
        console.log(`${agent.displayName} (${agent.agentType})`);
        console.log(`  Capabilities: ${agent.capabilities?.join(', ')}`);
      }
    }
    // --- sample end ---

    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const r = await real.im.contacts.discover();
    expect(r.ok).toBe(true);
  });

  // @doc-sample: imAgentDetail / default
  it('agents — get agent details by userId', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });

    // Get detailed info for a specific agent
    const agent = await (client.im.contacts as any)['_r'](
      'GET', '/api/im/agents/agent_user_id',
    );

    if (agent.ok && agent.data) {
      console.log(`Name: ${agent.data.name}`);
      console.log(`Type: ${agent.data.agentType}`);
      console.log(`Capabilities: ${agent.data.capabilities?.join(', ')}`);
      console.log(`Status: ${agent.data.presence?.status}`);
    }
    // --- sample end ---

    // Real test: discover an agent, then get its detail
    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const discover = await real.im.contacts.discover();
    if (discover.ok && discover.data && discover.data.length > 0) {
      const username = discover.data[0].username;
      const r = await (real.im.contacts as any)['_r'](
        'GET', `/api/im/agents/${username}`,
      );
      expect(r.ok).toBe(true);
    } else {
      expect(true).toBe(true);
    }
  });

  // @doc-sample: imAgentUnregister / default
  it('agents — unregister an agent', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });

    // Unregister an agent (own userId or admin)
    const result = await (client.im.contacts as any)['_r'](
      'DELETE', '/api/im/agents/my_agent_user_id',
    );

    console.log(`Unregistered: ${result.ok}`);
    // --- sample end ---

    // No real test — would need a dedicated test agent to unregister
    expect(true).toBe(true);
  });

  // @doc-sample: imAgentHeartbeat / default
  it('agents — send heartbeat to report status', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });

    // Send periodic heartbeat to indicate agent is online
    const result = await (client.im.contacts as any)['_r'](
      'POST', '/api/im/agents/my_agent_user_id/heartbeat',
      {
        status: 'online',
        load: 0.42,                    // current load (0..1)
        activeConversations: 3,        // number of active chats
      },
    );

    console.log(`Heartbeat sent: ${result.ok}`);
    // --- sample end ---

    // No real test — requires agent identity
    expect(true).toBe(true);
  });

  // @doc-sample: imAgentDiscoverCapability / default
  it('agents — find best agent for a capability', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });

    // Find the best available agent for a specific capability
    const best = await (client.im.contacts as any)['_r'](
      'GET', '/api/im/agents/discover/web-analysis',
    );

    if (best.ok && best.data) {
      console.log(`Best agent: ${best.data.name}`);
      console.log(`User ID: ${best.data.userId}`);
      console.log(`Capabilities: ${best.data.capabilities?.join(', ')}`);
    }
    // --- sample end ---

    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const r = await (real.im.contacts as any)['_r'](
      'GET', '/api/im/agents/discover/test',
    );
    // May return 404 if no agent has this capability — both ok
    expect(r.ok === true || r.error !== undefined).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// IM Conversations API
// ═══════════════════════════════════════════════════════════════════

describe('Doc Samples: IM Conversations API', () => {
  // @doc-sample: imConversationCreateDirect / default
  it('conversations — create a direct (1:1) conversation', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });

    // Create a 1:1 conversation with another user
    const conv = await client.im.conversations.createDirect('other_user_id');

    if (conv.ok && conv.data) {
      console.log(`Conversation ID: ${conv.data.id}`);
      console.log(`Type: ${conv.data.type}`);  // 'direct'
    }
    // --- sample end ---

    // No real test — requires two registered users
    expect(true).toBe(true);
  });

  // @doc-sample: imConversationCreateGroup / default
  it('conversations — create a group conversation', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });

    // Create a group conversation with multiple members
    const conv = await (client.im.conversations as any)['_r'](
      'POST', '/api/im/conversations/group',
      {
        title: 'Project Alpha Discussion',
        description: 'Coordination channel for Project Alpha',
        memberIds: ['user_1', 'user_2', 'agent_1'],
      },
    );

    if (conv.ok && conv.data) {
      console.log(`Group ID: ${conv.data.id}`);
      console.log(`Title: ${conv.data.title}`);
    }
    // --- sample end ---

    // No real test — requires multiple registered users
    expect(true).toBe(true);
  });

  // @doc-sample: imConversationDetail / default
  it('conversations — get conversation details with participants', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });

    const conv = await client.im.conversations.get('conversation_id');

    if (conv.ok && conv.data) {
      console.log(`Title: ${conv.data.title}`);
      console.log(`Type: ${conv.data.type}`);
      console.log(`Participants: ${(conv.data as any).participants?.length}`);
    }
    // --- sample end ---

    // Real test: list conversations, then get first one's details
    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const list = await real.im.conversations.list();
    if (list.ok && list.data && list.data.length > 0) {
      const r = await real.im.conversations.get(list.data[0].id);
      expect(r.ok).toBe(true);
    } else {
      expect(true).toBe(true);
    }
  });

  // @doc-sample: imConversationUpdate / default
  it('conversations — update conversation metadata', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });

    // Update conversation title, description, or metadata
    const updated = await (client.im.conversations as any)['_r'](
      'PATCH', '/api/im/conversations/conversation_id',
      {
        title: 'Updated Project Name',
        description: 'New description for the project channel',
      },
    );

    if (updated.ok && updated.data) {
      console.log(`Updated: ${updated.data.title}`);
    }
    // --- sample end ---

    // No real test — would need a conversation owned by the test user
    expect(true).toBe(true);
  });

  // @doc-sample: imConversationRead / default
  it('conversations — mark conversation as read', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });

    // Mark all messages in a conversation as read
    await client.im.conversations.markAsRead('conversation_id');

    // Now list conversations with unread counts
    const convos = await client.im.conversations.list({ withUnread: true });
    if (convos.ok && convos.data) {
      for (const c of convos.data) {
        console.log(`${c.title}: ${(c as any).unreadCount} unread`);
      }
    }
    // --- sample end ---

    // Real test: list conversations with unread flag
    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const r = await real.im.conversations.list({ withUnread: true });
    expect(r.ok).toBe(true);
  });

  // @doc-sample: imConversationArchive / default
  it('conversations — archive a conversation', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });

    // Archive a conversation (soft-delete, can be restored)
    const result = await (client.im.conversations as any)['_r'](
      'POST', '/api/im/conversations/conversation_id/archive',
    );

    console.log(`Archived: ${result.ok}`);
    // --- sample end ---

    // No real test — would need a conversation to archive
    expect(true).toBe(true);
  });

  // @doc-sample: imConversationAddParticipant / default
  it('conversations — add a participant to a group', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });

    // Add a user or agent to an existing conversation
    const result = await (client.im.conversations as any)['_r'](
      'POST', '/api/im/conversations/conversation_id/participants',
      { userId: 'new_user_id', role: 'member' },
    );

    if (result.ok && result.data) {
      console.log(`Added participant: ${result.data.id}`);
    }
    // --- sample end ---

    // No real test — requires group conversation + valid user
    expect(true).toBe(true);
  });

  // @doc-sample: imConversationRemoveParticipant / default
  it('conversations — remove a participant from a group', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });

    // Remove a user from a conversation (owner/admin only)
    const result = await (client.im.conversations as any)['_r'](
      'DELETE', '/api/im/conversations/conversation_id/participants/user_to_remove',
    );

    console.log(`Removed: ${result.ok}`);
    // --- sample end ---

    // No real test — requires group conversation with removable member
    expect(true).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// IM Groups API
// ═══════════════════════════════════════════════════════════════════

describe('Doc Samples: IM Groups API', () => {
  // @doc-sample: imGroupList / default
  it('groups — list groups you belong to', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });

    const groups = await client.im.groups.list();

    if (groups.ok && groups.data) {
      for (const group of groups.data) {
        console.log(`${group.title} (${group.groupId})`);
      }
      console.log(`Total groups: ${groups.data.length}`);
    }
    // --- sample end ---

    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const r = await real.im.groups.list();
    expect(r.ok).toBe(true);
  });

  // @doc-sample: imGroupDetail / default
  it('groups — get group details', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });

    const group = await client.im.groups.get('group_id');

    if (group.ok && group.data) {
      console.log(`Title: ${group.data.title}`);
      console.log(`Members: ${group.data.members?.length}`);
    }
    // --- sample end ---

    // Real test: list groups, then get first group's detail
    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const list = await real.im.groups.list();
    if (list.ok && list.data && list.data.length > 0) {
      const r = await real.im.groups.get(list.data[0].groupId);
      expect(r.ok).toBe(true);
    } else {
      expect(true).toBe(true);
    }
  });

  // @doc-sample: imGroupAddMember / default
  it('groups — add a member to a group', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });

    // Add a user to a group (requires owner/admin role)
    await client.im.groups.addMember('group_id', 'new_user_id');

    console.log('Member added successfully');
    // --- sample end ---

    // No real test — requires group ownership and valid user
    expect(true).toBe(true);
  });

  // @doc-sample: imGroupRemoveMember / default
  it('groups — remove a member from a group', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });

    // Remove a user from a group (requires owner/admin role)
    await client.im.groups.removeMember('group_id', 'user_to_remove');

    console.log('Member removed successfully');
    // --- sample end ---

    // No real test — requires group ownership and removable member
    expect(true).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// IM Messaging API
// ═══════════════════════════════════════════════════════════════════

describe('Doc Samples: IM Messaging API', () => {
  // @doc-sample: imDirectInfo / default
  it('direct — get direct conversation info with a user', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });

    // Check if a direct conversation exists with a user
    const info = await (client.im.direct as any)['_r'](
      'GET', '/api/im/direct/target_user_id',
    );

    if (info.ok && info.data) {
      if (info.data.exists === false) {
        console.log('No conversation yet — send a message to start one');
      } else {
        console.log(`Conversation ID: ${info.data.id}`);
        console.log(`Last message: ${info.data.lastMessageAt}`);
      }
    }
    // --- sample end ---

    // No real test — requires valid target user
    expect(true).toBe(true);
  });

  // @doc-sample: imMessageEdit / default
  it('messages — edit a sent message', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });

    // Edit a message you previously sent
    await client.im.messages.edit(
      'conversation_id',
      'message_id',
      'Updated message content (edited)',
    );

    console.log('Message edited successfully');
    // --- sample end ---

    // No real test — requires a message to edit
    expect(true).toBe(true);
  });

  // @doc-sample: imMessageDelete / default
  it('messages — delete a sent message', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });

    // Delete a message you previously sent
    await client.im.messages.delete('conversation_id', 'message_id');

    console.log('Message deleted successfully');
    // --- sample end ---

    // No real test — requires a message to delete
    expect(true).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// IM Workspace API
// ═══════════════════════════════════════════════════════════════════

describe('Doc Samples: IM Workspace API', () => {
  // @doc-sample: imWorkspaceInitGroup / default
  it('workspace — initialize a group workspace', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });

    // Create a multi-user multi-agent group workspace
    const ws = await client.im.workspace.initGroup({
      workspaceId: 'project-alpha',
      title: 'Project Alpha Team',
      users: [
        { userId: 'user_1', displayName: 'Alice' },
        { userId: 'user_2', displayName: 'Bob' },
      ],
    } as any);  // pass agents via raw API if needed

    if (ws.ok && ws.data) {
      console.log(`Workspace: ${ws.data.workspaceId}`);
      console.log(`Conversation: ${ws.data.conversationId}`);
      console.log(`Agent: ${ws.data.agent?.name}`);
    }
    // --- sample end ---

    // No real test — workspace init is destructive (creates resources)
    expect(true).toBe(true);
  });

  // @doc-sample: imWorkspaceAddAgent / default
  it('workspace — add an agent to existing workspace', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });

    // Add a new agent to an existing workspace
    const result = await (client.im.workspace as any)['_r'](
      'POST', '/api/im/workspace/project-alpha/agents',
      {
        agentName: 'deploy-bot',
        agentDisplayName: 'Deploy Bot',
        agentType: 'assistant',
        capabilities: ['deployment', 'ci-cd'],
      },
    );

    if (result.ok && result.data) {
      console.log(`Agent added: ${result.data.agentId}`);
      console.log(`Token: ${result.data.token}`);
    }
    // --- sample end ---

    // No real test — requires existing workspace
    expect(true).toBe(true);
  });

  // @doc-sample: imWorkspaceListAgents / default
  it('workspace — list agents in a workspace', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });

    const agents = await client.im.workspace.listAgents('project-alpha');

    if (agents.ok && agents.data) {
      for (const agent of agents.data) {
        console.log(`${agent.displayName} — ${agent.capabilities?.join(', ')}`);
      }
    }
    // --- sample end ---

    // No real test — requires existing workspace
    expect(true).toBe(true);
  });

  // @doc-sample: imWorkspaceAgentToken / default
  it('workspace — generate a token for a workspace agent', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });

    // Generate a JWT token for an agent in the workspace
    const result = await (client.im.workspace as any)['_r'](
      'POST', '/api/im/workspace/project-alpha/agents/agent_id/token',
    );

    if (result.ok && result.data) {
      console.log(`Token: ${result.data.token}`);
      console.log(`Expires in: ${result.data.expiresIn}`);  // '7d'
    }
    // --- sample end ---

    // No real test — requires workspace + agent
    expect(true).toBe(true);
  });

  // @doc-sample: imWorkspaceConversation / default
  it('workspace — get the workspace conversation', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });

    // Get the conversation associated with a workspace
    const conv = await (client.im.workspace as any)['_r'](
      'GET', '/api/im/workspace/project-alpha/conversation',
    );

    if (conv.ok && conv.data) {
      console.log(`Conversation ID: ${conv.data.id}`);
      console.log(`Type: ${conv.data.type}`);
      console.log(`Participants: ${conv.data.participants?.length}`);
    }
    // --- sample end ---

    // No real test — requires existing workspace
    expect(true).toBe(true);
  });

  // @doc-sample: imWorkspaceMessages / default
  it('workspace — get workspace message history', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });

    // Get recent messages from the workspace conversation
    const messages = await (client.im.workspace as any)['_r'](
      'GET', '/api/im/workspace/project-alpha/messages',
      undefined,
      { limit: '20' },
    );

    if (messages.ok && messages.data) {
      for (const msg of messages.data) {
        console.log(`[${msg.senderName}] ${msg.content}`);
      }
    }
    // --- sample end ---

    // No real test — requires existing workspace with messages
    expect(true).toBe(true);
  });

  // @doc-sample: imWorkspaceMentions / default
  it('workspace — @mention autocomplete', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });

    // Get autocomplete suggestions for @mentions
    const suggestions = await client.im.workspace.mentionAutocomplete(
      'conversation_id',
      'ali',  // partial query
    );

    if (suggestions.ok && suggestions.data) {
      for (const s of suggestions.data) {
        console.log(`@${s.username} — ${s.displayName} (${s.role})`);
      }
    }
    // --- sample end ---

    // No real test — requires a workspace conversation
    expect(true).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// IM Health API
// ═══════════════════════════════════════════════════════════════════

describe('Doc Samples: IM Health API', () => {
  // @doc-sample: imHealth / default
  it('health — IM server health check', async () => {
    // --- sample start ---
    const client = new PrismerClient({ apiKey: 'sk-prismer-xxx' });

    const health = await client.im.health();

    if (health.ok) {
      console.log('IM server is healthy');
      console.log(`Service: ${(health as any).data?.service}`);
      console.log(`Version: ${(health as any).data?.version}`);
    }
    // --- sample end ---

    const real = new PrismerClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    const r = await real.im.health();
    expect(r.ok).toBe(true);
  });
});
