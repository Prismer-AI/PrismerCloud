// Artifacts uploader for adapter-produced artifacts (release202/04 §3.1 —
// renamed from outbox-watcher; "artifacts" replaces the legacy outbox/result
// naming).
//
// Two deployment shapes share this implementation:
//
//   1. **Container / sandbox** (legacy)  — controller writes files to a fixed
//      artifacts dir at `/workspace/_outbox/` (legacy path name kept for the
//      container controller contract), watcher uploads them as
//      `kind="sandbox-output"` IMAssets. Tagged with the most-recent task
//      via `setActiveTask()` from the LocalServer onDispatch sink.
//
//   2. **Host / per-task scratch** (Wave-9)  — Daemon allocates
//      `${homedir}/.prismer/.../tasks/${taskId}/artifacts/` per dispatch,
//      watches it for the duration of the run, and **flushes the accumulated
//      assetIds back into `task.dispatch.reply.assetIds`** so the cloud's
//      agent_reply path renders user-deliverable files as chat
//      attachments. Per-task isolation prevents two concurrent dispatches
//      to the same agent profile from cross-contaminating outputs.
//
// Backward-compat (release202/04 P0): when a host-mode task points at the new
// `artifacts/` dir, the watcher ALSO scans the sibling legacy `result/` and
// `_outbox/` dirs if present, so in-flight tasks created before the rename
// (whose files landed in `result/`) still get their artifacts uploaded.
//
// The watcher reconfigures its monitored directory whenever
// `setActiveTask({ artifactsDir })` is called — Phase A keeps it polling-based
// (no chokidar dep) since dispatch latency tolerates 2s. Switch to fs.watch
// later if measurements warrant.
//
// Cloud contract (see `src/im/api/assets.ts`): multipart POST with
// workspaceId + kind + file + metadata.{taskId,containerId}. Sandbox-output
// is the default kind; host-mode dispatches override to `agent-output` so
// cloud's per-kind validation differs (sandbox-output requires
// containerId, agent-output does not).

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { Stats } from 'node:fs';
import type { CloudClient } from '../auth.js';
import { inferAgentOutputMime, validateAgentOutputAsset } from './asset/agent-output-policy.js';
import { detectMagicBytes, mimeMismatchReason } from './asset/magic-bytes.js';
import { DaemonAssetUploadClient } from './asset/origin/upload-runner.js';

export interface ArtifactsWatcherOptions {
  /**
   * Default directory to watch when no setActiveTask has narrowed it.
   * Container mode: `/workspace/_outbox` (legacy path name kept for the
   * container controller contract). Host mode: omit (no default scan — only
   * watch when an active task points at a specific dir).
   */
  artifactsDir?: string;
  /** Cloud client (already configured with apiKey + baseUrl). */
  cloud: CloudClient;
  /**
   * Container identifier — required by the cloud's kind=sandbox-output
   * contract as metadata.containerId. Read from env PRISMER_CONTAINER_ID
   * when controller injected one; otherwise the daemon_id as fallback so
   * the request still passes validation. Host-mode (kind=agent-output)
   * uploads bypass containerId validation.
   */
  containerId: string;
  /**
   * Resolver for the owning workspace at upload time. Returns null when no
   * workspace context is yet known — the watcher will skip the file and
   * retry on the next scan tick.
   */
  workspaceId: () => string | null;
  /** Poll interval in ms. Default 2000. */
  pollIntervalMs?: number;
  /** Optional log sink (default writes to stdout/stderr). */
  log?: { info: (msg: string) => void; warn: (msg: string) => void };
  /**
   * release202/09 P2 — directory auto-scan gate. **Default FALSE.**
   *
   * When false, the polling scan loop does NOT run: the watcher never reads
   * `artifactsDir` and never auto-uploads files. File delivery is instead
   * driven EXPLICITLY by the agent via `cloud deliver` → daemon local-server
   * `POST /local/deliver` → `recordDeliveredAsset(taskId, assetId)`. The
   * `pendingByTask` / `flushPending` / `recordDeliveredAsset` plumbing and the
   * `upload()` path all still work — only the implicit directory-magic is off.
   *
   * The original directory-scan code (currentScanDirs / tick / scanDir /
   * quarantine) is retained intact behind this flag so it can be re-enabled
   * (autoScan:true) as a fallback if the explicit path needs to fall back to
   * the legacy auto-archive behaviour.
   */
  autoScan?: boolean;
}

export interface ActiveTask {
  taskId: string;
  /** Adapter name; surfaces in upload metadata for observability. */
  adapter?: string;
  /**
   * Per-task artifacts directory. When set, scans this directory in
   * addition to `opts.artifactsDir`. Files uploaded from here are tagged
   * with `kind=agent-output` (host-mode contract).
   *
   * Backward-compat (release202/04 P0): the watcher also scans the sibling
   * legacy `result/` and `_outbox/` dirs (resolved from this dir's parent)
   * for in-flight tasks created before the artifacts rename.
   */
  artifactsDir?: string;
}

const DEFAULT_INTERVAL_MS = 2000;
const RESERVED_SUBDIR = '_uploaded';
// Directory where mime-mismatch files are quarantined so they don't loop
// (i.e. fail upload → retry → fail again) and the operator can inspect what
// the agent actually wrote. 2026-05-22 — added alongside magic-bytes sniffing.
const REJECTED_SUBDIR = '_rejected';
// P1-2 (2026-05-25): cap how many rejection records we keep per task so a
// runaway agent that produces thousands of bad files can't blow up memory.
// The last N entries are most useful for prompt-injection feedback.
const REJECTION_BUFFER_MAX = 20;

/**
 * P1-2: structured rejection record buffered per-task and drained on the
 * next `task.dispatch.reply` build. Mirrors the wire-level
 * `OutboxRejectionRecord` in `types/im-events.ts` so dispatch.ts can stamp
 * it directly into the reply without remapping. (Wire field name
 * `outboxRejections` is the cross-process contract with cloud and stays;
 * only the daemon-side type name is renamed — release202/04 P0.)
 */
export interface ArtifactsRejectionRecord {
  filename: string;
  reason: string;
  inferredMime: string;
  detectedMime: string;
  rejectedAt: string;
}

/**
 * Module-local buffer of per-task rejection records. Keyed by `taskId` so
 * concurrent dispatches don't cross-contaminate. Drained by
 * `flushRejections(taskId)`.
 *
 * Kept as a module-scoped Map (rather than a class field) so the helper
 * can be called from dispatch.ts even when the watcher is mid-construction
 * or paused — the recorder side (scanDir) and the drainer side (dispatch
 * reply build) are otherwise loosely coupled.
 */
const artifactsRejectionsByTask = new Map<string, ArtifactsRejectionRecord[]>();

/**
 * Drain and return the rejection records collected for `taskId` since the
 * last flush. Idempotent — calling twice with the same id returns `[]` the
 * second time. dispatch.ts calls this at reply-build time so the cloud
 * handler can stamp them onto `IMTask.metadata.outboxRejections` and the
 * next dispatch prompt re-surfaces them to the agent.
 */
export function flushRejections(taskId: string): ArtifactsRejectionRecord[] {
  const list = artifactsRejectionsByTask.get(taskId) ?? [];
  artifactsRejectionsByTask.delete(taskId);
  return list;
}

/**
 * Test-only helper for invariant assertions. Not part of the public API.
 */
export function _recordRejectionForTest(taskId: string, record: ArtifactsRejectionRecord): void {
  const list = artifactsRejectionsByTask.get(taskId) ?? [];
  list.push(record);
  if (list.length > REJECTION_BUFFER_MAX) list.splice(0, list.length - REJECTION_BUFFER_MAX);
  artifactsRejectionsByTask.set(taskId, list);
}

export class ArtifactsWatcher {
  private timer?: NodeJS.Timeout;
  private uploaded = new Set<string>();
  /**
   * Host-mode tasks keyed by taskId. Each entry has its own `outboxDir`
   * and the watcher scans every entry's directory each tick. Concurrent
   * dispatches (Wave-9: orchestrator + spawned worker on the same daemon)
   * each occupy their own slot — finishing one dispatch only removes its
   * slot, leaving every other concurrent dispatch's tracking intact.
   *
   * Replaces the v1 single `activeTask` slot which was last-wins and
   * caused cross-dispatch clobbering: an orchestrator finishing first
   * would `setActiveTask(null)` and silently discard the concurrent
   * worker's outbox tracking.
   */
  private activeTasks = new Map<string, ActiveTask>();
  /**
   * Legacy container/sandbox task. Used only when an `ActiveTask` is set
   * **without** an `outboxDir` (i.e. the legacy `setActiveTask` shape
   * where the watcher's default `opts.artifactsDir` is the scan target).
   * Single slot because the legacy container deployment only ever runs
   * one task at a time per container.
   */
  private legacyContainerTask: ActiveTask | null = null;
  private busy = false;
  /**
   * Per-task accumulated assetIds. Populated on each successful upload
   * keyed by the task whose outbox dir the file came from.
   * `flushPending(taskId)` drains and returns this list so dispatch.ts
   * can stamp it onto task.dispatch.reply.assetIds.
   */
  private pendingByTask = new Map<string, string[]>();

  constructor(private opts: ArtifactsWatcherOptions) {}

  /**
   * Register a host-mode task envelope. Each call adds (or replaces) an
   * entry keyed by `task.taskId` so concurrent dispatches do not clobber
   * each other.
   *
   * Requires `task.artifactsDir` to be set — the per-task workdir is the
   * isolation boundary. For the legacy container/sandbox single-slot
   * shape (no per-task dir), use `setActiveTask` instead.
   */
  addActiveTask(task: ActiveTask): void {
    if (!task.artifactsDir) {
      throw new Error('addActiveTask requires task.artifactsDir; use setActiveTask for legacy container mode');
    }
    this.activeTasks.set(task.taskId, task);
  }

  /**
   * Remove a host-mode task entry by id. No-op if the id was not
   * registered. Idempotent — dispatch.ts calls this in `finally{}` after
   * `flushPending` so a failed dispatch still clears its slot.
   */
  removeActiveTask(taskId: string): void {
    this.activeTasks.delete(taskId);
  }

  /**
   * Legacy single-slot API.
   *
   *   - Non-null with `outboxDir` → forwards to `addActiveTask` (host
   *     mode). The caller is still responsible for `removeActiveTask`
   *     (or another `setActiveTask(null)`) at teardown.
   *   - Non-null **without** `outboxDir` → store in the legacy container
   *     slot. Uploads from `opts.artifactsDir` are tagged with this task.
   *   - `null` → clear the legacy container slot only. Does NOT touch
   *     the host-mode `activeTasks` map; concurrent host-mode dispatches
   *     keep their own slots until they call `removeActiveTask`
   *     themselves.
   *
   * The null-clears-only-legacy semantic is the core fix for the
   * Wave-9 concurrency race: previously a finishing orchestrator's
   * `setActiveTask(null)` would clobber a still-running worker's
   * tracking, dropping its uploads on the floor.
   */
  setActiveTask(task: ActiveTask | null): void {
    if (task === null) {
      this.legacyContainerTask = null;
      return;
    }
    if (task.artifactsDir) {
      this.addActiveTask(task);
      return;
    }
    this.legacyContainerTask = task;
  }

  /**
   * Drain and return the assetIds collected for `taskId` since the last
   * flush. Idempotent — calling twice with the same id returns `[]` the
   * second time. dispatch.ts calls this once at reply-build time.
   */
  flushPending(taskId: string): string[] {
    const ids = this.pendingByTask.get(taskId) ?? [];
    this.pendingByTask.delete(taskId);
    return ids;
  }

  /**
   * release202/09 P2 — explicit-delivery hook (动作 A).
   *
   * Append an already-uploaded assetId to `pendingByTask[taskId]` so the
   * dispatch-end `flushPending(taskId)` surfaces it on
   * `task.dispatch.reply.assetIds` — exactly the same channel the (now
   * gated-off) auto-scan used at lines ~578-580. This is the bridge that
   * lets the daemon local-server's `POST /local/deliver` handler reuse the
   * existing reply-attachment plumbing instead of inventing a parallel one.
   *
   * Idempotency: callers should pass each assetId once. We de-dup defensively
   * so a double-delivered file does not appear twice in reply.assetIds.
   */
  recordDeliveredAsset(taskId: string, assetId: string): void {
    if (!taskId || !assetId) return;
    const list = this.pendingByTask.get(taskId) ?? [];
    if (!list.includes(assetId)) list.push(assetId);
    this.pendingByTask.set(taskId, list);
  }

  /**
   * release202/09 P2 — explicit upload entrypoint shared by the daemon
   * local-server `POST /local/deliver` handler. Reads the file off the
   * container FS, runs the SAME agent-output-policy + magic-bytes guards the
   * auto-scan `upload()` path uses, and POSTs via `DaemonAssetUploadClient`
   * with the daemon's credential. Returns the freshly-minted assetId.
   *
   * Unlike the private `upload()` (which is keyed on an ActiveTask + Stats
   * from the scan loop), this is a one-shot for a caller-supplied absolute
   * path; it does NOT touch `pendingByTask` — the caller decides whether the
   * file rides the reply (`recordDeliveredAsset`, 动作 A) or goes out as a
   * standalone message (动作 B).
   *
   * Throws a clear Error on policy / magic-bytes rejection so the agent can
   * read why its file was refused.
   */
  async deliverFile(input: {
    taskId: string;
    filePath: string;
    adapter?: string;
  }): Promise<{ assetId: string; mime: string; filename: string; sizeBytes: number }> {
    const wsId = this.opts.workspaceId();
    if (!wsId) {
      throw new Error('no workspaceId yet (daemon has not loaded workspace context)');
    }
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(input.filePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw new Error(`file not found: ${input.filePath}`);
      throw new Error(`cannot read ${input.filePath}: ${(err as Error).message}`);
    }
    const fileName = path.basename(input.filePath);
    const inferredMime = inferAgentOutputMime(fileName);
    const policy = validateAgentOutputAsset({ filename: fileName, mime: inferredMime, sizeBytes: bytes.length });
    if (!policy.ok) {
      throw new Error(`agent output rejected: ${policy.reason}`);
    }
    const detection = detectMagicBytes(bytes);
    const reason = mimeMismatchReason(detection, policy.mime);
    if (reason) {
      throw new Error(`MIME_MISMATCH for ${fileName}: ${reason}`);
    }
    const metadata: Record<string, unknown> = {
      taskId: input.taskId,
      ...(input.adapter ? { adapter: input.adapter } : {}),
    };
    const folderPath = `/tasks/${input.taskId}`;
    const uploader = new DaemonAssetUploadClient({
      cloudApiBase: this.opts.cloud.baseUrl,
      apiKey: this.opts.cloud.apiKey,
    });
    const uploaded = await uploader.uploadAsset({
      workspaceId: wsId,
      kind: 'agent-output',
      filename: fileName,
      bytes,
      mime: policy.mime,
      size: bytes.length,
      metadata,
      folderPath,
      sourceTaskId: input.taskId,
    });
    this.log(
      'info',
      `delivered ${fileName} (${bytes.length}B) kind=agent-output taskId=${input.taskId} ws=${wsId} assetId=${uploaded.assetId}`,
    );
    return { assetId: uploaded.assetId, mime: policy.mime, filename: fileName, sizeBytes: bytes.length };
  }

  start(): void {
    // release202/09 P2 — auto-scan is OFF by default. When disabled the
    // watcher is a passive container for explicitly-delivered assets
    // (recordDeliveredAsset → flushPending); we never spin the poll timer.
    if (this.opts.autoScan !== true) {
      this.log(
        'info',
        'artifacts watcher started: autoScan=off (explicit delivery only — files arrive via POST /local/deliver)',
      );
      return;
    }
    if (this.timer) return;
    const interval = this.opts.pollIntervalMs ?? DEFAULT_INTERVAL_MS;
    this.timer = setInterval(() => void this.tick(), interval);
    this.log('info', `artifacts watcher started: defaultDir=${this.opts.artifactsDir ?? '(per-task)'} interval=${interval}ms`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Force a synchronous scan — useful for tests + e2e harnesses that want to
   * trigger upload after writing a file rather than wait for the next tick.
   * Also used by dispatch.ts at reply-build time to drain any pending files
   * before flushPending() is called.
   */
  async scanNow(): Promise<void> {
    await this.tick();
  }

  private log(level: 'info' | 'warn', message: string): void {
    if (this.opts.log) {
      this.opts.log[level](`[artifacts] ${message}`);
      return;
    }
    const stream = level === 'warn' ? process.stderr : process.stdout;
    stream.write(`[artifacts] ${message}\n`);
  }

  /**
   * Build the list of directories to scan this tick — one entry per
   * concurrently-active task plus the legacy container slot (if any).
   * Each entry carries its own `task` envelope so uploads can be tagged
   * and accumulated per-task without sharing global mutable state.
   *
   * Dedup so a directory configured in both spots only scans once
   * (legacy single-task case where opts.artifactsDir == legacyTask.artifactsDir
   * is unlikely but cheap to handle).
   *
   * Backward-compat (release202/04 P0): for each host-mode task pointing at
   * the new `artifacts/` dir, also enqueue its sibling legacy `result/` and
   * `_outbox/` dirs (same parent). readdir on a missing legacy dir is a cheap
   * ENOENT no-op in scanDir, so this is safe even when no legacy files exist.
   */
  private currentScanDirs(): Array<{
    dir: string;
    kind: 'sandbox-output' | 'agent-output';
    task: ActiveTask | null;
  }> {
    const dirs: Array<{ dir: string; kind: 'sandbox-output' | 'agent-output'; task: ActiveTask | null }> = [];
    const seen = new Set<string>();
    const pushDir = (dir: string, kind: 'sandbox-output' | 'agent-output', task: ActiveTask | null): void => {
      if (seen.has(dir)) return;
      dirs.push({ dir, kind, task });
      seen.add(dir);
    };
    if (this.opts.artifactsDir) {
      pushDir(this.opts.artifactsDir, 'sandbox-output', this.legacyContainerTask);
    }
    for (const task of this.activeTasks.values()) {
      if (!task.artifactsDir) continue;
      pushDir(task.artifactsDir, 'agent-output', task);
      // Legacy sibling dirs for in-flight tasks created before the rename.
      const base = path.basename(task.artifactsDir);
      if (base === 'artifacts') {
        const parent = path.dirname(task.artifactsDir);
        pushDir(path.join(parent, 'result'), 'agent-output', task);
        pushDir(path.join(parent, '_outbox'), 'agent-output', task);
      }
    }
    return dirs;
  }

  private async tick(): Promise<void> {
    // release202/09 P2 — when auto-scan is gated off, a tick (including the
    // dispatch-end scanNow() drain) is a no-op: there is no directory to
    // sweep. Explicitly-delivered assets are already in pendingByTask.
    if (this.opts.autoScan !== true) return;
    // Serialize ticks — long uploads must not race with the next scan.
    if (this.busy) return;
    this.busy = true;
    try {
      for (const { dir, kind, task } of this.currentScanDirs()) {
        await this.scanDir(dir, kind, task);
      }
    } finally {
      this.busy = false;
    }
  }

  private async scanDir(
    dir: string,
    kind: 'sandbox-output' | 'agent-output',
    task: ActiveTask | null,
  ): Promise<void> {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return; // outbox not provisioned yet — wait
      this.log('warn', `readdir ${dir} failed: ${(err as Error).message}`);
      return;
    }
    for (const name of entries) {
      if (name.startsWith('.')) continue;
      if (name === RESERVED_SUBDIR) continue;
      if (name === REJECTED_SUBDIR) continue;
      const full = path.join(dir, name);
      let st: Stats;
      try {
        st = await fs.stat(full);
      } catch {
        continue; // raced with rename/delete
      }
      if (!st.isFile()) continue;
      const key = `${full}:${st.mtimeMs}:${st.size}`;
      if (this.uploaded.has(key)) continue;
      try {
        await this.upload(full, st, kind, task);
        this.uploaded.add(key);
      } catch (err) {
        const msg = (err as Error).message;
        this.log('warn', `upload ${full} failed: ${msg}`);
        // 2026-05-22 — mime-mismatch is permanent (the bytes won't change by
        // retrying). Quarantine the file so the watcher stops looping on it
        // and the operator can inspect what the agent actually produced.
        // Cloud rejections that carry the MIME_MISMATCH error code (added in
        // src/im/api/assets.ts) flow through the same throw and land here.
        if (/\bMIME_MISMATCH\b/i.test(msg) || /\bmime mismatch\b/i.test(msg)) {
          await this.quarantine(dir, full).catch((moveErr) =>
            this.log('warn', `quarantine ${full} failed: ${(moveErr as Error).message}`),
          );
          this.uploaded.add(key);
          // 2026-05-22 (F2B) — until now the rejection was silent: file
          // quarantined locally + warn line in daemon log, but neither the
          // agent nor the cloud-side task carried any record. The agent's
          // next dispatch would proceed as if the artifact was delivered.
          //
          // Report the rejection to cloud as a task event so the task log
          // captures the failure for audit. Best-effort — failure here must
          // not loop or escalate (we already returned 400, the file is
          // already quarantined). TODO(F2B prompt-surfacing): cloud
          // dispatch.ts should pull recent outbox_* logs into the next
          // prompt's "Recent events" section so the agent learns its
          // artifact was rejected. Tracked in cloud `src/im/api/tasks.ts`
          // POST /:id/event handler comment.
          await this.reportMimeMismatchToCloud(task, full, msg).catch((reportErr) =>
            this.log('warn', `report MIME_MISMATCH failed: ${(reportErr as Error).message}`),
          );
        }
        // Other errors (transient network, 5xx): do NOT add to uploaded —
        // next tick will retry as before.
      }
    }
  }

  /**
   * F2B — report an OUTBOX_MIME_MISMATCH task event to cloud so the task log
   * gains an auditable record of the rejection. Without this, the failure is
   * silent (file quarantined locally, agent unaware) and the next dispatch
   * loops on the same bad strategy.
   *
   * Best-effort: every catch site swallows errors. We never want this
   * upstream call to block local quarantine or trigger a retry loop, because
   * the reject decision is already final by the time we get here.
   *
   * Endpoint contract: POST /api/im/tasks/:id/event
   *   { code: 'OUTBOX_MIME_MISMATCH', payload: { file, daemonError }, message }
   * Only callable when `task?.taskId` is known — pre-dispatch outbox files
   * (no active task) are quarantined silently as before.
   */
  private async reportMimeMismatchToCloud(
    task: ActiveTask | null,
    filePath: string,
    daemonErrorMessage: string,
  ): Promise<void> {
    if (!task?.taskId) return; // pre-dispatch files: no task to attach to
    const fileName = path.basename(filePath);
    // Parse "MIME_MISMATCH for foo.pdf: <reason>" → <reason> for the payload.
    // Fallback to the full message if the prefix isn't recognizable.
    const reasonMatch = daemonErrorMessage.match(/MIME_MISMATCH[^:]*:\s*(.+)$/i);
    const reason = reasonMatch?.[1] ? reasonMatch[1].trim() : daemonErrorMessage;
    const body = {
      code: 'OUTBOX_MIME_MISMATCH',
      payload: {
        file: fileName,
        reason,
        daemonError: daemonErrorMessage,
      },
      message:
        `Your output file ${fileName} was rejected because its bytes do not match the claimed format. ` +
        'Use a real library (e.g. reportlab for PDF, openpyxl for XLSX) instead of renaming an extension.',
    };
    const res = await this.opts.cloud.request('POST', `/api/im/tasks/${encodeURIComponent(task.taskId)}/event`, {
      body,
    });
    if (!res.ok) {
      // Surface as a warn but do not throw — caller already catches and logs.
      throw new Error(`cloud rejected event: ${res.status} ${res.error?.code ?? ''} ${res.error?.message ?? ''}`);
    }
  }

  /**
   * Move a file under `<dir>/_rejected/` so it stops being a scan candidate
   * (the loop skips the reserved subdir) and operators can find the
   * offending artifact. Filename collision is rare per task; on collision
   * we append a millisecond suffix to keep the original observable.
   */
  private async quarantine(dir: string, full: string): Promise<void> {
    const rejectedDir = path.join(dir, REJECTED_SUBDIR);
    await fs.mkdir(rejectedDir, { recursive: true });
    const base = path.basename(full);
    let dest = path.join(rejectedDir, base);
    try {
      await fs.access(dest);
      // Collision: tack on millisecond suffix before the extension.
      const ext = path.extname(base);
      const stem = base.slice(0, base.length - ext.length);
      dest = path.join(rejectedDir, `${stem}.${Date.now()}${ext}`);
    } catch {
      /* no collision */
    }
    await fs.rename(full, dest);
    this.log('warn', `quarantined ${full} → ${dest}`);
  }

  private async upload(
    filePath: string,
    st: Stats,
    kind: 'sandbox-output' | 'agent-output',
    task: ActiveTask | null,
  ): Promise<void> {
    const wsId = this.opts.workspaceId();
    if (!wsId) {
      this.log('warn', `skip ${filePath}: no workspaceId yet (waiting for context)`);
      return;
    }
    if (!task) {
      this.log('warn', `skip ${filePath}: no active taskId (no dispatch/handoff received yet)`);
      return;
    }

    const bytes = await fs.readFile(filePath);
    const fileName = path.basename(filePath);
    const inferredMime = inferAgentOutputMime(fileName);
    const policy = validateAgentOutputAsset({ filename: fileName, mime: inferredMime, sizeBytes: bytes.length });
    if (!policy.ok) {
      throw new Error(`agent output rejected: ${policy.reason}`);
    }
    // 2026-05-22 — magic-bytes content vs filename/mime consistency check.
    // The agent_output_policy above validates extension+mime by NAME ONLY; it
    // would happily accept `report.pdf` whose bytes are actually markdown.
    // detectMagicBytes peeks at the first 4 KiB and yells when the content
    // family contradicts the declared/inferred mime — this is the local
    // first-pass guard that keeps the cloud from ever seeing a misformed
    // artifact (cloud has its own second-pass guard for defense-in-depth).
    const detection = detectMagicBytes(bytes);
    const reason = mimeMismatchReason(detection, policy.mime);
    if (reason) {
      // P1-2 (2026-05-25): record the rejection in the module-local buffer
      // BEFORE throwing — we have all the structured fields here (filename,
      // inferred mime, detected mime, reason); reconstructing them from the
      // stringified error message in scanDir's catch would be fragile.
      // dispatch.ts drains via `flushRejections(taskId)` at reply-build time.
      if (task?.taskId) {
        const record: ArtifactsRejectionRecord = {
          filename: fileName,
          reason,
          inferredMime: policy.mime,
          detectedMime: detection.mime ?? 'unknown',
          rejectedAt: new Date().toISOString(),
        };
        const list = artifactsRejectionsByTask.get(task.taskId) ?? [];
        list.push(record);
        if (list.length > REJECTION_BUFFER_MAX) {
          list.splice(0, list.length - REJECTION_BUFFER_MAX);
        }
        artifactsRejectionsByTask.set(task.taskId, list);
      }
      // Throw with a stable MIME_MISMATCH marker so scanDir's catch handler
      // routes the file into `_rejected/` instead of retrying forever.
      throw new Error(`MIME_MISMATCH for ${fileName}: ${reason}`);
    }
    const metadata: Record<string, unknown> = {
      taskId: task.taskId,
      ...(task.adapter ? { adapter: task.adapter } : {}),
    };
    // sandbox-output requires containerId per cloud's validation
    // (src/im/api/assets.ts:744). agent-output is the host-mode kind and
    // cloud accepts it without containerId. Keep containerId on
    // sandbox-output uploads for back-compat.
    if (kind === 'sandbox-output') {
      metadata.containerId = this.opts.containerId;
    }
    // Wave-9 Phase 2.2: auto-folder daemon-produced assets so the workspace
    // library shows them grouped per task instead of dumping everything at
    // root. Cloud accepts this on POST (Phase 2.1). Users keep the right
    // to PATCH folderPath afterwards — auto-tag only sets it on initial
    // create.
    //   agent-output  → /tasks/{taskId}     (host-mode chat dispatch)
    //   sandbox-output → /sandbox/{taskId}  (container/sandbox dispatch)
    const folderPath =
      kind === 'agent-output'
        ? `/tasks/${task.taskId}`
        : kind === 'sandbox-output'
          ? `/sandbox/${task.taskId}`
          : null;
    const uploader = new DaemonAssetUploadClient({
      cloudApiBase: this.opts.cloud.baseUrl,
      apiKey: this.opts.cloud.apiKey,
    });
    const uploaded = await uploader.uploadAsset({
      workspaceId: wsId,
      kind,
      filename: fileName,
      bytes,
      mime: policy.mime,
      size: bytes.length,
      metadata,
      ...(folderPath ? { folderPath } : {}),
      sourceTaskId: task.taskId,
    });

    // Capture the freshly-minted assetId so dispatch.ts can stamp it onto
    // reply.assetIds at flush time. Cloud responds with `{ ok, data: { id, ... } }`.
    const list = this.pendingByTask.get(task.taskId) ?? [];
    list.push(uploaded.assetId);
    this.pendingByTask.set(task.taskId, list);

    this.log(
      'info',
      `uploaded ${fileName} (${st.size}B) kind=${kind} taskId=${task.taskId} ws=${wsId} assetId=${uploaded.assetId}`,
    );
  }
}
