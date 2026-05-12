/**
 * §30 B3.5 — Adapter config builder for ProTileProfile (and any future
 * standalone profile editor). Extracted so the panel file stays under
 * the 250-line budget.
 *
 * Mirrors `buildLongRunningProfileConfig` from NewAgentDialog but supports
 * the full adapter set the standalone profile panel exposes (hermes /
 * openclaw / codex / claude-code).
 */

export type AdapterName = 'hermes' | 'openclaw' | 'codex' | 'claude-code';

export const ADAPTERS: readonly AdapterName[] = ['hermes', 'openclaw', 'codex', 'claude-code'];

/** Current stable default model across all long-running adapters. */
export const DEFAULT_MODEL = 'us-kimi-k2.6';

function generateLocalSecret(prefix: string): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues(bytes);
  return `${prefix}-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function buildProfileConfig(
  adapter: AdapterName,
  fields: { hermesPort: string; hermesApiKey: string; openclawBaseUrl: string; systemPrompt: string; model: string },
): Record<string, unknown> {
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
      };
    case 'openclaw':
      return {
        ...base,
        baseUrl: fields.openclawBaseUrl.trim() || 'http://127.0.0.1:3000',
        model: 'default',
      };
    case 'codex':
    case 'claude-code':
    default:
      return { ...base };
  }
}
