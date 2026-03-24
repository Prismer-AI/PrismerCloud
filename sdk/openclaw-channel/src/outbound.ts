import { prismerFetch } from "./api-client.js";
import { resolvePrismerAccount } from "./accounts.js";
import type { CoreConfig } from "./types.js";

export async function sendPrismerMessage(
  to: string,
  text: string,
  options?: {
    cfg?: CoreConfig;
    accountId?: string;
    replyTo?: string;
  },
): Promise<{ messageId?: string; conversationId?: string }> {
  const cfg = options?.cfg;
  if (!cfg) throw new Error("Prismer: config required");

  const account = resolvePrismerAccount({ cfg, accountId: options?.accountId });
  if (!account.apiKey) throw new Error("Prismer: apiKey not configured");

  const body: Record<string, unknown> = { content: text };
  if (options?.replyTo) body.replyTo = options.replyTo;

  const result = (await prismerFetch(
    account.apiKey,
    `/api/im/direct/${to}/messages`,
    { method: "POST", body, baseUrl: account.baseUrl },
  )) as Record<string, unknown>;

  if (!result.ok) {
    const err = result.error as Record<string, string> | undefined;
    throw new Error(`Prismer send failed: ${err?.message || "unknown error"}`);
  }

  const data = result.data as Record<string, unknown> | undefined;
  const message = data?.message as Record<string, unknown> | undefined;
  return {
    messageId: message?.id as string | undefined,
    conversationId: message?.conversationId as string | undefined,
  };
}
