/**
 * Prismer IM — WeChat Bridge
 *
 * Minimal v2.0 skeleton. Real scan-login SDK integration is intentionally
 * deferred behind ChannelTransport so the routing contract can compile now.
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
  type FetchLike,
  resolveExternalConversationTarget,
} from './channel-bridge-utils';

export const WECHAT_CAPABILITIES: BridgeCapabilities = {
  groupNative: true,
  outboundOnly: false,
  supportsInbound: true,
  supportsVerification: false,
  supportsExternalUserTarget: true,
  supportsExternalConversationTarget: true,
  deliveryModes: ['direct', 'group'],
};

export class WeChatBridge implements MessageBridge {
  platform = 'wechat';
  capabilities = WECHAT_CAPABILITIES;

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
      return { success: false, error: 'WeChat bridge requires a channel account' };
    }

    const config = channelConfig(account);
    const credentials = channelCredentials(account);
    const resolvedTarget = resolveExternalConversationTarget(target);
    if (!resolvedTarget) {
      return { success: false, error: 'Missing external WeChat target' };
    }

    if (this.transport) {
      return this.transport.sendText({ account, content, target, config, credentials });
    }

    const webhookUrl = configValue(config, 'webhookUrl');
    if (!webhookUrl) {
      return { success: false, error: 'Missing WeChat transport or webhookUrl' };
    }

    const res = await this.fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: content, target: resolvedTarget }),
    });
    if (!res.ok) return { success: false, error: `WeChat webhook ${res.status}` };
    const data = (await res.json().catch(() => ({}))) as { id?: string; messageId?: string };
    return { success: true, externalMessageId: data.messageId ?? data.id };
  }

  async startListening(_account: ChannelAccountRecord, _onMessage: InboundHandler): Promise<void> {
    // SDK hook point: future scan-login client registers inbound callbacks here.
  }

  async stopListening(_bindingId: string): Promise<void> {}

  async validateCredentials(config: BindingConfig): Promise<boolean> {
    return Boolean(config.webhookUrl || (config.appId && config.appSecret) || config.accessToken);
  }

  async sendVerification(): Promise<boolean> {
    return false;
  }
}
