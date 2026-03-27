/**
 * Prismer IM — Stream service
 * 
 * Manages LLM streaming messages (typewriter effect).
 * Holds active streams in memory and persists the final result as a message.
 */

import type { MessageType, MessageMetadata } from "../types/index";

export interface ActiveStream {
  streamId: string;
  conversationId: string;
  senderId: string;
  type: MessageType;
  metadata?: MessageMetadata;
  chunks: string[];
  startedAt: number;
}

export interface StartStreamInput {
  streamId: string;
  conversationId: string;
  senderId: string;
  type?: MessageType;
  metadata?: MessageMetadata;
}

export interface EndStreamResult {
  streamId: string;
  conversationId: string;
  senderId: string;
  type: MessageType;
  finalContent: string;
  metadata?: MessageMetadata;
}

export class StreamService {
  /** Active streams indexed by streamId */
  private streams = new Map<string, ActiveStream>();

  /** Auto-cleanup timeout (10 minutes) */
  private readonly STREAM_TIMEOUT_MS = 10 * 60 * 1000;

  constructor() {
    // Periodic cleanup of stale streams
    setInterval(() => this.cleanupStale(), 60_000);
  }

  /**
   * Start a new streaming session.
   */
  startStream(input: StartStreamInput): ActiveStream {
    const stream: ActiveStream = {
      streamId: input.streamId,
      conversationId: input.conversationId,
      senderId: input.senderId,
      type: input.type ?? "text",
      metadata: input.metadata,
      chunks: [],
      startedAt: Date.now(),
    };
    this.streams.set(input.streamId, stream);
    return stream;
  }

  /**
   * Append a chunk to an active stream.
   */
  appendChunk(streamId: string, chunk: string): boolean {
    const stream = this.streams.get(streamId);
    if (!stream) return false;
    stream.chunks.push(chunk);
    return true;
  }

  /**
   * End a stream and return the final assembled content.
   */
  async endStream(streamId: string, finalContent?: string): Promise<EndStreamResult | null> {
    const stream = this.streams.get(streamId);
    if (!stream) return null;

    this.streams.delete(streamId);

    const assembled = finalContent ?? stream.chunks.join("");

    return {
      streamId,
      conversationId: stream.conversationId,
      senderId: stream.senderId,
      type: stream.type,
      finalContent: assembled,
      metadata: stream.metadata,
    };
  }

  /**
   * Get an active stream.
   */
  getStream(streamId: string): ActiveStream | undefined {
    return this.streams.get(streamId);
  }

  /**
   * Get current content of an active stream.
   */
  getStreamContent(streamId: string): string | null {
    const stream = this.streams.get(streamId);
    if (!stream) return null;
    return stream.chunks.join("");
  }

  /**
   * Cancel an active stream.
   */
  cancelStream(streamId: string): boolean {
    return this.streams.delete(streamId);
  }

  /**
   * Get active stream count.
   */
  get activeCount(): number {
    return this.streams.size;
  }

  /**
   * Remove streams older than STREAM_TIMEOUT_MS.
   */
  private cleanupStale(): void {
    const now = Date.now();
    for (const [id, stream] of this.streams) {
      if (now - stream.startedAt > this.STREAM_TIMEOUT_MS) {
        this.streams.delete(id);
        console.log(`[Stream] Cleaned up stale stream: ${id}`);
      }
    }
  }
}
