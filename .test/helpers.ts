/**
 * Shared test helpers for Cookbook integration tests.
 *
 * API key resolution order:
 *   1. PRISMER_API_KEY_TEST env var
 *   2. ~/.prismer/config.toml (auto-read if `prismer setup` was run)
 */
import { PrismerClient } from '@prismer/sdk';
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

function readConfigKey(): string | undefined {
  try {
    const configPath = join(homedir(), '.prismer', 'config.toml');
    const content = readFileSync(configPath, 'utf-8');
    const match = content.match(/api_key\s*=\s*"([^"]+)"/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

export const API_KEY = process.env.PRISMER_API_KEY_TEST || readConfigKey();
if (!API_KEY) {
  throw new Error(
    'No API key found.\n' +
    'Either set PRISMER_API_KEY_TEST env var, or run `prismer setup` first.\n' +
    'Usage: PRISMER_API_KEY_TEST="sk-prismer-..." npx vitest run',
  );
}

export const BASE_URL = process.env.PRISMER_BASE_URL_TEST || 'https://prismer.cloud';
export const RUN_ID = Date.now().toString(36);

/** Client authenticated with the API key (for registration, public endpoints). */
export function apiClient(): PrismerClient {
  return new PrismerClient({
    apiKey: API_KEY!,
    baseUrl: BASE_URL,
    timeout: 60_000,
  });
}

/** Client authenticated with an IM JWT token (for agent-scoped operations). */
export function imClient(token: string): PrismerClient {
  return new PrismerClient({
    apiKey: token,
    baseUrl: BASE_URL,
    timeout: 60_000,
  });
}

/** Register a fresh agent and return { token, userId, client }. */
export async function registerAgent(
  name: string,
  opts?: { type?: string; capabilities?: string[] },
) {
  const client = apiClient();
  const reg = await client.im.account.register({
    type: 'agent',
    username: `${name}-${RUN_ID}`,
    displayName: `${name} (${RUN_ID})`,
    agentType: (opts?.type ?? 'assistant') as any,
    capabilities: opts?.capabilities ?? ['testing'],
    description: `Cookbook test agent: ${name}`,
  });

  if (!reg.ok || !reg.data) {
    throw new Error(`Failed to register agent ${name}: ${reg.error}`);
  }

  return {
    token: reg.data.token,
    userId: reg.data.imUserId,
    username: `${name}-${RUN_ID}`,
    client: imClient(reg.data.token),
  };
}
