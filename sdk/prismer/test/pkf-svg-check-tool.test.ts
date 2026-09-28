import { createServer, type Server } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachPkfRpc } from '../src/daemon/pkf/rpc.js';
import {
  PKF_SVG_CHECK_TOOL,
  runPkfSvgCheckLocal,
  type PkfSvgCheckOutput,
} from '../src/adapters/memory-tools.js';
import { HERMES_MEMORY_TOOLS } from '../src/adapters/persistence/hermes/memory-tools.js';

/**
 * pkf209/07 §5 Phase 3 — the `pkf_svg_check` native tool.
 *
 * In-process pure function (same shape as pkf_validate): paste the controlled
 * svg, get structureStatus + stable svg-* errors + budget counters back.
 * The Hermes python shell registers the SAME schema 1:1 and routes through
 * the daemon loopback `/local/pkf/svg-check`, which runs the same local
 * implementation. NOT in REQUIRED_PKF_NATIVE_TOOLS — old runtimes that lack
 * it must not report the whole PKF plane unavailable.
 */

const here = dirname(fileURLToPath(import.meta.url));
const providerPath = join(here, '..', 'plugins', 'memory', 'prismer', '__init__.py');
const havePython = spawnSync('python3', ['--version'], { timeout: 10_000 }).status === 0;

const GOOD_SVG = `<svg viewBox="0 0 200 100" role="img" aria-label="mini">
<title>mini</title><desc>mini desc</desc>
<rect x="0" y="0" width="200" height="100" fill="#F1EFE8"></rect>
<rect x="40" y="24" width="56" height="28" fill="#E6F1FB" stroke="#185FA5" stroke-width="0.5"></rect>
<rect x="104" y="24" width="56" height="28" fill="#E1F5EE" stroke="#0F6E56" stroke-width="0.5"></rect>
<text x="60" y="42" font-size="10" fill="#2C2C2A">mini</text>
</svg>`;

const MONO_SVG = `<svg viewBox="0 0 200 100" role="img" aria-label="mono">
<title>mono</title><desc>mono desc</desc>
<rect x="0" y="0" width="200" height="100" fill="#F1EFE8"></rect>
<rect x="40" y="24" width="56" height="28" fill="#E6F1FB" stroke="#185FA5" stroke-width="0.5"></rect>
<rect x="104" y="24" width="56" height="28" fill="#E6F1FB" stroke="#185FA5" stroke-width="0.5"></rect>
<text x="60" y="42" font-size="10" fill="#2C2C2A">mono</text>
</svg>`;

describe('pkf_svg_check local implementation (TS)', () => {
  it('passes a floor-clean svg and reports budgets', () => {
    const out = runPkfSvgCheckLocal({ svg: GOOD_SVG });
    expect(out.structureStatus).toBe('pass');
    expect(out.errors).toEqual([]);
    expect(out.budgets.elements).toBe(7); // svg + title + desc + 3 rect + text
    expect(out.budgets.attributes).toBeGreaterThan(10);
    expect(out.budgets.viewBox).toBe('0 0 200 100');
  });

  it('fails a monochrome svg with the stable code and a fixable diagnostic', () => {
    const out = runPkfSvgCheckLocal({ svg: MONO_SVG });
    expect(out.structureStatus).toBe('fail');
    expect(out.errors.map((error) => error.code)).toContain('svg-monochrome');
    expect(out.errors[0]!.message).toMatch(/#E6F1FB.*pkf-svg/s);
  });

  it('rejects empty input deterministically', () => {
    expect(() => runPkfSvgCheckLocal({ svg: '' })).toThrow(/svg/);
    expect(() => runPkfSvgCheckLocal({} as { svg: string })).toThrow(/svg/);
  });

  it('advertises the frozen input schema {svg} with no extra properties', () => {
    expect(PKF_SVG_CHECK_TOOL.name).toBe('pkf_svg_check');
    expect(PKF_SVG_CHECK_TOOL.inputSchema).toEqual({
      type: 'object',
      properties: {
        svg: expect.objectContaining({ type: 'string' }),
      },
      required: ['svg'],
      additionalProperties: false,
    });
  });

  it('joins the Hermes function-tool surface (coding freezers stay at 3)', async () => {
    const names = HERMES_MEMORY_TOOLS.map((tool) => tool.function.name).sort();
    expect(names).toContain('pkf_svg_check');
    const { CLAUDE_CODE_MEMORY_TOOLS } = await import('../src/adapters/coding/claude-code/memory-tools.js');
    const { CODEX_MEMORY_TOOLS } = await import('../src/adapters/coding/codex/memory-tools.js');
    expect(CLAUDE_CODE_MEMORY_TOOLS).toHaveLength(3);
    expect(CODEX_MEMORY_TOOLS).toHaveLength(3);
  });

  it('is NOT required for PKF runtime capability (old runtimes stay available)', async () => {
    const { REQUIRED_PKF_NATIVE_TOOLS } = await import('../src/daemon/pkf-runtime-capability.js');
    expect(REQUIRED_PKF_NATIVE_TOOLS).not.toContain('pkf_svg_check');
  });
});

function runProvider(script: string, port: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('python3', ['-c', script], {
      env: { ...process.env, PRISMER_DAEMON_PORT: String(port), PRISMER_WORKSPACE_ID: 'ws-svg-check' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe.skipIf(!havePython)('pkf_svg_check python parity + daemon loopback', () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    const pkfRpc = attachPkfRpc({});
    server = createServer(async (req, res) => {
      if (!(await pkfRpc(req, res))) res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('PKF RPC port unavailable');
    port = address.port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('registers the 1:1 schema and executes pass + monochrome fail through the loopback', async () => {
    const script = `
import importlib.util, json, sys, types
agent_pkg = types.ModuleType("agent"); agent_pkg.__path__ = []
mp = types.ModuleType("agent.memory_provider")
class MemoryProvider: pass
mp.MemoryProvider = MemoryProvider
sys.modules["agent"] = agent_pkg
sys.modules["agent.memory_provider"] = mp
spec = importlib.util.spec_from_file_location("prismer_shell", ${JSON.stringify(providerPath)})
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
p = mod.PrismerMemoryProvider(); p.initialize("sess_svg_check")
schemas = {s["name"]: s for s in p.get_tool_schemas()}
assert "pkf_svg_check" in schemas, sorted(schemas)
good = json.loads(p.handle_tool_call("pkf_svg_check", {"svg": ${JSON.stringify(GOOD_SVG)}}))
assert good["ok"] is True and good["structureStatus"] == "pass", good
bad = json.loads(p.handle_tool_call("pkf_svg_check", {"svg": ${JSON.stringify(MONO_SVG)}}))
assert bad["ok"] is True and bad["structureStatus"] == "fail", bad
codes = [e["code"] for e in bad["errors"]]
assert "svg-monochrome" in codes, codes
empty = json.loads(p.handle_tool_call("pkf_svg_check", {"svg": ""}))
assert empty["ok"] is False and empty["error"] == "pkf_svg_required", empty
print(json.dumps({
  "parameters": schemas["pkf_svg_check"]["parameters"],
  "budgets": good["budgets"],
  "failCodes": codes,
}))
`;
    const result = await runProvider(script, port);
    expect(result.code, result.stderr).toBe(0);
    const receipt = JSON.parse(result.stdout.trim().split('\n').pop()!) as {
      parameters: Record<string, unknown>;
      budgets: PkfSvgCheckOutput['budgets'];
      failCodes: string[];
    };

    // schema parity: python parameters are the TS inputSchema, key for key.
    const tsSchema = PKF_SVG_CHECK_TOOL.inputSchema as Record<string, unknown>;
    expect(receipt.parameters).toEqual(tsSchema);
    expect(receipt.budgets.viewBox).toBe('0 0 200 100');
    expect(receipt.failCodes).toContain('svg-monochrome');
  });
});
