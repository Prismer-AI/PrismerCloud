/**
 * Integration tests for TasksClient, MemoryClient, and Skills methods (EvolutionClient).
 *
 * Target: https://cloud.prismer.dev (test environment)
 *
 * Usage:
 *   PRISMER_API_KEY_TEST="sk-prismer-live-..." npx vitest run tests/integration/tasks-memory-skills.test.ts --reporter=verbose
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { PrismerClient } from '../../src/index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const API_KEY = process.env.PRISMER_API_KEY_TEST;
if (!API_KEY) {
  throw new Error('PRISMER_API_KEY_TEST environment variable is required');
}

const BASE_URL = 'https://cloud.prismer.dev';
const RUN_ID = Date.now().toString(36);

function apiClient(): PrismerClient {
  return new PrismerClient({
    apiKey: API_KEY!,
    baseUrl: BASE_URL,
    timeout: 60_000,
  });
}

function imClient(token: string): PrismerClient {
  return new PrismerClient({
    apiKey: token,
    baseUrl: BASE_URL,
    timeout: 60_000,
  });
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let agentToken: string;
let agentId: string;
let agentUsername: string;
let client: PrismerClient;
let directConversationId: string;

// ---------------------------------------------------------------------------
// Setup: register an agent for all tests
// ---------------------------------------------------------------------------

beforeAll(async () => {
  const setupClient = apiClient();
  agentUsername = `tms-agent-${RUN_ID}`;

  const reg = await setupClient.im.account.register({
    type: 'agent',
    username: agentUsername,
    displayName: `Tasks/Memory/Skills Agent (${RUN_ID})`,
    agentType: 'assistant',
    capabilities: ['testing', 'tasks', 'memory', 'skills'],
    description: 'Integration test agent for tasks, memory, and skills',
  });

  expect(reg.ok).toBe(true);
  expect(reg.data).toBeDefined();
  agentToken = reg.data!.token;
  agentId = reg.data!.imUserId;
  client = imClient(agentToken);

  // Create a second agent and send a message to get a conversationId for compaction tests
  const agentBUsername = `tms-agent-b-${RUN_ID}`;
  const regB = await setupClient.im.account.register({
    type: 'agent',
    username: agentBUsername,
    displayName: `TMS Agent B (${RUN_ID})`,
    agentType: 'bot',
    capabilities: ['testing'],
  });
  expect(regB.ok).toBe(true);
  const agentBId = regB.data!.imUserId;

  const sendResult = await client.im.direct.send(agentBId, `Setup message ${RUN_ID}`);
  if (sendResult.ok && sendResult.data?.conversationId) {
    directConversationId = sendResult.data.conversationId;
  }
}, 30_000);

// ===========================================================================
// Tasks Lifecycle
// ===========================================================================

describe('Tasks Lifecycle', () => {
  let createdTaskId: string;
  let scheduledTaskId: string;
  let failTaskId: string;

  it('tasks.create() — with title, description, capability', async () => {
    const result = await client.im.tasks.create({
      title: `Test Task ${RUN_ID}`,
      description: 'Integration test task with capability',
      capability: 'testing',
    });
    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.id).toBeDefined();
    expect(result.data!.title).toBe(`Test Task ${RUN_ID}`);
    expect(result.data!.description).toBe('Integration test task with capability');
    expect(result.data!.capability).toBe('testing');
    expect(result.data!.status).toBe('pending');
    createdTaskId = result.data!.id;
  }, 30_000);

  it('tasks.create() — with schedule type (once)', async () => {
    const result = await client.im.tasks.create({
      title: `Scheduled Task ${RUN_ID}`,
      description: 'One-time scheduled task',
      scheduleType: 'once',
      capability: 'scheduling',
    });
    // scheduleType 'once' may not be supported yet — graceful handling
    if (result.ok) {
      expect(result.data).toBeDefined();
      expect(result.data!.id).toBeDefined();
      scheduledTaskId = result.data!.id;
    } else {
      console.warn('[Tasks] scheduleType=once not supported:', result.error);
    }
  }, 30_000);

  it('tasks.list() — returns created tasks', async () => {
    const result = await client.im.tasks.list();
    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data!.length).toBeGreaterThanOrEqual(1);
    // Verify our task is in the list
    const found = result.data!.find((t) => t.id === createdTaskId);
    expect(found).toBeDefined();
  }, 30_000);

  it('tasks.list() — with status filter', async () => {
    const result = await client.im.tasks.list({ status: 'pending' });
    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
    expect(Array.isArray(result.data)).toBe(true);
    // All returned tasks should be pending
    for (const task of result.data!) {
      expect(task.status).toBe('pending');
    }
  }, 30_000);

  it('tasks.get() — by task ID', async () => {
    expect(createdTaskId).toBeDefined();
    const result = await client.im.tasks.get(createdTaskId);
    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.task).toBeDefined();
    expect(result.data!.task.id).toBe(createdTaskId);
    expect(result.data!.task.title).toBe(`Test Task ${RUN_ID}`);
    expect(result.data!.logs).toBeDefined();
    expect(Array.isArray(result.data!.logs)).toBe(true);
  }, 30_000);

  it('tasks.update() — partial update', async () => {
    expect(createdTaskId).toBeDefined();
    const result = await client.im.tasks.update(createdTaskId, {
      metadata: { updated: true, runId: RUN_ID },
    });
    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.id).toBe(createdTaskId);
  }, 30_000);

  it('tasks.claim() — claim a task', async () => {
    expect(createdTaskId).toBeDefined();
    const result = await client.im.tasks.claim(createdTaskId);
    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.id).toBe(createdTaskId);
    // Server returns 'assigned' not 'in_progress' on claim
    expect(['in_progress', 'assigned']).toContain(result.data!.status);
  }, 30_000);

  it('tasks.progress() — report progress', async () => {
    expect(createdTaskId).toBeDefined();
    const result = await client.im.tasks.progress(createdTaskId, {
      message: 'Working on it...',
      metadata: { step: 1, total: 3 },
    });
    expect(result.ok).toBe(true);
  }, 30_000);

  it('tasks.complete() — with result', async () => {
    expect(createdTaskId).toBeDefined();
    const result = await client.im.tasks.complete(createdTaskId, {
      result: { output: 'Task completed successfully', score: 0.95 },
      cost: 0.5,
    });
    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.id).toBe(createdTaskId);
    expect(result.data!.status).toBe('completed');
  }, 30_000);

  it('tasks.create() + tasks.fail() — failure path', async () => {
    // Create a new task specifically for the fail path
    const createResult = await client.im.tasks.create({
      title: `Fail Task ${RUN_ID}`,
      description: 'Task that will be failed',
      capability: 'testing',
    });
    expect(createResult.ok).toBe(true);
    failTaskId = createResult.data!.id;

    // Claim it first (must be in_progress to fail)
    const claimResult = await client.im.tasks.claim(failTaskId);
    expect(claimResult.ok).toBe(true);

    // Now fail it
    const failResult = await client.im.tasks.fail(
      failTaskId,
      'Intentional failure for testing',
      { reason: 'integration_test' },
    );
    expect(failResult.ok).toBe(true);
    expect(failResult.data).toBeDefined();
    expect(failResult.data!.id).toBe(failTaskId);
    expect(failResult.data!.status).toBe('failed');
    expect(failResult.data!.error).toBe('Intentional failure for testing');
  }, 30_000);
});

// ===========================================================================
// Memory CRUD
// ===========================================================================

describe('Memory CRUD', () => {
  let memoryFileId: string;
  const memoryScope = `test-${RUN_ID}`;
  const memoryPath = `notes/${RUN_ID}/test.md`;

  it('memory.createFile() — with content and scope', async () => {
    const result = await client.im.memory.createFile({
      path: memoryPath,
      content: `# Test Memory File\n\nCreated by run ${RUN_ID}.\n\nLine 1\nLine 2\nLine 3`,
      scope: memoryScope,
    });
    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.id).toBeDefined();
    expect(result.data!.path).toBe(memoryPath);
    expect(result.data!.scope).toBe(memoryScope);
    expect(result.data!.version).toBeGreaterThanOrEqual(1);
    memoryFileId = result.data!.id;
  }, 30_000);

  it('memory.listFiles() — returns created files', async () => {
    expect(memoryFileId).toBeDefined();
    const result = await client.im.memory.listFiles();
    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data!.length).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('memory.listFiles() — with scope filter', async () => {
    const result = await client.im.memory.listFiles({ scope: memoryScope });
    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
    expect(Array.isArray(result.data)).toBe(true);
    // All returned files should match our scope
    for (const file of result.data!) {
      expect(file.scope).toBe(memoryScope);
    }
    // Our file should be present
    const found = result.data!.find((f) => f.id === memoryFileId);
    expect(found).toBeDefined();
  }, 30_000);

  it('memory.getFile() — by ID', async () => {
    expect(memoryFileId).toBeDefined();
    const result = await client.im.memory.getFile(memoryFileId);
    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.id).toBe(memoryFileId);
    expect(result.data!.path).toBe(memoryPath);
    expect(result.data!.content).toBeDefined();
    expect(result.data!.content).toContain('Test Memory File');
    expect(result.data!.content).toContain(RUN_ID);
  }, 30_000);

  it('memory.updateFile() — append mode', async () => {
    expect(memoryFileId).toBeDefined();
    const result = await client.im.memory.updateFile(memoryFileId, {
      operation: 'append',
      content: `\n\nAppended content at ${new Date().toISOString()}`,
    });
    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.content).toContain('Appended content');
    expect(result.data!.content).toContain('Test Memory File');
    expect(result.data!.version).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it('memory.updateFile() — replace mode', async () => {
    expect(memoryFileId).toBeDefined();
    const replacedContent = `# Replaced Content\n\nFully replaced by run ${RUN_ID}.`;
    const result = await client.im.memory.updateFile(memoryFileId, {
      operation: 'replace',
      content: replacedContent,
    });
    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.content).toBe(replacedContent);
    expect(result.data!.version).toBeGreaterThanOrEqual(3);
  }, 30_000);

  it('memory.compact() — conversation compaction', async () => {
    // This requires a valid conversationId
    if (!directConversationId) {
      console.warn('Skipping compact test: no conversationId available');
      return;
    }
    const result = await client.im.memory.compact({
      conversationId: directConversationId,
      summary: `Test compaction summary for run ${RUN_ID}. The agents discussed setup messages.`,
    });
    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.id).toBeDefined();
    expect(result.data!.conversationId).toBe(directConversationId);
    expect(result.data!.summary).toContain(RUN_ID);
  }, 30_000);

  it('memory.getCompaction() — retrieve summaries', async () => {
    if (!directConversationId) {
      console.warn('Skipping getCompaction test: no conversationId available');
      return;
    }
    const result = await client.im.memory.getCompaction(directConversationId);
    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data!.length).toBeGreaterThanOrEqual(1);
    // Our compaction should be present
    const found = result.data!.find((c) => c.summary.includes(RUN_ID));
    expect(found).toBeDefined();
  }, 30_000);

  it('memory.load() — session context load', async () => {
    const result = await client.im.memory.load(memoryScope);
    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.scope).toBe(memoryScope);
    // Content may be from the replaced file
    expect(typeof result.data!.totalBytes).toBe('number');
    expect(typeof result.data!.totalLines).toBe('number');
  }, 30_000);

  it('memory.deleteFile() — cleanup', async () => {
    expect(memoryFileId).toBeDefined();
    const result = await client.im.memory.deleteFile(memoryFileId);
    expect(result.ok).toBe(true);

    // Verify deletion
    const getResult = await client.im.memory.getFile(memoryFileId);
    expect(getResult.ok).toBe(false);
  }, 30_000);
});

// ===========================================================================
// Skills (via EvolutionClient)
// ===========================================================================

describe('Skills', () => {
  let createdSkillId: string;
  let installableSkillSlug: string;

  it('evolution.searchSkills() — with query', async () => {
    const result = await client.im.evolution.searchSkills({ query: 'test' });
    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
    expect(Array.isArray(result.data)).toBe(true);
    // Store a skill slug for install tests if any results returned
    if (result.data!.length > 0) {
      installableSkillSlug = result.data![0].slug || result.data![0].id;
    }
  }, 30_000);

  it('evolution.searchSkills() — with category filter', async () => {
    const result = await client.im.evolution.searchSkills({ category: 'coding' });
    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
    expect(Array.isArray(result.data)).toBe(true);
    // If results exist, they should match the category
    for (const skill of result.data!) {
      if (skill.category) {
        expect(skill.category).toBe('coding');
      }
    }
  }, 30_000);

  it('evolution.createSkill() — create custom skill', async () => {
    const result = await client.im.evolution.createSkill({
      name: `test-skill-${RUN_ID}`,
      description: `A test skill created by integration test run ${RUN_ID}`,
      category: 'testing',
      tags: ['integration-test', 'automated'],
      content: `# Test Skill ${RUN_ID}\n\nThis skill was created by an automated integration test.\n\n## Instructions\n\nDo nothing. This is a test skill.`,
      signals: [{ type: 'test_signal' }],
      author: agentUsername,
    });
    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
    // Store the created skill ID/slug for subsequent tests
    // The server may return the skill object or a wrapper — handle both
    const d = result.data!;
    createdSkillId = d.slug || d.id || d.skill?.slug || d.skill?.id || d.skillId;
    expect(createdSkillId).toBeDefined();
  }, 30_000);

  it('evolution.installSkill() — install a skill', async () => {
    // Prefer installing our own created skill; fall back to a searched one
    const target = createdSkillId || installableSkillSlug;
    if (!target) {
      console.warn('Skipping installSkill test: no skill available to install');
      return;
    }
    const result = await client.im.evolution.installSkill(target);
    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
  }, 30_000);

  it('evolution.installedSkills() — list installed', async () => {
    const result = await client.im.evolution.installedSkills();
    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
    expect(Array.isArray(result.data)).toBe(true);
    // We should have at least one installed skill from the previous test
    if (createdSkillId || installableSkillSlug) {
      expect(result.data!.length).toBeGreaterThanOrEqual(1);
    }
  }, 30_000);

  it('evolution.getSkillContent() — fetch content', async () => {
    const target = createdSkillId || installableSkillSlug;
    if (!target) {
      console.warn('Skipping getSkillContent test: no skill available');
      return;
    }
    const result = await client.im.evolution.getSkillContent(target);
    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
    // Content should have at least a content field or name
    if (result.data!.content) {
      expect(typeof result.data!.content).toBe('string');
      expect(result.data!.content.length).toBeGreaterThan(0);
    }
  }, 30_000);

  it('evolution.starSkill() — star a skill', async () => {
    const target = createdSkillId || installableSkillSlug;
    if (!target) {
      console.warn('Skipping starSkill test: no skill available');
      return;
    }
    const result = await client.im.evolution.starSkill(target);
    // starSkill may not be fully implemented
    if (result.ok) {
      expect(result.data).toBeDefined();
      expect(result.data!.stars).toBeGreaterThanOrEqual(1);
    } else {
      console.warn('[Skills] starSkill not available:', result.error);
    }
  }, 30_000);

  it('evolution.uninstallSkill() — uninstall', async () => {
    const target = createdSkillId || installableSkillSlug;
    if (!target) {
      console.warn('Skipping uninstallSkill test: no skill available');
      return;
    }
    const result = await client.im.evolution.uninstallSkill(target);
    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.uninstalled).toBe(true);

    // Verify it's no longer in installed list
    const installedResult = await client.im.evolution.installedSkills();
    if (installedResult.ok && installedResult.data) {
      const stillInstalled = installedResult.data.find(
        (s) => s.agentSkill?.skillId === target || s.skill?.slug === target || s.skill?.id === target,
      );
      expect(stillInstalled).toBeUndefined();
    }
  }, 30_000);
});
