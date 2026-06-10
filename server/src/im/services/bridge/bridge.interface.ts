/**
 * Prismer IM — Message Bridge Interface
 *
 * Platform-agnostic interface for bridging messages
 * between IM and external platforms.
 */

import type { BridgeResult, InboundMessage } from '../../types/index';

export interface BindingConfig {
  botToken?: string;
  channelId?: string;
  webhookUrl?: string;
  apiBaseUrl?: string;
  accessToken?: string;
  phoneNumberId?: string;
  corpId?: string;
  corpSecret?: string;
  agentId?: string;
  appId?: string;
  appSecret?: string;
  [key: string]: unknown;
}

export type BridgeDeliveryMode = 'direct' | 'group' | 'channel';

export interface BridgeCapabilities {
  /** Platform supports true external group conversations instead of only 1:1 fanout. */
  groupNative: boolean;
  /** Platform can send out but cannot receive inbound messages through this bridge. */
  outboundOnly: boolean;
  /** Bridge can receive inbound external messages. */
  supportsInbound: boolean;
  /** Bridge can send an account-link verification code. */
  supportsVerification: boolean;
  /** Bridge can target an external user id directly. */
  supportsExternalUserTarget: boolean;
  /** Bridge can target an external conversation/group/channel id. */
  supportsExternalConversationTarget: boolean;
  deliveryModes: BridgeDeliveryMode[];
}

export const LEGACY_BRIDGE_CAPABILITIES: BridgeCapabilities = {
  groupNative: false,
  outboundOnly: false,
  supportsInbound: true,
  supportsVerification: true,
  supportsExternalUserTarget: false,
  supportsExternalConversationTarget: true,
  deliveryModes: ['channel'],
};

/** Full binding record from DB */
export interface BindingRecord {
  id: string;
  imUserId: string;
  platform: string;
  status: string;
  externalId?: string | null;
  externalName?: string | null;
  botToken?: string | null;
  channelId?: string | null;
  webhookUrl?: string | null;
}

/** v2.0 channel account record, independent from legacy im_bindings. */
export interface ChannelAccountRecord {
  id: string;
  ownerImUserId: string;
  workspaceId?: string | null;
  platform: string;
  label?: string;
  status: string;
  credentials?: string | Record<string, unknown> | null;
  accountIdentifier?: string | null;
  capabilities?: string | BridgeCapabilities | null;
  config?: string | Record<string, unknown> | null;
}

export interface BridgeOutboundTarget {
  externalUserId?: string;
  externalConversationId?: string;
  externalGroupId?: string;
  replyToken?: string;
  metadata?: Record<string, unknown>;
}

export type BridgeSendRecord = BindingRecord | ChannelAccountRecord;

export interface BridgeInboundMessage extends InboundMessage {
  channelAccountId?: string;
  externalUserId?: string;
  externalConversationId?: string;
  externalGroupId?: string;
}

export type InboundHandler = (message: BridgeInboundMessage) => Promise<void>;

export interface MessageBridge {
  /** Platform identifier */
  platform: string;

  /** Platform capabilities for routing and setup UI. */
  capabilities: BridgeCapabilities;

  /** Send a message to the external platform */
  sendMessage(
    binding: BridgeSendRecord,
    content: string,
    metadata?: Record<string, unknown>,
    target?: BridgeOutboundTarget,
  ): Promise<BridgeResult>;

  /** Start listening for inbound messages */
  startListening(binding: BridgeSendRecord, onMessage: InboundHandler): Promise<void>;

  /** Stop listening */
  stopListening(bindingId: string): Promise<void>;

  /** Validate credentials before binding */
  validateCredentials(config: BindingConfig): Promise<boolean>;

  /** Send verification code to the platform */
  sendVerification(binding: BindingRecord, code: string): Promise<boolean>;
}

export interface ChannelTransport {
  sendText(input: {
    content: string;
    target: BridgeOutboundTarget;
    account: ChannelAccountRecord;
    config: Record<string, unknown>;
    credentials: Record<string, unknown>;
  }): Promise<BridgeResult>;
}
