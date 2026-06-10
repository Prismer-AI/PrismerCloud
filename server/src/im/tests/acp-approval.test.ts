/**
 * ACP P3 approval regression tests.
 *
 * Covers:
 *   - approval resume/idempotency after a decision
 *   - approval security: requester self-approval and invalid options are denied
 *   - approval RBAC: workspace human/admin allowed, agent/outsider denied
 *   - MCP allowlist maps approval creation to prismer.approval.request_human_approval
 *
 * Run:
 *   rm -f /tmp/prismer-acp-approval.db
 *   DATABASE_URL="file:/tmp/prismer-acp-approval.db" \
 *     npx prisma db push --schema prisma/schema.prisma --skip-generate --accept-data-loss
 *   DATABASE_URL="file:/tmp/prismer-acp-approval.db" npx tsx src/im/tests/acp-approval.test.ts
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import prisma from '../db';
import { ApprovalService } from '../services/approval.service';

const execFileAsync = promisify(execFile);
const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

const ownerId = `acp_owner_${suffix}`;
const memberId = `acp_member_${suffix}`;
const outsiderId = `acp_outsider_${suffix}`;
const agentId = `acp_agent_${suffix}`;
const adminId = `acp_admin_${suffix}`;
const trustedId = `acp_trusted_${suffix}`;
const workspaceId = `acp_ws_${suffix}`;
const otherWorkspaceId = `acp_other_ws_${suffix}`;
const conversationId = `acp_conv_${suffix}`;
const otherConversationId = `acp_other_conv_${suffix}`;
const taskId = `acp_task_${suffix}`;

const service = new ApprovalService();
let passed = 0;
let failed = 0;
const resumeCalls: unknown[] = [];
const serviceWithResume = new ApprovalService({
  resumeAfterApprovalDecision: async (input: unknown) => {
    resumeCalls.push(input);
    return { taskId: (input as { taskId: string }).taskId, resumed: true, reason: 'resumed', runId: 'run_acp_test' };
  },
} as any);
const serviceWithFailingResume = new ApprovalService({
  resumeAfterApprovalDecision: async () => {
    throw new Error('dispatch unavailable');
  },
} as any);

async function runTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(err);
  }
}

async function cleanup() {
  await prisma.iMApproval.deleteMany({ where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } } });
  await prisma.iMTask.deleteMany({ where: { id: taskId } });
  await prisma.iMConversation.deleteMany({ where: { id: { in: [conversationId, otherConversationId] } } });
  await prisma.iMWorkspaceMember.deleteMany({ where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } } });
  await prisma.iMWorkspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } });
  await prisma.iMUser.deleteMany({
    where: { id: { in: [ownerId, memberId, outsiderId, agentId, adminId, trustedId] } },
  });
}

async function setup() {
  await prisma.iMUser.createMany({
    data: [
      { id: ownerId, username: `acp_owner_${suffix}`, displayName: 'Owner', role: 'human' },
      { id: memberId, username: `acp_member_${suffix}`, displayName: 'Member', role: 'human' },
      { id: outsiderId, username: `acp_outsider_${suffix}`, displayName: 'Outsider', role: 'human' },
      { id: agentId, username: `acp_agent_${suffix}`, displayName: 'Agent', role: 'agent' },
      { id: adminId, username: `acp_admin_${suffix}`, displayName: 'Admin', role: 'admin' },
      { id: trustedId, username: `acp_trusted_${suffix}`, displayName: 'Trusted', role: 'human', trustTier: 4 },
    ],
  });

  await prisma.iMWorkspace.createMany({
    data: [
      { id: workspaceId, ownerImUserId: ownerId, name: 'ACP', slug: `acp_${suffix}`, isDefault: true },
      {
        id: otherWorkspaceId,
        ownerImUserId: outsiderId,
        name: 'Other ACP',
        slug: `acp_other_${suffix}`,
        isDefault: true,
      },
    ],
  });

  await prisma.iMWorkspaceMember.createMany({
    data: [
      { workspaceId, memberImUserId: memberId, role: 'member' },
      { workspaceId, memberImUserId: agentId, role: 'member' },
    ],
  });

  await prisma.iMConversation.createMany({
    data: [
      { id: conversationId, type: 'direct', createdById: ownerId, workspaceId },
      { id: otherConversationId, type: 'direct', createdById: outsiderId, workspaceId: otherWorkspaceId },
    ],
  });

  await prisma.iMTask.create({
    data: {
      id: taskId,
      title: 'ACP gated task',
      creatorId: ownerId,
      workspaceId,
      conversationId,
    },
  });
}

async function createApproval(overrides: Partial<Parameters<ApprovalService['create']>[0]> = {}) {
  return service.create({
    workspaceId,
    conversationId,
    requestedById: ownerId,
    category: 'security',
    title: 'Approve production action',
    options: [
      { value: 'approve', label: 'Approve' },
      { value: 'reject', label: 'Reject' },
    ],
    metadata: { gate: 'acp-p3' },
    ...overrides,
  });
}

function statusIs(err: unknown, status: number) {
  return typeof (err as { status?: unknown })?.status === 'number' && (err as { status: number }).status === status;
}

async function runMcpAllowlistCase(allowlist: string, expected: 'allowed' | 'blocked') {
  const code = `
    import { assertMcpToolAllowed, prismerFetch } from './sdk/prismer-cloud/mcp/src/lib/client.ts';
    try {
      assertMcpToolAllowed('prismer.approval.request_human_approval');
      await prismerFetch('/api/im/approvals', { method: 'POST', body: { workspaceId: 'ws' } });
      console.log('allowed');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('tool_not_allowed_for_agent: prismer.approval.request_human_approval')) {
        console.log('blocked');
      } else if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
        console.log('allowed');
      } else {
        console.error(message);
        process.exit(2);
      }
    }
  `;
  const { stdout } = await execFileAsync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', code], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PRISMER_API_KEY: 'sk-prismer-acp-test',
      PRISMER_BASE_URL: 'http://127.0.0.1:9',
      PRISMER_MCP_ALLOWLIST: allowlist,
    },
  });
  assert.equal(stdout.trim(), expected);
}

async function main() {
  console.log('[acp-approval] setup fixtures');
  await cleanup();
  await setup();

  await runTest('create — requires conversationId or taskId resume surface', async () => {
    await assert.rejects(
      createApproval({ conversationId: null, taskId: null }),
      (err: unknown) =>
        err instanceof Error && err.message === 'conversationId or taskId is required' && statusIs(err, 400),
    );
  });

  await runTest('create — rejects conversation outside workspace', async () => {
    await assert.rejects(
      createApproval({ conversationId: otherConversationId }),
      (err: unknown) =>
        err instanceof Error && err.message === 'Conversation not found in workspace' && statusIs(err, 400),
    );
  });

  await runTest('create — task-gated approval is accepted', async () => {
    const approval = await createApproval({ conversationId: null, taskId });
    assert.equal(approval.taskId, taskId);
    assert.equal(approval.status, 'pending');
  });

  await runTest('decide — requester cannot approve own request', async () => {
    const approval = await createApproval();
    await assert.rejects(
      service.decide(approval.id, ownerId, { selectedValue: 'approve' }),
      (err: unknown) =>
        err instanceof Error &&
        err.message === 'Approval requester cannot decide their own request' &&
        statusIs(err, 403),
    );
  });

  await runTest('decide — invalid option is rejected before state change', async () => {
    const approval = await createApproval();
    await assert.rejects(
      service.decide(approval.id, memberId, { selectedValue: 'ship-it' }),
      (err: unknown) =>
        err instanceof Error && err.message === 'selectedValue is not a valid approval option' && statusIs(err, 400),
    );
    const current = await prisma.iMApproval.findUniqueOrThrow({ where: { id: approval.id } });
    assert.equal(current.status, 'pending');
    assert.equal(current.decidedById, null);
  });

  await runTest('decide — expired pending approval cannot be decided', async () => {
    const approval = await createApproval({ expiresAt: new Date(Date.now() - 1000) });
    await assert.rejects(
      service.decide(approval.id, memberId, { selectedValue: 'approve' }),
      (err: unknown) => err instanceof Error && err.message === 'Approval has expired' && statusIs(err, 409),
    );
    const current = await prisma.iMApproval.findUniqueOrThrow({ where: { id: approval.id } });
    assert.equal(current.status, 'expired');
    assert.equal(current.decidedById, null);
  });

  await runTest('decide — workspace human member can approve', async () => {
    const approval = await createApproval();
    const decided = await service.decide(approval.id, memberId, {
      selectedValue: 'approve',
      metadata: { resumeToken: 'r1' },
    });
    assert.equal(decided.changed, true);
    assert.equal(decided.approval.status, 'approved');
    assert.equal(decided.approval.selectedValue, 'approve');
    assert.equal(decided.approval.decidedById, memberId);
    assert.deepEqual(decided.approval.metadata.decidedOption, { value: 'approve', label: 'Approve' });
    assert.equal(decided.approval.metadata.resumeToken, 'r1');
  });

  await runTest('decide — task-gated approval invokes resume hook', async () => {
    resumeCalls.length = 0;
    const approval = await createApproval({ conversationId: null, taskId });
    const decided = await serviceWithResume.decide(approval.id, memberId, { selectedValue: 'approve' });
    assert.equal(decided.approval.status, 'approved');
    assert.deepEqual(decided.resume, { taskId, resumed: true, reason: 'resumed', runId: 'run_acp_test' });
    assert.equal(resumeCalls.length, 1);
    const resumeCall = resumeCalls[0] as Record<string, unknown>;
    assert.deepEqual(
      {
        approvalId: resumeCall.approvalId,
        taskId: resumeCall.taskId,
        actorId: resumeCall.actorId,
        status: resumeCall.status,
        selectedValue: resumeCall.selectedValue,
        category: resumeCall.category,
        title: resumeCall.title,
        metadata: resumeCall.metadata,
      },
      {
        approvalId: approval.id,
        taskId,
        actorId: memberId,
        status: 'approved',
        selectedValue: 'approve',
        category: 'security',
        title: 'Approve production action',
        metadata: {
          gate: 'acp-p3',
          decidedOption: { value: 'approve', label: 'Approve' },
        },
      },
    );
    assert.equal(resumeCall.requestedById, ownerId);
    assert.equal(resumeCall.decidedById, memberId);
    assert.equal(typeof resumeCall.decidedAt, 'string');
  });

  await runTest('decide — resume failure keeps approval retryable', async () => {
    const approval = await createApproval({ conversationId: null, taskId });
    await assert.rejects(
      serviceWithFailingResume.decide(approval.id, memberId, { selectedValue: 'approve' }),
      (err: unknown) =>
        err instanceof Error &&
        err.message === 'Approval decision recorded but task resume failed: dispatch unavailable' &&
        statusIs(err, 503),
    );
    const current = await prisma.iMApproval.findUniqueOrThrow({ where: { id: approval.id } });
    const metadata = JSON.parse(current.metadata);
    assert.equal(current.status, 'pending');
    assert.equal(current.selectedValue, null);
    assert.equal(current.decidedById, null);
    assert.equal(current.decidedAt, null);
    assert.equal(metadata.resume.ok, false);
    assert.equal(metadata.resume.error, 'dispatch unavailable');

    const retried = await serviceWithResume.decide(approval.id, memberId, { selectedValue: 'approve' });
    assert.equal(retried.approval.status, 'approved');
    assert.equal(retried.resume?.resumed, true);
  });

  await runTest('decide — completed approval rejects replay without changing original decision', async () => {
    const approval = await createApproval();
    const first = await service.decide(approval.id, memberId, { selectedValue: 'approve' });
    await assert.rejects(
      service.decide(approval.id, adminId, { selectedValue: 'reject', metadata: { late: true } }),
      (err: unknown) => err instanceof Error && err.message === 'Approval is already approved' && statusIs(err, 409),
    );
    const current = await prisma.iMApproval.findUniqueOrThrow({ where: { id: approval.id } });
    assert.equal(current.status, 'approved');
    assert.equal(current.selectedValue, 'approve');
    assert.equal(current.decidedById, memberId);
    assert.equal(current.decidedAt?.toISOString(), first.approval.decidedAt);
    assert.equal(JSON.parse(current.metadata).late, undefined);
  });

  await runTest('decide — agent workspace member is denied', async () => {
    const approval = await createApproval();
    await assert.rejects(
      service.decide(approval.id, agentId, { selectedValue: 'approve' }),
      (err: unknown) =>
        err instanceof Error &&
        err.message === 'Only a human workspace member can decide approvals' &&
        statusIs(err, 403),
    );
  });

  await runTest('decide — outsider human is denied by workspace boundary', async () => {
    const approval = await createApproval();
    await assert.rejects(
      service.decide(approval.id, outsiderId, { selectedValue: 'approve' }),
      (err: unknown) => err instanceof Error && err.message === 'Workspace not found' && statusIs(err, 404),
    );
  });

  await runTest('decide — admin and trust tier 4 bypass workspace membership', async () => {
    const adminApproval = await createApproval();
    const trustedApproval = await createApproval();
    const adminDecision = await service.decide(adminApproval.id, adminId, { selectedValue: 'approve' });
    const trustedDecision = await service.decide(trustedApproval.id, trustedId, { selectedValue: 'reject' });
    assert.equal(adminDecision.approval.status, 'approved');
    assert.equal(trustedDecision.approval.status, 'rejected');
  });

  await runTest('list — only workspace-accessible approvals are returned', async () => {
    const visible = await createApproval({ title: 'Visible approval' });
    await prisma.iMApproval.create({
      data: {
        workspaceId: otherWorkspaceId,
        conversationId: otherConversationId,
        requestedById: outsiderId,
        category: 'security',
        title: 'Hidden approval',
      },
    });
    const ownerList = await service.list({ requesterId: ownerId });
    const outsiderList = await service.list({ requesterId: outsiderId });
    assert.ok(
      ownerList.some((item) => item.id === visible.id),
      'owner should see own workspace approval',
    );
    assert.equal(
      ownerList.some((item) => item.title === 'Hidden approval'),
      false,
    );
    assert.ok(
      outsiderList.some((item) => item.title === 'Hidden approval'),
      'outsider should see other workspace approval',
    );
    assert.equal(
      outsiderList.some((item) => item.id === visible.id),
      false,
    );
  });

  await runTest('mcp allowlist — exact approval tool permits approval POST', async () => {
    await runMcpAllowlistCase('prismer.approval.request_human_approval', 'allowed');
  });

  await runTest('mcp allowlist — wildcard approval namespace permits approval POST', async () => {
    await runMcpAllowlistCase('prismer.approval.*', 'allowed');
  });

  await runTest('mcp allowlist — unrelated task-only allowlist blocks approval POST', async () => {
    await runMcpAllowlistCase('prismer.task.*', 'blocked');
  });

  await cleanup();
  await prisma.$disconnect();

  console.log(`\n[acp-approval] passed=${passed} failed=${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
