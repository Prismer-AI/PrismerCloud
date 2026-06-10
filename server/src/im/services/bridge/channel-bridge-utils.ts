import type { BindingConfig, BridgeOutboundTarget, ChannelAccountRecord } from './bridge.interface';

export type FetchLike = typeof fetch;

export function parseObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function channelConfig(account: ChannelAccountRecord): Record<string, unknown> {
  return parseObject(account.config);
}

export function channelCredentials(account: ChannelAccountRecord): Record<string, unknown> {
  return parseObject(account.credentials);
}

export function configValue(config: BindingConfig | Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function resolveExternalConversationTarget(target?: BridgeOutboundTarget): string | undefined {
  return target?.externalConversationId ?? target?.externalGroupId ?? target?.externalUserId;
}
