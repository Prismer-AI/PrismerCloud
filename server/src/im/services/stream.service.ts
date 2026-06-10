/**
 * Prismer IM — Stream Service (v2.0 §4.4.7 streaming partial render)
 *
 * Manages LLM streaming messages (typewriter effect). Each active stream
 * holds an in-memory chunk buffer; the daemon appends chunks via
 * `appendChunk` and a per-stream interval (default 200ms) flushes any
 * unsent text to:
 *   1. SSE per-recipient channel `im:sync:<recipientId>` as a synthetic
 *      `message.partial` envelope. The SSE handler forwards this envelope
 *      verbatim to the connected browser — without consuming a sync
 *      cursor seq (per-stream `chunkSeq` is independent of the
 *      per-conversation `boundarySeq`).
 *   2. `im_message_partials` row for F5 hydration. The persisted chunk
 *      buffer lets a reloaded browser query
 *      `GET /messages/:cid/:mid/partials?afterSeq=N` and rebuild the
 *      half-written placeholder before the SSE catches up.
 *
 * On `endStream`, the assembled content goes through `messageService.send`
 * (the existing Wave 2-B1 outbox path), which writes the final
 * `message.new` (a.k.a. `message.created` per §4.4.7 spec naming) event
 * with a real `boundarySeq`. The browser swaps the partial placeholder
 * for the persisted row by `messageId` match.
 *
 * Why direct Redis publish (not via SyncService.writeEvent)?
 * --------------------------------------------------------
 * Partial chunks are sub-message granularity (10-1000x the row count of
 * im_sync_events). Forcing them through the outbox would inflate the
 * publisher's 50ms tick load, churn the per-conversation `boundarySeq`
 * counter past the message-level invariant, and double-write to MySQL
 * for no reliability gain (a missed partial is recoverable from
 * im_message_partials on F5; the final message.created is the durable
 * SoT). So partial chunks bypass the outbox and rely on the dedicated
 * partials table for persistence.
 */

import type Redis from 'ioredis';
import { randomUUID } from 'crypto';
import prisma from '../db';
import type { MessageType, MessageMetadata } from '../types/index';
import { createModuleLogger } from '../../lib/logger';

const log = createModuleLogger('Stream');

const SYNC_CHANNEL_PREFIX = 'im:sync:';
/** Flush interval — §4.4.7 default 200ms. */
const DEFAULT_FLUSH_INTERVAL_MS = 200;
/** Auto-cleanup for orphan in-memory streams (10 min). */
const STREAM_TIMEOUT_MS = 10 * 60 * 1000;
/** Partial row TTL — §4.4.7 24h cleanup. */
export const PARTIAL_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface ActiveStream {
  streamId: string;
  /** Stable id used both for the partial rows and the eventual message row. */
  messageId: string;
  conversationId: string;
  senderId: string;
  type: MessageType;
  metadata?: MessageMetadata;
  chunks: string[];
  /** Position in `chunks` already flushed; subsequent flush emits chunks[flushedIdx..]. */
  flushedIdx: number;
  /** chunkSeq of the next flush (monotonic per messageId). */
  nextChunkSeq: number;
  startedAt: number;
  lastFlushAt: number;
  /** Recipients to fan out partial envelopes to (cached on start). */
  recipientIds: string[];
  /** Per-stream flush interval. */
  flushTimer: ReturnType<typeof setInterval> | null;
}

export interface StartStreamInput {
  streamId: string;
  /** Optional client-provided messageId; if absent, the service mints a cuid-shaped uuid. */
  messageId?: string;
  conversationId: string;
  senderId: string;
  type?: MessageType;
  metadata?: MessageMetadata;
}

export interface EndStreamResult {
  streamId: string;
  messageId: string;
  conversationId: string;
  senderId: string;
  type: MessageType;
  finalContent: string;
  metadata?: MessageMetadata;
}

export class StreamService {
  private streams = new Map<string, ActiveStream>();
  private redis?: Redis;
  private flushIntervalMs: number;
  private staleSweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts?: { flushIntervalMs?: number }) {
    this.flushIntervalMs = opts?.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    // Periodic in-memory orphan cleanup (DB cleanup is in scheduler.service).
    this.staleSweepTimer = setInterval(() => this.cleanupStale(), 60_000);
  }

  /**
   * Attach Redis for SSE fan-out. Without redis, partial flushes still
   * persist to im_message_partials but the live SSE typewriter effect is
   * disabled (clients see partial text only after F5 hydration).
   */
  setRedis(redis: Redis): void {
    this.redis = redis;
  }

  /** Start a new streaming session and arm the 200ms flush timer. */
  async startStream(input: StartStreamInput): Promise<ActiveStream> {
    const messageId = input.messageId ?? `msg-stream-${randomUUID()}`;

    // Resolve recipients up-front so each flush tick is O(1).
    const participants = await prisma.iMParticipant.findMany({
      where: { conversationId: input.conversationId, leftAt: null },
      select: { imUserId: true },
    });
    const recipientIds = new Set<string>([input.senderId]);
    for (const p of participants) recipientIds.add(p.imUserId);

    const stream: ActiveStream = {
      streamId: input.streamId,
      messageId,
      conversationId: input.conversationId,
      senderId: input.senderId,
      type: input.type ?? 'text',
      metadata: input.metadata,
      chunks: [],
      flushedIdx: 0,
      nextChunkSeq: 1,
      startedAt: Date.now(),
      lastFlushAt: 0,
      recipientIds: [...recipientIds],
      flushTimer: null,
    };
    stream.flushTimer = setInterval(() => {
      this.flush(input.streamId).catch((err: unknown) => {
        log.warn({ err: (err as Error).message, streamId: input.streamId }, 'flush error');
      });
    }, this.flushIntervalMs);
    this.streams.set(input.streamId, stream);
    log.debug({ streamId: input.streamId, messageId, flushMs: this.flushIntervalMs }, 'stream started');
    return stream;
  }

  /** Append a chunk to an active stream — flush is timer-driven, not sync. */
  appendChunk(streamId: string, chunk: string): boolean {
    const stream = this.streams.get(streamId);
    if (!stream) return false;
    stream.chunks.push(chunk);
    return true;
  }

  /**
   * Flush all unsent chunks (since `flushedIdx`) as ONE partial event.
   * If no new chunks, no-op (avoids needless Redis chatter on idle streams).
   * `isFinal=false` here — the final flush in `endStream` sets it true.
   */
  async flush(streamId: string, isFinal: boolean = false): Promise<{ flushed: boolean; chunkSeq?: number }> {
    const stream = this.streams.get(streamId);
    if (!stream) return { flushed: false };

    const pending = stream.chunks.slice(stream.flushedIdx);
    if (pending.length === 0 && !isFinal) return { flushed: false };
    if (pending.length === 0 && isFinal) {
      // emit a terminal marker even with no new text
      return await this.emitPartial(stream, '', true);
    }

    const chunkText = pending.join('');
    stream.flushedIdx = stream.chunks.length;
    stream.lastFlushAt = Date.now();
    return await this.emitPartial(stream, chunkText, isFinal);
  }

  /**
   * Emit one partial envelope: persist + SSE publish.
   * Internal — callers use `flush` / `endStream`.
   */
  private async emitPartial(
    stream: ActiveStream,
    chunkText: string,
    isFinal: boolean,
  ): Promise<{ flushed: boolean; chunkSeq: number }> {
    const chunkSeq = stream.nextChunkSeq++;
    const id = randomUUID();

    // 1) Persist (skip if empty terminal marker — no value in a zero-byte row).
    if (chunkText.length > 0) {
      try {
        await prisma.iMMessagePartial.create({
          data: {
            id,
            messageId: stream.messageId,
            chunkText,
            chunkSeq,
          },
        });
      } catch (err) {
        // Persistence failure is non-fatal — SSE still goes out. F5 hydration
        // will be missing this chunk but the live stream continues.
        log.warn(
          { err: (err as Error).message, messageId: stream.messageId, chunkSeq },
          'partial persist failed (continuing with SSE)',
        );
      }
    }

    // 2) SSE fan-out via Redis pub/sub.
    if (this.redis) {
      const envelope = {
        // Legacy field present so older subscribers don't choke on undefined.
        seq: 0,
        // boundarySeq intentionally null — partials don't consume the
        // per-conversation cursor (§4.4.7 / §4.1 invariant separation).
        boundarySeq: null,
        type: 'message.partial',
        data: {
          messageId: stream.messageId,
          conversationId: stream.conversationId,
          senderId: stream.senderId,
          partialContent: chunkText,
          chunkSeq,
          isFinal,
        },
        conversationId: stream.conversationId,
        at: new Date().toISOString(),
      };
      const payload = JSON.stringify(envelope);
      try {
        await Promise.all(
          stream.recipientIds.map((rid) => this.redis!.publish(`${SYNC_CHANNEL_PREFIX}${rid}`, payload)),
        );
      } catch (err) {
        log.warn({ err: (err as Error).message, streamId: stream.streamId }, 'partial publish failed');
      }
    }

    return { flushed: true, chunkSeq };
  }

  /**
   * End a stream: stop the flush timer, fire ONE terminal partial
   * (isFinal=true, draining any remaining buffered chunks), then return
   * the assembled content to the caller (typically WS handler) so it can
   * persist the final `message.new` via the normal outbox path.
   *
   * NOTE: We intentionally do NOT persist the final message inside this
   * method. The caller owns idempotency + auth + dispatch routing on the
   * final write. This keeps stream.service decoupled from message.service
   * and respects the §4.4.7 "the final message.created flows through the
   * normal outbox" contract.
   */
  async endStream(streamId: string, finalContent?: string): Promise<EndStreamResult | null> {
    const stream = this.streams.get(streamId);
    if (!stream) return null;

    // Stop the timer first so we don't race with our own final flush.
    if (stream.flushTimer) {
      clearInterval(stream.flushTimer);
      stream.flushTimer = null;
    }

    const assembled = finalContent ?? stream.chunks.join('');

    // Final flush — emits any buffered chunks + isFinal=true marker so the
    // UI can hide the "live typing" cursor immediately (without waiting for
    // the eventual message.new outbox echo). If `finalContent` was passed
    // and differs from the accumulated chunks, we still emit the diff
    // (everything past `flushedIdx`) so the UI tail matches.
    await this.flush(streamId, true);

    this.streams.delete(streamId);
    log.debug(
      { streamId, messageId: stream.messageId, totalChunks: stream.chunks.length, finalChunkSeq: stream.nextChunkSeq - 1 },
      'stream ended',
    );

    return {
      streamId,
      messageId: stream.messageId,
      conversationId: stream.conversationId,
      senderId: stream.senderId,
      type: stream.type,
      finalContent: assembled,
      metadata: stream.metadata,
    };
  }

  /** Get an active stream. */
  getStream(streamId: string): ActiveStream | undefined {
    return this.streams.get(streamId);
  }

  /** Get current content of an active stream. */
  getStreamContent(streamId: string): string | null {
    const stream = this.streams.get(streamId);
    if (!stream) return null;
    return stream.chunks.join('');
  }

  /** Cancel an active stream without firing the terminal partial. */
  cancelStream(streamId: string): boolean {
    const stream = this.streams.get(streamId);
    if (!stream) return false;
    if (stream.flushTimer) {
      clearInterval(stream.flushTimer);
      stream.flushTimer = null;
    }
    return this.streams.delete(streamId);
  }

  /** Active stream count. */
  get activeCount(): number {
    return this.streams.size;
  }

  /** Stop the orphan-sweep timer (for graceful shutdown). */
  stop(): void {
    if (this.staleSweepTimer) {
      clearInterval(this.staleSweepTimer);
      this.staleSweepTimer = null;
    }
    for (const [, stream] of this.streams) {
      if (stream.flushTimer) clearInterval(stream.flushTimer);
    }
    this.streams.clear();
  }

  private cleanupStale(): void {
    const now = Date.now();
    for (const [id, stream] of this.streams) {
      if (now - stream.startedAt > STREAM_TIMEOUT_MS) {
        if (stream.flushTimer) clearInterval(stream.flushTimer);
        this.streams.delete(id);
        log.info({ streamId: id }, 'cleaned up stale stream');
      }
    }
  }

  /**
   * Reaper used by scheduler.sweepMessagePartials — deletes partial rows
   * older than `cutoffMs` (default 24h). Returns the row count deleted.
   *
   * Static-ish so the scheduler can call it without an instance handle.
   */
  static async reapStalePartials(cutoffMs: number = PARTIAL_RETENTION_MS): Promise<number> {
    const cutoff = new Date(Date.now() - cutoffMs);
    const res = await prisma.iMMessagePartial.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    return res.count ?? 0;
  }

  /**
   * F5 hydration helper — read partial chunks for one message past a
   * given chunkSeq. Used by `GET /messages/:cid/:mid/partials?afterSeq=N`.
   */
  static async getPartials(
    messageId: string,
    afterSeq: number,
    limit: number = 500,
  ): Promise<Array<{ chunkSeq: number; chunkText: string; createdAt: string }>> {
    const rows = await prisma.iMMessagePartial.findMany({
      where: { messageId, chunkSeq: { gt: afterSeq } },
      orderBy: { chunkSeq: 'asc' },
      take: limit,
    });
    return rows.map((r: { chunkSeq: number; chunkText: string; createdAt: Date }) => ({
      chunkSeq: r.chunkSeq,
      chunkText: r.chunkText,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}
