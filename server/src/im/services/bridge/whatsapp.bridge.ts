/**
 * Prismer IM — WhatsApp Bridge
 *
 * Minimal outbound contract. Production integration should use a reviewed
 * WhatsApp transport because Baileys-style session login carries compliance
 * and reliability risk.
 */

import type {
  BindingConfig,
  BridgeCapabilities,
  BridgeOutboundTarget,
  BridgeSendRecord,
  ChannelAccountRecord,
  ChannelTransport,
  InboundHandler,
  MessageBridge,
} from './bridge.interface';
import type { BridgeResult } from '../../types/index';
import {
  channelConfig,
  channelCredentials,
  configValue,
  resolveExternalConversationTarget,
  type FetchLike,
} from './channel-bridge-utils';

const WHATSAPP_GRAPH_API = 'https://graph.facebook.com/v20.0';

export const WHATSAPP_CAPABILITIES: BridgeCapabilities = {
  groupNative: false,
  outboundOnly: false,
  supportsInbound: true,
  supportsVerification: false,
  supportsExternalUserTarget: true,
  supportsExternalConversationTarget: false,
  deliveryModes: ['direct'],
};

export class WhatsAppBridge implements MessageBridge {
  platform = 'whatsapp';
  capabilities = WHATSAPP_CAPABILITIES;

  constructor(
    private transport?: ChannelTransport,
    private fetchImpl: FetchLike = fetch,
  ) {}

  async sendMessage(
    account: BridgeSendRecord,
    content: string,
    _metadata?: Record<string, unknown>,
    target: BridgeOutboundTarget = {},
  ): Promise<BridgeResult> {
    if (!('ownerImUserId' in account)) {
      return { success: false, error: 'WhatsApp bridge requires a channel account' };
    }

    const config = channelConfig(account);
    const credentials = channelCredentials(account);
    const resolvedTarget = resolveExternalConversationTarget(target);
    if (!resolvedTarget) return { success: false, error: 'Missing external WhatsApp user target' };

    if (this.transport) {
      return this.transport.sendText({ account, content, target, config, credentials });
    }

    const accessToken = configValue(credentials, 'accessToken') ?? configValue(config, 'accessToken');
    const phoneNumberId = configValue(credentials, 'phoneNumberId') ?? configValue(config, 'phoneNumberId');
    if (!accessToken || !phoneNumberId) {
      return { success: false, error: 'Missing WhatsApp accessToken or phoneNumberId' };
    }

    const apiBaseUrl = configValue(config, 'apiBaseUrl') ?? WHATSAPP_GRAPH_API;
    const res = await this.fetchImpl(`${apiBaseUrl}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: resolvedTarget,
        type: 'text',
        text: { body: content },
      }),
    });
    if (!res.ok) return { success: false, error: `WhatsApp API ${res.status}` };
    const data = (await res.json().catch(() => ({}))) as { messages?: Array<{ id: string }> };
    return { success: true, externalMessageId: data.messages?.[0]?.id };
  }

  async startListening(_account: ChannelAccountRecord, _onMessage: InboundHandler): Promise<void> {
    // Webhook or session callback registration goes here.
  }

  async stopListening(_bindingId: string): Promise<void> {}

  async validateCredentials(config: BindingConfig): Promise<boolean> {
    return Boolean(config.webhookUrl || (config.accessToken && config.phoneNumberId));
  }

  async sendVerification(): Promise<boolean> {
    return false;
  }
}
