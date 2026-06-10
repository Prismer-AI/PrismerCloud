// MUST sync with sdk/prismer-cloud/runtime/src/cli/ui.ts
//
// MIRROR of `sdk/prismer-cloud/runtime/src/cli/ui.ts`. The two CLIs ship
// independently and switch contexts constantly (`prismer` for daemon ops,
// `cloud` for agent/user ops); their TUI vocabulary — icons, colors,
// banner, table rendering, spinner, JSON-mode envelope, brand-voice
// guard — must look identical so users don't perceive them as separate
// tools.
//
// Why not share a package? Because the SDK and runtime publish to npm as
// separate top-level packages with independent release cadences; pulling
// one in as a dependency of the other would create a publish-order
// chicken-and-egg. The mirror banner pattern is the same one we use for
// `src/types/im-events.ts` ↔ `runtime/src/types/im-events.ts`.
//
// Differences from the runtime original (intentional):
//   * Asset lookup: SDK ships `icon` + `smallicon` at the package root
//     (not under `assets/`), so the candidate list checks both layouts.
//   * Banner subtitle defaults to "Cloud CLI" (vs runtime's "Runtime CLI")
//     — the helpers don't bake this in; callers pass the subtitle.
//   * Legacy callsites in this package still use `src/ui.ts` (picocolors
//     + @clack/prompts). That file remains as-is for backwards compat;
//     new CLI code should prefer this mirror.
//
// TODO(SA + SB): `src/commands/*.ts` currently emit raw `process.stdout.write`
// and "Error: ..." stderr lines. They should be migrated to use this UI
// surface (`getUI().ok`, `.fail`, `.table`, `.json`, etc.) so visual
// alignment reaches every subcommand, not just the top-level entry. That
// migration is content-rewriting and out of scope for the v2.0 GA visual
// alignment pass.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ============================================================
// Types
// ============================================================

export type OutputMode = 'pretty' | 'json' | 'quiet';

export interface UIOptions {
  mode?: OutputMode;
  color?: boolean;
  stream?: NodeJS.WritableStream;
  errStream?: NodeJS.WritableStream;
}

export interface TableRow {
  [column: string]: string;
}

export interface TableOptions {
  columns: string[];
  maxWidth?: number;
}

export interface LegacyTableOptions {
  columns: string[];
  rows: TableRow[];
  maxWidth?: number;
}

// ============================================================
// Brand voice guard
// ============================================================

const FORBIDDEN_SUBSTRINGS = ['Sorry', 'Unfortunately', 'Oops'];
const FORBIDDEN_WORDS = ['Please'];

export function assertBrandVoice(text: string, label = 'text'): void {
  if (!process.env['PRISMER_BRAND_VOICE_STRICT']) return;
  for (const sub of FORBIDDEN_SUBSTRINGS) {
    if (text.includes(sub)) {
      throw new Error(`[Brand Voice] Forbidden substring "${sub}" in CLI ${label}: ${text}`);
    }
  }
  for (const word of FORBIDDEN_WORDS) {
    const re = new RegExp(`\\b${word}\\b`);
    if (re.test(text)) {
      throw new Error(`[Brand Voice] Forbidden word "${word}" in CLI ${label}: ${text}`);
    }
  }
  const lines = text.split('\n');
  for (const line of lines) {
    const stripped = line.replace(/"[^"]*"/g, '').replace(/'[^']*'/g, '');
    if (stripped.trimEnd().endsWith('!')) {
      throw new Error(`[Brand Voice] Trailing "!" in CLI ${label}: ${line}`);
    }
  }
}

// ============================================================
// Spinner / banner constants
// ============================================================

const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const COMPACT_BANNER = ['◇ PRISMER', '  Cloud CLI'];

// ============================================================
// Icon asset resolution
// ============================================================

function thisDirname(): string {
  // The SDK CLI is built CJS-only (see tsup.config.ts in this package), so
  // __dirname is always defined at runtime. Keep an ESM-safe branch behind
  // a feature-detect for forward compatibility, but avoid `eval()` so
  // bundlers don't warn. The runtime mirror uses import.meta.url because
  // it builds ESM; this CJS-targeted mirror uses __dirname instead — same
  // resolved path, different toolchain assumption.
  if (typeof __dirname !== 'undefined') return __dirname;
  // ESM fallback (unused in current tsup config, kept for parity)
  try {
    // @ts-ignore — import.meta is only available in ESM contexts
    const metaUrl: string | undefined = typeof import.meta !== 'undefined' ? (import.meta as { url?: string }).url : undefined;
    if (metaUrl) return path.dirname(fileURLToPath(metaUrl));
  } catch {
    /* ignore */
  }
  return process.cwd();
}

function findIconPath(size: 'big' | 'small' = 'big'): string | null {
  const name = size === 'big' ? 'icon' : 'smallicon';
  const here = thisDirname();
  const candidates = [
    // npm-installed: node_modules/@prismer/sdk/dist/cli.js → ../icon (SDK ships at pkg root)
    path.resolve(here, '..', name),
    // alternate dist layout (sub-bundle): dist/bin/cli.js → ../../icon
    path.resolve(here, '..', '..', name),
    // source/typecheck: src/cli-ui.ts → ../icon
    path.resolve(here, '..', name),
    // dev mode: cwd happens to be sdk root
    path.resolve(process.cwd(), name),
    path.resolve(process.cwd(), 'sdk/prismer-cloud/typescript', name),
    // legacy assets/ layout (runtime parity, in case SDK ever adopts it)
    path.resolve(here, '..', 'assets', name),
    path.resolve(here, '..', '..', 'assets', name),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

// ============================================================
// UI class
// ============================================================

export class UI {
  readonly mode: OutputMode;
  readonly colorEnabled: boolean;
  private readonly stream: NodeJS.WritableStream;
  private readonly errStream: NodeJS.WritableStream;

  constructor(opts?: UIOptions) {
    this.mode = opts?.mode ?? 'pretty';
    this.stream = opts?.stream ?? process.stdout;
    this.errStream = opts?.errStream ?? process.stderr;

    if (opts?.color !== undefined) {
      this.colorEnabled = opts.color;
    } else {
      const isTTY = (this.stream as NodeJS.WriteStream).isTTY === true;
      const noColor = Boolean(process.env['NO_COLOR']);
      this.colorEnabled = isTTY && !noColor;
    }
  }

  // ---- Internal color helpers ----

  private ansi(open: number, close: number, text: string): string {
    if (!this.colorEnabled) return text;
    return `[${open}m${text}[${close}m`;
  }

  private green(t: string): string {
    return this.ansi(32, 39, t);
  }
  private red(t: string): string {
    return this.ansi(31, 39, t);
  }
  private yellow(t: string): string {
    return this.ansi(33, 39, t);
  }
  private cyan(t: string): string {
    return this.ansi(36, 39, t);
  }
  private dim(t: string): string {
    return this.ansi(2, 22, t);
  }
  private bold(t: string): string {
    return this.ansi(1, 22, t);
  }
  private gray(t: string): string {
    return this.ansi(90, 39, t);
  }
  private brandMark(): string {
    return this.cyan('◇');
  }

  private colorBrandLine(line: string): string {
    let out = '';
    for (const ch of line) {
      if (ch === '▒') {
        out += this.cyan(ch);
      } else if (ch === '▓') {
        out += this.dim(ch);
      } else {
        out += ch;
      }
    }
    return out;
  }

  // ---- Core write helpers ----

  write(text: string): void {
    this.stream.write(text);
  }

  writeErr(text: string): void {
    this.errStream.write(text);
  }

  // ---- Level 1: Header ----

  header(text: string): void {
    if (this.mode === 'json') return;
    const prefix = text.startsWith('Prismer') ? this.brandMark() + ' ' : '';
    this.write(prefix + this.bold(text) + '\n');
  }

  smallHeader(subtitle?: string): void {
    if (this.mode === 'json' || this.mode === 'quiet') return;
    const iconPath = findIconPath('small');
    if (iconPath !== null) {
      try {
        const raw = fs.readFileSync(iconPath, 'utf-8').replace(/\n+$/, '');
        for (const line of raw.split('\n')) {
          this.write(this.cyan(line) + '\n');
        }
      } catch {
        this.write(this.brandMark() + ' ' + this.bold('Prismer') + '\n');
      }
    } else {
      this.write(this.brandMark() + ' ' + this.bold('Prismer') + '\n');
    }
    if (subtitle !== undefined && subtitle.length > 0) {
      this.write(this.dim('  ' + subtitle) + '\n');
    }
    this.blank();
  }

  banner(subtitle?: string, opts?: { full?: boolean }): void {
    if (this.mode === 'json' || this.mode === 'quiet') return;

    const envColumns =
      process.env['COLUMNS'] !== undefined ? parseInt(process.env['COLUMNS'], 10) : NaN;
    const width =
      (this.stream as NodeJS.WriteStream).columns ??
      process.stdout.columns ??
      (Number.isFinite(envColumns) ? envColumns : 80);
    const iconPath = findIconPath('big');
    const shouldUseFull = opts?.full === true || width >= 120;

    if (shouldUseFull && iconPath !== null) {
      try {
        const raw = fs.readFileSync(iconPath, 'utf-8');
        const lines = raw.split('\n');
        for (const line of lines) {
          // Mirror leaves the canonical banner string in place; callers that
          // want to overwrite "Prismer Cloud SDK" → "Prismer Cloud CLI" or
          // similar can do it via subtitle. Keeping the icon body identical
          // is part of the alignment promise.
          const stripped = line.trimEnd();
          if (stripped.length === 0) {
            this.write('\n');
            continue;
          }
          const clipped =
            stripped.length >= width ? stripped.slice(0, Math.max(width - 1, 1)) : stripped;
          this.write(this.colorBrandLine(clipped) + '\n');
        }
      } catch {
        this.write(this.cyan(COMPACT_BANNER[0] ?? '◇ PRISMER') + '\n');
        this.write(this.dim(COMPACT_BANNER[1] ?? '  Cloud CLI') + '\n');
      }
    } else {
      this.write(this.cyan(COMPACT_BANNER[0] ?? '◇ PRISMER') + '\n');
      this.write(this.dim(COMPACT_BANNER[1] ?? '  Cloud CLI') + '\n');
    }

    if (subtitle !== undefined && subtitle.length > 0) {
      this.write(this.dim('  ' + subtitle) + '\n');
    }
    this.blank();
  }

  // ---- Level 2: Primary data ----

  blank(): void {
    if (this.mode === 'json') return;
    this.write('\n');
  }

  line(text: string): void {
    if (this.mode === 'json') return;
    this.write(text + '\n');
  }

  info(text: string): void {
    this.line(text);
  }

  // ---- Level 3: Secondary ----

  secondary(text: string, indent = 2): void {
    if (this.mode === 'json') return;
    this.write(' '.repeat(indent) + this.dim(text) + '\n');
  }

  // ---- Level 4: Action tips ----

  tip(text: string): void {
    if (this.mode === 'json') return;
    this.write(this.cyan('Tip:') + ' ' + text + '\n');
  }

  next(text: string): void {
    if (this.mode === 'json') return;
    this.write(this.cyan('Next:') + ' ' + text + '\n');
  }

  // ---- Level 5: Status indicators ----

  ok(text: string, detail?: string): void {
    if (this.mode === 'json') return;
    const suffix = detail ? '  ' + this.dim(detail) : '';
    this.write('  ' + this.green('✓') + ' ' + text + suffix + '\n');
  }

  success(text: string, detail?: string): void {
    this.ok(text, detail);
  }

  fail(text: string, detail?: string): void {
    if (this.mode === 'json') return;
    const suffix = detail ? '  ' + this.dim(detail) : '';
    this.write('  ' + this.red('✗') + ' ' + text + suffix + '\n');
  }

  online(text: string): void {
    if (this.mode === 'json') return;
    this.write('  ' + this.green('●') + ' ' + text + '\n');
  }

  offline(text: string): void {
    if (this.mode === 'json') return;
    this.write('  ' + this.gray('○') + ' ' + text + '\n');
  }

  notInstalled(text: string): void {
    if (this.mode === 'json') return;
    this.write('  ' + this.dim('·') + ' ' + this.dim(text) + '\n');
  }

  pending(text: string): void {
    if (this.mode === 'json') return;
    this.write('  ' + this.yellow('⟳') + ' ' + text + '\n');
  }

  warn(text: string, detail?: string): void {
    if (this.mode === 'json') return;
    const suffix = detail ? '  ' + this.dim(detail) : '';
    this.write('  ' + this.yellow('!') + ' ' + text + suffix + '\n');
  }

  // ---- Level 6: Error block ----

  error(what: string, cause?: string, fix?: string): void {
    if (this.mode === 'json') return;
    this.writeErr(this.red('✗') + ' ' + what + '\n');
    if (cause !== undefined) {
      this.writeErr('  ' + this.dim('Cause:') + ' ' + this.dim(cause) + '\n');
    }
    if (fix !== undefined) {
      this.writeErr('  ' + this.cyan('Fix:') + ' ' + fix + '\n');
    }
  }

  // ---- Tables ----

  table(rows: TableRow[], opts: TableOptions): void;
  table(opts: LegacyTableOptions): void;
  table(rowsOrOpts: TableRow[] | LegacyTableOptions, maybeOpts?: TableOptions): void {
    if (this.mode === 'json') return;
    const rows = Array.isArray(rowsOrOpts) ? rowsOrOpts : rowsOrOpts.rows;
    const opts = Array.isArray(rowsOrOpts)
      ? maybeOpts
      : { columns: rowsOrOpts.columns, maxWidth: rowsOrOpts.maxWidth };

    if (!opts) throw new Error('table() requires columns');

    const maxWidth = opts.maxWidth ?? (process.stdout.columns || 80);
    const cols = opts.columns;

    const widths: number[] = cols.map((col) => col.length);
    for (const row of rows) {
      cols.forEach((col, i) => {
        const val = row[col] ?? '';
        const w = widths[i] ?? 0;
        if (val.length > w) widths[i] = val.length;
      });
    }

    const totalWidth = widths.reduce((a, b) => a + b, 0) + (cols.length - 1) * 2 + 2;

    if (totalWidth > maxWidth) {
      // List mode
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!row) continue;
        for (const col of cols) {
          const val = row[col] ?? '';
          this.write('  ' + this.bold(col + ':') + ' ' + val + '\n');
        }
        if (i < rows.length - 1) this.write('\n');
      }
      return;
    }

    const header = cols.map((col, i) => col.toUpperCase().padEnd(widths[i] ?? col.length)).join('  ');
    this.write('  ' + this.dim(header) + '\n');

    for (const row of rows) {
      const line = cols.map((col, i) => (row[col] ?? '').padEnd(widths[i] ?? col.length)).join('  ');
      this.write('  ' + line + '\n');
    }
  }

  // ---- Spinner ----

  spinner(text: string): { update(t: string): void; stop(final?: string): void } {
    if (this.mode === 'quiet' || this.mode === 'json') {
      return {
        update(): void {
          /* no-op */
        },
        stop(): void {
          /* no-op */
        },
      };
    }

    const isTTY = (this.stream as NodeJS.WriteStream).isTTY === true;

    if (!isTTY || !this.colorEnabled) {
      this.write('  ' + this.yellow('⟳') + ' ' + text + '\n');
      return {
        update: (t: string) => {
          this.write('  ' + this.yellow('⟳') + ' ' + t + '\n');
        },
        stop: (final?: string) => {
          if (final) this.write('  ' + this.green('✓') + ' ' + final + '\n');
        },
      };
    }

    let current = text;
    let frameIdx = 0;
    let stopped = false;

    const write = this.write.bind(this);
    const colorFn = this.yellow.bind(this);
    const greenFn = this.green.bind(this);

    function renderFrame(): void {
      const frame = BRAILLE_FRAMES[frameIdx % BRAILLE_FRAMES.length] ?? '⠋';
      const line = '  ' + colorFn(frame) + ' ' + current;
      write('\r' + line);
      frameIdx++;
    }

    renderFrame();
    const timer = setInterval(renderFrame, 80);

    return {
      update(t: string): void {
        if (stopped) return;
        current = t;
      },
      stop(final?: string): void {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        write('\r\x1b[2K');
        if (final) write('  ' + greenFn('✓') + ' ' + final + '\n');
      },
    };
  }

  // ---- Progress bar ----

  progress(
    text: string,
    total: number,
  ): { update(current: number, detail?: string): void; stop(final?: string): void } {
    if (this.mode === 'quiet' || this.mode === 'json') {
      return {
        update(): void {
          /* no-op */
        },
        stop(): void {
          /* no-op */
        },
      };
    }

    const isTTY = (this.stream as NodeJS.WriteStream).isTTY === true;
    const start = Date.now();
    const write = this.write.bind(this);
    const colorFn = this.cyan.bind(this);
    const dimFn = this.dim.bind(this);
    const greenFn = this.green.bind(this);

    let last = 0;
    let lastDetail = '';
    let stopped = false;

    const render = (): void => {
      if (stopped) return;
      const frac = total > 0 ? Math.min(1, Math.max(0, last / total)) : 0;
      const pct = Math.floor(frac * 100);
      const width = 20;
      const filled = Math.floor(frac * width);
      const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
      const elapsed = (Date.now() - start) / 1000;
      const eta = frac > 0.01 ? Math.max(0, elapsed / frac - elapsed) : 0;
      const etaStr = frac >= 1 ? '' : ` · ${eta < 1 ? '<1s' : Math.round(eta) + 's'} left`;
      const detailStr = lastDetail ? ` · ${lastDetail}` : '';
      const line = `  ${text} [${colorFn(bar)}] ${String(pct).padStart(3)}%${detailStr}${dimFn(etaStr)}`;
      if (isTTY && this.colorEnabled) {
        write('\r\x1b[2K' + line);
      } else {
        write(line + '\n');
      }
    };

    render();

    return {
      update: (current: number, detail?: string): void => {
        if (stopped) return;
        last = current;
        if (detail !== undefined) lastDetail = detail;
        render();
      },
      stop: (final?: string): void => {
        if (stopped) return;
        stopped = true;
        if (isTTY && this.colorEnabled) write('\r\x1b[2K');
        if (final) write('  ' + greenFn('✓') + ' ' + final + '\n');
      },
    };
  }

  // ---- JSON output ----

  json(payload: unknown, opts?: { pretty?: boolean }): void {
    const indent = opts?.pretty ? 2 : undefined;
    this.write(JSON.stringify(payload, null, indent) + '\n');
  }

  result<T>(pretty: () => void, jsonPayload: T): void {
    if (this.mode === 'pretty') {
      pretty();
    } else {
      this.json(jsonPayload);
    }
  }
}

// ============================================================
// Singleton
// ============================================================

let _ui: UI | null = null;

export function getUI(): UI {
  if (!_ui) _ui = new UI();
  return _ui;
}

export function setUI(ui: UI): void {
  _ui = ui;
}

export function __resetUIForTests(): void {
  _ui = null;
}

// ============================================================
// applyCommonFlags — strips --json/--quiet/--no-color/--color from argv
// ============================================================

export function applyCommonFlags(argv: string[]): {
  mode: OutputMode;
  color: boolean;
  restArgv: string[];
} {
  let mode: OutputMode = 'pretty';
  const isTTY = process.stdout.isTTY === true;
  const noColorEnv = Boolean(process.env['NO_COLOR']);
  let color = isTTY && !noColorEnv;

  const rest: string[] = [];

  for (const arg of argv) {
    switch (arg) {
      case '--no-color':
        color = false;
        break;
      case '--color':
        color = true;
        break;
      case '--json':
      case '--pretty-json':
        mode = 'json';
        // Push --json back so commander parses it per-command too — every
        // subcommand declares `.option('--json', ...)`, so leaving it in argv
        // makes opts.json truthy in action handlers (used to gate JSON output).
        if (arg === '--json') rest.push(arg);
        break;
      case '--quiet':
        mode = 'quiet';
        break;
      default:
        rest.push(arg);
    }
  }

  return { mode, color, restArgv: rest };
}

// ============================================================
// Compatibility shims for the legacy `src/ui.ts` surface used by
// `src/cli.ts` and the un-migrated `src/commands/*.ts` files. These
// route through the singleton so the visual output of every existing
// callsite picks up the runtime-aligned style without a content
// rewrite. New code should call `getUI()` directly.
// ============================================================

/** Print the full branded banner. Mirrors runtime's `printBanner({ full: true })`. */
export function displayBanner(subtitle?: string): void {
  // Only show banner in TTY pretty mode; getUI() respects NO_COLOR + --quiet
  // + --json suppression internally.
  getUI().banner(subtitle ?? 'Cloud CLI v2.0.0', { full: true });
}

/** Print the compact small-icon banner used inside command output. */
export function displaySmallBanner(subtitle?: string): void {
  getUI().smallHeader(subtitle ?? 'Cloud CLI v2.0.0');
}

export function success(msg: string): void {
  getUI().ok(msg);
}

export function failure(msg: string): void {
  getUI().fail(msg);
}

export function warn(msg: string): void {
  getUI().warn(msg);
}

export function info(msg: string): void {
  getUI().info(msg);
}

export function dim(msg: string): void {
  getUI().secondary(msg);
}

/** Render an "Error: ..." stderr line. JSON mode emits a structured envelope instead. */
export function errorLine(msg: string): void {
  const ui = getUI();
  if (ui.mode === 'json') {
    ui.json({ ok: false, error: { code: 'cli_error', message: msg } }, { pretty: true });
    return;
  }
  ui.writeErr('Error: ' + msg + '\n');
}

/** Print key/value pairs with bold keys, dimmed in non-TTY. Two-space indent matches runtime. */
export function keyValue(pairs: Record<string, string>): void {
  const ui = getUI();
  if (ui.mode === 'json') {
    ui.json(pairs);
    return;
  }
  const keys = Object.keys(pairs);
  if (keys.length === 0) return;
  const maxKeyLen = keys.reduce((max, k) => Math.max(max, k.length), 0);
  for (const key of keys) {
    const label = key.padEnd(maxKeyLen);
    const value = pairs[key] ?? '';
    // We can't access ui.bold directly (private); render via line() + raw padding.
    // Runtime style: 2-space indent + bold label + 2-space gap + value.
    ui.line('  ' + label + '  ' + value);
  }
}

/**
 * Convenience table that accepts (headers, rows[][]) — the legacy ui.ts shape
 * used in cli.ts. Internally normalises to the runtime UI's row-object form.
 */
export function table(headers: string[], rows: string[][]): void {
  const objectRows: TableRow[] = rows.map((r) => {
    const obj: TableRow = {};
    headers.forEach((h, i) => {
      obj[h] = r[i] ?? '';
    });
    return obj;
  });
  getUI().table(objectRows, { columns: headers });
}

/**
 * Run an async op with a spinner. Mirrors the runtime's UI.spinner() shape.
 * Always resolves (or rejects) — never swallows errors.
 */
export async function withSpinner<T>(message: string, fn: () => Promise<T>): Promise<T> {
  const sp = getUI().spinner(message);
  try {
    const result = await fn();
    sp.stop(message);
    return result;
  } catch (err) {
    sp.stop();
    throw err;
  }
}
