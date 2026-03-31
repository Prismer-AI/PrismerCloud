/**
 * Prismer IM — Telegram Bridge
 *
 * Bridges messages between IM and Telegram via Bot API.
 * Uses long polling in dev, webhook in production.
 */

import type {
  MessageBridge,
  BindingRecord,
  BindingConfig,
  InboundHandler,
} from "./bridge.interface";
import type { BridgeResult } from "../../types/index";

const TELEGRAM_API = "https://api.telegram.org";

export class TelegramBridge implements MessageBridge {
  platform = "telegram";

  /** Active polling handles keyed by bindingId */
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
        `${TELEGRAM_API}/bot${binding.botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: binding.channelId,
            text: content,
            parse_mode: "Markdown",
          }),
        }
      );

      const data = (await res.json()) as {
        ok: boolean;
        result?: { message_id: number };
        description?: string;
      };

      if (!data.ok) {
        return { success: false, error: data.description ?? "Telegram API error" };
      }

      return {
        success: true,
        externalMessageId: String(data.result?.message_id),
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async startListening(
    binding: BindingRecord,
    onMessage: InboundHandler
  ): Promise<void> {
    if (!binding.botToken) return;

    const abort = new AbortController();
    this.pollers.set(binding.id, { abort });

    // Long polling loop
    let offset = 0;
    const poll = async () => {
      while (!abort.signal.aborted) {
        try {
          const res = await fetch(
            `${TELEGRAM_API}/bot${binding.botToken}/getUpdates?offset=${offset}&timeout=30`,
            { signal: abort.signal }
          );
          const data = (await res.json()) as {
            ok: boolean;
            result: Array<{
              update_id: number;
              message?: {
                message_id: number;
                text?: string;
                from?: { id: number; first_name: string; username?: string };
                date: number;
              };
            }>;
          };

          if (data.ok && data.result.length > 0) {
            for (const update of data.result) {
              offset = update.update_id + 1;
              if (update.message?.text) {
                await onMessage({
                  bindingId: binding.id,
                  externalMessageId: String(update.message.message_id),
                  content: update.message.text,
                  senderName:
                    update.message.from?.username ??
                    update.message.from?.first_name ??
                    "unknown",
                  senderId: String(update.message.from?.id ?? "0"),
                  timestamp: new Date(update.message.date * 1000),
                });
              }
            }
          }
        } catch (err) {
          if ((err as Error).name === "AbortError") break;
          console.warn("[TelegramBridge] Poll error:", (err as Error).message);
          // Wait before retry
          await new Promise((r) => setTimeout(r, 5000));
        }
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
      const res = await fetch(
        `${TELEGRAM_API}/bot${config.botToken}/getMe`
      );
      const data = (await res.json()) as { ok: boolean };
      return data.ok;
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
      `Your Prismer IM verification code: *${code}*\n\nEnter this code in your Prismer dashboard to complete the binding.`
    );
    return result.success;
  }
}
