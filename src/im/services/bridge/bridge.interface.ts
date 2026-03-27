/**
 * Prismer IM — Message Bridge Interface
 *
 * Platform-agnostic interface for bridging messages
 * between IM and external platforms.
 */

import type { BridgeResult, InboundMessage } from "../../types/index";

export interface BindingConfig {
  botToken?: string;
  channelId?: string;
  webhookUrl?: string;
}

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

export type InboundHandler = (message: InboundMessage) => Promise<void>;

export interface MessageBridge {
  /** Platform identifier */
  platform: string;

  /** Send a message to the external platform */
  sendMessage(
    binding: BindingRecord,
    content: string,
    metadata?: Record<string, unknown>
  ): Promise<BridgeResult>;

  /** Start listening for inbound messages */
  startListening(
    binding: BindingRecord,
    onMessage: InboundHandler
  ): Promise<void>;

  /** Stop listening */
  stopListening(bindingId: string): Promise<void>;

  /** Validate credentials before binding */
  validateCredentials(config: BindingConfig): Promise<boolean>;

  /** Send verification code to the platform */
  sendVerification(
    binding: BindingRecord,
    code: string
  ): Promise<boolean>;
}
