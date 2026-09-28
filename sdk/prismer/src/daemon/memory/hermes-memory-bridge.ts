// Hermes MEMORY.md file bridge — release201/26 §14.7 Phase A (#A3).
//
// M1 "file bridge": pure TS file I/O over hermes' builtin `MEMORY.md`. Per
// doc 26 §14.7, hermes' builtin memory is always-on (the whole file is injected
// into the system prompt) and char-limited (~2200). We (Prismer) write a
// RELEVANT recalled subset into a MANAGED section so hermes injects it natively,
// and we read the agent-curated content OUT to up-sync to our cache. We must
// NEVER clobber the agent's own curated content.
//
// === Hermes MEMORY.md format facts (confirmed from hermes-agent source) ===
// `tools/memory_tool.py`:
//   - Path convention (`_path_for`, L246-251):
//         mem_dir = get_memory_dir(); return mem_dir / "MEMORY.md"
//     i.e. the file lives at `<profile mem_dir>/MEMORY.md`. The caller resolves
//     this path (we take it as a parameter — no hermes-adapter import, keeping
//     this module decoupled).
//   - File is plain UTF-8 text (`_read_file` L495, `_write_file` L570).
//   - Char limit (`__init__` L125): `memory_char_limit: int = 2200`.
//   - Entry format (`ENTRY_DELIMITER = "\n§\n"`, L60): entries are joined by
//     a literal `\n§\n` separator; `_read_file` splits on that and strips each
//     entry, dropping empties. So an entry is just a text block; the `§` line
//     is the delimiter between entries.
//   - `_read_file` returns `[]` if the file is absent or blank.
//
// Our managed content is wrapped in HTML comment delimiters so it reads as a
// single coherent block to hermes (and survives its strip/split since the
// markers are plain text), while staying visually distinct from agent entries.
//
// Standalone module — NOT wired into any live path yet (flag-gated wiring is a
// later phase per §14.10). Mirrors the sync-fs style of the sibling modules in
// this directory (see `store.ts`).

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Opening delimiter of our managed (Prismer-owned) recall section. */
export const MANAGED_START = '<!-- prismer:recall:start -->';
/** Closing delimiter of our managed (Prismer-owned) recall section. */
export const MANAGED_END = '<!-- prismer:recall:end -->';

/**
 * Default char budget for the managed section body. Hermes' builtin limit is
 * ~2200 chars for the WHOLE file (doc 26 §14.3 / memory_tool.py L125). We cap
 * our managed body at ~1800 to leave headroom for the delimiters and for the
 * agent's own curated entries.
 */
export const DEFAULT_CHAR_BUDGET = 1800;

/** Marker appended when a body is truncated to fit the char budget. */
const TRUNCATION_MARKER = '\n…(truncated)';

export interface HermesMemory {
  /** Agent-curated content (everything OUTSIDE our managed section), verbatim. */
  curated: string;
  /** Body inside our managed section (between the delimiters), trimmed. */
  managed: string;
  /** The full file contents as read from disk ('' if absent). */
  raw: string;
}

/**
 * Locate the managed section in `raw`. Returns the character offsets of the
 * section (including delimiters) plus the inner body, or null if no
 * well-formed managed section is present.
 */
function findManagedSection(
  raw: string,
): { sectionStart: number; sectionEnd: number; body: string } | null {
  const startIdx = raw.indexOf(MANAGED_START);
  if (startIdx === -1) return null;
  const endIdx = raw.indexOf(MANAGED_END, startIdx + MANAGED_START.length);
  if (endIdx === -1) return null;

  const bodyStart = startIdx + MANAGED_START.length;
  const body = raw.slice(bodyStart, endIdx);
  const sectionEnd = endIdx + MANAGED_END.length;
  return { sectionStart: startIdx, sectionEnd, body };
}

/**
 * Strip our managed section out of `raw`, returning the agent-curated remainder
 * with surrounding whitespace collapsed so we don't accumulate blank lines on
 * repeated rewrites.
 */
function stripManagedSection(raw: string): string {
  const found = findManagedSection(raw);
  if (!found) return raw.trim();
  const before = raw.slice(0, found.sectionStart);
  const after = raw.slice(found.sectionEnd);
  // Join the two curated halves; trim to avoid leftover delimiter whitespace.
  return `${before.replace(/\s+$/, '')}\n${after.replace(/^\s+/, '')}`.trim();
}

/**
 * Read `MEMORY.md` and split it into our managed section vs the agent-curated
 * remainder. Returns empty strings (not an error) if the file is absent.
 */
export function readHermesMemory(memoryMdPath: string): HermesMemory {
  let raw = '';
  try {
    raw = fs.readFileSync(memoryMdPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { curated: '', managed: '', raw: '' };
    }
    throw err;
  }

  const found = findManagedSection(raw);
  const managed = found ? found.body.trim() : '';
  const curated = stripManagedSection(raw);
  return { curated, managed, raw };
}

/**
 * Return ONLY the agent-curated content (everything outside our managed
 * section), for up-syncing to our cache (§14.6 low-scope up-roll).
 */
export function extractCurated(memoryMdPath: string): string {
  return readHermesMemory(memoryMdPath).curated;
}

/**
 * Apply the char budget to a managed body, truncating with a clear marker if it
 * exceeds the budget. The truncation marker itself is counted so the final
 * string never exceeds `charBudget`.
 */
function applyCharBudget(body: string, charBudget: number): string {
  if (body.length <= charBudget) return body;
  const keep = Math.max(0, charBudget - TRUNCATION_MARKER.length);
  return body.slice(0, keep).replace(/\s+$/, '') + TRUNCATION_MARKER;
}

/**
 * Render the full file contents from curated + managed body. The managed
 * section is placed at the END so the agent's curated entries keep their
 * leading position (and stable offsets) in the file.
 */
function renderFile(curated: string, managedBody: string): string {
  const block = `${MANAGED_START}\n${managedBody}\n${MANAGED_END}`;
  const curatedTrimmed = curated.trim();
  const contents = curatedTrimmed ? `${curatedTrimmed}\n\n${block}` : block;
  // Trailing newline so the file is POSIX-clean and stable across rewrites.
  return `${contents}\n`;
}

/**
 * Replace ONLY the managed section of `MEMORY.md`, preserving all agent-curated
 * content verbatim. Inserts the section if absent. Creates the file and parent
 * directory if needed. Enforces a char budget (default {@link DEFAULT_CHAR_BUDGET})
 * by truncating `body` with a `…(truncated)` marker.
 *
 * Idempotent: writing the same body twice yields a byte-identical file.
 */
export function writeManagedSection(
  memoryMdPath: string,
  body: string,
  opts?: { charBudget?: number },
): void {
  const charBudget = opts?.charBudget ?? DEFAULT_CHAR_BUDGET;

  let raw = '';
  try {
    raw = fs.readFileSync(memoryMdPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    // File absent: curated is empty, we'll create it below.
  }

  const curated = stripManagedSection(raw);
  const managedBody = applyCharBudget(body.trim(), charBudget);
  const next = renderFile(curated, managedBody);

  fs.mkdirSync(path.dirname(memoryMdPath), { recursive: true });
  fs.writeFileSync(memoryMdPath, next, 'utf-8');
}
