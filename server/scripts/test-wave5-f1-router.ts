/**
 * Wave 5 F1 — router audit unit test
 *
 * Verifies that creating the agentBindingsRouter no longer leaks its
 * authMiddleware wildcard onto sibling routes (notably /dispatch/*).
 *
 * Strategy: mount a minimal Hono app that mirrors routes.ts ordering
 * (agentBindings at `/` THEN dispatch at `/dispatch`) and fire requests
 * without an Authorization header. Expected behaviour:
 *   - /workspaces/:wsId/agent-bindings WITHOUT auth → 401 (sub MW)
 *   - /dispatch/T1/prepare WITHOUT auth → reaches the dispatch handler
 *     (which has its own daemon-auth path, no 401 from agent-bindings)
 *
 * Before the fix: dispatch returned 401 from agent-bindings' `*` wildcard.
 * After the fix: dispatch reaches its own handler.
 */

import { Hono } from 'hono';
import { createAgentBindingsRouter } from '../src/im/api/agent-bindings';
import { createDaemonHealthRouter } from '../src/im/api/daemon-health';
import { createRuntimeDiagnoseRouter } from '../src/im/api/runtime-diagnose';

async function main() {
  console.log('\nWave 5 F1 — router audit test\n');

  const app = new Hono();

  // Mirror routes.ts: agentBindings + daemonHealth + runtimeDiagnose mounted
  // at `/`, then dispatch at `/dispatch`.
  const ab = createAgentBindingsRouter({ syncService: undefined as any });
  app.route('/', ab);
  const dh = createDaemonHealthRouter({ redis: { withClient: async () => 0 } as any, rooms: {} as any });
  app.route('/', dh);
  const rd = createRuntimeDiagnoseRouter({ redis: { withClient: async () => 0 } as any, rooms: {} as any });
  app.route('/', rd);

  // Dispatch handler (mock — just returns 200)
  app.post('/dispatch/:taskId/prepare', (c) => c.json({ ok: true, where: 'dispatch-prepare' }));
  app.post('/dispatch/:taskId/commit', (c) => c.json({ ok: true, where: 'dispatch-commit' }));
  app.post('/messages', (c) => c.json({ ok: true, where: 'messages' }));

  const results: { name: string; passed: boolean; detail?: string }[] = [];
  async function check(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      results.push({ name, passed: true });
      console.log(`  ✓ ${name}`);
    } catch (err: any) {
      results.push({ name, passed: false, detail: err.message });
      console.log(`  ✗ ${name}\n    ${err.message}`);
    }
  }

  await check('POST /dispatch/T1/prepare without auth — NOT intercepted by agent-bindings MW', async () => {
    const res = await app.fetch(new Request('http://x/dispatch/T1/prepare', { method: 'POST' }));
    if (res.status !== 200) {
      throw new Error(`expected 200, got ${res.status} body=${await res.text()}`);
    }
    const body = (await res.json()) as any;
    if (body.where !== 'dispatch-prepare') throw new Error(`wrong handler: ${body.where}`);
  });

  await check('POST /dispatch/T1/commit without auth — NOT intercepted', async () => {
    const res = await app.fetch(new Request('http://x/dispatch/T1/commit', { method: 'POST' }));
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
  });

  await check('POST /messages without auth — NOT intercepted', async () => {
    const res = await app.fetch(new Request('http://x/messages', { method: 'POST' }));
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
  });

  await check('GET /workspaces/W1/agent-bindings without auth — 401 from sub MW (still protected)', async () => {
    const res = await app.fetch(new Request('http://x/workspaces/W1/agent-bindings'));
    // authMiddleware should return 401 (or 403) for missing JWT
    if (res.status === 200) throw new Error('agent-bindings route reached without auth — MW broken');
    if (res.status !== 401 && res.status !== 403) {
      throw new Error(`expected 401/403 for protected route, got ${res.status}`);
    }
  });

  await check('POST /agent-bindings/agent1/rebind without auth — 401 from sub MW', async () => {
    const res = await app.fetch(new Request('http://x/agent-bindings/agent1/rebind', { method: 'POST' }));
    if (res.status === 200) throw new Error('rebind route reached without auth');
    if (res.status !== 401 && res.status !== 403) {
      throw new Error(`expected 401/403, got ${res.status}`);
    }
  });

  await check('GET /daemons/d1/health without auth — 401 from sub MW (still protected)', async () => {
    const res = await app.fetch(new Request('http://x/daemons/d1/health'));
    if (res.status === 200) throw new Error('reached daemon-health without auth');
    if (res.status !== 401 && res.status !== 403) {
      throw new Error(`expected 401/403, got ${res.status}`);
    }
  });

  await check('GET /runtime/diagnose without auth — 401 from sub MW (still protected)', async () => {
    const res = await app.fetch(new Request('http://x/runtime/diagnose'));
    if (res.status === 200) throw new Error('reached runtime-diagnose without auth');
    if (res.status !== 401 && res.status !== 403) {
      throw new Error(`expected 401/403, got ${res.status}`);
    }
  });

  const passed = results.filter((r) => r.passed).length;
  console.log(`\nResults: ${passed}/${results.length} passed`);
  if (passed < results.length) {
    console.log('\nFailures:');
    results.filter((r) => !r.passed).forEach((r) => console.log(`  - ${r.name}: ${r.detail}`));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(2);
});
