// T12 — CLI UI primitives per §15 cli-design spec

import * as fs from 'node:fs';
import * as path from 'node:path';

// picocolors is used in bin/prismer.ts; imported here for consistency
// but we apply ANSI codes directly to honour the per-instance colorEnabled
// flag rather than relying on picocolors' global TTY/NO_COLOR detection.
// (The import keeps the dependency resolved for downstream bundlers.)
import _pc from 'picocolors';
void _pc; // intentionally unused — we manage ANSI inline via this.ansi()

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
// Brand voice guard — re-export from shared module so SDK-side callers
// can import it without dragging in the full UI class.
// ============================================================

export { assertBrandVoice } from '../shared/brand-voice.js';

// ============================================================
// Spinner frames
// ============================================================

const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const COMPACT_BANNER = [
  '◇ PRISMER',
  '  Runtime CLI',
];

function findIconPath(size: 'big' | 'small' = 'big'): string | null {
  const name = size === 'big' ? 'icon' : 'smallicon';
  const candidates = [
    path.resolve(__dirname, `../${name}`), // dist/bin/prismer.js -> dist/<name>
    path.resolve(__dirname, `../../${name}`), // dist/index.js -> dist/<name>
    path.resolve(__dirname, `../../../${name}`), // src/cli/ui.ts -> sdk/prismer-cloud/<name>
    path.resolve(process.cwd(), `../${name}`),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// Back-compat alias — kept so existing callers / tests don't break.
function findBrandIconPath(): string | null {
  return findIconPath('big');
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
  // We apply ANSI codes directly rather than through picocolors' global
  // TTY/NO_COLOR detection, so that injected streams (e.g. test collectors)
  // are honoured correctly.

  private ansi(open: number, close: number, text: string): string {
    if (!this.colorEnabled) return text;
    return `\u001b[${open}m${text}\u001b[${close}m`;
  }

  private green(t: string): string { return this.ansi(32, 39, t); }
  private red(t: string): string { return this.ansi(31, 39, t); }
  private yellow(t: string): string { return this.ansi(33, 39, t); }
  private cyan(t: string): string { return this.ansi(36, 39, t); }
  private dim(t: string): string { return this.ansi(2, 22, t); }
  private bold(t: string): string { return this.ansi(1, 22, t); }
  private gray(t: string): string { return this.ansi(90, 39, t); }
  private brandMark(): string { return this.cyan('◇'); }

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

  // Small-icon header — used by day-to-day commands (`prismer agent list`,
  // `prismer status`, etc). Renders the 5-line product icon in dim cyan then a
  // subtitle line. Falls back silently to a single `◇ Prismer | <subtitle>`
  // line when the asset cannot be resolved so non-dev installs still read.
  smallHeader(subtitle?: string): void {
    // `--quiet` and `--json` both suppress decorative preamble. Per-command
    // result output still prints in quiet mode; only banners/headers go away.
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
    // Decorative intro banner — suppress in both json and quiet modes so
    // `prismer --quiet status` doesn't print "◇ PRISMER / Runtime CLI" before
    // the actual output.
    if (this.mode === 'json' || this.mode === 'quiet') return;

    const envColumns = process.env['COLUMNS'] !== undefined
      ? parseInt(process.env['COLUMNS'], 10)
      : NaN;
    const width = (this.stream as NodeJS.WriteStream).columns ??
      process.stdout.columns ??
      (Number.isFinite(envColumns) ? envColumns : 80);
    const iconPath = findIconPath('big');
    const shouldUseFull = opts?.full === true || width >= 120;

    if (shouldUseFull && iconPath !== null) {
      const raw = fs.readFileSync(iconPath, 'utf-8');
      const lines = raw.split('\n');
      for (const line of lines) {
        const brandedLine = line.replace('Prismer Cloud SDK', 'Prismer Runtime CLI');
        const stripped = brandedLine.trimEnd();
        if (stripped.length === 0) {
          this.write('\n');
          continue;
        }
        const clipped = stripped.length >= width ? stripped.slice(0, Math.max(width - 1, 1)) : stripped;
        this.write(this.colorBrandLine(clipped) + '\n');
      }
    } else {
      this.write(this.cyan(COMPACT_BANNER[0]) + '\n');
      this.write(this.dim(COMPACT_BANNER[1]) + '\n');
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

  // JSON mode callers MUST emit error output via ui.json({ ok: false, ... });
  // this method is pretty-mode only. Keeping it silent in JSON mode prevents
  // stderr pollution for machine callers who chose --json for parseable stdout.
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
      : {
          columns: rowsOrOpts.columns,
          maxWidth: rowsOrOpts.maxWidth,
        };

    if (!opts) {
      throw new Error('table() requires columns');
    }

    const maxWidth = opts.maxWidth ?? (process.stdout.columns || 80);
    const cols = opts.columns;

    // Compute column widths
    const widths: number[] = cols.map((col) => col.length);
    for (const row of rows) {
      cols.forEach((col, i) => {
        const val = row[col] ?? '';
        if (val.length > widths[i]) widths[i] = val.length;
      });
    }

    const totalWidth = widths.reduce((a, b) => a + b, 0) + (cols.length - 1) * 2 + 2;

    if (totalWidth > maxWidth) {
      // List mode
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        for (const col of cols) {
          const val = row[col] ?? '';
          this.write('  ' + this.bold(col + ':') + ' ' + val + '\n');
        }
        if (i < rows.length - 1) this.write('\n');
      }
      return;
    }

    // Table mode — header row
    const header = cols.map((col, i) => col.toUpperCase().padEnd(widths[i])).join('  ');
    this.write('  ' + this.dim(header) + '\n');

    // Data rows
    for (const row of rows) {
      const line = cols.map((col, i) => (row[col] ?? '').padEnd(widths[i])).join('  ');
      this.write('  ' + line + '\n');
    }
  }

  // ---- Spinner ----

  spinner(text: string): { update(t: string): void; stop(final?: string): void } {
    if (this.mode === 'quiet' || this.mode === 'json') {
      return {
        update(): void { /* no-op */ },
        stop(): void { /* no-op */ },
      };
    }

    const isTTY = (this.stream as NodeJS.WriteStream).isTTY === true;

    if (!isTTY || !this.colorEnabled) {
      // Non-TTY: single start line, single stop line
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

    // Animated braille spinner
    let current = text;
    let frameIdx = 0;
    let stopped = false;

    const write = this.write.bind(this);
    const colorFn = this.yellow.bind(this);
    const greenFn = this.green.bind(this);

    function renderFrame(): void {
      const frame = BRAILLE_FRAMES[frameIdx % BRAILLE_FRAMES.length];
      const line = '  ' + colorFn(frame) + ' ' + current;
      // Move cursor to start of line and overwrite
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
        // Clear current line
        write('\r\x1b[2K');
        if (final) write('  ' + greenFn('✓') + ' ' + final + '\n');
      },
    };
  }

  // ---- Progress bar (§15.4 long-running ops) ----
  //
  // Usage:
  //   const bar = ui.progress('Downloading pack', total);
  //   bar.update(1.3 * 1024 * 1024, '1.3MB/2.1MB');
  //   bar.stop('Downloaded and verified');
  //
  // Non-TTY / quiet / json / no-color → degrades to a single-line summary and
  // a final line on stop().  Uses `▓`/`░` (aligns with banner characters).
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

  // ---- Result convenience ----

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
  if (!_ui) {
    _ui = new UI();
  }
  return _ui;
}

export function setUI(ui: UI): void {
  _ui = ui;
}

export function __resetUIForTests(): void {
  _ui = null;
}

// ============================================================
// applyCommonFlags
// ============================================================

export function applyCommonFlags(argv: string[]): {
  mode: OutputMode;
  color: boolean;
  restArgv: string[];
} {
  let mode: OutputMode = 'pretty';
  // Default color based on TTY + NO_COLOR — but flags can override
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
        mode = 'json';
        break;
      case '--pretty-json':
        // Kept as a flag — callers use it to set pretty:true on json() calls
        // We keep mode as 'json' but signal via the returned mode only; callers
        // can detect by checking whether 'pretty-json' was stripped.
        // For simplicity, treat it as json mode (caller sets pretty on construction).
        mode = 'json';
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
