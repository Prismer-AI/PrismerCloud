/**
 * Evolution Sub-module: Distillation
 *
 * shouldDistill(), getSuccessCapsules(), triggerDistillation(), callLLM()
 */

import prisma from '../db';
import type { PrismerGene, SignalTag } from '../types/index';
import { normalizeSignals, tagCoverageScore } from './evolution-signals';
import { loadGenes, saveGene, createGene } from './evolution-lifecycle';
import { KnowledgeLinkService } from './knowledge-link.service';

// ─── Constants ──────────────────────────────────────────────

/** Minimum successful capsules to trigger distillation */
const DISTILL_MIN_CAPSULES = 10;

/** Minimum success rate in recent capsules for distillation */
const DISTILL_MIN_SUCCESS_RATE = 0.7;

// ===== Distillation =====

/**
 * Check if distillation should be triggered for an agent.
 */
export async function shouldDistill(agentId: string): Promise<boolean> {
  const total = await prisma.iMEvolutionCapsule.count({
    where: { ownerAgentId: agentId, outcome: 'success' },
  });

  if (total < DISTILL_MIN_CAPSULES) return false;

  // Check recent capsules success rate
  const recent = await prisma.iMEvolutionCapsule.findMany({
    where: { ownerAgentId: agentId },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });

  if (recent.length === 0) return false;
  const recentSuccesses = recent.filter((c: { outcome: string }) => c.outcome === 'success').length;
  if (recentSuccesses / recent.length < DISTILL_MIN_SUCCESS_RATE) return false;

  // Cooldown: 12h if agent has >=5 published genes, otherwise 24h
  const card = await prisma.iMAgentCard.findUnique({ where: { imUserId: agentId } });
  if (card) {
    const metadata = JSON.parse(card.metadata || '{}');
    const lastDistill = metadata.last_distill_at;
    const genes: PrismerGene[] = metadata.genes || [];
    const publishedCount = genes.filter((g: PrismerGene) => g.visibility === 'published').length;
    const cooldownMs = publishedCount >= 5 ? 12 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    if (lastDistill && Date.now() - new Date(lastDistill).getTime() < cooldownMs) {
      return false;
    }
  }

  return true;
}

/**
 * Get successful capsules for distillation analysis.
 */
export async function getSuccessCapsules(
  agentId: string,
  limit = 50,
): Promise<
  Array<{
    geneId: string;
    signalKey: string;
    triggerSignals: string[];
    score: number | null;
    summary: string;
    createdAt: Date;
  }>
> {
  const capsules = await prisma.iMEvolutionCapsule.findMany({
    where: { ownerAgentId: agentId, outcome: 'success' },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  return capsules.map((c: any) => ({
    geneId: c.geneId as string,
    signalKey: c.signalKey as string,
    triggerSignals: JSON.parse(c.triggerSignals || '[]') as string[],
    score: c.score as number | null,
    summary: c.summary as string,
    createdAt: c.createdAt as Date,
  }));
}

/**
 * Trigger LLM-based gene distillation.
 * Analyzes successful capsules and synthesizes a new Gene.
 *
 * Uses OpenAI-compatible API (model from env or default gpt-4o-mini).
 * Validates synthesized JSON, deduplicates against existing genes.
 */
export async function triggerDistillation(agentId: string): Promise<{
  distilled: boolean;
  gene?: PrismerGene;
  reason: string;
}> {
  // 1. Check readiness
  const ready = await shouldDistill(agentId);
  if (!ready) {
    return { distilled: false, reason: 'Not ready: need ≥10 success capsules, 70% recent rate, and 24h cooldown' };
  }

  // 2. Collect capsules and existing genes
  const [capsules, existingGenes] = await Promise.all([getSuccessCapsules(agentId, 30), loadGenes(agentId)]);

  if (capsules.length === 0) {
    return { distilled: false, reason: 'No successful capsules found' };
  }

  // 3. Build distillation prompt
  const capsulesText = capsules
    .map(
      (c: any, i: number) =>
        `${i + 1}. Gene: ${c.geneId}, Signals: [${c.triggerSignals.join(', ')}], Score: ${c.score ?? 'N/A'}, Summary: ${c.summary}`,
    )
    .join('\n');

  const existingGenesText = existingGenes
    .map(
      (g: PrismerGene) =>
        `- ${g.id} (${g.category}): signals=[${g.signals_match.map((t) => t.type).join(', ')}], strategy=[${g.strategy.join('; ')}]`,
    )
    .join('\n');

  // v1.8.0 Phase 2c.3: Load related memory files for context-aware distillation
  let memoryContextText = '';
  try {
    const kls = new KnowledgeLinkService();
    const geneIds = [...new Set(capsules.map((c: any) => c.geneId))];
    const linkedMemories = await kls.getLinkedMemories(geneIds);
    if (linkedMemories.size > 0) {
      const memoryLines: string[] = [];
      for (const [geneId, memories] of linkedMemories) {
        for (const m of memories.slice(0, 3)) {
          memoryLines.push(`- Gene ${geneId} ↔ Memory "${m.path}": ${m.snippet.slice(0, 150)}`);
        }
      }
      if (memoryLines.length > 0) {
        memoryContextText = `\n## Related Agent Memories (domain knowledge):\n${memoryLines.join('\n')}\n`;
      }
    }
  } catch { /* non-blocking */ }

  const prompt = `You are a skill evolution engine. Analyze the following successful execution capsules and synthesize a NEW Gene — a reusable strategy pattern.

## Successful Capsules (${capsules.length} recent):
${capsulesText}

## Existing Genes (avoid duplicates):
${existingGenesText || '(none)'}
${memoryContextText}
## Task
Find a common pattern across multiple capsules that is NOT already covered by existing genes.
Synthesize a new Gene JSON with this exact schema:

{
  "category": "repair" | "optimize" | "innovate" | "diagnostic",
  "signals_match": ["signal1", "signal2"],
  "strategy": ["Step 1: ...", "Step 2: ..."],
  "preconditions": ["optional condition"],
  "constraints": { "max_credits": 100, "max_retries": 3 }
}

Category guide: "repair" for error recovery, "optimize" for performance,
"innovate" for new capabilities, "diagnostic" for triage/routing of ambiguous signals.

Rules:
1. signals_match must contain signals that appear in multiple capsules
2. strategy steps must be actionable and specific
3. Do NOT duplicate an existing gene's signals_match
4. Return ONLY the JSON object, no markdown or explanation

If no new pattern can be extracted, return: { "skip": true, "reason": "..." }`;

  // 4. Call LLM
  const llmResult = await callLLM(prompt);
  if (!llmResult) {
    return { distilled: false, reason: 'LLM call failed or returned empty' };
  }

  // 5. Parse and validate
  let parsed: any;
  try {
    // Extract JSON from possible markdown code block
    const jsonMatch = llmResult.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { distilled: false, reason: 'LLM did not return valid JSON' };
    }
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return { distilled: false, reason: 'Failed to parse LLM response as JSON' };
  }

  // Check if LLM decided to skip
  if (parsed.skip) {
    return { distilled: false, reason: parsed.reason || 'LLM found no new pattern' };
  }

  // Validate required fields
  if (!parsed.category || !parsed.signals_match || !parsed.strategy) {
    return { distilled: false, reason: 'LLM output missing required fields (category, signals_match, strategy)' };
  }

  if (!['repair', 'optimize', 'innovate', 'diagnostic'].includes(parsed.category)) {
    return { distilled: false, reason: `Invalid category: ${parsed.category}` };
  }

  // 6. Critique stage (§4.4: second LLM call to validate quality)
  const critiquePrompt = `You are a quality reviewer for AI agent strategy genes.

## Synthesized Gene (to review):
${JSON.stringify(parsed, null, 2)}

## Existing Genes (for differentiation check):
${existingGenesText || '(none)'}

## Source Capsules (${capsules.length}):
${capsulesText}

## Review Criteria:
1. **Generality**: Is the gene sufficiently general? (Not overfitting to a single case)
2. **Differentiation**: Does it meaningfully differ from existing genes? (>20% novel value)
3. **Actionability**: Are the strategy steps concrete and executable by an AI agent?
4. **Signal coverage**: Are signals_match neither too broad nor too narrow?

## Output (JSON only):
{
  "verdict": "pass" | "reject",
  "reason": "one-line explanation",
  "improvements": ["optional suggestion 1", "..."]
}`;

  try {
    const critiqueResult = await callLLM(critiquePrompt);
    if (critiqueResult) {
      const critiqueJson = JSON.parse(critiqueResult.match(/\{[\s\S]*\}/)?.[0] || '{}');
      if (critiqueJson.verdict === 'reject') {
        return { distilled: false, reason: `Critique rejected: ${critiqueJson.reason || 'quality check failed'}` };
      }
      // Apply improvements if critique passed with suggestions
      if (critiqueJson.improvements?.length > 0) {
        console.log(`[Evolution] Critique passed with ${critiqueJson.improvements.length} suggestions`);
      }
    }
  } catch (err) {
    // Critique failure is non-blocking — proceed with the gene
    console.warn('[Evolution] Critique stage failed, proceeding without review:', (err as Error).message);
  }

  // 6.5. Deduplication check (using tagCoverageScore for v0.3.0 compatibility)
  const newTags = normalizeSignals(parsed.signals_match as string[] | SignalTag[]);
  for (const existing of existingGenes) {
    const coverage = tagCoverageScore(newTags, existing.signals_match);
    if (coverage > 0.8) {
      return { distilled: false, reason: `Too similar to existing gene ${existing.id} (>80% signal coverage)` };
    }
  }

  // 7. Create and save the gene
  const gene = createGene({
    category: parsed.category,
    signals_match: parsed.signals_match,
    strategy: parsed.strategy,
    preconditions: parsed.preconditions,
    constraints: parsed.constraints,
    created_by: 'distillation',
  });
  // GAP6: Distilled genes enter canary (not private) for validation before full publication
  gene.visibility = 'canary';

  await saveGene(agentId, gene);

  // 8. Update last distillation timestamp
  const card = await prisma.iMAgentCard.findUnique({ where: { imUserId: agentId } });
  if (card) {
    const metadata = JSON.parse(card.metadata || '{}');
    metadata.last_distill_at = new Date().toISOString();
    await prisma.iMAgentCard.update({
      where: { imUserId: agentId },
      data: { metadata: JSON.stringify(metadata) },
    });
  }

  return { distilled: true, gene, reason: 'New gene distilled from successful capsules' };
}

/**
 * Call an OpenAI-compatible LLM for distillation.
 * Uses env: OPENAI_API_KEY, OPENAI_BASE_URL, DISTILL_MODEL (default: gpt-4o-mini).
 */
export async function callLLM(prompt: string, maxRetries = 2): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn('[Evolution] No OPENAI_API_KEY set, skipping LLM distillation');
    return null;
  }

  const baseUrl = process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1';
  const model = process.env.DISTILL_MODEL || process.env.DEFAULT_MODEL || 'gpt-4o-mini';

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens: 1000,
        }),
      });

      if (response.status === 429 || response.status >= 500) {
        // Retryable error — backoff and retry
        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 1000;
          console.warn(
            `[Evolution] LLM API ${response.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`,
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        console.error(`[Evolution] LLM API error: ${response.status} after ${maxRetries} retries`);
        return null;
      }

      if (!response.ok) {
        console.error(`[Evolution] LLM API error: ${response.status}`);
        return null;
      }

      const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return data.choices?.[0]?.message?.content ?? null;
    } catch (err) {
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000;
        console.warn(`[Evolution] LLM call failed (${(err as Error).message}), retrying in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      console.error('[Evolution] LLM call failed after retries:', (err as Error).message);
      return null;
    }
  }
  return null;
}
