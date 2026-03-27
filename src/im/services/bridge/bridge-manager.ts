/**
 * Prismer IM — Bridge Manager
 *
 * Manages all active message bridges.
 * Routes outbound messages to the correct bridge,
 * and handles inbound messages from external platforms.
 */

import type { PrismaClient } from "@prisma/client";
import type { MessageBridge, BindingRecord } from "./bridge.interface";
import type { MessageService } from "../message.service";
import type { InboundMessage } from "../../types/index";
import { TelegramBridge } from "./telegram.bridge";
import { DiscordBridge } from "./discord.bridge";

export class BridgeManager {
  private bridges = new Map<string, MessageBridge>();

  constructor(
    private prisma: PrismaClient,
    private messageService: MessageService
  ) {
    // Register built-in bridges
    this.registerBridge(new TelegramBridge());
    this.registerBridge(new DiscordBridge());
  }

  registerBridge(bridge: MessageBridge) {
    this.bridges.set(bridge.platform, bridge);
  }

  getBridge(platform: string): MessageBridge | undefined {
    return this.bridges.get(platform);
  }

  /**
   * Send an outbound message to all active bindings for a user.
   * Called after MessageService.send() for the recipient.
   */
  async sendOutbound(
    recipientImUserId: string,
    content: string,
    imMessageId: string,
    imConversationId: string
  ): Promise<void> {
    const bindings = await this.prisma.iMBinding.findMany({
      where: { imUserId: recipientImUserId, status: "active" },
    });

    for (const binding of bindings) {
      const bridge = this.bridges.get(binding.platform);
      if (!bridge) continue;

      const result = await bridge.sendMessage(
        binding as BindingRecord,
        content
      );

      // Record bridge message
      await this.prisma.iMBridgeMessage.create({
        data: {
          bindingId: binding.id,
          direction: "outbound",
          imMessageId,
          imConversationId,
          externalMessageId: result.externalMessageId,
          status: result.success ? "sent" : "failed",
          errorMessage: result.error,
        },
      });
    }
  }

  /**
   * Handle an inbound message from an external platform.
   * Routes it to the correct IM conversation.
   */
  async handleInbound(message: InboundMessage): Promise<void> {
    // Look up the binding to find the IM user
    const binding = await this.prisma.iMBinding.findUnique({
      where: { id: message.bindingId },
    });
    if (!binding || binding.status !== "active") return;

    // Find or create a conversation for this bridge user
    // For now, we simply record the bridge message
    // Full inbound → IM routing requires a dedicated "bridge conversation"
    await this.prisma.iMBridgeMessage.create({
      data: {
        bindingId: message.bindingId,
        direction: "inbound",
        externalMessageId: message.externalMessageId,
        status: "delivered",
      },
    });

    console.log(
      `[BridgeManager] Inbound from ${binding.platform}: ${message.content.slice(0, 50)}`
    );
  }

  /**
   * Start listening on all active bindings.
   */
  async startAll(): Promise<void> {
    const activeBindings = await this.prisma.iMBinding.findMany({
      where: { status: "active" },
    });

    for (const binding of activeBindings) {
      const bridge = this.bridges.get(binding.platform);
      if (!bridge) continue;

      try {
        await bridge.startListening(
          binding as BindingRecord,
          (msg) => this.handleInbound(msg)
        );
        console.log(
          `[BridgeManager] Listening on ${binding.platform} for user ${binding.imUserId}`
        );
      } catch (err) {
        console.warn(
          `[BridgeManager] Failed to start ${binding.platform}:`,
          (err as Error).message
        );
      }
    }
  }

  /**
   * Stop all bridge listeners.
   */
  async stopAll(): Promise<void> {
    for (const bridge of this.bridges.values()) {
      // Each bridge manages its own cleanup
      const activeBindings = await this.prisma.iMBinding.findMany({
        where: { platform: bridge.platform, status: "active" },
      });
      for (const binding of activeBindings) {
        await bridge.stopListening(binding.id);
      }
    }
  }
}
