/**
 * Prismer CLI UI utilities — lightweight visual polish layer.
 *
 * Uses picocolors (2KB, zero deps) for colors and @clack/prompts for
 * interactive spinners/selects/confirms.  Degrades gracefully when
 * stdout is not a TTY (CI, piped output).
 */

import * as pc from 'picocolors';
import * as clack from '@clack/prompts';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// TTY detection — all color / decoration is skipped when piped
// ---------------------------------------------------------------------------

const isTTY = !!process.stdout.isTTY || !!process.env.FORCE_COLOR;

// ---------------------------------------------------------------------------
// 1. Banner — read ../icon, colorize block characters
// ---------------------------------------------------------------------------

export function displayBanner(): void {
  if (!isTTY) return; // skip banner in non-interactive mode

  let iconPath: string;
  try {
    // Works from both src/ (dev) and dist/ (built)
    iconPath = path.resolve(__dirname, '..', 'icon');
    if (!fs.existsSync(iconPath)) {
      iconPath = path.resolve(__dirname, '..', '..', 'icon');
    }
    if (!fs.existsSync(iconPath)) return; // silently skip if icon not found

    const raw = fs.readFileSync(iconPath, 'utf-8');
    const lines = raw.split('\n');

    // Terminal width — truncate lines that would wrap
    const termWidth = process.stdout.columns || 80;

    // Colorize: ▒ (icon part) → cyan, ▓ (text "PRISMER") → bright white,
    //           █ → bright white (sometimes used as accent)
    const colorized = lines.map((line) => {
      // Trim trailing whitespace to prevent wrapping
      const trimmed = line.trimEnd();
      if (!trimmed) return '';
      let result = '';
      let visibleLen = 0;
      for (const ch of trimmed) {
        if (visibleLen >= termWidth - 1) break; // prevent wrap
        if (ch === '\u2592') {
          // ▒ medium shade — icon
          result += pc.cyan(ch);
        } else if (ch === '\u2593') {
          // ▓ dark shade — text
          result += pc.white(ch);
        } else if (ch === '\u2588') {
          // █ full block — accent
          result += pc.white(ch);
        } else {
          result += ch;
        }
        visibleLen++;
      }
      return result;
    });

    // Trim trailing empty lines
    while (colorized.length > 0 && colorized[colorized.length - 1].trim() === '') {
      colorized.pop();
    }

    console.log(colorized.join('\n'));
    console.log();
  } catch {
    // Silently skip — banner is cosmetic
  }
}

// ---------------------------------------------------------------------------
// 2. Colored status messages
// ---------------------------------------------------------------------------

const SYMBOLS = {
  success: isTTY ? '\u2713' : '[ok]',   // ✓
  error: isTTY ? '\u2717' : '[error]',   // ✗
  warn: isTTY ? '\u26A0' : '[warn]',     // ⚠
  info: isTTY ? '\u2139' : '[info]',     // ℹ
};

export function success(msg: string): void {
  console.log(pc.green(`${SYMBOLS.success} ${msg}`));
}

export function error(msg: string): void {
  console.error(pc.red(`${SYMBOLS.error} ${msg}`));
}

export function warn(msg: string): void {
  console.warn(pc.yellow(`${SYMBOLS.warn} ${msg}`));
}

export function info(msg: string): void {
  console.log(pc.blue(`${SYMBOLS.info} ${msg}`));
}

export function dim(msg: string): void {
  console.log(pc.dim(msg));
}

// ---------------------------------------------------------------------------
// 3. Spinner for async operations
// ---------------------------------------------------------------------------

export async function withSpinner<T>(message: string, fn: () => Promise<T>): Promise<T> {
  if (!isTTY) {
    // No spinner in non-TTY — just run silently
    return fn();
  }

  const s = clack.spinner();
  s.start(message);
  try {
    const result = await fn();
    s.stop(pc.green(`${SYMBOLS.success} ${message}`));
    return result;
  } catch (err) {
    s.stop(pc.red(`${SYMBOLS.error} ${message}`));
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 4. Table display — simple column-aligned, no heavy deps
// ---------------------------------------------------------------------------

export function table(headers: string[], rows: string[][]): void {
  if (headers.length === 0) return;

  // Calculate column widths
  const widths = headers.map((h, i) => {
    const dataMax = rows.reduce((max, row) => Math.max(max, (row[i] || '').length), 0);
    return Math.max(h.length, dataMax);
  });

  const PAD = 2; // space between columns

  // Header
  const headerLine = headers.map((h, i) => h.padEnd(widths[i] + PAD)).join('');
  if (isTTY) {
    console.log(pc.bold(headerLine));
    // Separator
    const separator = widths.map((w) => '\u2500'.repeat(w)).join('  ');
    console.log(pc.dim(separator));
  } else {
    console.log(headerLine);
    const separator = widths.map((w) => '-'.repeat(w)).join('  ');
    console.log(separator);
  }

  // Rows
  for (const row of rows) {
    const line = headers.map((_, i) => (row[i] || '').padEnd(widths[i] + PAD)).join('');
    console.log(line);
  }
}

// ---------------------------------------------------------------------------
// 5. Key-value display (for status / config output)
// ---------------------------------------------------------------------------

export function keyValue(pairs: Record<string, string>): void {
  const keys = Object.keys(pairs);
  if (keys.length === 0) return;

  const maxKeyLen = keys.reduce((max, k) => Math.max(max, k.length), 0);

  for (const key of keys) {
    const label = isTTY ? pc.bold(key.padEnd(maxKeyLen)) : key.padEnd(maxKeyLen);
    const value = pairs[key];
    console.log(`  ${label}  ${value}`);
  }
}

// ---------------------------------------------------------------------------
// 6. QR code rendering — unicode block characters
// ---------------------------------------------------------------------------

/**
 * Render a QR code in the terminal using unicode block characters.
 * Uses the `qrcode` npm package for encoding.  Falls back to a
 * plain-text URL display if the package is not available.
 */
export function renderQR(data: string): void {
  try {
    // qrcode is an optional dependency — dynamic require so the CLI
    // still works if it's not installed.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const QRCode = require('qrcode');

    // Generate the QR code as a UTF-8 string with small module size.
    // toString is synchronous when using the callback form but we
    // use the sync variant.
    QRCode.toString(data, {
      type: 'utf8',
      errorCorrectionLevel: 'M',
      margin: 1,
      small: true,
    }, (err: Error | null, qr: string) => {
      if (err || !qr) {
        warn('Could not generate QR code.');
        info(`Data: ${data}`);
        return;
      }

      if (isTTY) {
        console.log();
        // Colorize: dark modules in white-on-black to make them scannable
        const lines = qr.split('\n');
        for (const line of lines) {
          console.log(`  ${line}`);
        }
        console.log();
      } else {
        console.log(qr);
      }
    });
  } catch {
    // qrcode package not installed — fall back to plain display
    if (isTTY) {
      console.log();
      info('QR rendering requires the "qrcode" package.');
      dim('  npm install qrcode');
      console.log();
    }
    info(`Data: ${data}`);
  }
}

// ---------------------------------------------------------------------------
// 7. Agent install wizard prompts
// ---------------------------------------------------------------------------

export async function selectAgent(
  available: Array<{ name: string; description: string; installed: boolean }>
): Promise<string[]> {
  if (!isTTY) {
    // Non-interactive: return all non-installed agents
    return available.filter((a) => !a.installed).map((a) => a.name);
  }

  const result = await clack.multiselect({
    message: 'Select agents to install',
    options: available.map((a) => ({
      value: a.name,
      label: a.installed
        ? pc.dim(`${a.name} (installed)`)
        : pc.bold(a.name),
      hint: a.description,
    })),
    required: false,
  });

  if (clack.isCancel(result)) {
    clack.cancel('Agent selection cancelled.');
    process.exit(0);
  }

  return result as string[];
}

// ---------------------------------------------------------------------------
// 8. Confirmation prompt
// ---------------------------------------------------------------------------

export async function confirm(message: string): Promise<boolean> {
  if (!isTTY) {
    // Non-interactive: default to true (scripts expect forward progress)
    return true;
  }

  const result = await clack.confirm({ message });

  if (clack.isCancel(result)) {
    clack.cancel('Cancelled.');
    process.exit(0);
  }

  return result as boolean;
}
