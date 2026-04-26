/**
 * Prismer IM — LLM-Assisted Memory Recall (P1 v1.8.0)
 *
 * Three strategies for memory retrieval:
 *   - keyword: pure text matching (zero cost, fast)
 *   - llm: LLM selects from memory manifest (accurate, ~200 tokens)
 *   - hybrid: keyword pre-filter → LLM re-rank (best for large memory sets)
 *
 * Inspired by Claude Code's findRelevantMemories pattern.
 */

import prisma from '../db';
import type { MemoryService } from './memory.service';

const LOG = '[MemoryRecall]';

function getLLMConfig() {
  const apiKey = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || '';
  const apiBase =
    process.env.OPENAI_BASE_URL ||
    process.env.OPENAI_API_BASE_URL ||
    process.env.LLM_API_BASE ||
    'https://api.openai.com/v1';
  const model = process.env.LLM_RECALL_MODEL || process.env.DISTILL_MODEL || process.env.DEFAULT_MODEL || 'gpt-4o-mini';
  return { apiKey, apiBase, model };
}

export type RecallStrategy = 'keyword' | 'llm' | 'hybrid';

export interface RecallInput {
  query: string;
  agentId: string;
  scope?: string;
  maxResults?: number;
  strategy?: RecallStrategy;
  memoryType?: string;
}

export interface RecallResult {
  id: string;
  path: string;
  content: string;
  memoryType: string;
  description: string;
  score: number;
  reason?: string;
  updatedAt: Date;
}

interface ManifestEntry {
  id: string;
  path: string;
  memoryType: string;
  description: string;
  updatedAt: Date;
  stale: boolean;
  contentPreview: string;
}

/**
 * Build manifest from memory files — lightweight metadata for LLM context.
 * ~10 tokens per entry, so 200 files ≈ 2K tokens.
 */
async function buildManifest(agentId: string, scope: string): Promise<ManifestEntry[]> {
  const files = await prisma.iMMemoryFile.findMany({
    where: { ownerId: agentId, scope },
    select: {
      id: true,
      path: true,
      memoryType: true,
      description: true,
      updatedAt: true,
      stale: true,
      content: true,
    },
    orderBy: { updatedAt: 'desc' },
    take: 200,
  });

  return files.map(
    (f: {
      id: string;
      path: string;
      memoryType: string | null;
      description: string | null;
      updatedAt: Date;
      stale: boolean;
      content: string | null;
    }) => ({
      id: f.id,
      path: f.path,
      memoryType: f.memoryType ?? 'reference',
      description: f.description ?? '',
      updatedAt: f.updatedAt,
      stale: f.stale ?? false,
      contentPreview: (f.content ?? '').slice(0, 150),
    }),
  );
}

function formatManifest(entries: ManifestEntry[]): string {
  return entries
    .map((e, i) => {
      const staleTag = e.stale ? ' [STALE]' : '';
      const date = e.updatedAt.toISOString().slice(0, 10);
      return `${i + 1}. [${e.memoryType}] ${e.path} (${date})${staleTag}: ${e.description || e.contentPreview}`;
    })
    .join('\n');
}

/**
 * Keyword-based recall: text matching on path, description, and content.
 */
async function keywordRecall(memoryService: MemoryService, input: RecallInput): Promise<RecallResult[]> {
  const { agentId, query, scope = 'global', maxResults = 5, memoryType } = input;
  const files = await memoryService.searchMemoryFiles(agentId, query, maxResults * 2, scope);

  let results = files.map((f: any) => ({
    id: f.id,
    path: f.path,
    content: f.content ?? '',
    memoryType: f.memoryType ?? 'reference',
    description: f.description ?? '',
    score: computeKeywordScore(query, f.path, f.description || '', f.content || ''),
    reason: 'keyword match',
    updatedAt: f.updatedAt,
  }));

  if (memoryType) {
    results = results.filter((r: RecallResult) => r.memoryType === memoryType);
  }

  return results.sort((a: RecallResult, b: RecallResult) => b.score - a.score).slice(0, maxResults);
}

function computeKeywordScore(query: string, path: string, desc: string, content: string): number {
  const q = query.toLowerCase();
  const terms = q.split(/\s+/).filter(Boolean);
  let score = 0;

  for (const term of terms) {
    if (path.toLowerCase().includes(term)) score += 0.4;
    if (desc.toLowerCase().includes(term)) score += 0.3;
    if (content.toLowerCase().includes(term)) score += 0.2;
  }

  return Math.min(score / Math.max(terms.length, 1), 1.0);
}

/**
 * LLM-based recall: send manifest to LLM, ask it to select most relevant files.
 * Uses the cheapest fast model (env LLM_RECALL_MODEL or defaults to a haiku-class model).
 */
async function llmRecall(memoryService: MemoryService, input: RecallInput): Promise<RecallResult[]> {
  const { agentId, query, scope = 'global', maxResults = 5 } = input;

  const manifest = await buildManifest(agentId, scope);
  if (manifest.length === 0) return [];

  // For small manifests (≤ maxResults), skip LLM call
  if (manifest.length <= maxResults) {
    return manifest.map((e) => ({
      id: e.id,
      path: e.path,
      content: e.contentPreview,
      memoryType: e.memoryType,
      description: e.description,
      score: 0.5,
      reason: 'all files returned (small manifest)',
      updatedAt: e.updatedAt,
    }));
  }

  const manifestText = formatManifest(manifest);

  const systemPrompt = `You are a memory retrieval assistant. Given a user query and a list of memory files, select the most relevant files (up to ${maxResults}).

Return ONLY a JSON array of indices (1-based) of selected files, e.g. [1, 3, 7].
If no files are relevant, return [].
Consider:
- Recency: prefer recently updated files
- Relevance: match query intent, not just keywords
- Type: "user" and "project" memories are generally more relevant than "reference"
- Stale files ([STALE]) are less reliable`;

  const sanitizedQuery = query
    .replace(/[\n\r]/g, ' ')
    .replace(/"/g, '\\"')
    .slice(0, 500);
  const userPrompt = `Query: "${sanitizedQuery}"

Memory files:
${manifestText}

Select the ${maxResults} most relevant files. Return JSON array of indices only.`;

  try {
    const { apiKey, apiBase, model } = getLLMConfig();

    if (!apiKey) {
      console.warn(`${LOG} No LLM API key configured, falling back to keyword`);
      return keywordRecall(memoryService, input);
    }

    const response = await fetch(`${apiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0,
        max_tokens: 100,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      console.warn(`${LOG} LLM call failed (${response.status}), falling back to keyword`);
      return keywordRecall(memoryService, input);
    }

    const json = (await response.json()) as any;
    const text = json.choices?.[0]?.message?.content || '[]';

    const match = text.match(/\[\s*\d[\d\s,]*\]/);
    if (!match) {
      console.warn(`${LOG} LLM returned unparseable response, falling back to keyword`);
      return keywordRecall(memoryService, input);
    }

    let indices: number[];
    try {
      const parsed = JSON.parse(match[0]);
      indices = Array.isArray(parsed) ? parsed.filter((i: unknown) => typeof i === 'number') : [];
    } catch {
      console.warn(`${LOG} LLM returned invalid JSON indices, falling back to keyword`);
      return keywordRecall(memoryService, input);
    }
    const selected = indices.filter((i) => i >= 1 && i <= manifest.length).map((i) => manifest[i - 1]);

    const results: RecallResult[] = [];
    for (const entry of selected) {
      const file = await memoryService.readMemoryFile(entry.id);
      results.push({
        id: entry.id,
        path: entry.path,
        content: file?.content ?? entry.contentPreview,
        memoryType: entry.memoryType,
        description: entry.description,
        score: 0.9 - results.length * 0.05,
        reason: 'LLM selected',
        updatedAt: entry.updatedAt,
      });
    }

    console.log(`${LOG} LLM recall: ${selected.length}/${manifest.length} files selected for "${query}"`);
    return results;
  } catch (err) {
    console.warn(`${LOG} LLM recall error, falling back to keyword:`, (err as Error).message);
    return keywordRecall(memoryService, input);
  }
}

/**
 * Hybrid recall: keyword pre-filter → LLM re-rank.
 * Best for agents with 50+ memory files.
 */
async function hybridRecall(memoryService: MemoryService, input: RecallInput): Promise<RecallResult[]> {
  const { agentId, scope = 'global', maxResults = 5 } = input;

  // Step 1: Keyword pre-filter (get 3x candidates)
  const candidates = await keywordRecall(memoryService, {
    ...input,
    maxResults: maxResults * 3,
  });

  if (candidates.length <= maxResults) return candidates;

  // Step 2: LLM re-rank from candidates
  const candidateManifest = candidates.map((c, i) => ({
    id: c.id,
    path: c.path,
    memoryType: c.memoryType,
    description: c.description,
    updatedAt: c.updatedAt,
    stale: false,
    contentPreview: c.content.slice(0, 150),
  }));

  const manifestText = formatManifest(candidateManifest);
  const systemPrompt = `You are a memory retrieval assistant. Re-rank these pre-filtered memory files by relevance to the query.
Return ONLY a JSON array of indices (1-based) of the top ${maxResults} files, e.g. [1, 3, 7].`;

  const sanitizedQuery = input.query
    .replace(/[\n\r]/g, ' ')
    .replace(/"/g, '\\"')
    .slice(0, 500);
  const userPrompt = `Query: "${sanitizedQuery}"

Candidate files:
${manifestText}

Select the top ${maxResults} most relevant. Return JSON array of indices only.`;

  try {
    const { apiKey, apiBase, model } = getLLMConfig();

    if (!apiKey) return candidates.slice(0, maxResults);

    const response = await fetch(`${apiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0,
        max_tokens: 100,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) return candidates.slice(0, maxResults);

    const json = (await response.json()) as any;
    const text = json.choices?.[0]?.message?.content || '[]';
    const match = text.match(/\[\s*\d[\d\s,]*\]/);
    if (!match) return candidates.slice(0, maxResults);

    let indices: number[];
    try {
      const parsed = JSON.parse(match[0]);
      indices = Array.isArray(parsed) ? parsed.filter((i: unknown) => typeof i === 'number') : [];
    } catch {
      return candidates.slice(0, maxResults);
    }
    const reranked = indices
      .filter((i) => i >= 1 && i <= candidates.length)
      .map((i, rank) => ({
        ...candidates[i - 1],
        score: 0.95 - rank * 0.05,
        reason: 'hybrid: keyword + LLM re-rank',
      }));

    console.log(`${LOG} Hybrid recall: ${reranked.length} files after LLM re-rank`);
    return reranked;
  } catch {
    return candidates.slice(0, maxResults);
  }
}

/**
 * Main entry point: dispatch to strategy-specific implementation.
 */
export async function recallMemory(memoryService: MemoryService, input: RecallInput): Promise<RecallResult[]> {
  const strategy = input.strategy || 'keyword';

  switch (strategy) {
    case 'llm':
      return llmRecall(memoryService, input);
    case 'hybrid':
      return hybridRecall(memoryService, input);
    case 'keyword':
    default:
      return keywordRecall(memoryService, input);
  }
}
