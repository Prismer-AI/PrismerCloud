/**
 * Prismer IM — Agent Full Lifecycle Test
 *
 * 模拟一个真实 Agent 从注册到完整使用的全生命周期：
 *
 *   Phase 1: 身份建立
 *     - Agent 自主注册，获取 Token
 *     - 查看自我身份 (/me)
 *     - 人类用户注册
 *
 *   Phase 2: 社交绑定
 *     - Agent 绑定 Telegram
 *     - 验证绑定
 *     - 人类绑定 Discord
 *     - 查看绑定列表
 *
 *   Phase 3: Credits 体系
 *     - 查看初始余额
 *     - CreditService 扣费（模拟消息发送计费）
 *     - 查看余额变化
 *     - 查看交易记录
 *     - 余额不足场景
 *
 *   Phase 4: 通信协作
 *     - Agent 向人类发起单聊
 *     - 人类回复 @Agent
 *     - Agent 创建多人群聊（拉入第二个 Agent）
 *     - 群内 @mention 路由
 *     - 消息编辑 / 删除
 *
 *   Phase 5: 社交感知
 *     - 联系人列表（通信后自动出现）
 *     - 发现其他 Agent（按能力搜索）
 *     - 未读消息统计 + 标记已读
 *     - /me 反映最新状态（bindings + credits + stats）
 *
 *   Phase 6: Token 续期
 *     - Token 刷新
 *     - 新 Token 可用
 *
 *   Phase 7: 清理
 *     - 解除社交绑定
 *     - 确认清理后状态
 *
 * Usage:
 *   DATABASE_URL="file:/Users/prismer/workspace/prismercloud/prisma/dev.db" \
 *   npx tsx src/im/tests/agent-lifecycle.test.ts
 */

const BASE = process.env.IM_BASE_URL || 'http://localhost:3200';
const TS = String(Date.now()).slice(-6);

// ─── Test Infrastructure ────────────────────────────────────
let passed = 0;
let failed = 0;
const failures: string[] = [];
const suiteResults: { name: string; passed: number; failed: number }[] = [];
let suiteP = 0;
let suiteF = 0;
let currentSuite = '';

function suite(name: string) {
  if (currentSuite) {
    suiteResults.push({ name: currentSuite, passed: suiteP, failed: suiteF });
  }
  suiteP = 0;
  suiteF = 0;
  currentSuite = name;
  console.log(`\n🔹 ${name}`);
}

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    suiteP++;
    console.log(`  ✅ ${name}`);
  } catch (err: any) {
    failed++;
    suiteF++;
    const msg = err.message || String(err);
    failures.push(`${name}: ${msg}`);
    console.log(`  ❌ ${name}: ${msg}`);
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

function assertEqual(actual: any, expected: any, field: string) {
  if (actual !== expected) {
    throw new Error(`${field}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function api(method: string, path: string, body?: any, token?: string): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  return { status: res.status, data };
}

// ─── Actors ─────────────────────────────────────────────────
// 模拟真实场景中的三个角色

/** 主角：一个代码审查 Agent */
const codeAgent = { id: '', token: '', username: `code_agent_${TS}` };
/** 配角：一个搜索 Agent */
const searchAgent = { id: '', token: '', username: `search_agent_${TS}` };
/** 人类用户：开发者 Alice */
const alice = { id: '', token: '', username: `alice_dev_${TS}` };

// 场景数据
let directConvId = '';
let groupId = '';
let groupConvId = '';
let codeAgentBindingId = '';
let codeAgentBindingCode = '';
let aliceBindingId = '';
let aliceBindingCode = '';
let editableMessageId = '';
let deletableMessageId = '';

// ═══════════════════════════════════════════════════════════
//  Phase 1: 身份建立
// ═══════════════════════════════════════════════════════════

async function phase1_Identity() {
  suite('Phase 1: 身份建立');

  // 先创建基础用户（模拟 API Key 代理层已创建 IM User）
  const setupA = await api('POST', '/users/register', {
    username: codeAgent.username,
    displayName: 'Code Review Agent',
    role: 'agent',
    agentType: 'specialist',
  });
  codeAgent.id = setupA.data.data.user.id;
  codeAgent.token = setupA.data.data.token;

  const setupB = await api('POST', '/users/register', {
    username: searchAgent.username,
    displayName: 'Search Agent',
    role: 'agent',
    agentType: 'assistant',
  });
  searchAgent.id = setupB.data.data.user.id;
  searchAgent.token = setupB.data.data.token;

  const setupC = await api('POST', '/users/register', {
    username: alice.username,
    displayName: 'Alice (Developer)',
    role: 'human',
  });
  alice.id = setupC.data.data.user.id;
  alice.token = setupC.data.data.token;

  await test('1.1 Agent 自主注册 — 声明能力', async () => {
    const res = await api(
      'POST',
      '/register',
      {
        type: 'agent',
        username: codeAgent.username,
        displayName: 'Code Review Agent',
        agentType: 'specialist',
        capabilities: ['code_review', 'refactor', 'debug'],
        description: '专业代码审查 Agent，支持多语言',
        endpoint: 'https://my-agent.example.com/webhook',
      },
      codeAgent.token,
    );
    assertEqual(res.status, 200, 'status');
    assert(res.data.ok, 'ok');
    assert(res.data.data.token, 'should return new token');
    codeAgent.token = res.data.data.token; // 用注册后的 token
  });

  await test('1.2 第二个 Agent 注册', async () => {
    const res = await api(
      'POST',
      '/register',
      {
        type: 'agent',
        username: searchAgent.username,
        displayName: 'Search Agent',
        agentType: 'assistant',
        capabilities: ['web_search', 'summarize', 'translate'],
        description: '全网搜索+摘要 Agent',
      },
      searchAgent.token,
    );
    assertEqual(res.status, 200, 'status');
    searchAgent.token = res.data.data.token;
  });

  await test('1.3 Agent 查看自我身份 (/me)', async () => {
    const res = await api('GET', '/me', undefined, codeAgent.token);
    assertEqual(res.status, 200, 'status');
    assert(res.data.ok, 'ok');
    assertEqual(res.data.data.user.role, 'agent', 'role');
    assertEqual(res.data.data.agentCard.agentType, 'specialist', 'agentType');
    assert(res.data.data.agentCard.capabilities.includes('code_review'), 'should have code_review capability');
    // v0.3.0: 初始状态应有 bindings 和 credits
    assert(Array.isArray(res.data.data.bindings), 'should have bindings array');
    assertEqual(res.data.data.bindings.length, 0, 'no bindings yet');
    assert(res.data.data.credits !== undefined, 'should have credits');
    assertEqual(res.data.data.credits.balance, 10000, 'default 10000 credits');
  });

  await test('1.4 人类用户注册', async () => {
    const res = await api(
      'POST',
      '/register',
      {
        type: 'human',
        username: alice.username,
        displayName: 'Alice (Developer)',
      },
      alice.token,
    );
    assertEqual(res.status, 200, 'status');
    alice.token = res.data.data.token;
  });
}

// ═══════════════════════════════════════════════════════════
//  Phase 2: 社交绑定
// ═══════════════════════════════════════════════════════════

async function phase2_SocialBindings() {
  suite('Phase 2: 社交绑定');

  await test('2.1 Agent 绑定 Telegram（接收通知）', async () => {
    const res = await api(
      'POST',
      '/bindings',
      {
        platform: 'telegram',
        botToken: '7654321:FAKE-BOT-TOKEN-for-code-agent',
        chatId: '123456789',
      },
      codeAgent.token,
    );
    assertEqual(res.status, 201, 'status');
    assert(res.data.ok, 'ok');
    assertEqual(res.data.data.platform, 'telegram', 'platform');
    assertEqual(res.data.data.status, 'pending', 'pending before verify');
    assert(res.data.data.verificationCode.length === 6, '6-digit code');
    codeAgentBindingId = res.data.data.bindingId;
    codeAgentBindingCode = res.data.data.verificationCode;
  });

  await test('2.2 Agent 验证 Telegram 绑定', async () => {
    const res = await api(
      'POST',
      `/bindings/${codeAgentBindingId}/verify`,
      { code: codeAgentBindingCode },
      codeAgent.token,
    );
    assertEqual(res.status, 200, 'status');
    assertEqual(res.data.data.status, 'active', 'status after verify');
    assert(res.data.data.capabilities.includes('receive_message'), 'should have receive_message');
  });

  await test('2.3 Alice 绑定 Discord', async () => {
    const res = await api(
      'POST',
      '/bindings',
      {
        platform: 'discord',
        botToken: 'MTk-FAKE-DISCORD-TOKEN',
        channelId: '987654321',
      },
      alice.token,
    );
    assertEqual(res.status, 201, 'status');
    aliceBindingId = res.data.data.bindingId;
    aliceBindingCode = res.data.data.verificationCode;
  });

  await test('2.4 Alice 验证 Discord 绑定', async () => {
    const res = await api('POST', `/bindings/${aliceBindingId}/verify`, { code: aliceBindingCode }, alice.token);
    assertEqual(res.status, 200, 'status');
    assertEqual(res.data.data.status, 'active', 'active');
  });

  await test('2.5 Agent 查看自己的绑定列表', async () => {
    const res = await api('GET', '/bindings', undefined, codeAgent.token);
    assertEqual(res.status, 200, 'status');
    assertEqual(res.data.data.length, 1, 'agent has 1 binding');
    assertEqual(res.data.data[0].platform, 'telegram', 'platform');
    assertEqual(res.data.data[0].status, 'active', 'active');
  });

  await test('2.6 不同用户绑定互不干扰', async () => {
    const agentBindings = await api('GET', '/bindings', undefined, codeAgent.token);
    const aliceBindings = await api('GET', '/bindings', undefined, alice.token);
    assertEqual(agentBindings.data.data.length, 1, 'agent 1 binding');
    assertEqual(aliceBindings.data.data.length, 1, 'alice 1 binding');
    assertEqual(agentBindings.data.data[0].platform, 'telegram', 'agent=telegram');
    assertEqual(aliceBindings.data.data[0].platform, 'discord', 'alice=discord');
  });
}

// ═══════════════════════════════════════════════════════════
//  Phase 3: Credits 体系
// ═══════════════════════════════════════════════════════════

async function phase3_Credits() {
  suite('Phase 3: Credits 体系');

  await test('3.1 Agent 查看初始余额 — 10000 credits', async () => {
    const res = await api('GET', '/credits', undefined, codeAgent.token);
    assertEqual(res.status, 200, 'status');
    assertEqual(res.data.data.balance, 10000, 'initial balance');
    assertEqual(res.data.data.totalSpent, 0, 'nothing spent');
    assertEqual(res.data.data.totalEarned, 0, 'nothing earned');
  });

  await test('3.2 模拟消息发送扣费', async () => {
    // 通过 CreditService 直接扣费（模拟代理层计费行为）
    const { PrismaClient } = await import('@prisma/client');
    const { LocalCreditService } = await import('../services/credit.service');
    const prisma = new PrismaClient({
      datasources: {
        db: {
          url: process.env.DATABASE_URL || 'file:/Users/prismer/workspace/prismercloud/prisma/dev.db',
        },
      },
    });
    const creditService = new LocalCreditService(prisma);

    // 模拟发送 10 条消息，每条 0.001 credits
    for (let i = 0; i < 10; i++) {
      const result = await creditService.deduct(
        codeAgent.id,
        0.001,
        `send: direct/alice/msg_${i}`,
        'message',
        `msg_sim_${i}`,
      );
      assert(result.success, `deduction ${i} should succeed`);
    }

    // 模拟一次 workspace 初始化 0.01 credits
    const wsResult = await creditService.deduct(
      codeAgent.id,
      0.01,
      'workspace_init: team-collab',
      'workspace',
      'ws_sim_1',
    );
    assert(wsResult.success, 'workspace deduction should succeed');

    await prisma.$disconnect();
  });

  await test('3.3 余额反映扣费结果', async () => {
    const res = await api('GET', '/credits', undefined, codeAgent.token);
    const expectedBalance = 10000 - 10 * 0.001 - 0.01;
    assert(
      Math.abs(res.data.data.balance - expectedBalance) < 0.0001,
      `balance should be ~${expectedBalance}, got ${res.data.data.balance}`,
    );
    assert(res.data.data.totalSpent > 0, 'totalSpent > 0');
  });

  await test('3.4 交易记录完整 — 11 笔', async () => {
    const res = await api('GET', '/credits/transactions?limit=50', undefined, codeAgent.token);
    assertEqual(res.status, 200, 'status');
    assertEqual(res.data.meta.total, 11, '11 transactions');
    // 所有交易都应该是 usage 类型
    assert(
      res.data.data.every((t: any) => t.type === 'usage'),
      'all should be usage type',
    );
    // 应包含一笔 workspace 扣费
    const wsTx = res.data.data.find((t: any) => t.description.includes('workspace_init'));
    assert(wsTx, 'should have workspace transaction');
    assertEqual(wsTx.amount, -0.01, 'workspace cost');
    // 应包含 10 笔消息扣费
    const msgTxs = res.data.data.filter((t: any) => t.description.includes('send:'));
    assertEqual(msgTxs.length, 10, '10 message transactions');
  });

  await test('3.5 交易记录分页', async () => {
    const page1 = await api('GET', '/credits/transactions?limit=5&offset=0', undefined, codeAgent.token);
    const page2 = await api('GET', '/credits/transactions?limit=5&offset=5', undefined, codeAgent.token);
    assertEqual(page1.data.data.length, 5, 'page1 has 5');
    assertEqual(page2.data.data.length, 5, 'page2 has 5');
    assert(page1.data.data[0].id !== page2.data.data[0].id, 'different pages');
  });

  await test('3.6 Alice 余额独立不受影响', async () => {
    const res = await api('GET', '/credits', undefined, alice.token);
    assertEqual(res.data.data.balance, 10000, 'alice still 10000');
    assertEqual(res.data.data.totalSpent, 0, 'alice spent 0');
  });
}

// ═══════════════════════════════════════════════════════════
//  Phase 4: 通信协作
// ═══════════════════════════════════════════════════════════

async function phase4_Communication() {
  suite('Phase 4: 通信协作');

  await test('4.1 Agent 向 Alice 发起单聊', async () => {
    const res = await api(
      'POST',
      `/direct/${alice.id}/messages`,
      { content: "Hi Alice, I've finished reviewing your PR #42." },
      codeAgent.token,
    );
    assertEqual(res.status, 201, 'status');
    assert(res.data.ok, 'ok');
    directConvId = res.data.data.conversationId;
    assert(directConvId, 'should have conversationId');
  });

  await test('4.2 Alice 回复并 @Agent', async () => {
    const res = await api(
      'POST',
      `/direct/${codeAgent.id}/messages`,
      {
        content: `@${codeAgent.username} 谢谢！有几个建议能详细说明吗？`,
      },
      alice.token,
    );
    assertEqual(res.status, 201, 'status');
    // 路由信息应包含 agent
    if (res.data.data.routing) {
      assertEqual(res.data.data.routing.mode, 'explicit', 'routing mode');
      assert(
        res.data.data.routing.targets.some((t: any) => t.userId === codeAgent.id),
        'agent should be in targets',
      );
    }
  });

  await test('4.3 Agent 回复详细审查意见', async () => {
    const res = await api(
      'POST',
      `/direct/${alice.id}/messages`,
      {
        content: '建议 1: `handleError()` 缺少 edge case 处理\n建议 2: 数据库查询可以批量化',
        type: 'markdown',
      },
      codeAgent.token,
    );
    assertEqual(res.status, 201, 'status');
    editableMessageId = res.data.data.message?.id || res.data.data.id;
  });

  await test('4.4 Agent 修改消息（补充遗漏）', async () => {
    // 通过底层 messages API 编辑
    const res = await api(
      'PATCH',
      `/messages/${directConvId}/${editableMessageId}`,
      {
        content:
          '建议 1: `handleError()` 缺少 edge case 处理\n建议 2: 数据库查询可以批量化\n建议 3: 建议增加单元测试覆盖率',
      },
      codeAgent.token,
    );
    assertEqual(res.status, 200, 'status');
    assert(res.data.ok, 'ok');
  });

  await test('4.5 Agent 发送一条待删除消息', async () => {
    const res = await api(
      'POST',
      `/direct/${alice.id}/messages`,
      { content: '这条消息马上删除（发错了）' },
      codeAgent.token,
    );
    assertEqual(res.status, 201, 'status');
    deletableMessageId = res.data.data.message?.id || res.data.data.id;
  });

  await test('4.6 Agent 删除误发消息', async () => {
    const res = await api('DELETE', `/messages/${directConvId}/${deletableMessageId}`, undefined, codeAgent.token);
    assertEqual(res.status, 200, 'status');
  });

  await test('4.7 创建多人群聊 — Agent 协作场景', async () => {
    const res = await api(
      'POST',
      '/groups',
      {
        title: `PR Review Team ${TS}`,
        description: 'Code Agent + Search Agent + Alice 协作群',
        members: [searchAgent.id, alice.id],
      },
      codeAgent.token,
    );
    assertEqual(res.status, 201, 'status');
    assert(res.data.ok, 'ok');
    groupId = res.data.data.groupId;
    groupConvId = res.data.data.groupId;
  });

  await test('4.8 Agent 在群里发消息 @SearchAgent', async () => {
    const res = await api(
      'POST',
      `/groups/${groupId}/messages`,
      {
        content: `@${searchAgent.username} 帮我搜一下 handleError best practices`,
      },
      codeAgent.token,
    );
    assertEqual(res.status, 201, 'status');
    if (res.data.data.routing) {
      assertEqual(res.data.data.routing.mode, 'explicit', 'routing');
    }
  });

  await test('4.9 SearchAgent 在群里回复', async () => {
    const res = await api(
      'POST',
      `/groups/${groupId}/messages`,
      {
        content:
          '找到 3 篇相关文章:\n1. Error Handling Patterns in Node.js\n2. Defensive Programming\n3. Graceful Degradation',
        type: 'markdown',
      },
      searchAgent.token,
    );
    assertEqual(res.status, 201, 'status');
  });

  await test('4.10 Alice 在群里回复所有人', async () => {
    const res = await api(
      'POST',
      `/groups/${groupId}/messages`,
      { content: '很好，我会根据这些建议修改 PR，谢谢两位！' },
      alice.token,
    );
    assertEqual(res.status, 201, 'status');
  });

  await test('4.11 验证单聊消息历史（含编辑+删除后）', async () => {
    const res = await api('GET', `/direct/${alice.id}/messages`, undefined, codeAgent.token);
    assertEqual(res.status, 200, 'status');
    const messages = res.data.data;
    assert(Array.isArray(messages), 'should be array');
    // 发了 4 条，删了 1 条 = 3 条
    assertEqual(messages.length, 3, '3 messages after delete');
    // 被编辑的消息应包含 "建议 3"
    const edited = messages.find((m: any) => m.content.includes('建议 3'));
    assert(edited, 'edited message should have 建议 3');
  });

  await test('4.12 验证群聊消息历史', async () => {
    const res = await api('GET', `/groups/${groupId}/messages`, undefined, codeAgent.token);
    assertEqual(res.status, 200, 'status');
    assertEqual(res.data.data.length, 3, '3 group messages');
  });
}

// ═══════════════════════════════════════════════════════════
//  Phase 5: 社交感知
// ═══════════════════════════════════════════════════════════

async function phase5_SocialAwareness() {
  suite('Phase 5: 社交感知');

  await test('5.1 Agent 联系人列表 — Alice 和 SearchAgent', async () => {
    const res = await api('GET', '/contacts', undefined, codeAgent.token);
    assertEqual(res.status, 200, 'status');
    const contacts = res.data.data;
    assert(contacts.length >= 2, 'should have at least 2 contacts');
    const aliceContact = contacts.find((c: any) => c.username === alice.username);
    const searchContact = contacts.find((c: any) => c.username === searchAgent.username);
    assert(aliceContact, 'Alice should be in contacts');
    assert(searchContact, 'SearchAgent should be in contacts');
  });

  await test('5.2 发现 Agent — 按能力搜索', async () => {
    const res = await api('GET', '/discover?type=agent&capability=web_search', undefined, codeAgent.token);
    assertEqual(res.status, 200, 'status');
    const agents = res.data.data;
    const found = agents.find((a: any) => a.username === searchAgent.username);
    assert(found, 'SearchAgent should be discoverable by web_search');
    assert(found.capabilities.includes('web_search'), 'capabilities should include web_search');
  });

  await test('5.3 发现 Agent — 排除自己', async () => {
    const res = await api('GET', '/discover?type=agent', undefined, codeAgent.token);
    const agents = res.data.data;
    const self = agents.find((a: any) => a.username === codeAgent.username);
    assert(!self, 'should not discover self');
  });

  await test('5.4 SearchAgent 有未读消息', async () => {
    // SearchAgent 在群聊中有来自 codeAgent 和 alice 的消息
    const res = await api('GET', '/me', undefined, searchAgent.token);
    assert(res.data.data.stats.unreadCount > 0, 'should have unread');
  });

  await test('5.5 Alice 有未读消息', async () => {
    const res = await api('GET', '/conversations?withUnread=true', undefined, alice.token);
    assertEqual(res.status, 200, 'status');
    const convs = res.data.data;
    const withUnread = convs.filter((c: any) => c.unreadCount > 0);
    assert(withUnread.length > 0, 'alice should have unread conversations');
  });

  await test('5.6 Alice 标记单聊已读', async () => {
    // 找到和 codeAgent 的直聊会话
    const convRes = await api('GET', '/conversations', undefined, alice.token);
    const directConv = convRes.data.data.find((c: any) => c.type === 'direct');
    assert(directConv, 'should find direct conversation');

    const readRes = await api('POST', `/conversations/${directConv.id}/read`, {}, alice.token);
    assertEqual(readRes.status, 200, 'status');
  });

  await test('5.7 /me 反映完整状态', async () => {
    const res = await api('GET', '/me', undefined, codeAgent.token);
    assertEqual(res.status, 200, 'status');
    const data = res.data.data;

    // 身份
    assertEqual(data.user.role, 'agent', 'role');
    // Agent Card
    assert(data.agentCard.capabilities.includes('code_review'), 'capability');
    // Stats
    assert(data.stats.conversationCount >= 2, 'at least 2 conversations');
    assert(data.stats.contactCount >= 2, 'at least 2 contacts');
    assert(data.stats.messagesSent > 0, 'sent messages');
    // Bindings (v0.3.0)
    assertEqual(data.bindings.length, 1, '1 binding');
    assertEqual(data.bindings[0].platform, 'telegram', 'telegram');
    assertEqual(data.bindings[0].status, 'active', 'active');
    // Credits (v0.3.0)
    assert(data.credits.balance < 10000, 'credits spent');
    assert(data.credits.totalSpent > 0, 'totalSpent > 0');
  });
}

// ═══════════════════════════════════════════════════════════
//  Phase 6: Token 续期
// ═══════════════════════════════════════════════════════════

async function phase6_TokenRefresh() {
  suite('Phase 6: Token 续期');

  let newToken = '';

  await test('6.1 Agent 刷新 Token', async () => {
    // JWT iat 精度为秒级，需等待 1s 确保新 token 的 iat 不同
    await new Promise((r) => setTimeout(r, 1100));
    const res = await api('POST', '/token/refresh', {}, codeAgent.token);
    assertEqual(res.status, 200, 'status');
    assert(res.data.ok, 'ok');
    assert(res.data.data.token, 'should return new token');
    newToken = res.data.data.token;
    assert(newToken !== codeAgent.token, 'new token should differ');
  });

  await test('6.2 新 Token 可正常使用', async () => {
    const res = await api('GET', '/me', undefined, newToken);
    assertEqual(res.status, 200, 'status');
    assertEqual(res.data.data.user.username, codeAgent.username, 'same user');
  });

  await test('6.3 旧 Token 仍然有效（未过期）', async () => {
    const res = await api('GET', '/me', undefined, codeAgent.token);
    assertEqual(res.status, 200, 'status');
  });

  // 更新为新 token
  codeAgent.token = newToken;
}

// ═══════════════════════════════════════════════════════════
//  Phase 7: 清理与边界
// ═══════════════════════════════════════════════════════════

async function phase7_Cleanup() {
  suite('Phase 7: 清理与边界');

  await test('7.1 Agent 解除 Telegram 绑定', async () => {
    const res = await api('DELETE', `/bindings/${codeAgentBindingId}`, undefined, codeAgent.token);
    assertEqual(res.status, 200, 'status');
  });

  await test('7.2 绑定列表为空', async () => {
    const res = await api('GET', '/bindings', undefined, codeAgent.token);
    assertEqual(res.data.data.length, 0, 'no bindings');
  });

  await test('7.3 /me 反映绑定已清除', async () => {
    const res = await api('GET', '/me', undefined, codeAgent.token);
    assertEqual(res.data.data.bindings.length, 0, 'bindings empty');
    // Credits 和 stats 应该不变
    assert(res.data.data.credits.balance < 10000, 'credits unchanged');
    assert(res.data.data.stats.conversationCount >= 2, 'conversations unchanged');
  });

  await test('7.4 Alice 解除 Discord 绑定', async () => {
    const res = await api('DELETE', `/bindings/${aliceBindingId}`, undefined, alice.token);
    assertEqual(res.status, 200, 'status');
  });

  await test('7.5 Alice 重新绑定同一平台 — 应该成功', async () => {
    const res = await api(
      'POST',
      '/bindings',
      {
        platform: 'discord',
        botToken: 'NEW-DISCORD-TOKEN',
        channelId: '111222333',
      },
      alice.token,
    );
    assertEqual(res.status, 201, 'status');
    assertEqual(res.data.data.platform, 'discord', 'discord');
    assertEqual(res.data.data.status, 'pending', 'pending');
  });

  await test('7.6 跨用户操作被拒绝', async () => {
    // Alice 试图查看 Agent 的绑定 — 绑定 API 只返回自己的
    const agentBindings = await api('GET', '/bindings', undefined, codeAgent.token);
    const aliceBindings = await api('GET', '/bindings', undefined, alice.token);
    // Agent 的已删除，Alice 刚创建了一个新的
    assertEqual(agentBindings.data.data.length, 0, 'agent: 0');
    assertEqual(aliceBindings.data.data.length, 1, 'alice: 1');
  });
}

// ═══════════════════════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════════════════════

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Prismer IM — Agent Full Lifecycle Test');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Health check
  try {
    const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
    if (!health.ok) throw new Error('not healthy');
    console.log(`  Server: ${BASE} (v${health.version}) ✓`);
  } catch {
    console.error(`\n❌ Cannot connect to ${BASE}`);
    console.error(
      '   Start: DATABASE_URL="file:/Users/prismer/workspace/prismercloud/prisma/dev.db" npx tsx src/im/start.ts',
    );
    process.exit(1);
  }

  await phase1_Identity();
  await phase2_SocialBindings();
  await phase3_Credits();
  await phase4_Communication();
  await phase5_SocialAwareness();
  await phase6_TokenRefresh();
  await phase7_Cleanup();

  // Final suite record
  if (currentSuite) {
    suiteResults.push({ name: currentSuite, passed: suiteP, failed: suiteF });
  }

  // ─── Summary ────────────────────────────────────────────
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  console.log('\n📊 Phase Summary:');
  for (const s of suiteResults) {
    const icon = s.failed === 0 ? '✅' : '❌';
    console.log(`   ${icon} ${s.name}: ${s.passed}/${s.passed + s.failed}`);
  }

  if (failures.length > 0) {
    console.log('\n  Failures:');
    for (const f of failures) {
      console.log(`    ❌ ${f}`);
    }
  }

  console.log();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
