// memory211/01 §6.11 D11-4 (W7 item 4) — per-workspace tool-sequence ring.
//
// The §6.9-1 breakthrough claim — 渐进披露 (progressive disclosure) plus the
// direct-recall shortcut — was, until W7, unobservable on the behaviour side:
// grep found zero toolSequence/behaviourTrace references in the daemon memory
// domain, so "the agent walks INDEX → hub → leaf" was a design story, not a
// measurement. This module is the recording half (the GQ `behavior` category
// and `turn.*` metrics are the consumers).
//
// PRIVACY BOUNDARY (hard, spec §6.11 item 4): an entry records the VERB, the
// PAGE PATH, the DURATION and the TIMESTAMP — and nothing else except the two
// behavioural flags a metric cannot be computed without (`navigation`,
// `queries`). The QUERY TEXT never enters this ring. Anyone adding a field
// here must extend `ALLOWED_ENTRY_KEYS`, which the test asserts as a closed
// set — a new field cannot silently start recording content.
//
// Retention: an in-process ring per workspace, hard-capped at
// {@link TOOL_SEQUENCE_RING_LIMIT} entries (oldest dropped). Daemon-lifetime
// memory only — not persisted, not flushed to cloud: the turn.* metrics and a
// live GQ behaviour run read it in the same process; a daemon restart
// legitimately starts a new observation window.

/** The memory verbs that are recorded. One entry per RPC call. */
export type MemoryToolVerb = 'search' | 'load' | 'browse' | 'write';

export interface ToolSequenceEntry {
  verb: MemoryToolVerb;
  /** Page path addressed (load/browse/write). A search addresses no page ⇒ ''. */
  path: string;
  durationMs: number;
  /** ISO timestamp of the call. */
  at: string;
  /** search only: 1 when the miss-lane `navigation` payload was returned. */
  navigation?: 0 | 1;
  /** search only: how many queries the call carried (a count, never content). */
  queries?: number;
}

/** Closed set of fields an entry may carry — the privacy boundary, enforced. */
export const ALLOWED_ENTRY_KEYS: readonly (keyof ToolSequenceEntry)[] = [
  'verb',
  'path',
  'durationMs',
  'at',
  'navigation',
  'queries',
];

export const TOOL_SEQUENCE_RING_LIMIT = 200;

const rings = new Map<string, ToolSequenceEntry[]>();

/**
 * Record one memory tool call. Best-effort by construction: a throwing caller
 * (or a workspace that was never opened) must never break the recall it
 * observes.
 */
export function recordToolSequence(workspaceId: string, entry: ToolSequenceEntry): void {
  try {
    const ring = rings.get(workspaceId) ?? [];
    const sanitised = {
      verb: entry.verb,
      path: entry.path,
      durationMs: entry.durationMs,
      at: entry.at,
      ...(entry.navigation !== undefined ? { navigation: entry.navigation } : {}),
      ...(entry.queries !== undefined ? { queries: entry.queries } : {}),
    } satisfies ToolSequenceEntry;
    ring.push(sanitised);
    if (ring.length > TOOL_SEQUENCE_RING_LIMIT) ring.splice(0, ring.length - TOOL_SEQUENCE_RING_LIMIT);
    rings.set(workspaceId, ring);
  } catch {
    /* observability path is best-effort; never bubble into the RPC handler. */
  }
}

/** A copy of the ring (oldest first). Absent workspace ⇒ []. */
export function getToolSequence(workspaceId: string): ToolSequenceEntry[] {
  return [...(rings.get(workspaceId) ?? [])];
}

/** The ring entries recorded at or after `sinceMs` (epoch ms). */
export function getToolSequenceSince(workspaceId: string, sinceMs: number): ToolSequenceEntry[] {
  return getToolSequence(workspaceId).filter((e) => Date.parse(e.at) >= sinceMs);
}

/** Test seam: drop one workspace's ring (or every ring when no id is passed). */
export function resetToolSequenceRing(workspaceId?: string): void {
  if (workspaceId === undefined) rings.clear();
  else rings.delete(workspaceId);
}

export interface ToolTurnSummary {
  /** 1 when this turn consumed navigation at all (see {@link summarizeToolTurn}). */
  navigationUsed: 0 | 1;
  /** Direct reads this turn: loads with NO browse before them. */
  shortcutsTaken: number;
}

/**
 * Summarise one turn's memory behaviour from its ring slice.
 *
 *   navigationUsed = 1 — the turn contains a browse, OR a load that follows a
 *     search which returned the miss-lane navigation payload (the agent walked
 *     from a structural start point into a page). A later SEARCH does not
 *     count as consuming navigation: search → search → search is the 乱枪
 *     (spray-and-pray) shape the §6.11 behaviour question exists to catch, and
 *     it must read as navigation NOT used.
 *   shortcutsTaken — the direct-recall shortcut: loads issued with no browse
 *     before them in the turn. A browse→load walk is progressive disclosure
 *     (0 shortcuts); a straight `memory_load` of a known path is 1.
 *
 * An empty slice (the turn made no memory call) returns null — the turn metric
 * emits no row, exactly like the token metrics that only exist when usage was
 * reported.
 */
export function summarizeToolTurn(entries: ToolSequenceEntry[]): ToolTurnSummary | null {
  if (entries.length === 0) return null;

  const firstMissLaneSearch = entries.findIndex((e) => e.verb === 'search' && e.navigation === 1);
  const hasBrowse = entries.some((e) => e.verb === 'browse');
  const loadAfterMissLaneSearch =
    firstMissLaneSearch >= 0 && entries.some((e, i) => e.verb === 'load' && i > firstMissLaneSearch);
  const navigationUsed: 0 | 1 = hasBrowse || loadAfterMissLaneSearch ? 1 : 0;

  let shortcutsTaken = 0;
  let browsed = false;
  for (const entry of entries) {
    if (entry.verb === 'browse') browsed = true;
    else if (entry.verb === 'load' && !browsed) shortcutsTaken += 1;
  }

  return { navigationUsed, shortcutsTaken };
}

/**
 * The turn window for one dispatch: the ring slice since `sinceMs` for a
 * workspace, summarised. null when the turn made no memory call (no rows).
 */
export function summarizeToolTurnFor(
  workspaceId: string | null | undefined,
  sinceMs: number,
): ToolTurnSummary | null {
  if (!workspaceId) return null;
  return summarizeToolTurn(getToolSequenceSince(workspaceId, sinceMs));
}

/**
 * memory211/03 §7.2 B4 (B-3 follow-up, 2026-09-06) — R5 hybrid-first-round
 * analysis. The ANALYSER BODY LIVES HERE (daemon side, same file domain as the
 * input ring + {@link summarizeToolTurn}) because the ring is daemon-local;
 * the cloud registry (`src/im/services/metric-registry.ts` `summarizeR5Turn`)
 * stays the CONTRACT AUTHORITY / reference oracle — this mirror must not drift,
 * and `test/memory-tool-sequence.test.ts` enforces parity against it. The
 * daemon package cannot import the cloud module (standalone runtime), so
 * {@link R5_ROUND_GAP_MS} is re-declared VERBATIM and test-asserted equal.
 *
 * Round grouping — the one thing the ring does not record is an explicit round
 * boundary. A round is a batch of tool calls the model issues together; the
 * ring only carries per-call timestamps, so consecutive calls within
 * {@link R5_ROUND_GAP_MS} are the same round. Deliberate (same precision note
 * as the cloud side): the first-round question (hybrid? direct-read?) is about
 * "did the turn START with the one-round mix", not reconstructing agent step
 * boundaries.
 *
 * null-for-empty (review Minor 1): a turn with NO memory call returns null —
 * the emitter then writes no row, exactly like {@link summarizeToolTurn}. A
 * {0,0,0} row would be counted by `turn.count` and dilute the avg denominator
 * of every consumer (first-round hybrid rate / direct-read ratio / rounds-per-
 * turn). The cloud pure function returns zeros on an empty slice only because
 * it is always called on non-empty turn slices (documented there); the daemon
 * posture is null-for-empty.
 */
export const R5_ROUND_GAP_MS = 2_000;

export interface R5TurnSummary {
  /** 1 when the first tool round is the R5 hybrid: batch search (>=2 queries) AND browse, together. */
  firstRoundHybrid: 0 | 1;
  /** 1 when the first tool round is a direct-recall shortcut: a load with no preceding browse. */
  firstRoundDirectRead: 0 | 1;
  /** Tool rounds observed in this slice (a round = the batch issued within {@link R5_ROUND_GAP_MS}). */
  toolRounds: number;
}

/**
 * Summarise one turn's R5 first-round behaviour from its ring slice. Mirrors
 * the cloud contract `summarizeR5Turn` (metric-registry.ts) — same round
 * grouping, same hybrid / direct-read rules — except the empty slice: null
 * here, {0,0,0} there. Input ring entries are already oldest-first as
 * recorded; a call starts a new round when it is the first entry or its
 * timestamp is > {@link R5_ROUND_GAP_MS} after the previous one (strictly
 * beyond: exactly the gap stays the same round).
 */
export function summarizeR5Turn(entries: ToolSequenceEntry[]): R5TurnSummary | null {
  if (entries.length === 0) return null;

  const rounds: ToolSequenceEntry[][] = [];
  let current: ToolSequenceEntry[] = [];
  let previousAt = 0;
  for (const entry of entries) {
    const at = Date.parse(entry.at);
    if (current.length === 0 || (previousAt > 0 && at - previousAt > R5_ROUND_GAP_MS)) {
      current = [];
      rounds.push(current);
    }
    current.push(entry);
    previousAt = at;
  }

  const firstRound = rounds[0] ?? [];
  const firstRoundHybrid: 0 | 1 =
    firstRound.some((c) => c.verb === 'search' && (c.queries ?? 0) >= 2) && firstRound.some((c) => c.verb === 'browse')
      ? 1
      : 0;

  // Direct-read: the first round's first load comes before any browse (in the
  // round order preserved above). browse→load in the same round is progressive
  // disclosure and counts 0 — same rule as turn.shortcuts_taken, scoped to the
  // FIRST round.
  let firstRoundDirectRead: 0 | 1 = 0;
  for (const call of firstRound) {
    if (call.verb === 'browse') break;
    if (call.verb === 'load') {
      firstRoundDirectRead = 1;
      break;
    }
  }

  return { firstRoundHybrid, firstRoundDirectRead, toolRounds: rounds.length };
}

/**
 * The R5 summary for one dispatch's turn window (ring slice since `sinceMs`).
 * null when the turn made no memory call (no rows emitted).
 */
export function summarizeR5TurnFor(
  workspaceId: string | null | undefined,
  sinceMs: number,
): R5TurnSummary | null {
  if (!workspaceId) return null;
  return summarizeR5Turn(getToolSequenceSince(workspaceId, sinceMs));
}
