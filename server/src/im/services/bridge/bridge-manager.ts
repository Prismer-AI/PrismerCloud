/**
 * Prismer IM — Bridge Manager
 *
 * Manages all active message bridges.
 * Routes outbound messages to the correct bridge,
 * and handles inbound messages from external platforms.
 */

import type { PrismaClient } from '@prisma/client';
import type {
  MessageBridge,
  BindingRecord,
  BridgeCapabilities,
  BridgeOutboundTarget,
  ChannelAccountRecord,
} from './bridge.interface';
import type { MessageService } from '../message.service';
import type { InboundMessage } from '../../types/index';
import { TelegramBridge } from './telegram.bridge';
import { DiscordBridge } from './discord.bridge';
import { WeChatBridge } from './wechat.bridge';
import { WeComBridge } from './wecom.bridge';
import { WhatsAppBridge } from './whatsapp.bridge';

export class BridgeManager {
  private bridges = new Map<string, MessageBridge>();

  constructor(
    private prisma: PrismaClient,
    private messageService: MessageService,
  ) {
    // Register built-in bridges
    this.registerBridge(new TelegramBridge());
    this.registerBridge(new DiscordBridge());
    this.registerBridge(new WeChatBridge());
    this.registerBridge(new WeComBridge());
    this.registerBridge(new WhatsAppBridge());
  }

  registerBridge(bridge: MessageBridge) {
    this.bridges.set(bridge.platform, bridge);
  }

  getBridge(platform: string): MessageBridge | undefined {
    return this.bridges.get(platform);
  }

  getCapabilities(platform: string): BridgeCapabilities | undefined {
    return this.bridges.get(platform)?.capabilities;
  }

  /**
   * Send an outbound message to all active bindings for a user.
   * Called after MessageService.send() for the recipient.
   */
  async sendOutbound(
    recipientImUserId: string,
    content: string,
    imMessageId: string,
    imConversationId: string,
  ): Promise<void> {
    const bindings = await this.prisma.iMBinding.findMany({
      where: { imUserId: recipientImUserId, status: 'active' },
    });

    for (const binding of bindings) {
      const bridge = this.bridges.get(binding.platform);
      if (!bridge) continue;

      const result = await bridge.sendMessage(binding as BindingRecord, content);

      // Record bridge message
      await this.prisma.iMBridgeMessage.create({
        data: {
          bindingId: binding.id,
          direction: 'outbound',
          imMessageId,
          imConversationId,
          externalMessageId: result.externalMessageId,
          status: result.success ? 'sent' : 'failed',
          errorMessage: result.error,
        },
      });
    }
  }

  /**
   * Send through a v2.0 channel account and explicit external target.
   * This path is intentionally independent from legacy im_bindings.
   */
  async sendToChannelTarget(
    channelAccountId: string,
    target: BridgeOutboundTarget,
    content: string,
    imMessageId?: string,
    imConversationId?: string,
  ): Promise<void> {
    const account = await this.prisma.iMChannelAccount.findUnique({
      where: { id: channelAccountId },
    });
    if (!account || account.status === 'revoked') return;

    const bridge = this.bridges.get(account.platform);
    if (!bridge) return;

    const result = await bridge.sendMessage(account as ChannelAccountRecord, content, undefined, target);

    if (imMessageId || imConversationId) {
      await this.recordChannelBridgeMessage({
        channelAccountId,
        direction: 'outbound',
        imMessageId,
        imConversationId,
        externalMessageId: result.externalMessageId,
        externalGroupId: target.externalGroupId ?? target.externalConversationId,
        status: result.success ? 'sent' : 'failed',
        errorMessage: result.error,
      });
    }
  }

  private async recordChannelBridgeMessage(data: {
    channelAccountId: string;
    direction: 'inbound' | 'outbound';
    imMessageId?: string;
    imConversationId?: string;
    externalMessageId?: string;
    externalGroupId?: string;
    status: string;
    errorMessage?: string;
  }): Promise<void> {
    const client = this.prisma as unknown as {
      iMBridgeMessage: {
        create(args: { data: Record<string, unknown> }): Promise<unknown>;
      };
    };

    try {
      await client.iMBridgeMessage.create({
        data,
      });
    } catch (err) {
      console.warn('[BridgeManager] Channel bridge message record skipped:', (err as Error).message);
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
    if (!binding || binding.status !== 'active') return;

    // Find or create a conversation for this bridge user
    // For now, we simply record the bridge message
    // Full inbound → IM routing requires a dedicated "bridge conversation"
    await this.prisma.iMBridgeMessage.create({
      data: {
        bindingId: message.bindingId,
        direction: 'inbound',
        externalMessageId: message.externalMessageId,
        status: 'delivered',
      },
    });

    console.log(`[BridgeManager] Inbound from ${binding.platform}: ${message.content.slice(0, 50)}`);
  }

  async handleChannelInbound(input: {
    channelAccountId: string;
    externalMessageId: string;
    externalUserId: string;
    externalConversationId?: string;
    externalGroupId?: string;
    content: string;
    senderName?: string;
    timestamp?: Date;
  }): Promise<void> {
    const identity = await this.prisma.iMExternalIdentity.upsert({
      where: {
        channelAccountId_externalUserId: {
          channelAccountId: input.channelAccountId,
          externalUserId: input.externalUserId,
        },
      },
      update: {
        externalName: input.senderName,
        lastSeenAt: input.timestamp ?? new Date(),
      },
      create: {
        channelAccountId: input.channelAccountId,
        externalUserId: input.externalUserId,
        externalName: input.senderName,
      },
    });

    const routing = await this.prisma.iMExternalRouting.findFirst({
      where: { externalIdentityId: identity.id },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });

    await this.recordChannelBridgeMessage({
      channelAccountId: input.channelAccountId,
      direction: 'inbound',
      imConversationId: routing?.conversationId,
      externalMessageId: input.externalMessageId,
      externalGroupId: input.externalGroupId ?? input.externalConversationId,
      status: routing ? 'delivered' : 'failed',
      errorMessage: routing ? undefined : 'No IMExternalRouting for inbound channel message',
    });

    console.log(`[BridgeManager] Channel inbound ${input.channelAccountId}: ${input.content.slice(0, 50)}`);
  }

  /**
   * Start listening on all active bindings.
   */
  async startAll(): Promise<void> {
    const activeBindings = await this.prisma.iMBinding.findMany({
      where: { status: 'active' },
    });

    for (const binding of activeBindings) {
      const bridge = this.bridges.get(binding.platform);
      if (!bridge) continue;

      try {
        await bridge.startListening(binding as BindingRecord, (msg) => this.handleInbound(msg));
        console.log(`[BridgeManager] Listening on ${binding.platform} for user ${binding.imUserId}`);
      } catch (err) {
        console.warn(`[BridgeManager] Failed to start ${binding.platform}:`, (err as Error).message);
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
        where: { platform: bridge.platform, status: 'active' },
      });
      for (const binding of activeBindings) {
        await bridge.stopListening(binding.id);
      }
    }
  }
}
