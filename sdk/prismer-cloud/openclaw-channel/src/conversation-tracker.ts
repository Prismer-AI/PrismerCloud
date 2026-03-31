/**
 * Per-conversation state tracker for OpenClaw Prismer channel.
 *
 * Tracks:
 * - Signal occurrences per conversation (for stuck detection)
 * - Pending gene suggestion (for auto-feedback)
 * - Message count (for periodic memory writes)
 * - Error signal count (for memory write triggers)
 *
 * This is the OpenClaw equivalent of Claude Code Plugin's session journal +
 * pending-suggestion.json, adapted for the message-based architecture.
 */

/** Pending gene suggestion awaiting feedback from the next message. */
export interface PendingGeneSuggestion {
  geneId: string;
  geneTitle: string;
  signals: string[];
  suggestedAt: number;
}

/** Per-conversation state. */
export interface ConversationState {
  /** Signal type -> count within this conversation */
  signalCounts: Map<string, number>;
  /** Total messages received in this conversation */
  messageCount: number;
  /** Total error signals detected across all messages */
  errorSignalCount: number;
  /** Last few message summaries for memory context (ring buffer, max 20) */
  messageSummaries: string[];
  /** Pending gene suggestion awaiting outcome feedback */
  pendingGene: PendingGeneSuggestion | null;
  /** Whether startup context has been injected for this conversation */
  startupContextInjected: boolean;
  /** Timestamp of last memory write */
  lastMemoryWriteAt: number;
  /** Conversation creation timestamp */
  createdAt: number;
}

/** TTL for pending gene feedback (3 minutes) */
const PENDING_GENE_TTL_MS = 3 * 60 * 1000;

/** Stuck detection threshold — same signal type N+ times triggers analyze */
const STUCK_THRESHOLD = 2;

/** Memory write interval (every N messages) */
const MEMORY_WRITE_INTERVAL = 10;

/** Error count threshold for memory write */
const ERROR_COUNT_MEMORY_THRESHOLD = 5;

/** Max conversations to track (LRU eviction) */
const MAX_CONVERSATIONS = 200;

/** Max message summaries per conversation */
const MAX_SUMMARIES = 20;

/**
 * In-memory Map of conversationId -> ConversationState.
 * Uses LRU eviction when MAX_CONVERSATIONS is exceeded.
 */
const conversations = new Map<string, ConversationState>();

/** Access order for LRU eviction */
const accessOrder: string[] = [];

function touchAccess(conversationId: string): void {
  const idx = accessOrder.indexOf(conversationId);
  if (idx >= 0) accessOrder.splice(idx, 1);
  accessOrder.push(conversationId);

  // Evict oldest if over limit
  while (accessOrder.length > MAX_CONVERSATIONS) {
    const oldest = accessOrder.shift();
    if (oldest) conversations.delete(oldest);
  }
}

/** Get or create conversation state. */
export function getConversation(conversationId: string): ConversationState {
  let state = conversations.get(conversationId);
  if (!state) {
    state = {
      signalCounts: new Map(),
      messageCount: 0,
      errorSignalCount: 0,
      messageSummaries: [],
      pendingGene: null,
      startupContextInjected: false,
      lastMemoryWriteAt: 0,
      createdAt: Date.now(),
    };
    conversations.set(conversationId, state);
  }
  touchAccess(conversationId);
  return state;
}

/** Check if this is the first message in a conversation (for startup context injection). */
export function isFirstMessage(conversationId: string): boolean {
  const state = conversations.get(conversationId);
  return !state || state.messageCount === 0;
}

/** Record a message and its detected signals. Returns the updated state. */
export function recordMessage(
  conversationId: string,
  content: string,
  signals: string[],
): ConversationState {
  const state = getConversation(conversationId);
  state.messageCount++;

  // Track signal counts
  for (const sig of signals) {
    state.signalCounts.set(sig, (state.signalCounts.get(sig) || 0) + 1);
    state.errorSignalCount++;
  }

  // Add message summary (truncated)
  const summary = content.slice(0, 200);
  state.messageSummaries.push(summary);
  if (state.messageSummaries.length > MAX_SUMMARIES) {
    state.messageSummaries.shift();
  }

  return state;
}

/** Record a message without error signals (just bump count + summary). */
export function recordCleanMessage(
  conversationId: string,
  content: string,
): ConversationState {
  const state = getConversation(conversationId);
  state.messageCount++;

  const summary = content.slice(0, 200);
  state.messageSummaries.push(summary);
  if (state.messageSummaries.length > MAX_SUMMARIES) {
    state.messageSummaries.shift();
  }

  return state;
}

/**
 * Check if any signal has reached the stuck threshold.
 * Returns the signal types that are "stuck" (appeared >= STUCK_THRESHOLD times).
 */
export function getStuckSignals(conversationId: string): string[] {
  const state = conversations.get(conversationId);
  if (!state) return [];

  const stuck: string[] = [];
  for (const [type, count] of state.signalCounts) {
    if (count >= STUCK_THRESHOLD) {
      stuck.push(type);
    }
  }
  return stuck;
}

/** Set a pending gene suggestion for auto-feedback. */
export function setPendingGene(
  conversationId: string,
  gene: PendingGeneSuggestion,
): void {
  const state = getConversation(conversationId);
  state.pendingGene = gene;
}

/**
 * Consume the pending gene suggestion if it exists and hasn't expired.
 * Returns the pending gene and clears it from state.
 */
export function consumePendingGene(
  conversationId: string,
): PendingGeneSuggestion | null {
  const state = conversations.get(conversationId);
  if (!state?.pendingGene) return null;

  const pending = state.pendingGene;
  state.pendingGene = null;

  // Check TTL
  if (Date.now() - pending.suggestedAt > PENDING_GENE_TTL_MS) {
    return null; // Expired
  }

  return pending;
}

/** Check if memory write should be triggered. */
export function shouldWriteMemory(conversationId: string): boolean {
  const state = conversations.get(conversationId);
  if (!state) return false;

  // Trigger on message count interval
  if (state.messageCount > 0 && state.messageCount % MEMORY_WRITE_INTERVAL === 0) {
    return true;
  }

  // Trigger on error count threshold (and not written recently for this reason)
  if (
    state.errorSignalCount >= ERROR_COUNT_MEMORY_THRESHOLD &&
    Date.now() - state.lastMemoryWriteAt > 60_000 // At least 1 minute since last write
  ) {
    return true;
  }

  return false;
}

/** Mark memory as written for this conversation. */
export function markMemoryWritten(conversationId: string): void {
  const state = conversations.get(conversationId);
  if (state) {
    state.lastMemoryWriteAt = Date.now();
  }
}

/** Mark startup context as injected. */
export function markStartupInjected(conversationId: string): void {
  const state = getConversation(conversationId);
  state.startupContextInjected = true;
}

/** Build a conversation summary for memory writes. */
export function buildConversationSummary(conversationId: string): string {
  const state = conversations.get(conversationId);
  if (!state) return '';

  const lines: string[] = [
    `## Conversation Summary`,
    `Messages: ${state.messageCount}, Errors: ${state.errorSignalCount}`,
    `Duration: ${Math.round((Date.now() - state.createdAt) / 1000)}s`,
  ];

  // Signal breakdown
  if (state.signalCounts.size > 0) {
    lines.push('', '### Error Patterns');
    for (const [type, count] of state.signalCounts) {
      lines.push(`- ${type}: ${count}x`);
    }
  }

  // Recent context
  if (state.messageSummaries.length > 0) {
    lines.push('', '### Recent Context');
    const recent = state.messageSummaries.slice(-5);
    for (const summary of recent) {
      lines.push(`- ${summary.slice(0, 100)}${summary.length > 100 ? '...' : ''}`);
    }
  }

  return lines.join('\n');
}
