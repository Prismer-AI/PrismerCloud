// release202 — ClarifyBridge unit proof (non-destructive; `npx tsx` runnable).
// Proves the cloud orchestration brain: record clarify → pending; human reply
// → resolve signal (+ clears); non-pending / agent reply → null (normal
// dispatch untouched); numeric choice → option text.
import assert from 'node:assert';
import { ClarifyBridge } from '../services/clarify-bridge';

let pass = 0;
function check(name: string, fn: () => void) {
  fn();
  pass += 1;
  console.log(`  ✓ ${name}`);
}

const entry = {
  conversationId: 'conv1',
  taskId: 'run_abc',
  runId: 'run_abc',
  clarifyId: 'cl_1',
  agentImUserId: 'agent_x',
  question: 'Tea or coffee?',
  choices: ['Tea', 'Coffee'],
  createdAt: 1,
};

check('record → getPending returns it', () => {
  const b = new ClarifyBridge();
  b.recordRequest(entry);
  assert.equal(b.getPending('conv1')?.clarifyId, 'cl_1');
  assert.equal(b.hasPending('conv1'), true);
});

check('human reply → resolve signal + clears pending', () => {
  const b = new ClarifyBridge();
  b.recordRequest(entry);
  const sig = b.tryResolveInbound('conv1', 'human', 'Coffee');
  assert.ok(sig);
  assert.equal(sig!.type, 'task.clarify.resolve');
  assert.equal(sig!.response, 'Coffee');
  assert.equal(sig!.clarifyId, 'cl_1');
  assert.equal(sig!.taskId, 'run_abc');
  assert.equal(sig!.runId, 'run_abc');
  assert.equal(b.hasPending('conv1'), false); // cleared
});

check('numeric choice "2" → option text "Coffee"', () => {
  const b = new ClarifyBridge();
  b.recordRequest(entry);
  const sig = b.tryResolveInbound('conv1', 'human', '2');
  assert.equal(sig!.response, 'Coffee');
});

check('no pending → null (normal dispatch path untouched)', () => {
  const b = new ClarifyBridge();
  assert.equal(b.tryResolveInbound('conv1', 'human', 'hello'), null);
});

check('agent reply does NOT consume a pending clarify', () => {
  const b = new ClarifyBridge();
  b.recordRequest(entry);
  assert.equal(b.tryResolveInbound('conv1', 'agent', 'Coffee'), null);
  assert.equal(b.hasPending('conv1'), true); // still pending
});

check('empty reply → null, pending kept', () => {
  const b = new ClarifyBridge();
  b.recordRequest(entry);
  assert.equal(b.tryResolveInbound('conv1', 'human', '   '), null);
  assert.equal(b.hasPending('conv1'), true);
});

console.log(`\nClarifyBridge: ${pass}/6 passed`);
