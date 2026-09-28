import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudClient } from '../src/auth.js';
import { attachPkfRpc } from '../src/daemon/pkf/rpc.js';

const hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const sri = (data: string | Buffer) => `sha256-${createHash('sha256').update(data).digest('base64')}`;

const here = dirname(fileURLToPath(import.meta.url));
const providerPath = join(here, '..', 'plugins', 'memory', 'prismer', '__init__.py');
const havePython = spawnSync('python3', ['--version'], { timeout: 10_000 }).status === 0;

function runProvider(script: string, port: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('python3', ['-c', script], {
      env: {
        ...process.env,
        PRISMER_DAEMON_PORT: String(port),
        PRISMER_WORKSPACE_ID: 'ws-pkf-native-e2e',
        PRISMER_AGENT_IM_USER_ID: 'agent-pkf-native-e2e',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe.skipIf(!havePython)('native PKF function-call provider → real Runtime RPC', () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    const view = {
      replayed: false,
      receipt: { id: 'pkfbr_native', state: 'committed', requestHash: 'd'.repeat(64) },
      root: {
        id: 'pkfb_native',
        revision: 1,
        contentHash: 'a'.repeat(64),
        filename: 'native.pkf',
        workspacePath: 'PKF/native.pkf',
      },
      resources: [{
        id: 'pkfr_native',
        path: 'data.csv',
        contentHash: 'b'.repeat(64),
        integrity: `sha256-${'c'.repeat(43)}=`,
        mime: 'text/csv',
        usage: 'data',
        fromContentHash: 'a'.repeat(64),
        fromNodeKey: `asset:pkfb_native:1:${'a'.repeat(64)}`,
        boundKind: 'pkf-resource',
      }],
    };
    const cloud = {
      request: vi.fn(async () => ({ ok: true, status: 200, data: { success: true, data: view, requestId: 'req' } })),
    } as unknown as CloudClient;
    const pkfRpc = attachPkfRpc({ cloud, workspaceId: () => 'ws-pkf-native-e2e' });
    server = createServer(async (req, res) => {
      if (!(await pkfRpc(req, res))) {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('PKF RPC port unavailable');
    port = address.port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('registers and executes mint/validate/outline/search/read without shell discovery, with in-journey TAMPER rejection', async () => {
    const source =
      '<script type="application/prismer+json">' +
      '{"type":"note","title":"Native E2E","description":"Native function-call test.","pkfVersion":"1.1"}' +
      '</script><section><h2 id="cache" data-sid="sec_01k2f6m8v7q4x9a3b5c6d7e8f9">Cache</h2>' +
      '<p>bounded needle</p></section>';
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
p = mod.PrismerMemoryProvider(); p.initialize("sess_native_e2e")
names = [schema["name"] for schema in p.get_tool_schemas()]
required = ["pkf_mint_sids", "pkf_validate", "pkf_outline", "pkf_search", "pkf_read", "pkf_bundle_commit"]
assert all(name in names for name in required), names
source = ${JSON.stringify(source)}
minted = json.loads(p.handle_tool_call("pkf_mint_sids", {"count": 2}))
validated = json.loads(p.handle_tool_call("pkf_validate", {"source": source, "level": "structure"}))
outlined = json.loads(p.handle_tool_call("pkf_outline", {"source": source}))
searched = json.loads(p.handle_tool_call("pkf_search", {"source": source, "query": "needle", "limit": 2}))
read = json.loads(p.handle_tool_call("pkf_read", {"source": source, "sectionSid": "sec_01k2f6m8v7q4x9a3b5c6d7e8f9", "maxBytes": 1024}))
tampered = json.loads(p.handle_tool_call("pkf_mint_sids", {"count": 51}))
bundle = json.loads(p.handle_tool_call("pkf_bundle_commit", {
  "idempotencyKey": "native-restart-stable",
  "root": {"filename": "native.pkf", "source": source, "sourceHash": "${hex(source)}"},
  "resources": [{
    "path": "data.csv", "bytesBase64": "YSxiCjEsMgo=",
    "contentHash": "${hex(Buffer.from('YSxiCjEsMgo=', 'base64'))}", "integrity": "${sri(Buffer.from('YSxiCjEsMgo=', 'base64'))}",
    "mime": "text/csv", "usage": "data"
  }]
}))
assert len(minted["sids"]) == 2 and all(s.startswith("sec_") for s in minted["sids"]), minted
assert validated["structureStatus"] == "pass", validated
assert len(outlined["sections"]) == 1, outlined
assert len(searched["matches"]) == 1, searched
assert "bounded needle" in read["content"], read
assert tampered == {"ok": False, "error": "pkf_sid_count_invalid", "min": 1, "max": 50}, tampered
assert bundle["ok"] is True and bundle["readbackVerified"] is True, bundle
assert bundle["receipt"]["state"] == "committed" and len(bundle["resources"]) == 1, bundle
print(json.dumps({"tools": required, "sourceHash": validated["sourceHash"], "tamper": tampered["error"], "bundleReceipt": bundle["receipt"]["id"]}))
`;

    const result = await runProvider(script, port);

    expect(result.code, result.stderr).toBe(0);
    const receipt = JSON.parse(result.stdout.trim().split('\n').pop()!) as {
      tools: string[];
      sourceHash: string;
      tamper: string;
      bundleReceipt: string;
    };
    expect(receipt.tools).toEqual([
      'pkf_mint_sids',
      'pkf_validate',
      'pkf_outline',
      'pkf_search',
      'pkf_read',
      'pkf_bundle_commit',
    ]);
    expect(receipt.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.tamper).toBe('pkf_sid_count_invalid');
    expect(receipt.bundleReceipt).toBe('pkfbr_native');
  });
});
