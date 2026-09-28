// release203/15 §WS-G — Hermes (persistence) tool-call → structured ToolCallDetail.
//
// Problem (code + live verified): Hermes records tool steps WITHOUT a structured
// `detail` — `sessions-sse.ts` called `recordToolCall(name, args, callId)` /
// `recordToolResult(callId, output)` with no `{detail}` opt. The recorder then
// only wrote `{toolName, inputSummary, altitude:'milestone'}`, so `execute_code`
// rendered as a bare row ("import subprocess (+3 行)" = inputSummary) with no
// expand, while coding agents (code-agent-driver.ts) thread `{detail}` and render
// rich + expandable. Live DB: ALL hermes tool rows had 0 `$.detail`.
//
// This mapper is the missing producer half. The entire downstream
// (recorder.capDetail → cloud task-step-recorder → unified WS → agent-message
// decode → ActivityDetail RichDetail rendering + canExpand=detailHasBody) already
// works for coding details; emitting the same `ToolCallDetail` union here aligns
// the two agent classes with no cloud/schema/render change.
//
// ⚠️ Output-forwarding caveat (the `tool.completed` branch, sessions-sse.ts:766-851
// as of 2026-09-22): the Hermes gateway's sessions-chat-stream callback
// `_tool_progress` (gateway/platforms/api_server.py:3166 @v2026.9.14 — anchors
// here are version-pinned; the earlier ":1585-1590" was a drifted ref) enqueues
// only `{message_id, tool_name, preview, args}` and DROPS **kwargs — so on THIS
// endpoint `result`/`output` are absent and the recorder's synthetic
// `outputSummary` marker is the only trace of a completion. (A path that DOES
// forward the output exists — the OpenAI/responses bridge wires
// `_on_tool_complete`, which enqueues `result: function_result`
// (gateway/platforms/api_server_openai_routes.py:878-881 @v2026.9.14, read back
// at :256) — which is why sessions-sse still reads every candidate
// field before falling back.) Where the output is absent we leave the
// output-shaped field UNDEFINED — `output` (shell) / `content` (read, search) /
// `result` (fetch) — never a fake: the command/url/path + expand +
// exitCode-when-present still render, and the cloud renderer marks the gap on
// the step row as `[output not forwarded]` (spec 11 T4-4,
// `ActivityDetail.outputNotForwarded()`) instead of leaving a blank output slot.
// Real-output forwarding is a separate Hermes-gateway gap tracked in doc 15 WS-G.

import type { ToolCallDetail } from '../../coding/shared/agent-sdk-types.js';

/** Coerce an arbitrary arg field to a non-empty string, else undefined. */
function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v.length > 0 ? v : undefined;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

/** Coerce to a finite number, else undefined. */
function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/** First non-empty string among the named arg keys. */
function pick(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const s = str(args[k]);
    if (s !== undefined) return s;
  }
  return undefined;
}

/**
 * Normalize the Hermes tool `args` payload into a plain record. Hermes builds
 * pass args as a JSON object, but some paths forward a JSON-string or a bare
 * scalar (`preview`). Best-effort parse; non-objects collapse to `{}`.
 */
function asArgs(args: unknown): Record<string, unknown> {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* not JSON — fall through */
    }
  }
  return {};
}

// ─── memory203/18 R5.2 — CLI extraction from python execute_code wrappers ───
//
// Hermes agents run CLI commands by wrapping them in python
// (`execute_code` → `subprocess.run(['prismer','memory','search',…])`), so the
// event stream showed "import subprocess (+9 行)" instead of the command. This
// heuristic reconstructs the inner CLI so `detail.command` carries
// `prismer memory search …`; the full python source is preserved additively on
// `detail.script` (commandSource:'argv' flags the extraction for the renderer
// summary). No match → caller keeps the current whole-source behaviour.

/** Max length of the reconstructed CLI (multiple calls joined with ' && '). */
const MAX_EXTRACTED_CLI_CHARS = 400;

/** Shell-quote a single argv token (only when it needs it). */
function quoteArg(arg: string): string {
  if (arg.length === 0) return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Read one python string literal starting at src[i] (quote char). Handles escapes; no triple-quote / f-string interpolation. */
function readPyString(src: string, i: number): { value: string; end: number } | null {
  const quote = src[i];
  if (quote !== "'" && quote !== '"') return null;
  let out = '';
  let j = i + 1;
  while (j < src.length) {
    const ch = src[j]!;
    if (ch === '\\') {
      const nxt = src[j + 1];
      out += nxt === 'n' ? '\n' : nxt === 't' ? '\t' : (nxt ?? '');
      j += 2;
      continue;
    }
    if (ch === quote) return { value: out, end: j + 1 };
    out += ch;
    j += 1;
  }
  return null; // unterminated
}

/** Skip whitespace + optional string prefix letters (f/r/b) before a literal. */
function skipToLiteral(src: string, i: number): number {
  let j = i;
  while (j < src.length && /\s/.test(src[j]!)) j += 1;
  while (j < src.length && /[frbuFRBU]/.test(src[j]!) && (src[j + 1] === "'" || src[j + 1] === '"')) j += 1;
  return j;
}

/** Parse a python list literal of string literals starting at `[`. Non-literal element → null (dynamic argv, don't guess). */
function readPyStringList(src: string, i: number): { items: string[]; end: number } | null {
  if (src[i] !== '[') return null;
  const items: string[] = [];
  let j = i + 1;
  for (;;) {
    j = skipToLiteral(src, j);
    if (j >= src.length) return null;
    if (src[j] === ']') return { items, end: j + 1 };
    const lit = readPyString(src, j);
    if (!lit) return null;
    items.push(lit.value);
    j = skipToLiteral(src, lit.end);
    if (src[j] === ',') {
      j += 1;
      continue;
    }
    if (src[j] === ']') return { items, end: j + 1 };
    return null; // concatenation / comment / dynamic expr — bail
  }
}

const PY_EXEC_CALL_RE = /\b(?:subprocess\s*\.\s*(?:run|check_output|check_call|call|Popen)|os\s*\.\s*system)\s*\(/g;

/**
 * Extract the CLI command(s) from python source. Matches, in order of
 * appearance:
 *   - `subprocess.run(['prismer','memory','search',…], …)` (also check_output /
 *     check_call / call / Popen) with a **string-literal** list → argv joined
 *     with shell quoting;
 *   - the same calls with a string first arg (shell=True style) → verbatim;
 *   - `os.system("…")` → verbatim;
 *   - Jupyter-style `!cmd` lines.
 * Multiple hits join with ' && ' (capped). Dynamic argv (variables, f-string
 * interpolation elements) is NOT guessed → null → caller keeps raw python.
 */
export function extractCliFromPython(code: string): string | null {
  if (!code || !/subprocess|os\s*\.\s*system|^\s*!/m.test(code)) return null;
  const commands: string[] = [];

  PY_EXEC_CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PY_EXEC_CALL_RE.exec(code)) !== null) {
    const argStart = skipToLiteral(code, m.index + m[0].length);
    if (code[argStart] === '[') {
      const list = readPyStringList(code, argStart);
      if (list && list.items.length > 0) commands.push(list.items.map(quoteArg).join(' '));
      continue;
    }
    const lit = readPyString(code, argStart);
    if (lit && lit.value.trim()) commands.push(lit.value.trim());
  }

  // Jupyter-style bang lines (`!prismer memory search …`).
  for (const line of code.split('\n')) {
    const bang = line.match(/^\s*!\s?(.+)$/);
    if (bang && bang[1]!.trim()) commands.push(bang[1]!.trim());
  }

  if (commands.length === 0) return null;
  const joined = commands.join(' && ');
  return joined.length > MAX_EXTRACTED_CLI_CHARS ? `${joined.slice(0, MAX_EXTRACTED_CLI_CHARS)}…` : joined;
}

const SHELL_TOOLS = new Set([
  'execute_code',
  'terminal',
  'bash',
  'shell',
  'run_command',
  'run_shell',
  'exec',
]);
const READ_TOOLS = new Set(['read_file', 'cat', 'view', 'read', 'open_file']);
const WRITE_TOOLS = new Set(['write_file', 'create_file', 'write']);
const EDIT_TOOLS = new Set(['edit_file', 'apply_patch', 'edit', 'patch', 'str_replace']);
// `workspace_web_search` is our provider-shell web tool (release203
// web-capability fix). It cannot be NAMED `web_search` — Hermes reserves core
// tool names against provider shadowing — but it maps onto the same
// first-class `web_search` search row here.
const SEARCH_TOOLS = new Set(['search', 'grep', 'web_search', 'workspace_web_search', 'glob', 'find']);
// `web_load` is our provider-shell workspace web tool (release203 web-capability
// fix — loads pages via the cloud Load API); render it as a first-class fetch
// row, same as its sibling `web_search` renders as a search row above.
const FETCH_TOOLS = new Set(['fetch', 'browser', 'open_url', 'browse', 'http_get', 'visit', 'web_load']);

/**
 * Map a Hermes tool call into a structured `ToolCallDetail`.
 *
 * - `output`/`exitCode` are only known at `tool.completed`; at `tool.started`
 *   pass them undefined (the running detail carries just command/path/query).
 * - Unknown tool names return `undefined` → the recorder falls back to the
 *   current inputSummary behaviour (no regression for unmapped tools).
 */
export function mapHermesToolDetail(
  toolName: string,
  rawArgs: unknown,
  output?: string,
  exitCode?: number,
): ToolCallDetail | undefined {
  const name = toolName.toLowerCase();
  const args = asArgs(rawArgs);

  if (SHELL_TOOLS.has(name)) {
    // execute_code et al. carry the program in `code`; CLI-style tools in
    // `command`. The live inputSummary "import subprocess" came from `args.code`.
    const command = pick(args, 'code', 'command', 'cmd', 'script', 'input') ?? '';
    // memory203/18 R5.2 — execute_code wrapping a CLI: surface the inner
    // command as `command` (timeline shows `$ prismer memory search …`), keep
    // the full python additively on `script`. No extraction → unchanged.
    if (name === 'execute_code') {
      const cli = extractCliFromPython(command);
      if (cli) {
        return {
          type: 'shell',
          command: cli,
          script: command,
          commandSource: 'argv',
          ...(output !== undefined ? { output } : {}),
          ...(exitCode !== undefined ? { exitCode } : {}),
        };
      }
    }
    return {
      type: 'shell',
      command,
      ...(output !== undefined ? { output } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
    };
  }

  if (READ_TOOLS.has(name)) {
    const filePath = pick(args, 'file_path', 'path', 'filename', 'file');
    if (!filePath) return undefined;
    return {
      type: 'read',
      filePath,
      ...(output !== undefined ? { content: output } : {}),
    };
  }

  if (WRITE_TOOLS.has(name)) {
    const filePath = pick(args, 'file_path', 'path', 'filename', 'file');
    if (!filePath) return undefined;
    return {
      type: 'write',
      filePath,
      ...(pick(args, 'content', 'contents', 'text') !== undefined
        ? { content: pick(args, 'content', 'contents', 'text') }
        : {}),
    };
  }

  if (EDIT_TOOLS.has(name)) {
    const filePath = pick(args, 'file_path', 'path', 'filename', 'file');
    if (!filePath) return undefined;
    const unifiedDiff = pick(args, 'patch', 'diff', 'unified_diff');
    return {
      type: 'edit',
      filePath,
      ...(unifiedDiff !== undefined ? { unifiedDiff } : {}),
      ...(pick(args, 'old_string', 'old_str') !== undefined
        ? { oldString: pick(args, 'old_string', 'old_str') }
        : {}),
      ...(pick(args, 'new_string', 'new_str') !== undefined
        ? { newString: pick(args, 'new_string', 'new_str') }
        : {}),
    };
  }

  if (SEARCH_TOOLS.has(name)) {
    const query = pick(args, 'query', 'pattern', 'q', 'search');
    if (!query) return undefined;
    const toolName: 'search' | 'grep' | 'glob' | 'web_search' =
      name === 'web_search' || name === 'workspace_web_search'
        ? 'web_search'
        : name === 'grep'
          ? 'grep'
          : name === 'glob' || name === 'find'
            ? 'glob'
            : 'search';
    return {
      type: 'search',
      query,
      toolName,
      ...(output !== undefined ? { content: output } : {}),
    };
  }

  if (FETCH_TOOLS.has(name)) {
    const url = pick(args, 'url', 'uri', 'link', 'address');
    if (!url) return undefined;
    return {
      type: 'fetch',
      url,
      ...(pick(args, 'prompt', 'goal') !== undefined ? { prompt: pick(args, 'prompt', 'goal') } : {}),
      ...(output !== undefined ? { result: output } : {}),
      ...(exitCode !== undefined ? { code: exitCode } : {}),
    };
  }

  return undefined;
}
