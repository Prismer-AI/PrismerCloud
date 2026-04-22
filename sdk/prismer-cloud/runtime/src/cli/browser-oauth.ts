// ============================================================
// Browser OAuth loopback helpers for `prismer setup`
// ============================================================
//
// Port of sdk/prismer-cloud/typescript/src/cli.ts:295-358 Path 4 flow with
// three runtime-side differences:
//
//   1. Resolves with the api key instead of calling process.exit, so the
//      caller can continue the setup pipeline (persist + daemon start).
//   2. Accepts an injected opener for tests (no real tabs popped open).
//   3. Accepts a configurable timeout (default 5 min; tests use ~250ms).
//
// Extracted into its own module because the CLI bin file calls
// program.parseAsync(argv) at module load — importing helpers from there
// in vitest would trigger commander against the test runner's argv.

import * as http from 'node:http';
import * as crypto from 'node:crypto';
import type { UI } from './ui.js';

// ============================================================
// openBrowser
// ============================================================

/**
 * Launch the user's default browser pointing at `url`. Uses the require-based
 * child_process access pattern that the rest of the runtime already uses (see
 * agents/hooks.ts) so we do not add a new npm dep.
 *
 * Silent failure fallback: callers always print the URL to stdout before
 * invoking this helper, so a failed spawn still lets the user finish sign-in
 * manually by copy-pasting the URL into any browser.
 */
export function openBrowser(url: string): void {
  const { execFile: launch } = require('node:child_process') as typeof import('node:child_process');
  const onErr = (err: Error | null): void => { if (err) console.warn('Could not open browser. Please open the URL above manually.'); };
  if (process.platform === 'darwin') {
    launch('open', [url], onErr);
  } else if (process.platform === 'win32') {
    launch('cmd.exe', ['/c', 'start', '', url], onErr);
  } else {
    launch('xdg-open', [url], onErr);
  }
}

// ============================================================
// runBrowserOAuth
// ============================================================

export interface BrowserOAuthOptions {
  /** Base URL of the Prismer Cloud site (e.g. https://prismer.cloud). */
  baseUrl: string;
  /** UI for progress messages. */
  ui: UI;
  /** Overridable for tests — skip actually launching the browser. */
  openBrowser?: (url: string) => void;
  /** Total timeout before we give up. Default 5 min; tests pass a shorter value. */
  timeoutMs?: number;
}

export async function runBrowserOAuth(opts: BrowserOAuthOptions): Promise<string> {
  const { baseUrl, ui } = opts;
  const doOpenBrowser = opts.openBrowser ?? openBrowser;
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;

  const state = crypto.randomBytes(16).toString('hex');

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | null = null;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      try { server.close(); } catch { /* best-effort */ }
      if (timeoutHandle) clearTimeout(timeoutHandle);
      fn();
    };

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');

      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const key = url.searchParams.get('key');
      const returnedState = url.searchParams.get('state');

      res.writeHead(200, { 'Content-Type': 'text/html' });

      if (!key || !returnedState || returnedState !== state) {
        res.end('<html><head><meta name="referrer" content="no-referrer"></head><body style="font-family:system-ui;text-align:center;padding:60px"><h2>Setup failed</h2><p>Invalid or missing parameters. Please try again.</p></body></html>');
        settle(() => reject(new Error('OAuth callback state mismatch or missing parameters')));
        return;
      }

      if (!key.startsWith('sk-prismer-')) {
        res.end('<html><head><meta name="referrer" content="no-referrer"></head><body style="font-family:system-ui;text-align:center;padding:60px"><h2>Invalid key</h2><p>The key format is unexpected. Please try again.</p></body></html>');
        settle(() => reject(new Error('OAuth callback returned an unexpected key format')));
        return;
      }

      res.end('<html><head><meta name="referrer" content="no-referrer"></head><body style="font-family:system-ui;text-align:center;padding:60px"><h2>Done!</h2><p>API key received. You can close this tab.</p></body></html>');
      settle(() => resolve(key));
    });

    server.on('error', (err) => { settle(() => reject(err)); });

    timeoutHandle = setTimeout(() => {
      settle(() => reject(new Error(`Timed out waiting for authentication (${Math.round(timeoutMs / 1000)}s)`)));
    }, timeoutMs);

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      const callbackUrl = `http://127.0.0.1:${port}/callback`;
      const setupUrl = `${baseUrl}/setup?callback=${encodeURIComponent(callbackUrl)}&state=${state}&utm_source=cli&utm_medium=auto`;

      ui.info('Opening browser to sign in...');
      ui.blank();
      try {
        doOpenBrowser(setupUrl);
      } catch {
        // non-fatal; the URL is already printed below for manual fallback.
      }
      ui.info('Waiting for authentication...');
      ui.secondary('(If the browser did not open, visit this URL manually:)');
      ui.secondary(setupUrl);
      ui.blank();
    });
  });
}
