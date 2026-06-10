// CLI UI primitives — ported from pre-refactor `runtime/src/cli/ui.ts`.
// Provides a 6-level output hierarchy (header / banner / primary / secondary /
// tip / status indicators / error block), 3 modes (pretty / quiet / json),
// table / spinner / progress / json helpers, and brand-voice guard.
//
// MUST sync with sdk/prismer-cloud/typescript/src/cli-ui.ts
//
// This file is the canonical TUI style surface. The SDK CLI (@prismer/sdk,
// bin `cloud`) maintains a mirror at `src/cli-ui.ts` so users switching
// between `prismer ...` (daemon ops) and `cloud ...` (agent/user ops) see
// the same icons, colors, banner, table layout, spinner, and brand voice.
// Any change here must be ported to the SDK mirror in the same commit.

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
const COMPACT_BANNER = ['◇ PRISMER', '  Runtime CLI'];

// ============================================================
// Icon asset resolution
// ============================================================

function thisDirname(): string {
  // ESM-safe: derive __dirname from import.meta.url. For tsup CJS emits the
  // built file shadows this with a synthesized __dirname, which still resolves.
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}

function findIconPath(size: 'big' | 'small' = 'big'): string | null {
  const name = size === 'big' ? 'icon' : 'smallicon';
  const here = thisDirname();
  const candidates = [
    // npm-installed: node_modules/@prismer/runtime/dist/cli.js → ../assets
    path.resolve(here, '../assets', name),
    // alternate dist layout (sub-bundle): dist/bin/cli.js → ../../assets
    path.resolve(here, '../../assets', name),
    // source/typecheck: src/cli/ui.ts → ../../assets
    path.resolve(here, '../../assets', name),
    // dev mode: cwd happens to be runtime root
    path.resolve(process.cwd(), 'assets', name),
    path.resolve(process.cwd(), 'sdk/prismer-cloud/runtime/assets', name),
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
          const brandedLine = line.replace('Prismer Cloud SDK', 'Prismer Runtime CLI');
          const stripped = brandedLine.trimEnd();
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
        this.write(this.dim(COMPACT_BANNER[1] ?? '  Runtime CLI') + '\n');
      }
    } else {
      this.write(this.cyan(COMPACT_BANNER[0] ?? '◇ PRISMER') + '\n');
      this.write(this.dim(COMPACT_BANNER[1] ?? '  Runtime CLI') + '\n');
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
