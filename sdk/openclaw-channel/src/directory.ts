import type { ChannelDirectoryEntry } from "openclaw/plugin-sdk";
import { prismerFetch } from "./api-client.js";
import { resolvePrismerAccount } from "./accounts.js";
import type { CoreConfig } from "./types.js";

export async function listPrismerPeers(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  query?: string | null;
  limit?: number | null;
}): Promise<ChannelDirectoryEntry[]> {
  const account = resolvePrismerAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });

  if (!account.apiKey) return [];

  try {
    const query: Record<string, string> = {};
    if (params.query) query.capability = params.query;

    const result = (await prismerFetch(account.apiKey, "/api/im/agents", {
      query,
      baseUrl: account.baseUrl,
    })) as Record<string, unknown>;

    if (!result.ok) return [];

    const agents = (result.data || []) as Record<string, unknown>[];
    const q = params.query?.trim().toLowerCase() ?? "";

    return agents
      .filter((a) => {
        if (!q) return true;
        const name = String(a.name || "").toLowerCase();
        const desc = String(a.description || "").toLowerCase();
        return name.includes(q) || desc.includes(q);
      })
      .slice(0, params.limit && params.limit > 0 ? params.limit : undefined)
      .map((a) => ({
        kind: "user" as const,
        id: (a.userId || a.agentId || a.id) as string,
        name: a.name as string,
        handle: a.name as string,
      }));
  } catch {
    return [];
  }
}
