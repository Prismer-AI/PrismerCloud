// release203 web-capability fix — provider-shell web tool registration.
//
// Executes the REAL plugins/memory/prismer/__init__.py under python3 (with a
// stub `agent.memory_provider` ABC on sys.path) and proves:
//   1. get_tool_schemas() registers the 5 memory verbs, 2 web verbs, and the
//      4 native PKF read/validate verbs promised by pkf-writing.
//   2. NEGATIVE: handle_tool_call('web_load', { url: 'file://…' }) rejects
//      non-http input shell-side (invalid_url) WITHOUT touching the daemon.
//
// Skipped when python3 is unavailable (the shell only ever runs inside pods
// that ship python).

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const shellDir = join(here, '..', 'plugins', 'memory', 'prismer');

const havePython = (() => {
  try {
    return spawnSync('python3', ['--version'], { timeout: 10_000 }).status === 0;
  } catch {
    return false;
  }
})();

function runPy(script: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('python3', ['-c', script], {
    timeout: 30_000,
    encoding: 'utf8',
    env: {
      ...process.env,
      // Point the shell at a dead loopback port: any accidental daemon RPC
      // fails fast instead of hanging (the negative test must not need one).
      PRISMER_DAEMON_PORT: '1',
      PRISMER_WORKSPACE_ID: 'ws_test',
      PRISMER_AGENT_IM_USER_ID: 'agent_test',
    },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// Bootstrap: stub the hermes `agent.memory_provider` ABC, import the real
// shell module from disk, instantiate + initialize the provider.
const BOOTSTRAP = `
import json, sys, types
agent_pkg = types.ModuleType("agent"); agent_pkg.__path__ = []
mp = types.ModuleType("agent.memory_provider")
class MemoryProvider:  # minimal ABC stand-in
    pass
mp.MemoryProvider = MemoryProvider
sys.modules["agent"] = agent_pkg
sys.modules["agent.memory_provider"] = mp

import importlib.util
spec = importlib.util.spec_from_file_location("prismer_shell", ${JSON.stringify(join(shellDir, '__init__.py'))})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
p = mod.PrismerMemoryProvider()
p.initialize("sess_test")
`;

describe.skipIf(!havePython)('provider shell web tools (python)', () => {
  it('binds the public PKF actor hint from the per-profile host environment', () => {
    const r = runPy(`${BOOTSTRAP}
headers = mod._headers()
assert headers.get("X-Prismer-Agent") == "agent_test", headers
assert "X-IM-Agent" not in headers, headers
print("PKF_CANONICAL_AGENT_HEADER_OK")
`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('PKF_CANONICAL_AGENT_HEADER_OK');
  });

  it('registers 15 tools: memory + web + native PKF author/read/validate/commit/svg-check/reply-inline', () => {
    const r = runPy(`${BOOTSTRAP}
schemas = p.get_tool_schemas()
print(json.dumps([s["name"] for s in schemas]))
`);
    expect(r.status, r.stderr).toBe(0);
    const names = JSON.parse(r.stdout.trim().split('\n').pop()!) as string[];
    expect(names).toHaveLength(15);
    expect(names).toEqual(
      expect.arrayContaining([
        'memory_search',
        'memory_load',
        'memory_browse',
        'memory_write',
        'memory_curate',
        'workspace_web_search',
        'web_load',
        'pkf_validate',
        'pkf_mint_sids',
        'pkf_outline',
        'pkf_search',
        'pkf_read',
        'pkf_bundle_commit',
        'pkf_svg_check',
        'pkf_reply_inline',
      ]),
    );
  });

  it('pkf_mint_sids is workspace-independent and forwards only a bounded count', () => {
    const r = runPy(`${BOOTSTRAP}
calls = []
def fake_post(path, body, timeout):
    calls.append({"path": path, "body": body, "timeout": timeout})
    return {"status": 200, "body": {"ok": True, "sids": ["sec_01k2f6m8v7q4x9a3b5c6d7e8f9"]}}
mod._http_post_with_status = fake_post
p._workspace_id = ""
out = json.loads(p.handle_tool_call("pkf_mint_sids", {"count": 1}))
assert len(out["sids"]) == 1, out
assert calls == [{"path": "/local/pkf/mint-sids", "body": {"count": 1}, "timeout": mod._PKF_TIMEOUT}], calls
print("PKF_MINT_SIDS_RPC_OK")
`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('PKF_MINT_SIDS_RPC_OK');
  });

  it('pkf_validate is a native function tool and forwards source to the daemon RPC', () => {
    const r = runPy(`${BOOTSTRAP}
calls = []
def fake_post(path, body, timeout):
    calls.append({"path": path, "body": body, "timeout": timeout})
    return {"status": 200, "body": {"ok": True, "structureStatus": "pass", "sourceHash": "abc"}}
mod._http_post_with_status = fake_post
# PKF parsing is pure local CPU work and must not inherit Memory's workspace
# precondition. This also covers cold-start/self-check invocations.
p._workspace_id = ""
source = '<script type="application/prismer+json">{"type":"note","title":"T","pkfVersion":"1.1"}</script><section><h2 id="s" data-sid="sec_01k2f6m8v7q4x9a3b5c6d7e8f9">S</h2><p>x</p></section>'
out = json.loads(p.handle_tool_call("pkf_validate", {"source": source, "level": "structure"}))
assert out["ok"] is True, out
assert calls == [{"path": "/local/pkf/validate", "body": {"source": source, "level": "structure"}, "timeout": mod._PKF_TIMEOUT}], calls
print("PKF_VALIDATE_RPC_OK")
`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('PKF_VALIDATE_RPC_OK');
  });

  it('pkf_outline/search/read execute through the registered function-call lane with bounded allowlisted arguments', () => {
    const r = runPy(`${BOOTSTRAP}
calls = []
def fake_post(path, body, timeout):
    calls.append({"path": path, "body": body, "timeout": timeout})
    return {"status": 200, "body": {"ok": True, "complete": True, "sourceHash": "abc"}}
mod._http_post_with_status = fake_post
p._workspace_id = ""
source = '<script type="application/prismer+json">{"type":"note","title":"T","pkfVersion":"1.1"}</script><section><h2 id="s" data-sid="sec_01k2f6m8v7q4x9a3b5c6d7e8f9">S</h2><p>needle</p></section>'
assert json.loads(p.handle_tool_call("pkf_outline", {
    "source": source, "documentUri": "prismer://asset/a", "revisionId": "r1",
    "cursor": "c1", "includeSource": True
}))["ok"] is True
assert json.loads(p.handle_tool_call("pkf_search", {
    "source": source, "query": "needle", "limit": 3, "includeSource": True
}))["ok"] is True
assert json.loads(p.handle_tool_call("pkf_read", {
    "source": source, "sectionSid": "sec_01k2f6m8v7q4x9a3b5c6d7e8f9", "maxBytes": 1024,
    "includeSource": True
}))["ok"] is True
assert calls == [
    {"path": "/local/pkf/outline", "body": {"source": source, "documentUri": "prismer://asset/a", "revisionId": "r1", "cursor": "c1"}, "timeout": mod._PKF_TIMEOUT},
    {"path": "/local/pkf/search", "body": {"source": source, "query": "needle", "limit": 3}, "timeout": mod._PKF_TIMEOUT},
    {"path": "/local/pkf/read", "body": {"source": source, "sectionSid": "sec_01k2f6m8v7q4x9a3b5c6d7e8f9", "maxBytes": 1024}, "timeout": mod._PKF_TIMEOUT},
], calls
print("PKF_BOUNDED_QUERY_RPC_OK")
`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('PKF_BOUNDED_QUERY_RPC_OK');
  });

  it('pkf_bundle_commit requires workspace scope and forwards only the atomic descriptor', () => {
    const r = runPy(`${BOOTSTRAP}
calls = []
def fake_post(path, body, timeout):
    calls.append({"path": path, "body": body, "timeout": timeout})
    return {"status": 200, "body": {"ok": True, "readbackVerified": True, "receipt": {"id": "pkfbr_1", "state": "committed"}}}
mod._http_post_with_status = fake_post
args = {
  "idempotencyKey": "stable-key",
  "root": {"filename": "report.pkf", "source": "pkf", "sourceHash": "a" * 64},
  "resources": [{
    "path": "data.csv", "bytesBase64": "YQ==", "contentHash": "b" * 64,
    "integrity": "sha256-" + "c" * 43 + "=", "mime": "text/csv", "usage": "data"
  }],
  "workspaceId": "forged-workspace",
  "actor": {"id": "forged-actor"},
}
p._workspace_id = ""
denied = json.loads(p.handle_tool_call("pkf_bundle_commit", args))
assert denied == {"ok": False, "error": "pkf_bundle_workspace_unbound"}, denied
assert calls == [], calls
p._workspace_id = "ws-bound"
out = json.loads(p.handle_tool_call("pkf_bundle_commit", args))
assert out["ok"] is True and out["readbackVerified"] is True, out
assert calls == [{
  "path": "/local/pkf/bundle-commit",
  "body": {"idempotencyKey": args["idempotencyKey"], "root": args["root"], "resources": args["resources"]},
  "timeout": mod._PKF_BUNDLE_TIMEOUT,
}], calls
print("PKF_BUNDLE_COMMIT_RPC_OK")
`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('PKF_BUNDLE_COMMIT_RPC_OK');
  });

  it('NEGATIVE: web_load rejects non-http input shell-side (no daemon call needed)', () => {
    const r = runPy(`${BOOTSTRAP}
out = json.loads(p.handle_tool_call("web_load", {"url": "file:///etc/passwd"}))
assert out["ok"] is False, out
assert out["error"] == "invalid_url", out
out2 = json.loads(p.handle_tool_call("web_load", {"urls": ["https://ok.com", "ftp://bad"]}))
assert out2["error"] == "invalid_url", out2
out3 = json.loads(p.handle_tool_call("web_load", {}))
assert out3["ok"] is False, out3
print("NEGATIVE_OK")
`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('NEGATIVE_OK');
  });

  it('web_load ACCEPTS prismer:// URIs shell-side (memory203/20 §2.2) — passes validation, only fails at the dead daemon', () => {
    const r = runPy(`${BOOTSTRAP}
out = json.loads(p.handle_tool_call("web_load", {"url": "prismer://owner/asset/" + "a" * 64}))
# Validation passed → the shell tried the (dead) daemon: NOT invalid_url.
assert out.get("error") != "invalid_url", out
assert out.get("error") == "daemon_unreachable", out
# Garbage schemes still rejected BEFORE any daemon call.
out2 = json.loads(p.handle_tool_call("web_load", {"url": "ftp://x.com/a"}))
assert out2.get("error") == "invalid_url", out2
print("PRISMER_URI_OK")
`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('PRISMER_URI_OK');
  });

  it('memory_curate candidates kind enum includes oversized (memory203/20 §1.2 hub-size advisory)', () => {
    const r = runPy(`${BOOTSTRAP}
schemas = {s["name"]: s for s in p.get_tool_schemas()}
kinds = schemas["memory_curate"]["parameters"]["properties"]["kind"]["enum"]
assert "oversized" in kinds, kinds
assert "conflicts" in kinds, kinds
print("OVERSIZED_KIND_OK")
`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('OVERSIZED_KIND_OK');
  });

  it('sync_turn parses <attached_assets> ids out of the turn text (memory203/20 §2.1 pointer contract)', () => {
    const r = runPy(`${BOOTSTRAP}
ids = mod._parse_attached_asset_ids(
    '<current_message><attached_assets><asset id="ast_1" mime="application/pdf"/>'
    '<asset id="ast_2"/><asset id="ast_1"/></attached_assets></current_message>'
)
assert ids == ["ast_1", "ast_2"], ids
assert mod._parse_attached_asset_ids("no assets here") == []
print("ASSET_IDS_OK")
`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('ASSET_IDS_OK');
  });

  it('carries successful explicit memory_write receipts into the post-turn hook exactly once', () => {
    const r = runPy(`${BOOTSTRAP}
import os
os.environ["PRISMER_AGENT_IM_USER_ID"] = "agent_1"
def fake_post(path, body, timeout):
    assert path == "/local/memory/write", path
    assert body.get("providerSessionId") == "sess_test", body
    assert body.get("durabilityReceiptIndex") == 0, body
    return {"status": 200, "body": {"authority": "outbox", "outboxEventId": "out_page_1", "page": {
        "id": "page_1", "path": "decisions/a.pkf", "version": 3, "contentHash": "hash_1"
    }}}
mod._http_post_with_status = fake_post
out = json.loads(p.handle_tool_call("memory_write", {
    "path": "decisions/a.pkf", "content": "# durable decision"
}))
assert out == {"ok": True, "path": "decisions/a.pkf", "pageId": "page_1", "version": 3, "contentHash": "hash_1"}, out

delivered = []
class Response:
    status = 204
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def read(self): return b""
def fake_urlopen(req, timeout=0):
    delivered.append(json.loads(req.data.decode("utf-8")))
    return Response()
mod.urllib.request.urlopen = fake_urlopen
p.sync_turn("remember this decision", "done", session_id="api_provider_1")
p.sync_turn("ordinary follow-up", "done", session_id="api_provider_2")
receipts = delivered[0]["extra"].get("explicit_memory_receipts")
assert receipts == [{"pageId": "page_1", "path": "decisions/a.pkf", "version": 3, "contentHash": "hash_1", "authority": "outbox", "authorityEventId": "out_page_1"}], receipts
assert "explicit_memory_receipts" not in delivered[1]["extra"], delivered[1]
print("EXPLICIT_RECEIPT_OK")
`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('EXPLICIT_RECEIPT_OK');
  });

  it('renews an expired Memory cap once and retries the original provider RPC', () => {
    const r = runPy(`${BOOTSTRAP}
import io, urllib.error
mod._memory_cap = "v2.stale.sig"
calls = []
class Response:
    status = 200
    def __init__(self, body): self.body = body
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def read(self): return self.body
def fake_urlopen(req, timeout=0):
    calls.append({"url": req.full_url, "cap": req.get_header("X-prismer-memory-cap")})
    if len(calls) == 1:
        raise urllib.error.HTTPError(req.full_url, 401, "expired", {}, io.BytesIO(b'{"error":"memory_cap_invalid"}'))
    if req.full_url.endswith("/local/memory/cap/refresh"):
        return Response(b'{"cap":"v2.renewed.sig","exp":9999999999999}')
    return Response(b'{"results":[]}')
mod.urllib.request.urlopen = fake_urlopen
out = mod._http_get("/local/memory/search?workspaceId=ws_test&q=x", 5)
assert out == {"results": []}, out
assert [c["cap"] for c in calls] == ["v2.stale.sig", "v2.stale.sig", "v2.renewed.sig"], calls
assert calls[1]["url"].endswith("/local/memory/cap/refresh"), calls
print("CAP_REFRESH_RETRY_OK")
`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('CAP_REFRESH_RETRY_OK');
  });

  it('preserves fail-closed Memory GET errors instead of reporting empty data or daemon_unreachable', () => {
    const r = runPy(`${BOOTSTRAP}
def denied(path, timeout):
    return {"status": 401, "body": {"ok": False, "error": "memory_cap_required"}}
mod._http_get_with_status = denied
search = json.loads(p.handle_tool_call("memory_search", {"query": "x"}))
curate = json.loads(p.handle_tool_call("memory_curate", {"op": "candidates"}))
assert search == {"ok": False, "error": "memory_cap_required"}, search
assert curate == {"ok": False, "error": "memory_cap_required"}, curate
print("MEMORY_GET_ERROR_PRESERVED_OK")
`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('MEMORY_GET_ERROR_PRESERVED_OK');
  });

  it('workspace_web_search with empty query is rejected shell-side', () => {
    const r = runPy(`${BOOTSTRAP}
out = json.loads(p.handle_tool_call("workspace_web_search", {"query": "  "}))
assert out["ok"] is False, out
print("EMPTY_QUERY_OK")
`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('EMPTY_QUERY_OK');
  });
});

describe('provider shell source sanity', () => {
  it('the on-disk shell contains both web tool registrations', () => {
    expect(existsSync(join(shellDir, '__init__.py'))).toBe(true);
  });

  it('tells the hosted model that an ok memory mutation must not be repeated for verification', () => {
    // memory211/01 W5 轴 H — the schema text moved to the GENERATED artifact
    // (tool-schemas.generated.json), so the teaching is asserted against the
    // loaded schema, not a hand-written literal. The shell-source assertion
    // below keeps the load-bearing invariant: the shell must LOAD the artifact.
    const schemas = JSON.parse(readFileSync(join(shellDir, 'tool-schemas.generated.json'), 'utf8')) as {
      memoryTools: Array<{ name: string; description: string }>;
    };
    const write = schemas.memoryTools.find((t) => t.name === 'memory_write');
    expect(write?.description).toContain('{"ok":true}');
    expect(write?.description).toContain('do not call memory_write again');
    expect(write?.description).toContain('use memory_load instead');
  });

  it('loads the memory schemas from the GENERATED artifact, not hand-written literals', () => {
    const source = readFileSync(join(shellDir, '__init__.py'), 'utf8');
    expect(source).toContain('tool-schemas.generated.json');
    expect(existsSync(join(shellDir, 'tool-schemas.generated.json'))).toBe(true);
  });
});
