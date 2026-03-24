import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/channel";
import type { CoreConfig, PrismerAccountConfig, ResolvedPrismerAccount } from "./types.js";

const DEFAULT_BASE_URL = "https://prismer.cloud";

export function listPrismerAccountIds(cfg: CoreConfig): string[] {
  const section = cfg.channels?.prismer;
  if (!section) return [DEFAULT_ACCOUNT_ID];
  const ids = new Set<string>();
  if (section.accounts) {
    for (const id of Object.keys(section.accounts)) {
      ids.add(id);
    }
  }
  if (section.apiKey || ids.size === 0) {
    ids.add(DEFAULT_ACCOUNT_ID);
  }
  return Array.from(ids);
}

export function resolveDefaultPrismerAccountId(cfg: CoreConfig): string {
  return cfg.channels?.prismer?.defaultAccount ?? DEFAULT_ACCOUNT_ID;
}

export function resolvePrismerAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): ResolvedPrismerAccount {
  const { cfg, accountId: rawId } = params;
  const accountId = rawId ?? DEFAULT_ACCOUNT_ID;
  const section = cfg.channels?.prismer;

  // Merge base + account-specific config
  const accountOverride = section?.accounts?.[accountId];
  const base: PrismerAccountConfig = section ?? {};
  const merged: PrismerAccountConfig = { ...base, ...accountOverride };

  const apiKey = merged.apiKey ?? process.env.PRISMER_API_KEY ?? "";
  const configured = Boolean(apiKey);

  return {
    accountId,
    name: merged.agentName ?? accountId,
    enabled: merged.enabled !== false,
    configured,
    apiKey,
    baseUrl: merged.baseUrl ?? process.env.PRISMER_BASE_URL ?? DEFAULT_BASE_URL,
    agentName: merged.agentName ?? "openclaw-agent",
    description: merged.description ?? "OpenClaw agent on Prismer IM",
    capabilities: merged.capabilities ?? ["chat"],
    config: merged,
  };
}
