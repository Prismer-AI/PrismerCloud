/**
 * mode-b-e2e.mjs — End-to-end Mode B handshake acceptance test.
 *
 * Drives the full PARA Mode B round-trip with a real LLM. Spans both
 * the Node side (this package) and the Python side (prismer-adapter-hermes
 * on PyPI, 0.2.0+ with the [dispatch] extra).
 *
 *   [Node]                                         [Python]
 *   ─────                                          ────────
 *   autoRegisterHermes(registry)
 *     └─ GET /health                     ────→    aiohttp /health handler
 *        ← 200 {"status":"ok"}           ←────
 *
 *   adapter.dispatch({taskId, prompt})
 *     └─ POST /dispatch                  ────→    aiohttp /dispatch handler
 *                                                 └─ AIAgent(session_id=f"dispatch-{taskId}")
 *                                                    └─ Hermes.run_conversation(prompt)
 *                                                       └─ HTTP → real LLM
 *                                                       └─ invoke_hook(...) fires PARA
 *                                                          events to ~/.prismer/para/events.jsonl
 *     ← 200 {ok, output, metadata}       ←────
 *
 * Not wired into any runner — intentionally manual. This requires a
 * live LLM endpoint, live credentials, and the Python dispatch server
 * running in the background. The vitest unit tests in ../ cover the
 * transport logic under test doubles; this file checks the wire lines up.
 *
 * Prerequisites — see ../integration/README.md.
 *
 * Running:
 *   node test/integration/mode-b-e2e.mjs
 *
 * Configurable via env:
 *   HERMES_MODE_B_PORT               (default: 8765)
 *   PRISMER_PARA_EVENTS_FILE         (default: $HOME/.prismer/para/events.jsonl
 *                                      or the server's HOME — pass it explicitly
 *                                      if you launched the server with an
 *                                      isolated HOME=… override)
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Import the built dist — run `npm run build` in the package root first.
// Using a relative path keeps the test self-contained so CI / devs don't
// have to npm link or configure a workspace.
const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, '..');
const DIST_INDEX = join(__dirname, '..', '..', 'dist', 'index.mjs');

if (!existsSync(DIST_INDEX)) {
  console.error(
    `FAIL — dist/index.mjs not found at ${DIST_INDEX}\n` +
      'Run `npm run build` in the package root first.',
  );
  process.exit(1);
}

const { autoRegisterHermes, detectHermesLoopback } = await import(DIST_INDEX);

// ── Config from env ──────────────────────────────────────────────────────────

const PORT = Number(process.env.HERMES_MODE_B_PORT ?? 8765);
const HOME = process.env.HOME || process.env.USERPROFILE || '';
const EVENTS_FILE =
  process.env.PRISMER_PARA_EVENTS_FILE || join(HOME, '.prismer', 'para', 'events.jsonl');

// ── Helpers ──────────────────────────────────────────────────────────────────

function banner(msg) {
  console.log(`\n${'='.repeat(72)}\n  ${msg}\n${'='.repeat(72)}`);
}

function fail(msg) {
  console.error('FAIL —', msg);
  process.exit(1);
}

function makeRegistry() {
  // Structural match of MinimalAdapterRegistry from @prismer/adapter-hermes.
  const adapters = new Map();
  return {
    adapters,
    register(adapter) {
      adapters.set(adapter.name, adapter);
    },
    unregister(name) {
      adapters.delete(name);
    },
    has(name) {
      return adapters.has(name);
    },
  };
}

// ── Phase 1: detect ──────────────────────────────────────────────────────────

banner('PHASE 1 — detectHermesLoopback()');
const probe = await detectHermesLoopback({ port: PORT });
console.log('probe:', probe);
if (!probe.found) {
  fail(
    `Hermes Mode B not reachable at ${probe.loopbackUrl}. ` +
      `Reason: ${probe.reason}. Is prismer-hermes-serve running?`,
  );
}

// ── Phase 2: autoRegister ────────────────────────────────────────────────────

banner('PHASE 2 — autoRegisterHermes(registry)');
const registry = makeRegistry();
const result = await autoRegisterHermes(registry, { port: PORT });
console.log('result:', result);
if (!result.installed) fail('autoRegisterHermes did not install');

const adapter = registry.adapters.get('hermes');
console.log('adapter.name            :', adapter.name);
console.log('adapter.tiersSupported  :', adapter.tiersSupported);
console.log('adapter.capabilityTags  :', adapter.capabilityTags);
console.log('adapter.metadata        :', adapter.metadata);

// ── Phase 3: dispatch — text-only ────────────────────────────────────────────

banner('PHASE 3 — dispatch() real LLM, text-only');
const t1 = Date.now();
const res1 = await adapter.dispatch({
  taskId: 'e2e-text-' + Date.now(),
  capability: 'code.write',
  prompt: 'Reply with exactly the literal token: TASK_C_TEXT_OK',
});
const d1 = Date.now() - t1;
console.log(`took ${d1}ms`);
console.log('ok       :', res1.ok);
console.log('output   :', JSON.stringify(res1.output));
console.log('metadata :', JSON.stringify(res1.metadata));
if (res1.error) console.log('error    :', res1.error);
if (!res1.ok) fail('text dispatch returned ok=false');
if (!String(res1.output).includes('TASK_C_TEXT_OK')) fail('expected token not in output');

// ── Phase 4: dispatch — tool-using ───────────────────────────────────────────

banner('PHASE 4 — dispatch() real LLM, tool-using');
const t2 = Date.now();
const res2 = await adapter.dispatch({
  taskId: 'e2e-tool-' + Date.now(),
  capability: 'code.execute',
  prompt: 'Run the shell command: echo TASK_C_TOOL_OK ; tell me the output',
});
const d2 = Date.now() - t2;
console.log(`took ${d2}ms`);
console.log('ok       :', res2.ok);
console.log('output   :', JSON.stringify(res2.output));
console.log('metadata :', JSON.stringify(res2.metadata));
if (!res2.ok || !String(res2.output).includes('TASK_C_TOOL_OK')) {
  fail('tool dispatch did not relay the expected marker');
}

// ── Phase 5: inspect events.jsonl ────────────────────────────────────────────

banner(`PHASE 5 — inspect ${EVENTS_FILE}`);
if (!existsSync(EVENTS_FILE)) {
  fail(
    `events.jsonl does not exist at ${EVENTS_FILE}. ` +
      'If the server was launched with an isolated $HOME, set ' +
      'PRISMER_PARA_EVENTS_FILE to that server-visible path.',
  );
}

const events = readFileSync(EVENTS_FILE, 'utf-8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

const counts = events.reduce((acc, e) => {
  acc[e.type] = (acc[e.type] || 0) + 1;
  return acc;
}, {});
console.log(`total events: ${events.length}`);
console.log('counts:', JSON.stringify(counts, null, 2));

const textTurnEnd = events.find(
  (e) =>
    e.type === 'agent.turn.end' && String(e.lastAssistantMessage || '').includes('TASK_C_TEXT_OK'),
);
const toolPost = events.find((e) => e.type === 'agent.tool.post' && e.ok === true);
const toolTurnEnd = events.find(
  (e) =>
    e.type === 'agent.turn.end' && String(e.lastAssistantMessage || '').includes('TASK_C_TOOL_OK'),
);

if (!textTurnEnd) fail('text turn.end missing');
if (!toolPost) fail('tool.post ok=true missing');
if (!toolTurnEnd) fail('tool turn.end missing');

console.log('text turn.end found   : YES');
console.log('tool.post ok=true     : YES');
console.log('tool turn.end found   : YES');

// ── Phase 6: adapter.health ──────────────────────────────────────────────────

banner('PHASE 6 — adapter.health()');
const h = await adapter.health();
console.log('health:', h);
if (!h.healthy) fail('unhealthy at end');

// ── Summary ──────────────────────────────────────────────────────────────────

banner('SUMMARY — MODE B END-TO-END ALL PASSED');
console.log(`  Mode B probe           : PASS (${probe.loopbackUrl})`);
console.log('  autoRegisterHermes     : PASS (transport=mode_b_http_loopback)');
console.log(`  text LLM dispatch      : PASS (${d1}ms, output has TASK_C_TEXT_OK)`);
console.log(`  tool LLM dispatch      : PASS (${d2}ms, output has TASK_C_TOOL_OK)`);
console.log(`  events.jsonl sequence  : PASS (${events.length} events, tool.post ok=true)`);
console.log('  adapter.health         : PASS');
