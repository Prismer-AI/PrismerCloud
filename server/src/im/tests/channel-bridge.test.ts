/**
 * v2.0 channel bridge unit tests.
 *
 * Usage: npx tsx src/im/tests/channel-bridge.test.ts
 */

import type { PrismaClient } from '@prisma/client';
import { BridgeManager } from '../services/bridge/bridge-manager';
import type {
  BindingConfig,
  BridgeOutboundTarget,
  BridgeSendRecord,
  InboundHandler,
  MessageBridge,
} from '../services/bridge/bridge.interface';
import { WeChatBridge } from '../services/bridge/wechat.bridge';
import { WeComBridge } from '../services/bridge/wecom.bridge';
import { WhatsAppBridge } from '../services/bridge/whatsapp.bridge';
import type { BridgeResult, InboundMessage } from '../types/index';

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok ${name}`);
  } catch (err) {
    failed++;
    failures.push(`${name}: ${(err as Error).message}`);
    console.log(`  fail ${name}: ${(err as Error).message}`);
  }
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function assertEq<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

class CaptureBridge implements MessageBridge {
  platform = 'capture';
  capabilities = {
    groupNative: true,
    outboundOnly: false,
    supportsInbound: true,
    supportsVerification: false,
    supportsExternalUserTarget: true,
    supportsExternalConversationTarget: true,
    deliveryModes: ['direct', 'group'] as const,
  };
  sent?: { record: BridgeSendRecord; content: string; target?: BridgeOutboundTarget };

  async sendMessage(
    record: BridgeSendRecord,
    content: string,
    _metadata?: Record<string, unknown>,
    target?: BridgeOutboundTarget,
  ): Promise<BridgeResult> {
    this.sent = { record, content, target };
    return { success: true, externalMessageId: 'external-1' };
  }

  async startListening(_binding: BridgeSendRecord, _onMessage: InboundHandler): Promise<void> {}
  async stopListening(_bindingId: string): Promise<void> {}
  async validateCredentials(_config: BindingConfig): Promise<boolean> {
    return true;
  }
  async sendVerification(): Promise<boolean> {
    return false;
  }
}

async function main() {
  console.log('\nchannel bridge tests');

  await test('BridgeManager exposes legacy and v2 channel capabilities', async () => {
    const manager = new BridgeManager({} as PrismaClient, {} as never);

    assertEq(manager.getCapabilities('telegram')?.groupNative, false, 'telegram keeps legacy groupNative=false');
    assertEq(manager.getCapabilities('discord')?.supportsVerification, true, 'discord keeps verification');
    assertEq(manager.getCapabilities('wechat')?.groupNative, true, 'wechat is native group capable');
    assertEq(manager.getCapabilities('wecom')?.supportsExternalConversationTarget, true, 'wecom targets groups');
    assertEq(manager.getCapabilities('whatsapp')?.supportsExternalUserTarget, true, 'whatsapp targets users');
  });

  await test('BridgeManager routes v2 outbound by channel account target', async () => {
    const created: Array<Record<string, unknown>> = [];
    const prisma = {
      iMChannelAccount: {
        findUnique: async () => ({
          id: 'ch-1',
          ownerImUserId: 'owner-1',
          platform: 'capture',
          status: 'online',
          credentials: '{}',
          config: '{}',
        }),
      },
      iMBridgeMessage: {
        create: async (args: { data: Record<string, unknown> }) => {
          created.push(args.data);
        },
      },
    } as unknown as PrismaClient;
    const manager = new BridgeManager(prisma, {} as never);
    const bridge = new CaptureBridge();
    manager.registerBridge(bridge);

    await manager.sendToChannelTarget(
      'ch-1',
      { externalConversationId: 'wx-group-9', externalUserId: 'wx-user-7' },
      'hello',
      'im-msg-1',
      'im-conv-1',
    );

    assertEq(bridge.sent?.content, 'hello', 'content routed');
    assertEq(bridge.sent?.target?.externalConversationId, 'wx-group-9', 'external conversation routed');
    assertEq(created[0]?.channelAccountId, 'ch-1', 'channel bridge record uses channel account');
    assertEq(created[0]?.externalGroupId, 'wx-group-9', 'external group recorded');
  });

  await test('new channel bridges validate config and use injected transport', async () => {
    const calls: Array<{ target: BridgeOutboundTarget; content: string }> = [];
    const transport = {
      sendText: async (input: { content: string; target: BridgeOutboundTarget }) => {
        calls.push({ content: input.content, target: input.target });
        return { success: true, externalMessageId: 'sent-1' };
      },
    };
    const account = {
      id: 'ch-2',
      ownerImUserId: 'owner-1',
      platform: 'wechat',
      status: 'online',
      credentials: '{}',
      config: '{}',
    };

    const wechat = new WeChatBridge(transport);
    const wecom = new WeComBridge(transport);
    const whatsapp = new WhatsAppBridge(transport);

    assert(await wechat.validateCredentials({ appId: 'a', appSecret: 's' }), 'wechat config validates');
    assert(await wecom.validateCredentials({ corpId: 'c', corpSecret: 's', agentId: 'a' }), 'wecom config validates');
    assert(await whatsapp.validateCredentials({ accessToken: 't', phoneNumberId: 'p' }), 'whatsapp config validates');

    await wechat.sendMessage(account, 'hi', undefined, { externalGroupId: 'group-1' });
    await wecom.sendMessage({ ...account, platform: 'wecom' }, 'yo', undefined, { externalConversationId: 'room-1' });
    await whatsapp.sendMessage({ ...account, platform: 'whatsapp' }, 'wa', undefined, {
      externalUserId: '15551234567',
    });

    assertEq(
      calls.map((c) => c.content),
      ['hi', 'yo', 'wa'],
      'transport sends all messages',
    );
    assertEq(calls[2]?.target.externalUserId, '15551234567', 'whatsapp user target passed through');
  });

  if (failed > 0) {
    console.error(`\n${failed} failed`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(`\n${passed} passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
