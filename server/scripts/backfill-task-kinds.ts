/**
 * Audit/backfill im_tasks.metadata.kind for the conversation/task/run/goal split.
 *
 * Usage:
 *   DATABASE_URL="file:$(pwd)/prisma/data/dev.db" npx tsx scripts/backfill-task-kinds.ts
 *   DATABASE_URL="mysql://..." npx tsx scripts/backfill-task-kinds.ts --write
 */

import prisma from '../src/im/db';

type Kind = 'work_item' | 'goal' | 'agent_run';

interface Row {
  id: string;
  title: string;
  capability: string | null;
  conversationId: string | null;
  metadata: string | null;
}

const write = process.argv.includes('--write');
const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
const limit = limitArg ? Number.parseInt(limitArg.slice('--limit='.length), 10) : undefined;

function parseJson(raw: string | null): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!raw) return { ok: true, value: {} };
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'metadata is not a JSON object' };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

function explicitKind(meta: Record<string, unknown>): Kind | null {
  return meta.kind === 'work_item' || meta.kind === 'goal' || meta.kind === 'agent_run' ? meta.kind : null;
}

function inferKind(row: Row, meta: Record<string, unknown>): Kind {
  const explicit = explicitKind(meta);
  if (explicit) return explicit;
  if (meta.intent === 'standing_objective' || meta.goal !== undefined) return 'goal';
  if (meta.triggerKind === 'mention' || typeof meta.triggerMessageId === 'string') return 'agent_run';
  if (meta.run !== undefined || meta.runtime !== undefined) return 'agent_run';
  if (row.capability === 'chat' && Boolean(row.conversationId)) return 'agent_run';
  return 'work_item';
}

function buildNextMetadata(row: Row, meta: Record<string, unknown>, kind: Kind): Record<string, unknown> {
  const now = new Date().toISOString();
  const next: Record<string, unknown> = {
    ...meta,
    kind,
    schemaVersion: typeof meta.schemaVersion === 'number' ? meta.schemaVersion : 1,
    migrations: {
      ...(meta.migrations && typeof meta.migrations === 'object' && !Array.isArray(meta.migrations)
        ? (meta.migrations as Record<string, unknown>)
        : {}),
      kindBackfillAt: now,
    },
  };
  if (kind === 'agent_run') {
    next.links = {
      ...(meta.links && typeof meta.links === 'object' && !Array.isArray(meta.links)
        ? (meta.links as Record<string, unknown>)
        : {}),
      ...(row.conversationId ? { conversationId: row.conversationId } : {}),
      ...(typeof meta.triggerMessageId === 'string' ? { triggerMessageId: meta.triggerMessageId } : {}),
      ...(typeof meta.parentTaskId === 'string' ? { parentTaskId: meta.parentTaskId } : {}),
      ...(typeof meta.goalTaskId === 'string' ? { goalTaskId: meta.goalTaskId } : {}),
    };
    next.run = {
      ...(meta.run && typeof meta.run === 'object' && !Array.isArray(meta.run)
        ? (meta.run as Record<string, unknown>)
        : {}),
      trigger: typeof meta.triggerKind === 'string' ? meta.triggerKind : 'legacy',
    };
  }
  if (kind === 'goal') {
    next.goal = {
      ...(meta.goal && typeof meta.goal === 'object' && !Array.isArray(meta.goal)
        ? (meta.goal as Record<string, unknown>)
        : {}),
      state: (meta.goal as any)?.state ?? (meta.goal as any)?.status ?? 'active',
    };
  }
  return next;
}

async function main() {
  const rows = await prisma.iMTask.findMany({
    select: { id: true, title: true, capability: true, conversationId: true, metadata: true },
    orderBy: { createdAt: 'asc' },
    ...(limit && Number.isFinite(limit) ? { take: limit } : {}),
  });

  const summary = {
    mode: write ? 'write' : 'dry-run',
    total: rows.length,
    explicit: { work_item: 0, goal: 0, agent_run: 0 },
    inferred: { work_item: 0, goal: 0, agent_run: 0 },
    malformed: 0,
    changed: 0,
    unchanged: 0,
  };
  const malformed: Array<{ id: string; error: string }> = [];
  const changes: Array<{ id: string; title: string; inferredKind: Kind; previousKind: string | null }> = [];

  for (const row of rows) {
    const parsed = parseJson(row.metadata);
    if (!parsed.ok) {
      summary.malformed++;
      malformed.push({ id: row.id, error: parsed.error });
      continue;
    }
    const previous = typeof parsed.value.kind === 'string' ? parsed.value.kind : null;
    const kind = inferKind(row, parsed.value);
    if (explicitKind(parsed.value)) {
      summary.explicit[kind]++;
      summary.unchanged++;
      continue;
    }
    summary.inferred[kind]++;
    const next = buildNextMetadata(row, parsed.value, kind);
    changes.push({ id: row.id, title: row.title, inferredKind: kind, previousKind: previous });
    summary.changed++;
    if (write) {
      await prisma.iMTask.update({ where: { id: row.id }, data: { metadata: JSON.stringify(next) } });
    }
  }

  console.log(JSON.stringify({ summary, changes, malformed }, null, 2));
}

main()
  .catch((err) => {
    console.error('[backfill-task-kinds] fatal:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
