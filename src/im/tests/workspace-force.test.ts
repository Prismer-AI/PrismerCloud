/**
 * Quick test: workspace force option
 */
import { WorkspaceBridgeService } from '../services/workspace-bridge.service';
import Redis from 'ioredis';

const redis = new Redis({ lazyConnect: true });
const svc = new WorkspaceBridgeService(redis);

async function test() {
  const ws = 'test_force_' + Date.now();

  // 1st init
  const r1 = await svc.initializeWorkspace({
    workspaceId: ws,
    userId: 'test_user_1',
    userDisplayName: 'Test User',
    agentName: 'test-agent',
    agentDisplayName: 'Test Agent',
  });
  console.log('1st init OK, conv:', r1.conversationId);

  // 2nd init WITHOUT force — returns same conversation
  const r2 = await svc.initializeWorkspace({
    workspaceId: ws,
    userId: 'test_user_1',
    userDisplayName: 'Test User',
  });
  const sameConv = r2.conversationId === r1.conversationId;
  console.log('2nd init (no force), same conv:', sameConv);
  if (!sameConv) throw new Error('Expected same conversation without force');

  // 3rd init WITH force — creates new conversation
  const r3 = await svc.initializeWorkspace({
    workspaceId: ws,
    userId: 'test_user_1',
    userDisplayName: 'Test User',
    agentName: 'test-agent-3',
    agentDisplayName: 'Test Agent 3',
    force: true,
  });
  const newConv = r3.conversationId !== r1.conversationId;
  console.log('3rd init (force=true), new conv:', newConv, 'id:', r3.conversationId);
  if (!newConv) throw new Error('Expected new conversation with force=true');

  // Group init on same workspace — should fail without force
  try {
    await svc.initializeGroupWorkspace({
      workspaceId: ws,
      title: 'Group',
      users: [{ userId: 'test_user_1', displayName: 'Test' }],
      agents: [],
    });
    throw new Error('group init should have failed');
  } catch (e: any) {
    const blocked = e.message.includes('already has a conversation');
    console.log('Group init blocked correctly:', blocked);
    if (!blocked) throw e;
  }

  // Group init with force — should succeed
  const r4 = await svc.initializeGroupWorkspace({
    workspaceId: ws,
    title: 'Group Force',
    force: true,
    users: [{ userId: 'test_user_1', displayName: 'Test' }],
    agents: [],
  });
  console.log('Group init (force=true) OK, conv:', r4.conversationId);

  console.log('\n--- All workspace force tests passed! ---');
  process.exit(0);
}

test().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
