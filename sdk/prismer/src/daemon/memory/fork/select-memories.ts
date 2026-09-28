// Memory selector prompt + response parser — M-B (doc 25 §3 支柱 2).
//
// Ports CC's `SELECT_MEMORIES_SYSTEM_PROMPT` and the JSON schema from
// `luminclaw/ref/CC-Source/src/memdir/findRelevantMemories.ts:18-24,
// 109-119`. The prompt is intentionally Be-Selective-First — empty
// returns are normal and preferred over noise.
//
// The host calls `buildSelectorPrompt(query, manifest, recentTools?)`
// to format the messages, then runs its own LLM (cache-safe) and feeds
// the raw response back through `parseSelectorOutput(rawText, manifest)`
// to get a list of filenames. The daemon's finalize RPC then maps those
// filenames to full pages.

import type { ManifestEntry, SelectedFilenames } from './types.js';

/**
 * Selector system prompt. Verbatim port of CC's
 * `SELECT_MEMORIES_SYSTEM_PROMPT` (memdir/findRelevantMemories.ts:18).
 * The "be selective" framing is the load-bearing line — small models
 * default to "include everything" without an explicit nudge.
 */
export const SELECT_MEMORIES_SYSTEM_PROMPT = [
  'You are selecting memories that will be useful to an AI agent as it processes a user query.',
  "You will be given the user's query and a list of available memory files with their filenames and descriptions.",
  '',
  'Return a list of filenames for the memories that will clearly be useful (up to 5).',
  'Only include memories that you are CERTAIN will be helpful based on their name and description.',
  '- If you are unsure if a memory will be useful, do NOT include it. Be selective and discerning.',
  '- If no memories in the list would clearly be useful, return an empty list.',
  '- If a list of recently-used tools is provided, do NOT select usage reference or API documentation',
  '  for those tools (the agent is already exercising them). DO still select memories containing',
  '  warnings, gotchas, or known issues — active use is exactly when those matter.',
  '',
  'Respond with a single JSON object: { "selected_memories": ["path1", "path2", ...] }',
  'Do NOT wrap the JSON in code fences. Do NOT include any commentary.',
].join('\n');

/** Cap on selector input — keeps a multi-thousand-page workspace tractable. */
export const MAX_MANIFEST_ENTRIES = 200;

/** Cap on the number of paths the selector may pick. Mirrors CC's "up to 5". */
export const MAX_SELECTED = 5;

/**
 * Format a manifest into the YAML-ish block the selector reads. Matches
 * CC's `formatMemoryManifest` shape (one entry per line: `path —
 * description`). Truncates description to 200 chars and skips entries
 * past `MAX_MANIFEST_ENTRIES`.
 */
export function formatManifest(entries: ReadonlyArray<ManifestEntry>): string {
  const cap = entries.slice(0, MAX_MANIFEST_ENTRIES);
  return cap
    .map((e) => {
      const desc = e.description ? truncate(e.description, 200) : '(no description)';
      const title = e.title ? ` [${truncate(e.title, 80)}]` : '';
      return `- ${e.path}${title} — ${desc}`;
    })
    .join('\n');
}

/**
 * Build the user-message body for a selector call. Includes the query,
 * the manifest, and (when relevant) the list of tools the agent is
 * actively using so the selector can downweight their reference docs.
 */
export function buildSelectorUserMessage(
  query: string,
  manifest: ReadonlyArray<ManifestEntry>,
  recentTools: ReadonlyArray<string> = [],
): string {
  const formattedManifest = formatManifest(manifest);
  const toolsSection =
    recentTools.length > 0
      ? `\n\nRecently used tools: ${recentTools.join(', ')}`
      : '';
  return `Query: ${query}\n\nAvailable memories:\n${formattedManifest}${toolsSection}`;
}

/**
 * Parse the LLM's JSON response. Tolerates code-fence wrappers and
 * leading/trailing whitespace. Validates that every returned filename
 * appears in the manifest (selectors hallucinate paths sometimes —
 * never trust them blindly).
 *
 * On any parse failure, returns `{ selected: [], rawText }` — never
 * throws. The fork-recall path treats "selector misbehaved" as
 * equivalent to "selector chose nothing"; degrades gracefully instead
 * of breaking the agent turn.
 */
export function parseSelectorOutput(
  rawText: string,
  manifest: ReadonlyArray<ManifestEntry>,
): SelectedFilenames {
  const trimmed = rawText.trim();
  if (!trimmed) return { selected: [], rawText };

  const validPaths = new Set(manifest.map((e) => e.path));

  // Strip optional ```json … ``` fences before parsing.
  const stripped = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return { selected: [], rawText };
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as { selected_memories?: unknown }).selected_memories)
  ) {
    return { selected: [], rawText };
  }

  const filenames = (parsed as { selected_memories: unknown[] }).selected_memories;
  const valid: string[] = [];
  for (const f of filenames) {
    if (typeof f !== 'string') continue;
    if (!validPaths.has(f)) continue;
    if (valid.includes(f)) continue;
    valid.push(f);
    if (valid.length >= MAX_SELECTED) break;
  }
  return { selected: valid, rawText };
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
