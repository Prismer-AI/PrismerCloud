/**
 * §30 B3.5 — Long-running agent creation pipeline.
 *
 * Encapsulates the 3-call sequence from NewAgentDialog.handleSubmit
 * (register → profile → direct conversation), returning a discriminated
 * result so the caller can render partial-success error states cleanly.
 *
 * Extracted per B0 audit recommendation (the audit suggested
 * `unified-creation/agent/create-long-running-agent.ts`). Keeps
 * ProTileAgent under the 250-line budget.
 *
 * B0 Risk #1: register succeeded but profile/direct failed → the agent
 * is registered without a profile or conversation. We surface that
 * partial state via `stage` so the panel can show a clear message.
 */

import { createAgent, createAgentProfile, createDirectConversation, type AgentTypeEnum } from '../../../lib/mutations';
import type { AgentRoleTemplate } from '../../../lib/templates';
import type { LocalDaemonHealthDTO } from '../../../lib/types';
import type { LongRunningAdapter } from './AgentSubBlocks';

// ───────────────────────── Config builders ─────────────────────────

export function generateLocalSecret(prefix: string): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues(bytes);
  return `${prefix}-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function buildLongRunningProfileConfig(input: {
  adapter: LongRunningAdapter;
  template?: AgentRoleTemplate;
  hermesPort: string;
  hermesApiKey: string;
  openclawBaseUrl: string;
  model: string;
}): Record<string, unknown> {
  const base = input.template?.systemPrompt?.trim() ? { systemPrompt: input.template.systemPrompt.trim() } : {};
  if (input.adapter === 'hermes') {
    return {
      ...base,
      hermesProfileName: 'default',
      port: Number(input.hermesPort) || 8642,
      apiKey: input.hermesApiKey.trim(),
      autoStart: true,
      startupTimeoutMs: 30_000,
      configurePrismerProvider: true,
      model: input.model || 'us-kimi-k2.6',
      prismerProviderName: 'prismer',
    };
  }
  return { ...base, baseUrl: input.openclawBaseUrl.trim() || 'http://127.0.0.1:3000', model: 'default' };
}

export interface LongRunningAgentInput {
  workspaceId: string;
  displayName: string;
  username: string;
  agentType: AgentTypeEnum;
  description?: string;
  adapter: LongRunningAdapter;
  daemon: LocalDaemonHealthDTO;
  template?: AgentRoleTemplate;
  /** Adapter-specific config blob built by the caller via `buildConfig()`. */
  config: Record<string, unknown>;
}

export type LongRunningAgentResult =
  | { ok: true; imUserId: string; conversationId: string }
  | { ok: false; stage: 'register' | 'profile' | 'direct'; message: string; imUserId?: string };

export async function createLongRunningAgent(input: LongRunningAgentInput): Promise<LongRunningAgentResult> {
  const res = await createAgent({
    displayName: input.displayName,
    username: input.username,
    agentType: input.agentType,
    workspaceId: input.workspaceId,
    adapter: input.adapter,
    daemonId: input.daemon.daemonId,
    capabilities: input.template?.capabilities.length ? input.template.capabilities : undefined,
    description: input.description || undefined,
  });
  if (!res.ok) return { ok: false, stage: 'register', message: res.message };

  const profile = await createAgentProfile({
    workspaceId: input.workspaceId,
    agentImUserId: res.data.imUserId,
    adapterName: input.adapter,
    name: 'default',
    config: input.config,
  });
  if (!profile.ok) {
    return {
      ok: false,
      stage: 'profile',
      message: `Agent created, but profile setup failed: ${profile.message}`,
      imUserId: res.data.imUserId,
    };
  }

  const direct = await createDirectConversation(res.data.imUserId, input.workspaceId);
  if (!direct.ok) {
    return {
      ok: false,
      stage: 'direct',
      message: `Agent created, but session creation failed: ${direct.message}`,
      imUserId: res.data.imUserId,
    };
  }

  return { ok: true, imUserId: res.data.imUserId, conversationId: direct.data.id };
}
