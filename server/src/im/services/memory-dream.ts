/**
 * Memory Dream Service — v1.8.0 Phase 2b
 *
 * Periodically consolidates agent memory files:
 * - Three-gate trigger: time (24h) + session count (5+) + lock
 * - Scans for duplicate/stale memories
 * - Merges related topics
 * - Updates MEMORY.md index
 * - Marks old memories as stale
 *
 * Design reference: DESIGN-EVOLUTION-MEMORY-CONVERGENCE.md §2b
 * Inspired by: Claude Code auto-dream consolidation
 */

import prisma from '../db';
import { callLLM } from './evolution-distill';
import { KnowledgeLinkService } from './knowledge-link.service';

const LOG = '[MemoryDream]';

const DREAM_TIME_GATE_MS = 24 * 60 * 60 * 1000;
const DREAM_SESSION_GATE = 5;
const STALE_THRESHOLD_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_MERGE_PER_DREAM = 5;
const DREAM_LOCK_TTL_MS = 30 * 60 * 1000; // 30 min — shared by both DB lock and process lock

const _dreamLocks = new Map<string, number>(); // agentId → expiry timestamp

export interface DreamResult {
  triggered: boolean;
  reason: string;
  merged: number;
  staleMarked: number;
  contradictions: number;
  indexUpdated: boolean;
}

/**
 * Check if dream should trigger for this agent.
 * Uses both in-process lock (_dreamLocks) and DB-level optimistic lock
 * (meta.dream_lock_at) for cross-Pod safety.
 */
export async function shouldDream(agentId: string): Promise<{ ready: boolean; reason: string }> {
  // Fast path: in-process lock avoids unnecessary DB query (with TTL to prevent stuck locks)
  const lockExpiry = _dreamLocks.get(agentId);
  if (lockExpiry && Date.now() < lockExpiry) {
    return { ready: false, reason: 'Dream already running for this agent (process lock)' };
  }
  if (lockExpiry) _dreamLocks.delete(agentId); // expired lock — clean up

  const card = await prisma.iMAgentCard.findUnique({
    where: { imUserId: agentId },
    select: { metadata: true },
  });
  const meta = (() => {
    try {
      return JSON.parse(card?.metadata || '{}');
    } catch {
      return {};
    }
  })();

  // DB-level lock check: if another instance is currently running a dream
  const dreamLockAt = meta.dream_lock_at ? new Date(meta.dream_lock_at).getTime() : 0;
  if (dreamLockAt > 0 && Date.now() - dreamLockAt < DREAM_LOCK_TTL_MS) {
    return {
      ready: false,
      reason: `Dream locked by another instance (locked ${Math.round((Date.now() - dreamLockAt) / 1000)}s ago)`,
    };
  }

  const lastDreamAt = meta.last_dream_at ? new Date(meta.last_dream_at).getTime() : 0;
  if (Date.now() - lastDreamAt < DREAM_TIME_GATE_MS) {
    return {
      ready: false,
      reason: `Time gate: ${Math.round((DREAM_TIME_GATE_MS - (Date.now() - lastDreamAt)) / 3600000)}h remaining`,
    };
  }

  // Activity gate: count memory files updated since last dream (proxy for session activity)
  const lastDreamDate = lastDreamAt > 0 ? new Date(lastDreamAt) : new Date(0);
  const recentActivity = await prisma.iMMemoryFile.count({
    where: { ownerId: agentId, updatedAt: { gte: lastDreamDate } },
  });
  if (recentActivity < DREAM_SESSION_GATE) {
    return {
      ready: false,
      reason: `Activity gate: ${recentActivity}/${DREAM_SESSION_GATE} files updated since last dream`,
    };
  }

  const fileCount = await prisma.iMMemoryFile.count({ where: { ownerId: agentId } });
  if (fileCount < 3) {
    return { ready: false, reason: 'Too few memory files to consolidate' };
  }

  return { ready: true, reason: 'All gates passed' };
}

/**
 * Acquire DB-level dream lock via optimistic update on metadata.
 * Returns true if lock acquired, false if another instance holds it.
 */
async function acquireDbDreamLock(agentId: string): Promise<boolean> {
  try {
    const card = await prisma.iMAgentCard.findUnique({
      where: { imUserId: agentId },
      select: { metadata: true },
    });
    if (!card) return false;

    const meta = (() => {
      try {
        return JSON.parse(card.metadata || '{}');
      } catch {
        return {};
      }
    })();

    const dreamLockAt = meta.dream_lock_at ? new Date(meta.dream_lock_at).getTime() : 0;

    // If lock is held and not expired, fail
    if (dreamLockAt > 0 && Date.now() - dreamLockAt < DREAM_LOCK_TTL_MS) {
      return false;
    }

    // Optimistic lock: update only if metadata hasn't changed (CAS via matching old value)
    const oldMetadata = card.metadata || '{}';
    meta.dream_lock_at = new Date().toISOString();
    meta.dream_lock_by = `${process.pid}`;
    const newMetadata = JSON.stringify(meta);

    const result = await prisma.iMAgentCard.updateMany({
      where: { imUserId: agentId, metadata: oldMetadata },
      data: { metadata: newMetadata },
    });

    return result.count > 0;
  } catch (err) {
    console.warn(`${LOG} Failed to acquire DB dream lock:`, (err as Error).message);
    return false;
  }
}

/**
 * Release DB-level dream lock.
 */
async function releaseDbDreamLock(agentId: string): Promise<void> {
  try {
    const card = await prisma.iMAgentCard.findUnique({
      where: { imUserId: agentId },
      select: { metadata: true },
    });
    if (!card) return;

    const meta = (() => {
      try {
        return JSON.parse(card.metadata || '{}');
      } catch {
        return {};
      }
    })();

    delete meta.dream_lock_at;
    delete meta.dream_lock_by;

    await prisma.iMAgentCard.update({
      where: { imUserId: agentId },
      data: { metadata: JSON.stringify(meta) },
    });
  } catch (err) {
    console.warn(`${LOG} Failed to release DB dream lock:`, (err as Error).message);
  }
}

/**
 * Run the dream consolidation for an agent.
 */
export async function runDream(agentId: string, scope: string = 'global'): Promise<DreamResult> {
  const { ready, reason } = await shouldDream(agentId);
  if (!ready) {
    return { triggered: false, reason, merged: 0, staleMarked: 0, contradictions: 0, indexUpdated: false };
  }

  // Acquire DB-level lock (cross-Pod safe)
  const lockAcquired = await acquireDbDreamLock(agentId);
  if (!lockAcquired) {
    return {
      triggered: false,
      reason: 'Failed to acquire DB dream lock (another instance may be running)',
      merged: 0,
      staleMarked: 0,
      contradictions: 0,
      indexUpdated: false,
    };
  }

  _dreamLocks.set(agentId, Date.now() + DREAM_LOCK_TTL_MS);
  try {
    const files = await prisma.iMMemoryFile.findMany({
      where: { ownerId: agentId, scope },
      orderBy: { updatedAt: 'desc' },
    });

    if (files.length < 3) {
      return {
        triggered: true,
        reason: 'Too few files',
        merged: 0,
        staleMarked: 0,
        contradictions: 0,
        indexUpdated: false,
      };
    }

    // Phase 1: Mark stale memories (>90 days, not feedback type)
    const staleMarked = await markStaleMemories(agentId, files);

    // Phase 2: LLM-guided consolidation + contradiction detection
    let merged = 0;
    let contradictions = 0;
    if (process.env.OPENAI_API_KEY) {
      const result = await llmConsolidate(agentId, files, scope);
      merged = result.merged;
      contradictions = result.contradictions;
    }

    // Phase 3: Update MEMORY.md index
    const indexUpdated = await updateMemoryIndex(agentId, scope);

    // Update last_dream_at (also clears lock)
    const card = await prisma.iMAgentCard.findUnique({ where: { imUserId: agentId } });
    if (card) {
      const meta = JSON.parse(card.metadata || '{}');
      meta.last_dream_at = new Date().toISOString();
      delete meta.dream_lock_at;
      delete meta.dream_lock_by;
      await prisma.iMAgentCard.update({
        where: { imUserId: agentId },
        data: { metadata: JSON.stringify(meta) },
      });
    }

    console.log(
      `${LOG} Dream complete for ${agentId}: merged=${merged}, stale=${staleMarked}, contradictions=${contradictions}, index=${indexUpdated}`,
    );
    return { triggered: true, reason: 'Dream completed', merged, staleMarked, contradictions, indexUpdated };
  } finally {
    _dreamLocks.delete(agentId);
    // Safety: ensure DB lock is released even if last_dream_at update failed
    await releaseDbDreamLock(agentId).catch(() => {});
  }
}

async function markStaleMemories(
  agentId: string,
  files: Array<{ id: string; path: string; memoryType: string | null; updatedAt: Date; stale: boolean }>,
): Promise<number> {
  const threshold = new Date(Date.now() - STALE_THRESHOLD_MS);
  const toMark = files.filter(
    (f) => !f.stale && f.updatedAt < threshold && f.memoryType !== 'feedback' && f.path !== 'MEMORY.md',
  );

  if (toMark.length === 0) return 0;

  await prisma.iMMemoryFile.updateMany({
    where: { id: { in: toMark.map((f) => f.id) } },
    data: { stale: true, lastConsolidatedAt: new Date() },
  });

  console.log(`${LOG} Marked ${toMark.length} memories as stale for ${agentId}`);
  return toMark.length;
}

async function llmConsolidate(
  agentId: string,
  files: Array<{ id: string; path: string; content: string; memoryType: string | null; updatedAt: Date }>,
  scope: string,
): Promise<{ merged: number; contradictions: number }> {
  const nonIndex = files.filter((f) => f.path !== 'MEMORY.md');
  if (nonIndex.length < 3) return { merged: 0, contradictions: 0 };

  // Include file IDs so the LLM can reference them for contradiction links
  const fileSummaries = nonIndex
    .slice(0, 20)
    .map((f) => {
      const type = f.memoryType ? `[${f.memoryType}]` : '';
      const age = Math.round((Date.now() - f.updatedAt.getTime()) / 86400000);
      return `- id="${f.id}" ${type} ${f.path} (${age}d ago, ${f.content.length} chars): ${f.content.slice(0, 300)}...`;
    })
    .join('\n');

  const safeAgentId = agentId.replace(/[\n\r"]/g, '');
  const prompt = `You are a memory consolidation assistant. Analyze these memory files for Agent ${safeAgentId}.

## Memory Files (${nonIndex.length} total):
${fileSummaries}

## Task
Perform two analyses:

### 1. MERGE — Identify memories that should be merged (duplicate or highly overlapping content).
For each merge group, output:
{ "action": "merge", "files": ["path1.md", "path2.md"], "target": "merged-path.md", "reason": "why these should be merged" }

### 2. CONTRADICTS — Identify memories that state conflicting or contradictory facts.
For each contradiction pair, output:
{ "action": "contradicts", "sourceId": "<id of newer memory>", "targetId": "<id of older memory>", "sourcePath": "newer.md", "targetPath": "older.md", "reason": "what facts conflict" }

## Rules
- NEVER merge or delete feedback-type memories (behavior corrections)
- Max ${MAX_MERGE_PER_DREAM} merge groups
- Max 5 contradiction pairs
- Only merge files with >50% content overlap
- Only flag contradictions when two memories make clearly incompatible factual claims (not just different perspectives)
- Return empty array [] if no merges or contradictions found
- Return ONLY a JSON array containing both merge and contradicts items`;

  const result = await callLLM(prompt, 1);
  if (!result) return { merged: 0, contradictions: 0 };

  let actions: Array<{
    action: string;
    files?: string[];
    target?: string;
    reason?: string;
    sourceId?: string;
    targetId?: string;
    sourcePath?: string;
    targetPath?: string;
  }>;
  try {
    const match = result.match(/\[[\s\S]*?\]/);
    const parsed = match ? JSON.parse(match[0]) : [];
    actions = Array.isArray(parsed) ? parsed : [];
  } catch {
    return { merged: 0, contradictions: 0 };
  }

  const mergeGroups = actions.filter((a) => a.action === 'merge');
  const contradictPairs = actions.filter((a) => a.action === 'contradicts');

  // Process merges
  let merged = 0;
  for (const group of mergeGroups.slice(0, MAX_MERGE_PER_DREAM)) {
    try {
      if (!group.files || !group.target) continue;
      const sourceFiles = nonIndex.filter((f) => group.files!.includes(f.path));
      if (sourceFiles.length < 2) continue;

      const mergedContent = sourceFiles.map((f) => `## From: ${f.path}\n\n${f.content}`).join('\n\n---\n\n');

      await prisma.iMMemoryFile.upsert({
        where: {
          ownerId_scope_path: { ownerId: agentId, scope, path: group.target },
        },
        create: {
          ownerId: agentId,
          ownerType: 'agent',
          scope,
          path: group.target,
          content: mergedContent,
          memoryType: 'project',
          description: `Merged: ${group.reason}`,
          version: 1,
          lastConsolidatedAt: new Date(),
        },
        update: {
          content: mergedContent,
          description: `Merged: ${group.reason}`,
          version: { increment: 1 },
          lastConsolidatedAt: new Date(),
        },
      });

      // Mark source files as stale (don't delete — preserve history)
      for (const sf of sourceFiles) {
        if (sf.path !== group.target) {
          await prisma.iMMemoryFile.update({
            where: { id: sf.id },
            data: { stale: true, lastConsolidatedAt: new Date() },
          });
        }
      }

      merged++;
      console.log(`${LOG} Merged ${group.files.join(' + ')} → ${group.target}`);
    } catch (err) {
      console.warn(`${LOG} Merge failed for group:`, (err as Error).message);
    }
  }

  // Process contradictions
  let contradictions = 0;
  const linkService = new KnowledgeLinkService();
  const fileIdSet = new Set(nonIndex.map((f) => f.id));

  for (const pair of contradictPairs.slice(0, 5)) {
    try {
      if (!pair.sourceId || !pair.targetId) continue;
      // Validate that both IDs exist in our file set
      if (!fileIdSet.has(pair.sourceId) || !fileIdSet.has(pair.targetId)) {
        console.warn(
          `${LOG} Contradiction skipped: invalid file ID(s) — source=${pair.sourceId}, target=${pair.targetId}`,
        );
        continue;
      }

      // Create contradicts link in knowledge graph
      await linkService.createLink('memory', pair.sourceId, 'memory', pair.targetId, 'contradicts', scope);

      // Mark the older memory (targetId) as stale since it contains outdated facts
      const targetFile = nonIndex.find((f) => f.id === pair.targetId);
      if (targetFile && !targetFile.path.endsWith('MEMORY.md')) {
        await prisma.iMMemoryFile.update({
          where: { id: pair.targetId },
          data: {
            stale: true,
            description: `Contradicted by ${pair.sourcePath || pair.sourceId}: ${pair.reason || 'conflicting facts'}`,
            lastConsolidatedAt: new Date(),
          },
        });
      }

      contradictions++;
      console.log(
        `${LOG} Contradiction: ${pair.sourcePath || pair.sourceId} ↔ ${pair.targetPath || pair.targetId} — ${pair.reason}`,
      );
    } catch (err) {
      console.warn(`${LOG} Contradiction link failed:`, (err as Error).message);
    }
  }

  return { merged, contradictions };
}

async function updateMemoryIndex(agentId: string, scope: string): Promise<boolean> {
  try {
    const files = await prisma.iMMemoryFile.findMany({
      where: { ownerId: agentId, scope, stale: false },
      select: { path: true, memoryType: true, description: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
    });

    const activeFiles = files.filter((f: { path: string }) => f.path !== 'MEMORY.md');
    if (activeFiles.length === 0) return false;

    const lines = activeFiles.map(
      (f: { path: string; memoryType: string | null; description: string | null; updatedAt: Date }) => {
        const type = f.memoryType ? `[${f.memoryType}]` : '';
        const desc = f.description ? ` — ${f.description}` : '';
        return `- ${type} \`${f.path}\`${desc}`;
      },
    );

    const indexContent = `# Memory Index\n\n_Auto-updated by Dream consolidation (${new Date().toISOString().slice(0, 10)})_\n\n${lines.join('\n')}\n`;

    await prisma.iMMemoryFile.upsert({
      where: {
        ownerId_scope_path: { ownerId: agentId, scope, path: 'MEMORY.md' },
      },
      create: {
        ownerId: agentId,
        ownerType: 'agent',
        scope,
        path: 'MEMORY.md',
        content: indexContent,
        version: 1,
      },
      update: {
        content: indexContent,
        version: { increment: 1 },
      },
    });

    return true;
  } catch (err) {
    console.warn(`${LOG} Index update failed:`, (err as Error).message);
    return false;
  }
}
