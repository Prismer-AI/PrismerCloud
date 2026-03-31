import type { OpenClawConfig } from "openclaw/plugin-sdk";

export type PrismerAccountConfig = {
  enabled?: boolean;
  apiKey?: string;
  agentName?: string;
  description?: string;
  capabilities?: string[];
  baseUrl?: string;
  /** Evolution scope — partitions gene pools per project/team. Defaults to agentName. */
  scope?: string;
  /** Memory write interval in messages (default: 10). 0 disables auto-write. */
  memoryWriteInterval?: number;
};

export type PrismerConfig = PrismerAccountConfig & {
  accounts?: Record<string, PrismerAccountConfig>;
  defaultAccount?: string;
};

export type CoreConfig = OpenClawConfig & {
  channels?: OpenClawConfig["channels"] & {
    prismer?: PrismerConfig;
  };
};

export type ResolvedPrismerAccount = {
  accountId: string;
  name: string;
  enabled: boolean;
  configured: boolean;
  apiKey: string;
  baseUrl: string;
  agentName: string;
  description: string;
  capabilities: string[];
  /** Evolution scope — partitions gene pools. Falls back to agentName. */
  scope: string;
  config: PrismerAccountConfig;
};

export type PrismerInboundMessage = {
  messageId: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  content: string;
  timestamp: number;
  isGroup: boolean;
};
