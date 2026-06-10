/**
 * §30 B3.5 — Long-running agent creation pipeline.
 *
 * Encapsulates the multi-call sequence from NewAgentDialog.handleSubmit
 * (register → profile → [k8s install] → direct conversation), returning a
 * discriminated result so the caller can render partial-success error states
 * cleanly.
 *
 * Extracted per B0 audit recommendation (the audit suggested
 * `unified-creation/agent/create-long-running-agent.ts`). Keeps
 * ProTileAgent under the 250-line budget.
 *
 * B0 Risk #1: register succeeded but profile/direct failed → the agent
 * is registered without a profile or conversation. We surface that
 * partial state via `stage` so the panel can show a clear message.
 *
 * v200 K8S device picker (2026-05-19): the host target is no longer hardcoded
 * to the local daemon. `LongRunningAgentInput.target: DaemonTarget` lets the
 * caller pick either the local host daemon OR a K8S sandbox device in the
 * current workspace. Each source uses a different install path:
 *
 *   source='local-host' → existing pull-based flow. `createAgent` carries the
 *     `daemonId`; the daemon's WS connection receives the agent event and
 *     self-installs via the `prismer agent install` codepath.
 *
 *   source='k8s-device' → push-based flow. `createAgent` + `createAgentProfile`
 *     first (so the IM workspace knows about the agent), then explicit
 *     `POST /api/workspace/runtime-installations/:id/agents` which cloud-side
 *     RPCs `k8sSandbox.installAgent` → in-pod daemon `/v1/agents/install`.
 */

import { workspaceFetch } from '../../../lib/im-api';
import {
  createAgent,
  createAgentProfile,
  createDirectConversation,
  preinstallRoleTemplateSkills,
  type AgentTypeEnum,
  type RegisterAgentResult,
} from '../../../lib/mutations';
import { buildRoleTemplateSnapshot, type AgentRoleTemplate } from '../../../lib/templates';
import type { LongRunningAdapter } from './AgentSubBlocks';
import type { AdapterName } from './profile-config';
import type { DaemonTarget } from './daemon-target';
import type { ProxyProvider } from '../../proxy-provider-select';

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
  /**
   * 2026-05-30 — per-agent proxy provider selector. Default `newapi`.
   * Only the hermes adapter writes this field into config — openclaw routes
   * through its own daemon-side gateway and ignores the cloud proxy.
   */
  proxyProvider?: ProxyProvider;
}): Record<string, unknown> {
  const roleTemplate = buildRoleTemplateSnapshot(input.template);
  const base = {
    ...(input.template?.systemPrompt?.trim() ? { systemPrompt: input.template.systemPrompt.trim() } : {}),
    ...(roleTemplate
      ? {
          roleTemplate,
          mcpAllowlist: (roleTemplate.mcpServers as Array<{ toolsAllowlist?: string[] }>)[0]?.toolsAllowlist,
          taskAuthority: roleTemplate.taskAuthority,
          approvalPolicy: roleTemplate.approvalPolicy,
          operatingPrinciples: roleTemplate.operatingPrinciples,
        }
      : {}),
  };
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
      proxyProvider: input.proxyProvider ?? 'newapi',
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
  /**
   * Adapter the agent registers + profiles under. Orchestrators use the
   * long-running adapters (hermes/openclaw); executors (doc 06) reuse this
   * same pipeline with the CLI adapters (codex/claude-code). The field flows
   * straight into `createAgent` metadata + `createAgentProfile.adapterName`,
   * both of which accept any adapter string.
   */
  adapter: AdapterName | LongRunningAdapter;
  /**
   * Where the agent runs. `local-host` uses the host daemon's WS pull path;
   * `k8s-device` uses the explicit runtime-installations install endpoint.
   */
  target: DaemonTarget;
  template?: AgentRoleTemplate;
  /** Adapter-specific config blob built by the caller via `buildConfig()`. */
  config: Record<string, unknown>;
  /** Resume after register succeeded but profile/session creation failed. */
  recovery?: { agent: RegisterAgentResult; profileCreated?: boolean; installCompleted?: boolean };
}

export type LongRunningAgentStage = 'register' | 'profile' | 'install' | 'direct';

export type LongRunningAgentResult =
  | { ok: true; imUserId: string; conversationId: string }
  | {
      ok: false;
      stage: LongRunningAgentStage;
      message: string;
      recovery?: { agent: RegisterAgentResult; profileCreated?: boolean; installCompleted?: boolean };
      imUserId?: string;
    };

export async function createLongRunningAgent(input: LongRunningAgentInput): Promise<LongRunningAgentResult> {
  let agent = input.recovery?.agent;
  let profileCreated = input.recovery?.profileCreated ?? false;
  let installCompleted = input.recovery?.installCompleted ?? false;

  // Resolve daemonId source: for K8S devices, the IMContainer row's daemonId
  // is the authoritative daemon identifier. For local-host, it's the host
  // daemon's self-reported daemonId from /healthz.
  const daemonId = input.target.source === 'local-host' ? input.target.daemonId : (input.target.daemonId ?? undefined);

  if (!agent) {
    const res = await createAgent({
      displayName: input.displayName,
      username: input.username,
      agentType: input.agentType,
      workspaceId: input.workspaceId,
      adapter: input.adapter,
      daemonId,
      capabilities: input.template?.capabilities.length ? input.template.capabilities : undefined,
      description: input.description || undefined,
    });
    if (!res.ok) return { ok: false, stage: 'register', message: res.message };
    agent = res.data;
  }

  let profileId: string | undefined;
  if (!profileCreated) {
    const profile = await createAgentProfile({
      workspaceId: input.workspaceId,
      agentImUserId: agent.imUserId,
      adapterName: input.adapter,
      name: 'default',
      config: input.config,
    });
    if (!profile.ok) {
      const profileAlreadyExists =
        profile.status === 409 && /profile.*already exists/i.test(`${profile.error} ${profile.message}`);
      if (!profileAlreadyExists) {
        return {
          ok: false,
          stage: 'profile',
          message: `Agent created, but profile setup failed: ${profile.message}. Retry will resume profile setup for @${agent.username}.`,
          recovery: { agent, profileCreated: false },
          imUserId: agent.imUserId,
        };
      }
    } else {
      profileId = profile.data.id;
    }
    profileCreated = true;
  }

  // K8S device push-install: cloud explicitly tells the pod to install this
  // agent's adapter profile. Local-host skips this — the daemon's WS event
  // handler picks up the agent and self-installs (pull-based).
  if (input.target.source === 'k8s-device' && !installCompleted) {
    const installRes = await workspaceFetch(
      `/api/workspace/runtime-installations/${encodeURIComponent(input.target.installationId)}/agents`,
      {
        method: 'POST',
        body: JSON.stringify({
          agentImUserId: agent.imUserId,
          ...(profileId ? { profileId } : {}),
          adapterName: input.adapter,
          profileName: 'default',
          config: input.config,
        }),
      },
    );
    if (!installRes.ok) {
      return {
        ok: false,
        stage: 'install',
        message: `Agent + profile created, K8S install failed: ${installRes.message}. Retry will resume install on the same device.`,
        recovery: { agent, profileCreated, installCompleted: false },
        imUserId: agent.imUserId,
      };
    }
    installCompleted = true;
  } else {
    // Local-host path doesn't have an explicit install step.
    installCompleted = true;
  }

  if (input.template?.id && input.template.id !== 'custom') {
    void preinstallRoleTemplateSkills({
      agentImUserId: agent.imUserId,
      roleTemplate: input.template.id,
      workspaceId: input.workspaceId,
    });
  }

  const direct = await createDirectConversation(agent.imUserId, input.workspaceId);
  if (!direct.ok) {
    return {
      ok: false,
      stage: 'direct',
      message: `Agent created, but session creation failed: ${direct.message}. Retry will resume session setup for @${agent.username}.`,
      recovery: { agent, profileCreated, installCompleted },
      imUserId: agent.imUserId,
    };
  }

  return { ok: true, imUserId: agent.imUserId, conversationId: direct.data.id };
}
