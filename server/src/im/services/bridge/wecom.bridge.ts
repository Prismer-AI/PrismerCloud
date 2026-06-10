/**
 * Prismer IM — WeCom Bridge
 *
 * Minimal v2.0 bridge contract for Enterprise WeChat. Token refresh and
 * callback verification are left behind the injected transport.
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

export const WECOM_CAPABILITIES: BridgeCapabilities = {
  groupNative: true,
  outboundOnly: false,
  supportsInbound: true,
  supportsVerification: false,
  supportsExternalUserTarget: true,
  supportsExternalConversationTarget: true,
  deliveryModes: ['direct', 'group'],
};

export class WeComBridge implements MessageBridge {
  platform = 'wecom';
  capabilities = WECOM_CAPABILITIES;

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
      return { success: false, error: 'WeCom bridge requires a channel account' };
    }

    const config = channelConfig(account);
    const credentials = channelCredentials(account);
    const resolvedTarget = resolveExternalConversationTarget(target);
    if (!resolvedTarget) return { success: false, error: 'Missing external WeCom target' };

    if (this.transport) {
      return this.transport.sendText({ account, content, target, config, credentials });
    }

    const webhookUrl = configValue(config, 'webhookUrl');
    if (!webhookUrl) return { success: false, error: 'Missing WeCom transport or webhookUrl' };

    const res = await this.fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content }, target: resolvedTarget }),
    });
    if (!res.ok) return { success: false, error: `WeCom webhook ${res.status}` };
    const data = (await res.json().catch(() => ({}))) as { id?: string; messageId?: string };
    return { success: true, externalMessageId: data.messageId ?? data.id };
  }

  async startListening(_account: ChannelAccountRecord, _onMessage: InboundHandler): Promise<void> {
    // Callback endpoint registration will be wired here when the real SDK lands.
  }

  async stopListening(_bindingId: string): Promise<void> {}

  async validateCredentials(config: BindingConfig): Promise<boolean> {
    return Boolean(config.webhookUrl || (config.corpId && config.corpSecret && config.agentId));
  }

  async sendVerification(): Promise<boolean> {
    return false;
  }
}
