import {
  buildBaseAccountStatusSnapshot,
  buildBaseChannelStatusSummary,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
  type ChannelPlugin,
} from "openclaw/plugin-sdk";
import {
  listPrismerAccountIds,
  resolveDefaultPrismerAccountId,
  resolvePrismerAccount,
} from "./accounts.js";
import { listPrismerPeers } from "./directory.js";
import { startPrismerGateway } from "./inbound.js";
import { sendPrismerMessage } from "./outbound.js";
import { createPrismerAgentTools } from "./tools.js";
import type { CoreConfig, ResolvedPrismerAccount } from "./types.js";

export const prismerPlugin: ChannelPlugin<ResolvedPrismerAccount> = {
  id: "prismer",
  meta: {
    id: "prismer",
    label: "Prismer",
    selectionLabel: "Prismer IM",
    docsPath: "https://prismer.cloud/docs",
    blurb: "Agent-to-Agent messaging + web knowledge",
    order: 90,
  },
  capabilities: {
    chatTypes: ["direct"],
    media: false,
    reply: false,
    edit: false,
    threads: false,
  },
  reload: { configPrefixes: ["channels.prismer"] },
  config: {
    listAccountIds: (cfg) => listPrismerAccountIds(cfg as CoreConfig),
    resolveAccount: (cfg, accountId) =>
      resolvePrismerAccount({ cfg: cfg as CoreConfig, accountId }),
    defaultAccountId: (cfg) =>
      resolveDefaultPrismerAccountId(cfg as CoreConfig),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg: cfg as CoreConfig,
        sectionKey: "prismer",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg: cfg as CoreConfig,
        sectionKey: "prismer",
        accountId,
        clearBaseFields: ["apiKey", "agentName", "description", "capabilities"],
      }),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
    }),
  },
  messaging: {
    normalizeTarget: (raw) => raw.trim() || undefined,
    targetResolver: {
      looksLikeId: (raw) => /^[a-zA-Z0-9_-]+$/.test(raw.trim()),
      hint: "<userId>",
    },
  },
  resolver: {
    resolveTargets: async ({ inputs, kind }) => {
      return inputs.map((input) => {
        const normalized = input.trim();
        if (!normalized) {
          return { input, resolved: false, note: "empty target" };
        }
        if (kind === "group") {
          return { input, resolved: false, note: "Prismer does not support group targets yet" };
        }
        return { input, resolved: true, id: normalized, name: normalized };
      });
    },
  },
  directory: {
    self: async () => null,
    listPeers: async ({ cfg, accountId, query, limit }) =>
      listPrismerPeers({
        cfg: cfg as CoreConfig,
        accountId,
        query,
        limit,
      }),
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    sendText: async ({ cfg, to, text, accountId }) => {
      const result = await sendPrismerMessage(to, text, {
        cfg: cfg as CoreConfig,
        accountId: accountId ?? undefined,
      });
      return {
        channel: "prismer",
        messageId: result.messageId ?? "",
        conversationId: result.conversationId,
      };
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
      const combined = mediaUrl ? `${text}\n\nAttachment: ${mediaUrl}` : text;
      const result = await sendPrismerMessage(to, combined, {
        cfg: cfg as CoreConfig,
        accountId: accountId ?? undefined,
      });
      return {
        channel: "prismer",
        messageId: result.messageId ?? "",
        conversationId: result.conversationId,
      };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildChannelSummary: ({ snapshot }) => ({
      ...buildBaseChannelStatusSummary(snapshot),
    }),
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      ...buildBaseAccountStatusSnapshot({ account, runtime, probe }),
    }),
  },
  gateway: {
    startAccount: async (ctx) => startPrismerGateway(ctx),
  },
  agentTools: ({ cfg }) => {
    const account = resolvePrismerAccount({ cfg: cfg as CoreConfig });
    if (!account.apiKey) return [];
    return createPrismerAgentTools(account.apiKey, account.baseUrl);
  },
};
