// G-19 — prismer setup browser OAuth loopback flow
//
// Exercises the runtime-side copy of sdk/prismer-cloud/typescript Path 4.
// Tests drive the exported helper directly via real HTTP requests against
// the ephemeral loopback server so the state/key handshake is covered
// end-to-end. We stub only the `openBrowser` step so no tabs pop up.

import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import { UI } from '../../src/cli/ui.js';
import { runBrowserOAuth } from '../../src/cli/browser-oauth.js';

// ============================================================
// Helpers
// ============================================================

function makeSilentUI(): UI {
  const sink = { write(): boolean { return true; } } as NodeJS.WritableStream;
  return new UI({ mode: 'quiet', color: false, stream: sink, errStream: sink });
}

/**
 * Fire a GET at a callback URL and resolve when the server responds. We do
 * not care about the response body here — the runBrowserOAuth promise is
 * what we actually await in the test.
 */
function hitCallback(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      res.resume();
      res.on('end', () => resolve());
    });
    req.on('error', reject);
  });
}

/**
 * Intercept the generated setup URL so the test can extract the state token
 * and loopback callback URL that the real browser would hit. Returns a
 * function that simulates the browser callback with whatever query we want.
 */
function captureSetupUrl(): { opener: (url: string) => void; wait: () => Promise<{ callback: string; state: string }> } {
  let resolveWait!: (v: { callback: string; state: string }) => void;
  const p = new Promise<{ callback: string; state: string }>((r) => { resolveWait = r; });
  const opener = (url: string): void => {
    const parsed = new URL(url);
    const callback = parsed.searchParams.get('callback') ?? '';
    const state = parsed.searchParams.get('state') ?? '';
    resolveWait({ callback, state });
  };
  return { opener, wait: () => p };
}

// ============================================================
// Tests
// ============================================================

describe('runBrowserOAuth', () => {
  it('T1: happy path — matching state + valid key → resolves with the key', async () => {
    const { opener, wait } = captureSetupUrl();
    const ui = makeSilentUI();

    const flow = runBrowserOAuth({ baseUrl: 'https://example.test', ui, openBrowser: opener, timeoutMs: 5000 });
    const { callback, state } = await wait();
    const key = 'sk-prismer-live-' + 'a'.repeat(32);
    await hitCallback(`${callback}?state=${state}&key=${encodeURIComponent(key)}`);

    await expect(flow).resolves.toBe(key);
  });

  it('T2: state mismatch → rejects, no key returned', async () => {
    const { opener, wait } = captureSetupUrl();
    const ui = makeSilentUI();

    const flow = runBrowserOAuth({ baseUrl: 'https://example.test', ui, openBrowser: opener, timeoutMs: 5000 });
    // Attach the rejection handler BEFORE we fire the callback so there is
    // no window where the rejection is visible as "unhandled".
    const assertion = expect(flow).rejects.toThrow(/state mismatch|missing parameters/i);
    const { callback } = await wait();
    const key = 'sk-prismer-live-' + 'a'.repeat(32);
    await hitCallback(`${callback}?state=wrong-state&key=${encodeURIComponent(key)}`);
    await assertion;
  });

  it('T3: invalid key format (not sk-prismer-*) → rejects', async () => {
    const { opener, wait } = captureSetupUrl();
    const ui = makeSilentUI();

    const flow = runBrowserOAuth({ baseUrl: 'https://example.test', ui, openBrowser: opener, timeoutMs: 5000 });
    const assertion = expect(flow).rejects.toThrow(/unexpected key format/i);
    const { callback, state } = await wait();
    await hitCallback(`${callback}?state=${state}&key=bad-key`);
    await assertion;
  });

  it('T4: timeout → rejects with the timeout message', async () => {
    // No opener callback needed — we do NOT hit the callback at all so the
    // timeout fires. Use a tiny timeoutMs so the test completes quickly.
    const ui = makeSilentUI();
    const noop = (): void => { /* never resolves capture */ };

    const flow = runBrowserOAuth({ baseUrl: 'https://example.test', ui, openBrowser: noop, timeoutMs: 250 });
    const assertion = expect(flow).rejects.toThrow(/timed out/i);
    await assertion;
  });

  it('T5: missing key parameter → rejects (treated as state/param failure)', async () => {
    const { opener, wait } = captureSetupUrl();
    const ui = makeSilentUI();

    const flow = runBrowserOAuth({ baseUrl: 'https://example.test', ui, openBrowser: opener, timeoutMs: 5000 });
    const assertion = expect(flow).rejects.toThrow(/state mismatch|missing parameters/i);
    const { callback, state } = await wait();
    // Hit /callback with state but NO key.
    await hitCallback(`${callback}?state=${state}`);
    await assertion;
  });
});
