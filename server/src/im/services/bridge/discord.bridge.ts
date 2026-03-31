/**
 * Prismer IM — Discord Bridge
 *
 * Bridges messages between IM and Discord via Bot REST API.
 */

import type {
  MessageBridge,
  BindingRecord,
  BindingConfig,
  InboundHandler,
} from "./bridge.interface";
import type { BridgeResult } from "../../types/index";

const DISCORD_API = "https://discord.com/api/v10";

export class DiscordBridge implements MessageBridge {
  platform = "discord";

  /** Active polling handles */
  private pollers = new Map<string, { abort: AbortController }>();

  async sendMessage(
    binding: BindingRecord,
    content: string
  ): Promise<BridgeResult> {
    if (!binding.botToken || !binding.channelId) {
      return { success: false, error: "Missing botToken or channelId" };
    }

    try {
      const res = await fetch(
        `${DISCORD_API}/channels/${binding.channelId}/messages`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bot ${binding.botToken}`,
          },
          body: JSON.stringify({ content }),
        }
      );

      if (!res.ok) {
        const err = await res.text();
        return { success: false, error: `Discord API ${res.status}: ${err}` };
      }

      const data = (await res.json()) as { id: string };
      return { success: true, externalMessageId: data.id };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async startListening(
    binding: BindingRecord,
    onMessage: InboundHandler
  ): Promise<void> {
    if (!binding.botToken || !binding.channelId) return;

    const abort = new AbortController();
    this.pollers.set(binding.id, { abort });

    // Simple polling: fetch recent messages periodically
    let lastMessageId: string | null = null;

    const poll = async () => {
      while (!abort.signal.aborted) {
        try {
          const url = lastMessageId
            ? `${DISCORD_API}/channels/${binding.channelId}/messages?after=${lastMessageId}&limit=10`
            : `${DISCORD_API}/channels/${binding.channelId}/messages?limit=1`;

          const res = await fetch(url, {
            headers: { Authorization: `Bot ${binding.botToken}` },
            signal: abort.signal,
          });

          if (res.ok) {
            const messages = (await res.json()) as Array<{
              id: string;
              content: string;
              author: { id: string; username: string; bot?: boolean };
              timestamp: string;
            }>;

            // Skip bot messages and process in chronological order
            const userMessages = messages
              .filter((m) => !m.author.bot)
              .reverse();

            for (const msg of userMessages) {
              lastMessageId = msg.id;
              await onMessage({
                bindingId: binding.id,
                externalMessageId: msg.id,
                content: msg.content,
                senderName: msg.author.username,
                senderId: msg.author.id,
                timestamp: new Date(msg.timestamp),
              });
            }

            if (messages.length > 0 && !lastMessageId) {
              lastMessageId = messages[0].id;
            }
          }
        } catch (err) {
          if ((err as Error).name === "AbortError") break;
          console.warn("[DiscordBridge] Poll error:", (err as Error).message);
        }

        // Wait 5s between polls
        await new Promise((r) => setTimeout(r, 5000));
      }
    };

    poll(); // fire-and-forget
  }

  async stopListening(bindingId: string): Promise<void> {
    const poller = this.pollers.get(bindingId);
    if (poller) {
      poller.abort.abort();
      this.pollers.delete(bindingId);
    }
  }

  async validateCredentials(config: BindingConfig): Promise<boolean> {
    if (!config.botToken) return false;
    try {
      const res = await fetch(`${DISCORD_API}/users/@me`, {
        headers: { Authorization: `Bot ${config.botToken}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async sendVerification(
    binding: BindingRecord,
    code: string
  ): Promise<boolean> {
    if (!binding.botToken || !binding.channelId) return false;
    const result = await this.sendMessage(
      binding,
      `Your Prismer IM verification code: **${code}**\n\nEnter this code in your Prismer dashboard to complete the binding.`
    );
    return result.success;
  }
}
