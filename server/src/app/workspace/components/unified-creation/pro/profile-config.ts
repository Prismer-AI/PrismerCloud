/**
 * §30 B3.5 — Adapter config builder for ProTileProfile (and any future
 * standalone profile editor). Extracted so the panel file stays under
 * the 250-line budget.
 *
 * Mirrors `buildLongRunningProfileConfig` from NewAgentDialog but supports
 * the full adapter set the standalone profile panel exposes (hermes /
 * openclaw / codex / claude-code).
 */

import { NEWAPI_DEFAULT_MODEL } from '@/lib/llm/provider-sources';
import type { ProxyProvider } from '../../proxy-provider-select';

export type AdapterName = 'hermes' | 'openclaw' | 'codex' | 'claude-code';

export const ADAPTERS: readonly AdapterName[] = ['hermes', 'openclaw', 'codex', 'claude-code'];

/**
 * Current stable default model across all long-running adapters.
 * release202/12 C3 — single-sourced from the provider-source registry (the
 * newapi funnel default) so this can't drift from curated-models / chains.
 */
export const DEFAULT_MODEL = NEWAPI_DEFAULT_MODEL;

function generateLocalSecret(prefix: string): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues(bytes);
  return `${prefix}-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** codex sandbox policy — mirrors the daemon-side CodexConfigSchema. */
export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface ProfileConfigFields {
  hermesPort: string;
  hermesApiKey: string;
  openclawBaseUrl: string;
  systemPrompt: string;
  model: string;
  /**
   * 2026-05-30 — per-agent proxy provider selector. Default `newapi`.
   * Only the hermes adapter consumes the field (openclaw routes through its
   * own daemon-side gateway); we still accept it on the input type so the
   * caller doesn't fork the form shape per adapter.
   */
  proxyProvider?: ProxyProvider;
  /**
   * 2026-06-02 (doc 06) — codex executor sandbox policy. Only the codex
   * adapter consumes it; default `workspace-write`.
   */
  sandbox?: CodexSandbox;
}

export function buildProfileConfig(adapter: AdapterName, fields: ProfileConfigFields): Record<string, unknown> {
  const base = fields.systemPrompt.trim() ? { systemPrompt: fields.systemPrompt.trim() } : {};
  switch (adapter) {
    case 'hermes':
      return {
        ...base,
        hermesProfileName: 'default',
        port: Number(fields.hermesPort) || 8642,
        apiKey: fields.hermesApiKey.trim() || generateLocalSecret('hermes'),
        autoStart: true,
        startupTimeoutMs: 30_000,
        model: fields.model || DEFAULT_MODEL,
        proxyProvider: fields.proxyProvider ?? 'newapi',
      };
    case 'openclaw':
      return {
        ...base,
        baseUrl: fields.openclawBaseUrl.trim() || 'http://127.0.0.1:3000',
        model: 'default',
      };
    case 'codex':
      // doc 06 U1 — matches the verified-working codex CodexConfigSchema.
      // cwd is just a fallback; the daemon overrides it with the task scratch dir.
      return {
        ...base,
        cwd: '/tmp/prismer-codex',
        model: fields.model || DEFAULT_MODEL,
        sandbox: fields.sandbox ?? 'workspace-write',
        proxyProvider: fields.proxyProvider ?? 'newapi',
        prismerApiKeyEnv: 'PRISMER_API_KEY',
        sessionContinuity: true,
      };
    case 'claude-code':
      // doc 06 U1 / doc 03 G4 — provider override deferred (in production).
      return { ...base, cwd: '/tmp/prismer-claude', model: fields.model || DEFAULT_MODEL };
    default:
      return { ...base };
  }
}
