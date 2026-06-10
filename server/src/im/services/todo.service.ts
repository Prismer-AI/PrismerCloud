/**
 * Prismer IM — TodoService (release201/10 rev 2 §5.3)
 *
 * Thin wrapper around IMAsset (boundKind='task-bound', filename='TODO.md',
 * sourceTaskId=<tid>). Each tick / add / remove writes a NEW IMAssetRevision
 * so the TODO history is naturally preserved. Emits SSE
 * `task.todo.changed` to the task creator + watchers each mutation.
 *
 * Markdown convention (§2.4):
 *   - top-level `# Heading` optional (not counted)
 *   - `- [ ] xxx` → pending item
 *   - `- [x] xxx` / `- [X] xxx` → done item
 *   - nested `  - [ ]` → subitem (depth from leading-spaces / 2; cap 3)
 *   - free paragraphs (not starting with `- [`) → note, NOT counted
 *
 * `progressPct = doneCount / totalCount` (non-checkbox lines ignored).
 *
 * Forbidden patterns (§0.2.4):
 *   - log "[todo] markdown parse failure"  — surface explicit warning instead
 *   - direct IMAsset.storageUri UPDATE (must always go through IMAssetRevision)
 */

import crypto from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { createModuleLogger } from '@/lib/logger';
import { metricEmit } from './metric.service';

const log = createModuleLogger('TodoService');

export interface TodoItem {
  /** 0-based index inside the parsed list (skipping non-checkbox lines). */
  index: number;
  depth: number;
  status: 'pending' | 'done';
  text: string;
}

export interface TodoView {
  markdown: string;
  items: TodoItem[];
  doneCount: number;
  totalCount: number;
  progressPct: number; // 0..1
  revision: number;
}

export interface TodoServiceDeps {
  eventBusService?: {
    publish: (msg: any) => any;
  };
}

const RESERVED_FILENAME_TODO = 'TODO.md';

const CHECKBOX_RE = /^(\s*)-\s+\[([ xX])\]\s+(.*)$/;

export class TodoError extends Error {
  status: number;
  code: string;
  detail?: Record<string, unknown>;
  constructor(code: string, message: string, status = 400, detail?: Record<string, unknown>) {
    super(message);
    this.name = 'TodoError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Parse a TODO.md markdown body into a checklist. Lines that aren't
 * checkbox lines are kept in the source markdown but excluded from
 * indices / counts.
 */
export function parseTodoMarkdown(md: string): TodoItem[] {
  if (!md) return [];
  const out: TodoItem[] = [];
  const lines = md.split(/\r?\n/);
  let idx = 0;
  for (const line of lines) {
    const m = CHECKBOX_RE.exec(line);
    if (!m) continue;
    const leadingSpaces = m[1] ? m[1].length : 0;
    const depth = Math.min(3, Math.floor(leadingSpaces / 2));
    const tick = m[2] ?? ' ';
    const text = (m[3] ?? '').trim();
    out.push({
      index: idx++,
      depth,
      status: tick === ' ' ? 'pending' : 'done',
      text,
    });
  }
  return out;
}

/**
 * Serialise items back to a markdown string. Keeps depth indent
 * stable (2 spaces per level). NOTE: caller-provided header lines
 * (free markdown text BEFORE the first checkbox) are dropped on
 * rewrite — TodoService owns the markdown body wholesale. Title can
 * be set via `header` arg if you want a `# TODO — Heading` line.
 */
export function serialiseTodoMarkdown(items: TodoItem[], header?: string): string {
  const out: string[] = [];
  if (header && header.trim()) {
    out.push(header.trim());
    out.push('');
  }
  for (const it of items) {
    const indent = ' '.repeat(it.depth * 2);
    const tick = it.status === 'done' ? '[x]' : '[ ]';
    out.push(`${indent}- ${tick} ${it.text}`);
  }
  // Trailing newline keeps git happy.
  return out.join('\n') + '\n';
}

/**
 * Hash helper — SHA-256 hex of the markdown text. Reused for IMAsset
 * contentHash so duplicate revisions can be collapsed downstream if
 * we ever want to.
 */
function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf-8').digest('hex');
}

function makeAssetId(): string {
  return 'a' + crypto.randomBytes(12).toString('base64url').slice(0, 14);
}

function makeRevisionId(): string {
  return 'r' + crypto.randomBytes(12).toString('base64url').slice(0, 14);
}

export class TodoService {
  private deps: TodoServiceDeps;
  constructor(deps: TodoServiceDeps = {}) {
    this.deps = deps;
  }

  // ─── Reads ────────────────────────────────────────────────────────────

  /**
   * Return the latest TODO.md for a task. Returns an empty view (no items
   * + revision=0) when the asset hasn't been created yet — callers can
   * detect "no TODO yet" without throwing.
   */
  async get(taskId: string): Promise<TodoView> {
    const asset = await this.findLatestAsset(taskId);
    if (!asset) {
      return {
        markdown: '',
        items: [],
        doneCount: 0,
        totalCount: 0,
        progressPct: 0,
        revision: 0,
      };
    }
    const markdown = await this.readAssetContent(asset);
    return this.materialiseView(markdown, asset.revision ?? 1);
  }

  async parseFromAsset(taskId: string): Promise<TodoView> {
    return this.get(taskId);
  }

  // ─── Mutations ────────────────────────────────────────────────────────

  async appendItem(
    taskId: string,
    text: string,
    actorId: string,
    opts: { workspaceId: string; creatorId: string | null; depth?: number } = {
      workspaceId: '',
      creatorId: null,
    },
  ): Promise<TodoView> {
    if (!text || !text.trim()) throw new TodoError('validation', 'text is required');
    const cur = await this.get(taskId);
    const next: TodoItem[] = [
      ...cur.items,
      {
        index: cur.items.length,
        depth: opts.depth ?? 0,
        status: 'pending',
        text: text.trim(),
      },
    ];
    return this.writebackToAsset(taskId, next, actorId, opts);
  }

  async toggleItem(
    taskId: string,
    index: number,
    done: boolean | undefined,
    actorId: string,
    opts: { workspaceId: string; creatorId: string | null } = { workspaceId: '', creatorId: null },
  ): Promise<TodoView> {
    const cur = await this.get(taskId);
    if (index < 0 || index >= cur.items.length) {
      throw new TodoError('item_not_found', `item index ${index} not found (len=${cur.items.length})`, 404);
    }
    const next = cur.items.map((it, i): TodoItem => {
      if (i !== index) return it;
      const nextStatus: 'pending' | 'done' =
        typeof done === 'boolean' ? (done ? 'done' : 'pending') : it.status === 'done' ? 'pending' : 'done';
      return { ...it, status: nextStatus };
    });
    return this.writebackToAsset(taskId, next, actorId, opts);
  }

  async setText(
    taskId: string,
    index: number,
    newText: string,
    actorId: string,
    opts: { workspaceId: string; creatorId: string | null } = { workspaceId: '', creatorId: null },
  ): Promise<TodoView> {
    if (!newText || !newText.trim()) throw new TodoError('validation', 'text is required');
    const cur = await this.get(taskId);
    if (index < 0 || index >= cur.items.length) {
      throw new TodoError('item_not_found', `item index ${index} not found`, 404);
    }
    const next = cur.items.map((it, i) => (i === index ? { ...it, text: newText.trim() } : it));
    return this.writebackToAsset(taskId, next, actorId, opts);
  }

  async removeItem(
    taskId: string,
    index: number,
    actorId: string,
    opts: { workspaceId: string; creatorId: string | null } = { workspaceId: '', creatorId: null },
  ): Promise<TodoView> {
    const cur = await this.get(taskId);
    if (index < 0 || index >= cur.items.length) {
      throw new TodoError('item_not_found', `item index ${index} not found`, 404);
    }
    const next = cur.items.filter((_, i) => i !== index).map((it, i) => ({ ...it, index: i }));
    return this.writebackToAsset(taskId, next, actorId, opts);
  }

  /**
   * Overwrite the TODO.md asset with `items`. Creates the IMAsset on
   * first call; subsequent calls write a new IMAssetRevision and bump
   * IMAsset.revision. Emits SSE `task.todo.changed`.
   */
  async writebackToAsset(
    taskId: string,
    items: TodoItem[],
    actorId: string,
    opts: { workspaceId: string; creatorId: string | null },
  ): Promise<TodoView> {
    // Re-index in case caller passes loose indices.
    const reindexed = items.map((it, i) => ({ ...it, index: i }));
    const markdown = serialiseTodoMarkdown(reindexed);

    // Resolve workspaceId if caller didn't pass it.
    const workspaceId =
      opts.workspaceId ||
      (
        await prisma.iMTask.findUnique({
          where: { id: taskId },
          select: { workspaceId: true },
        })
      )?.workspaceId ||
      '';
    if (!workspaceId) {
      throw new TodoError('task_not_found', `task ${taskId} has no workspaceId`, 404);
    }

    const contentHash = sha256Hex(markdown);
    const storageUri = `inline-markdown://todo/${taskId}/${contentHash.slice(0, 12)}`;

    const existing = await this.findLatestAsset(taskId);
    let assetId: string;
    let nextRevision: number;
    if (!existing) {
      assetId = makeAssetId();
      nextRevision = 1;
      await prisma.iMAsset.create({
        data: {
          id: assetId,
          workspaceId,
          ownerImUserId: actorId,
          contentHash,
          storageUri,
          sizeBytes: BigInt(Buffer.byteLength(markdown, 'utf-8')),
          mime: 'text/markdown',
          kind: 'document',
          sourceTaskId: taskId,
          metadata: JSON.stringify({ reservedFilename: RESERVED_FILENAME_TODO, source: 'todo-service' }),
          revision: 1,
          visibility: 'task',
          filename: RESERVED_FILENAME_TODO,
          boundKind: 'task-bound',
        } as never,
      });
    } else {
      assetId = existing.id;
      nextRevision = (existing.revision ?? 1) + 1;
      await prisma.iMAsset.update({
        where: { id: assetId },
        data: {
          contentHash,
          storageUri,
          sizeBytes: BigInt(Buffer.byteLength(markdown, 'utf-8')),
          revision: nextRevision,
        } as never,
      });
    }

    await prisma.iMAssetRevision.create({
      data: {
        id: makeRevisionId(),
        assetId,
        workspaceId,
        revision: nextRevision,
        contentHash,
        storageUri,
        sizeBytes: BigInt(Buffer.byteLength(markdown, 'utf-8')),
        mime: 'text/markdown',
        kind: 'document',
        ownerImUserId: actorId,
        sourceTaskId: taskId,
        // §3.5 — inline-markdown scheme: store body inside metadata for
        // round-trip read. Storage layer round-trip would be premature
        // for small markdown blobs (TODO/SPEC).
        metadata: JSON.stringify({ reservedFilename: RESERVED_FILENAME_TODO, body: markdown }),
        ingestStatus: 'ready',
        ingestVersion: 1,
        filename: RESERVED_FILENAME_TODO,
        visibility: 'task',
        createdByImUserId: actorId,
        reason: 'todo.writeback',
      } as never,
    });

    const view = this.materialiseView(markdown, nextRevision);

    // Emit SSE — push to task creator (orchestrator window).
    await this.emitChanged(taskId, view, actorId, opts.creatorId, workspaceId).catch((err) => {
      log.warn(`emit task.todo.changed failed for ${taskId}: ${(err as Error).message}`);
    });

    return view;
  }

  // ─── Internals ────────────────────────────────────────────────────────

  private materialiseView(markdown: string, revision: number): TodoView {
    const items = parseTodoMarkdown(markdown);
    const doneCount = items.filter((i) => i.status === 'done').length;
    const totalCount = items.length;
    const progressPct = totalCount > 0 ? doneCount / totalCount : 0;
    return { markdown, items, doneCount, totalCount, progressPct, revision };
  }

  private async findLatestAsset(taskId: string): Promise<{
    id: string;
    storageUri: string;
    revision: number | null;
    workspaceId: string;
  } | null> {
    const row = (await prisma.iMAsset.findFirst({
      where: {
        sourceTaskId: taskId,
        filename: RESERVED_FILENAME_TODO,
        boundKind: 'task-bound',
        deletedAt: null,
      } as never,
      select: { id: true, storageUri: true, revision: true, workspaceId: true } as never,
    })) as unknown as {
      id: string;
      storageUri: string;
      revision: number | null;
      workspaceId: string;
    } | null;
    return row;
  }

  private async readAssetContent(asset: { storageUri: string; id: string }): Promise<string> {
    // §3.5 — TODO.md storage is inline-markdown://. The latest revision's
    // content is whatever we last wrote. We rehydrate by reading the
    // latest IMAssetRevision row; that's where the canonical text lives
    // (no external object store round-trip).
    const rev = await prisma.iMAssetRevision.findFirst({
      where: { assetId: asset.id, deletedAt: null } as never,
      orderBy: { revision: 'desc' } as never,
      select: { metadata: true, storageUri: true } as never,
    });
    if (!rev) return '';
    // The actual markdown is reconstructed from the parsed items in
    // metadata? No — we stored markdown verbatim in
    // metadata.lastMarkdown when writing. But to keep storage-agnostic,
    // we read it from the storageUri marker (inline scheme). The
    // simplest path: the writeback method derives storageUri from
    // contentHash + we keep markdown in IMAssetRevision.metadata.body
    // for inline scheme.
    // For inline scheme: read body out of metadata JSON.
    try {
      const md = JSON.parse((rev as { metadata: string }).metadata);
      if (typeof md === 'object' && md && typeof (md as { body?: string }).body === 'string') {
        return (md as { body: string }).body;
      }
    } catch {
      /* fall through */
    }
    // Last resort — re-render from caller-supplied items by reading the
    // most recent emit? For now, return empty + warn.
    log.warn(
      { assetId: asset.id },
      'TODO.md asset content not available inline — caller should re-create via TodoService.writebackToAsset',
    );
    return '';
  }

  private async emitChanged(
    taskId: string,
    view: TodoView,
    actorId: string,
    creatorId: string | null,
    workspaceId: string,
  ): Promise<void> {
    if (!this.deps.eventBusService) return;
    try {
      const ret = this.deps.eventBusService.publish({
        type: 'task.todo.changed',
        timestamp: Date.now(),
        data: {
          taskId,
          byActorId: actorId,
          completedCount: view.doneCount,
          totalCount: view.totalCount,
          progressPct: view.progressPct,
          revision: view.revision,
          // Hint to recipient routing — creator is the orchestrator
          // window owner per §4.5.
          recipientHint: creatorId ?? null,
        },
      });
      if (ret && typeof (ret as Promise<unknown>).catch === 'function') {
        (ret as Promise<unknown>).catch(() => {});
      }
    } catch {
      /* swallow */
    }

    // §F1 — metric emit (registered in metric-registry.ts).
    try {
      metricEmit({
        namespace: 'task.todo',
        name: 'completion_rate',
        value: view.progressPct,
        dims: { workspaceId, taskId },
      });
    } catch {
      /* swallow */
    }
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────

let _singleton: TodoService | null = null;
export function getTodoService(deps?: TodoServiceDeps): TodoService {
  if (!_singleton) {
    _singleton = new TodoService(deps);
  } else if (deps?.eventBusService && !(_singleton as any).deps?.eventBusService) {
    (_singleton as any).deps = { ...((_singleton as any).deps ?? {}), eventBusService: deps.eventBusService };
  }
  return _singleton;
}

export function __setTodoServiceForTests(svc: TodoService | null): void {
  _singleton = svc;
}
