"""Unit tests for ``prismer.hermes_memory_provider``.

Mocks the daemon's HTTP RPC via ``httpx.MockTransport`` so tests run
without a live daemon. Covers the T2-C spec plus M-A default-no-op:

    1.  is_available() returns False when env unset
    2.  is_available() returns False on health-probe timeout
    3.  initialize() preloads INDEX.md → system_prompt_block returns it
    4.  system_prompt_block() returns "" when INDEX.md is missing (404)
    5.  prefetch(query) renders the <memory-context> fence
        (legacy, gated by PRISMER_MEMORY_AUTO_PREFETCH=1)
    6.  prefetch(query) emits recall_inject events to the daemon outbox
        (legacy, gated by PRISMER_MEMORY_AUTO_PREFETCH=1)
    7.  prefetch() returns "" on daemon error (graceful degradation)
        (legacy, gated by PRISMER_MEMORY_AUTO_PREFETCH=1)
    7b. **M-A default**: prefetch() returns "" without contacting the
        daemon when PRISMER_MEMORY_AUTO_PREFETCH is unset. Doc 25 §3
        支柱 1 — auto-injection retired in favor of agent-driven
        memory_search.
    8.  get_tool_schemas() returns memory_search + memory_load
    9.  handle_tool_call("memory_search") returns JSON + emits recall_pull
   10.  handle_tool_call("memory_load") returns content + emits recall_pull
   11.  shutdown() closes the persistent HTTP client

These are pure unit tests — no daemon, no network, no API key. Conftest
fixtures in ``tests/conftest.py`` use a different fixture set (PrismerClient
with PRISMER_API_KEY_TEST) and don't apply here because we don't request
those fixtures.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional, Tuple

import httpx
import pytest

from prismer.hermes_memory_provider import (
    PrismerDaemonMemoryProvider,
    MEMORY_LOAD_SCHEMA,
    MEMORY_SEARCH_SCHEMA,
    _truncate_to_budget,
)


# ---------------------------------------------------------------------------
# Test transport — records every request and routes by URL
# ---------------------------------------------------------------------------

class FakeDaemon:
    """Mock daemon: route requests by URL path, record every call."""

    def __init__(self) -> None:
        self.requests: List[Tuple[str, str, Optional[Dict[str, Any]]]] = []
        self._index_content: Optional[str] = None
        self._search_results: List[Dict[str, Any]] = []
        self._load_response: Optional[Dict[str, Any]] = None
        self._healthz_status: int = 200
        self._search_status: int = 200
        self._load_status: int = 200
        self._emit_status: int = 200
        self._index_status: int = 200
        # M-B fork-recall fixtures.
        self._manifest_entries: List[Dict[str, Any]] = []
        self._manifest_status: int = 200
        self._finalize_results: List[Dict[str, Any]] = []
        self._finalize_status: int = 200

    # -- Setters used by tests ---------------------------------------------

    def set_index(self, content: Optional[str], status: int = 200) -> None:
        self._index_content = content
        self._index_status = status

    def set_search_results(self, results: List[Dict[str, Any]], status: int = 200) -> None:
        self._search_results = results
        self._search_status = status

    def set_load_response(self, body: Optional[Dict[str, Any]], status: int = 200) -> None:
        self._load_response = body
        self._load_status = status

    def set_healthz(self, status: int) -> None:
        self._healthz_status = status

    def set_emit_status(self, status: int) -> None:
        self._emit_status = status

    def set_manifest(self, entries: List[Dict[str, Any]], status: int = 200) -> None:
        self._manifest_entries = entries
        self._manifest_status = status

    def set_finalize_results(self, results: List[Dict[str, Any]], status: int = 200) -> None:
        self._finalize_results = results
        self._finalize_status = status

    # -- Queries -----------------------------------------------------------

    def emit_calls(self) -> List[Dict[str, Any]]:
        out = []
        for method, path, body in self.requests:
            if method == "POST" and path == "/local/memory/observability/emit" and body:
                out.append(body)
        return out

    def search_calls(self) -> List[Dict[str, str]]:
        return [
            (lambda url=path: dict(_parse_query(url)))()
            for method, path, _ in self.requests
            if method == "GET" and path.startswith("/local/memory/search")
        ]

    # -- Transport handler -------------------------------------------------

    def handler(self, request: httpx.Request) -> httpx.Response:
        method = request.method
        path = request.url.path
        body: Optional[Dict[str, Any]] = None
        if request.content:
            try:
                body = json.loads(request.content)
            except Exception:
                body = None

        # Route. Record path WITH query string for search/load lookups.
        full_path = path + ("?" + request.url.query.decode() if request.url.query else "")
        self.requests.append((method, full_path, body))

        if method == "GET" and path == "/healthz":
            return httpx.Response(self._healthz_status, json={"status": "ok"})

        if method == "GET" and path == "/local/memory/load":
            uri = request.url.params.get("uri", "")
            # Differentiate INDEX.md preload vs page load. INDEX.md path
            # ends with /INDEX.md; otherwise treat as a page load.
            is_index = "/INDEX.md" in uri
            if is_index:
                if self._index_status == 404:
                    return httpx.Response(404, json={"error": "memory_page_not_found"})
                if self._index_status != 200:
                    return httpx.Response(self._index_status, json={"error": "boom"})
                return httpx.Response(
                    200,
                    json={
                        "page": {
                            "id": "page_index",
                            "path": "INDEX.md",
                            "title": "Index",
                            "pageType": "hub",
                            "version": 1,
                            "contentHash": "abc",
                        },
                        "content": self._index_content,
                    },
                )
            # generic page load
            if self._load_status == 404:
                return httpx.Response(404, json={"error": "memory_page_not_found"})
            if self._load_status != 200:
                return httpx.Response(self._load_status, json={"error": "boom"})
            return httpx.Response(200, json=self._load_response or {})

        if method == "GET" and path == "/local/memory/search":
            if self._search_status != 200:
                return httpx.Response(self._search_status, json={"error": "boom"})
            return httpx.Response(
                200,
                json={
                    "query": request.url.params.get("q", ""),
                    "results": self._search_results,
                },
            )

        if method == "POST" and path == "/local/memory/observability/emit":
            if self._emit_status != 200:
                return httpx.Response(self._emit_status, json={"error": "boom"})
            return httpx.Response(200, json={"id": "out_test", "deadLetter": False})

        # M-B fork-recall — manifest enumeration + finalize resolution.
        if method == "GET" and path == "/local/memory/recall/manifest":
            if self._manifest_status != 200:
                return httpx.Response(self._manifest_status, json={"error": "boom"})
            return httpx.Response(
                200,
                json={
                    "workspaceId": request.url.params.get("workspaceId", ""),
                    "query": request.url.params.get("q", ""),
                    "entries": self._manifest_entries,
                    "truncated": False,
                },
            )

        if method == "POST" and path == "/local/memory/recall/finalize":
            if self._finalize_status != 200:
                return httpx.Response(self._finalize_status, json={"error": "boom"})
            return httpx.Response(
                200,
                json={
                    "workspaceId": (body or {}).get("workspaceId"),
                    "results": self._finalize_results,
                },
            )

        return httpx.Response(404, json={"error": "not_found", "path": path})


def _parse_query(url: str) -> List[Tuple[str, str]]:
    if "?" not in url:
        return []
    qs = url.split("?", 1)[1]
    out: List[Tuple[str, str]] = []
    for part in qs.split("&"):
        if not part:
            continue
        k, _, v = part.partition("=")
        out.append((k, v))
    return out


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def daemon() -> FakeDaemon:
    return FakeDaemon()


@pytest.fixture
def mock_client(daemon: FakeDaemon) -> httpx.Client:
    transport = httpx.MockTransport(daemon.handler)
    return httpx.Client(transport=transport, timeout=5.0)


@pytest.fixture(autouse=True)
def env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Default env for every test — individual tests override via monkeypatch."""
    monkeypatch.setenv("PRISMER_DAEMON_URL", "http://daemon.test")
    monkeypatch.setenv("PRISMER_WORKSPACE_ID", "ws_test")
    monkeypatch.setenv("PRISMER_AGENT_IM_USER_ID", "im_agent_test")
    monkeypatch.setenv("PRISMER_DAEMON_ID", "dev_test")


@pytest.fixture
def provider(daemon: FakeDaemon, mock_client: httpx.Client) -> PrismerDaemonMemoryProvider:
    """Fresh provider with the mock transport patched in.

    `initialize()` rebuilds the HTTP client, so we override `_make_client`
    to always return the test transport. This way the mock client survives
    the fixture set up + initialize() call sequence.
    """
    p = PrismerDaemonMemoryProvider()
    p._make_client = lambda: mock_client  # type: ignore[assignment]
    p._client = mock_client  # type: ignore[attr-defined]
    return p


# ---------------------------------------------------------------------------
# 1. is_available() False when env unset
# ---------------------------------------------------------------------------

def test_is_available_returns_false_when_env_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PRISMER_WORKSPACE_ID", raising=False)
    p = PrismerDaemonMemoryProvider()
    assert p.is_available() is False


# ---------------------------------------------------------------------------
# 2. is_available() False on healthz timeout / network error
# ---------------------------------------------------------------------------

def test_is_available_returns_false_on_health_probe_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Simulate a hanging daemon by making the health probe raise."""
    p = PrismerDaemonMemoryProvider()

    def _raise_timeout(*_a: Any, **_k: Any) -> Any:
        raise httpx.ConnectTimeout("simulated timeout")

    # is_available() builds its own short-lived client, so monkey-patch
    # httpx.Client.get globally (only inside is_available's path).
    monkeypatch.setattr(httpx.Client, "get", _raise_timeout)
    assert p.is_available() is False


# ---------------------------------------------------------------------------
# 3. initialize() preloads INDEX.md → system_prompt_block() returns it
# ---------------------------------------------------------------------------

def test_initialize_preloads_index_and_system_prompt_block_returns_it(
    daemon: FakeDaemon, provider: PrismerDaemonMemoryProvider,
) -> None:
    daemon.set_index("# Workspace\n\n- decisions/auth.md")
    provider.initialize(session_id="sess_1")
    block = provider.system_prompt_block()
    assert block.startswith("## Workspace memory (INDEX)")
    assert "decisions/auth.md" in block


# ---------------------------------------------------------------------------
# 4. system_prompt_block() returns "" when INDEX.md is missing
# ---------------------------------------------------------------------------

def test_system_prompt_block_skill_only_when_index_missing(
    daemon: FakeDaemon, provider: PrismerDaemonMemoryProvider,
) -> None:
    """When INDEX is missing, the INDEX heading is omitted but the
    memory-curation skill block is still emitted (Line C C6 design —
    skill teaches the agent when to write memory pages even on a
    brand-new workspace with zero existing memory). See provider
    docstring for the contract."""
    daemon.set_index(None, status=404)
    provider.initialize(session_id="sess_1")
    block = provider.system_prompt_block()
    assert "Workspace memory (INDEX)" not in block
    assert "Memory curation skill" in block


# ---------------------------------------------------------------------------
# 5. prefetch(query) renders the <memory-context> fence
# ---------------------------------------------------------------------------

def test_prefetch_renders_memory_context_fence(
    daemon: FakeDaemon,
    provider: PrismerDaemonMemoryProvider,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Legacy auto-injection path — opt in via env var (M-A default is no-op).
    monkeypatch.setenv("PRISMER_MEMORY_AUTO_PREFETCH", "1")
    daemon.set_search_results([
        {
            "pageId": "p_a",
            "path": "decisions/auth.md",
            "snippet": "We chose OAuth.",
            "score": 0.9,
            "tokenCount": 32,
        },
        {
            "pageId": "p_b",
            "path": "glossary/identity.md",
            "snippet": "DID = decentralized identifier.",
            "score": 0.6,
            "tokenCount": 18,
        },
    ])
    provider.initialize(session_id="sess_1")
    result = provider.prefetch("how do I auth")
    assert result.startswith("<memory-context>\n")
    assert result.endswith("\n</memory-context>")
    assert "## decisions/auth.md" in result
    assert "We chose OAuth." in result
    assert "## glossary/identity.md" in result


# ---------------------------------------------------------------------------
# 6. prefetch(query) emits one recall_inject per result
# ---------------------------------------------------------------------------

def test_prefetch_emits_one_recall_inject_per_result(
    daemon: FakeDaemon,
    provider: PrismerDaemonMemoryProvider,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Legacy auto-injection path — opt in via env var (M-A default is no-op).
    monkeypatch.setenv("PRISMER_MEMORY_AUTO_PREFETCH", "1")
    daemon.set_search_results([
        {"pageId": "p_a", "path": "a.md", "snippet": "x", "score": 0.8, "tokenCount": 10},
        {"pageId": "p_b", "path": "b.md", "snippet": "y", "score": 0.7, "tokenCount": 20},
    ])
    provider.initialize(session_id="sess_1")
    provider.prefetch("query foo")
    emits = daemon.emit_calls()
    assert len(emits) == 2
    types = [e["eventType"] for e in emits]
    assert types == ["recall_inject", "recall_inject"]
    # First emit must reference page p_a, with the right query + actor.
    first = emits[0]
    assert first["pageId"] == "p_a"
    assert first["query"] == "query foo"
    assert first["actorImUserId"] == "im_agent_test"
    assert first["actorKind"] == "agent"
    assert first["workspaceId"] == "ws_test"
    assert first["schemaVersion"] == 1
    assert first["metricsJson"]["topK"] == 2
    assert first["metricsJson"]["relevanceScore"] == 0.8


# ---------------------------------------------------------------------------
# 7. prefetch() returns "" on daemon error (graceful degradation)
# ---------------------------------------------------------------------------

def test_prefetch_returns_empty_on_daemon_error(
    daemon: FakeDaemon,
    provider: PrismerDaemonMemoryProvider,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Legacy auto-injection path — opt in via env var so we exercise the
    # daemon-error branch. Without the env var prefetch short-circuits to
    # "" before any HTTP call (covered in test 7b below).
    monkeypatch.setenv("PRISMER_MEMORY_AUTO_PREFETCH", "1")
    daemon.set_search_results([], status=500)
    provider.initialize(session_id="sess_1")
    # Empty result should NOT raise. Provider catches and returns "".
    assert provider.prefetch("anything") == ""


# ---------------------------------------------------------------------------
# 7b. M-A default: prefetch() returns "" without hitting the daemon
# ---------------------------------------------------------------------------

def test_prefetch_default_is_noop_no_daemon_call(
    daemon: FakeDaemon,
    provider: PrismerDaemonMemoryProvider,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """M-A: ``prefetch()`` is a no-op unless ``PRISMER_MEMORY_AUTO_PREFETCH``
    is opted into. Doc 25 §3 支柱 1 — agents call ``memory_search`` selectively
    instead of paying the auto-injection tax on every turn.
    """
    monkeypatch.delenv("PRISMER_MEMORY_AUTO_PREFETCH", raising=False)
    # Seed search results so a stray call would *succeed* and produce a
    # fence — we want to prove no call happens at all.
    daemon.set_search_results([
        {"pageId": "p_a", "path": "a.md", "snippet": "x", "score": 0.9, "tokenCount": 10},
    ])
    provider.initialize(session_id="sess_1")
    # Drop the request log AFTER initialize() (which legitimately preloads
    # INDEX.md) so we observe only what prefetch would have done.
    daemon.requests.clear()

    result = provider.prefetch("how do I auth")

    assert result == ""
    # No search call, no observability emit — the whole point of the M-A
    # default is zero per-turn cost when the agent did not ask for it.
    search_calls = [
        path for method, path, _ in daemon.requests
        if method == "GET" and path.startswith("/local/memory/search")
    ]
    assert search_calls == []
    assert daemon.emit_calls() == []


# ---------------------------------------------------------------------------
# 8. get_tool_schemas() returns memory_search + memory_load
# ---------------------------------------------------------------------------

def test_get_tool_schemas_shape() -> None:
    p = PrismerDaemonMemoryProvider()
    schemas = p.get_tool_schemas()
    # M-B added memory_recall on top of phase-0's memory_search / memory_load.
    assert len(schemas) == 3
    names = [s["name"] for s in schemas]
    assert names == ["memory_search", "memory_load", "memory_recall"]
    # Required field on memory_search input.
    search = next(s for s in schemas if s["name"] == "memory_search")
    assert "query" in search["parameters"]["required"]
    # Memory load schema must allow uri OR workspaceId+path.
    load = next(s for s in schemas if s["name"] == "memory_load")
    props = load["parameters"]["properties"]
    assert "uri" in props
    assert "workspaceId" in props
    assert "path" in props
    # Confirm we mirror MEMORY_*_SCHEMA module-level constants.
    assert search == MEMORY_SEARCH_SCHEMA
    assert load == MEMORY_LOAD_SCHEMA
    # memory_recall: query required, recentTools optional array.
    recall = next(s for s in schemas if s["name"] == "memory_recall")
    assert "query" in recall["parameters"]["required"]
    assert recall["parameters"]["properties"]["recentTools"]["type"] == "array"


# ---------------------------------------------------------------------------
# 9. handle_tool_call("memory_search") returns JSON + emits recall_pull
# ---------------------------------------------------------------------------

def test_handle_tool_call_memory_search_emits_recall_pull(
    daemon: FakeDaemon, provider: PrismerDaemonMemoryProvider,
) -> None:
    daemon.set_search_results([
        {"pageId": "p_a", "path": "a.md", "snippet": "x", "score": 0.9, "tokenCount": 10},
    ])
    provider.initialize(session_id="sess_1")
    raw = provider.handle_tool_call("memory_search", {"query": "foo", "limit": 5})
    body = json.loads(raw)
    assert body["query"] == "foo"
    assert len(body["results"]) == 1
    assert body["results"][0]["path"] == "a.md"
    # Tool call must emit recall_pull (not recall_inject, that's the
    # auto-injection variant).
    pulls = [e for e in daemon.emit_calls() if e["eventType"] == "recall_pull"]
    assert len(pulls) == 1
    assert pulls[0]["pageId"] == "p_a"
    assert pulls[0]["query"] == "foo"
    assert pulls[0]["metadataJson"]["tool"] == "memory_search"


# ---------------------------------------------------------------------------
# 10. handle_tool_call("memory_load") returns content + emits recall_pull
# ---------------------------------------------------------------------------

def test_handle_tool_call_memory_load_emits_recall_pull(
    daemon: FakeDaemon, provider: PrismerDaemonMemoryProvider,
) -> None:
    daemon.set_load_response({
        "page": {
            "id": "p_xyz",
            "path": "decisions/auth.md",
            "title": "Auth",
            "pageType": "decision",
            "version": 1,
            "contentHash": "h1",
        },
        "content": "We chose OAuth in 2026-01.",
    })
    provider.initialize(session_id="sess_1")
    raw = provider.handle_tool_call(
        "memory_load",
        {"uri": "prismer://workspace/ws_test/memory/decisions/auth.md"},
    )
    body = json.loads(raw)
    assert body["content"] == "We chose OAuth in 2026-01."
    assert body["page"]["id"] == "p_xyz"
    pulls = [e for e in daemon.emit_calls() if e["eventType"] == "recall_pull"]
    assert len(pulls) == 1
    assert pulls[0]["pageId"] == "p_xyz"
    assert pulls[0]["metadataJson"]["tool"] == "memory_load"


# ---------------------------------------------------------------------------
# 11. shutdown() closes the persistent HTTP client
# ---------------------------------------------------------------------------

def test_shutdown_closes_http_client(provider: PrismerDaemonMemoryProvider) -> None:
    provider.initialize(session_id="sess_1")
    assert provider._client is not None  # type: ignore[attr-defined]
    provider.shutdown()
    assert provider._client is None  # type: ignore[attr-defined]
    # Calling shutdown again must not raise.
    provider.shutdown()


# ---------------------------------------------------------------------------
# Bonus coverage — these aren't part of the 11 spec cases but pin
# behavior the provider relies on.
# ---------------------------------------------------------------------------

def test_truncate_to_budget_caps_lines() -> None:
    # 250 lines, cap 200 → 200 lines remain.
    content = "\n".join(f"line {i}" for i in range(250))
    out = _truncate_to_budget(content, max_lines=200, max_bytes=10_000_000)
    assert out.count("\n") == 199  # 200 lines = 199 newlines


def test_truncate_to_budget_caps_bytes() -> None:
    content = "x" * 50_000
    out = _truncate_to_budget(content, max_lines=10_000, max_bytes=1024)
    assert len(out.encode("utf-8")) <= 1024


def test_handle_tool_call_unknown_returns_error_json(
    provider: PrismerDaemonMemoryProvider,
) -> None:
    # Tool dispatch precondition: initialize() must be called first per
    # the Hermes ABC contract. Without it the lifecycle guard short-
    # circuits to ``provider_not_initialized`` (see separate test below).
    provider.initialize(session_id="sess_1")
    raw = provider.handle_tool_call("nope_not_a_tool", {})
    body = json.loads(raw)
    assert body["error"] == "unknown_tool"


def test_handle_tool_call_before_initialize_returns_safe_error(
    provider: PrismerDaemonMemoryProvider,
) -> None:
    """Tool dispatch before initialize() must not raise — Hermes ABC
    contract requires initialize() first; an exception here would kill
    the agent loop. Provider returns a safe error JSON instead.
    """
    # Note: do NOT call provider.initialize() — that's the point.
    raw = provider.handle_tool_call("memory_search", {"query": "anything"})
    body = json.loads(raw)
    assert body["error"] == "provider_not_initialized"
    # Confirm prefetch follows the same contract — empty string, no raise.
    assert provider.prefetch("anything") == ""


def test_handle_tool_call_memory_search_missing_query(
    provider: PrismerDaemonMemoryProvider,
) -> None:
    provider.initialize(session_id="sess_1")
    raw = provider.handle_tool_call("memory_search", {})
    body = json.loads(raw)
    assert body["error"] == "missing_query"


def test_handle_tool_call_memory_load_404_returns_error_json(
    daemon: FakeDaemon, provider: PrismerDaemonMemoryProvider,
) -> None:
    daemon.set_load_response(None, status=404)
    provider.initialize(session_id="sess_1")
    raw = provider.handle_tool_call(
        "memory_load",
        {"workspaceId": "ws_test", "path": "missing.md"},
    )
    body = json.loads(raw)
    assert body["error"] == "not_found"


def test_handle_tool_call_memory_search_propagates_page_type_filter(
    daemon: FakeDaemon, provider: PrismerDaemonMemoryProvider,
) -> None:
    """Schema advertises ``pageType: array`` filter — make sure the tool
    actually wires it through to the daemon's query string. Mirrors the
    canonical TS adapter (memory-tools.ts:167-171) which takes the first
    element of the array (daemon accepts a single value per request).

    Regression for review issue I-1: without this, the LLM passes
    ``pageType: ["decision"]`` and the daemon silently sees no filter.
    """
    daemon.set_search_results([
        {"pageId": "p_a", "path": "decisions/auth.md", "snippet": "x", "score": 0.9, "tokenCount": 10},
    ])
    provider.initialize(session_id="sess_1")
    raw = provider.handle_tool_call(
        "memory_search",
        {"query": "auth", "limit": 5, "pageType": ["decision"]},
    )
    body = json.loads(raw)
    assert body["query"] == "auth"

    # Find the GET /local/memory/search call recorded by the fake daemon
    # and confirm pageType=decision is in the query string.
    search_paths = [
        full_path
        for method, full_path, _ in daemon.requests
        if method == "GET" and full_path.startswith("/local/memory/search")
    ]
    assert len(search_paths) == 1, f"expected exactly one search call, got {search_paths!r}"
    qs = dict(_parse_query(search_paths[0]))
    assert qs.get("pageType") == "decision", (
        f"pageType filter dropped — query string was {qs!r}"
    )
    # Sanity: limit / topK threaded through too (catches I-2 regression).
    assert qs.get("topK") == "5"


def test_handle_tool_call_memory_search_uses_schema_default_when_limit_omitted(
    daemon: FakeDaemon, provider: PrismerDaemonMemoryProvider,
) -> None:
    """When the LLM omits ``limit``, _tool_memory_search must use the
    schema's documented default (5), not prefetch's auto-inject budget (3).

    Regression for review issue I-2: schema says default 5, runtime was
    silently using 3.
    """
    daemon.set_search_results([])
    provider.initialize(session_id="sess_1")
    provider.handle_tool_call("memory_search", {"query": "anything"})
    search_paths = [
        full_path
        for method, full_path, _ in daemon.requests
        if method == "GET" and full_path.startswith("/local/memory/search")
    ]
    assert len(search_paths) == 1
    qs = dict(_parse_query(search_paths[0]))
    assert qs.get("topK") == "5", (
        f"tool default top-K must match schema default (5), got {qs.get('topK')!r}"
    )


# ---------------------------------------------------------------------------
# M-B — memory_recall tool + fork_query + selector helpers
# ---------------------------------------------------------------------------

def test_get_tool_schemas_includes_memory_recall() -> None:
    """M-B exposes a third tool. CC/Hermes/OpenClaw/Codex parity expects it."""
    p = PrismerDaemonMemoryProvider()
    schemas = p.get_tool_schemas()
    names = [s["name"] for s in schemas]
    assert names == ["memory_search", "memory_load", "memory_recall"]


def test_parse_selector_output_handles_clean_json() -> None:
    entries = [
        {"path": "memory/a.md", "title": None, "pageType": "leaf", "description": None, "mtimeMs": 0},
        {"path": "memory/b.md", "title": None, "pageType": "leaf", "description": None, "mtimeMs": 0},
    ]
    selected = PrismerDaemonMemoryProvider._parse_selector_output(
        '{"selected_memories":["memory/a.md"]}', entries,
    )
    assert selected == ["memory/a.md"]


def test_parse_selector_output_strips_code_fences() -> None:
    entries = [{"path": "memory/a.md", "title": None, "pageType": "leaf", "description": None, "mtimeMs": 0}]
    selected = PrismerDaemonMemoryProvider._parse_selector_output(
        '```json\n{"selected_memories":["memory/a.md"]}\n```',
        entries,
    )
    assert selected == ["memory/a.md"]


def test_parse_selector_output_drops_hallucinated_paths() -> None:
    entries = [{"path": "memory/a.md", "title": None, "pageType": "leaf", "description": None, "mtimeMs": 0}]
    selected = PrismerDaemonMemoryProvider._parse_selector_output(
        '{"selected_memories":["memory/nope.md","memory/a.md"]}', entries,
    )
    assert selected == ["memory/a.md"]


def test_parse_selector_output_returns_empty_on_garbage_input() -> None:
    selected = PrismerDaemonMemoryProvider._parse_selector_output("not json at all", [])
    assert selected == []


def test_fork_query_returns_empty_without_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    """fork_query must degrade silently when no Anthropic API key is set."""
    monkeypatch.delenv("PRISMER_MEMORY_FORK_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    p = PrismerDaemonMemoryProvider()
    assert p.fork_query("system", "user") == ""


def test_fork_query_posts_to_anthropic_with_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    """When key is set, fork_query POSTs to v1/messages and returns the text content."""
    monkeypatch.setenv("PRISMER_MEMORY_FORK_API_KEY", "sk-ant-test")
    monkeypatch.setenv("PRISMER_MEMORY_FORK_MODEL", "claude-haiku-4-5-20251001")

    captured: Dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["headers"] = dict(request.headers)
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "id": "msg_1",
                "type": "message",
                "role": "assistant",
                "content": [{"type": "text", "text": '{"selected_memories":["memory/a.md"]}'}],
                "stop_reason": "end_turn",
            },
        )

    transport = httpx.MockTransport(handler)
    # Patch httpx.Client globally so PrismerDaemonMemoryProvider's internal
    # one-shot client picks up the mock transport.
    real_client_init = httpx.Client.__init__

    def patched_init(self: httpx.Client, **kwargs: Any) -> None:
        kwargs["transport"] = transport
        real_client_init(self, **kwargs)

    monkeypatch.setattr(httpx.Client, "__init__", patched_init)
    p = PrismerDaemonMemoryProvider()
    out = p.fork_query("sys prompt", "user msg")
    assert out == '{"selected_memories":["memory/a.md"]}'
    assert captured["url"].endswith("/v1/messages")
    assert captured["headers"]["x-api-key"] == "sk-ant-test"
    assert captured["body"]["model"] == "claude-haiku-4-5-20251001"
    assert captured["body"]["system"] == "sys prompt"
    assert captured["body"]["messages"] == [{"role": "user", "content": "user msg"}]


def test_memory_recall_returns_empty_when_manifest_is_empty(
    daemon: FakeDaemon, provider: PrismerDaemonMemoryProvider,
) -> None:
    """No candidates → no fork call → empty results. Skips LLM cost when there's nothing to pick."""
    daemon.set_manifest([])
    provider.initialize(session_id="sess_1")
    raw = provider.handle_tool_call("memory_recall", {"query": "what was the auth plan"})
    body = json.loads(raw)
    assert body == {"query": "what was the auth plan", "results": []}
    # No POST to recall/finalize — daemon-side resolution skipped.
    assert all(p != "/local/memory/recall/finalize" for _m, p, _b in daemon.requests)


def test_memory_recall_orchestrates_manifest_fork_and_finalize(
    daemon: FakeDaemon,
    provider: PrismerDaemonMemoryProvider,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """End-to-end: manifest → fork_query (mocked) → finalize → emit recall_pull."""
    daemon.set_manifest(
        [
            {
                "path": "memory/auth.md",
                "title": "Auth decision",
                "pageType": "decision",
                "description": "OAuth migration plan",
                "mtimeMs": 1700000000000,
            }
        ]
    )
    daemon.set_finalize_results(
        [
            {
                "pageId": "p_auth",
                "path": "memory/auth.md",
                "title": "Auth decision",
                "snippet": "We chose OAuth.",
                "mtimeMs": 1700000000000,
                "uri": "prismer://workspace/ws_test/memory/memory/auth.md",
            }
        ]
    )

    captured_fork: Dict[str, Any] = {}

    def fake_fork(self: PrismerDaemonMemoryProvider, system: str, user: str, *, max_tokens: int = 256) -> str:
        captured_fork["system"] = system
        captured_fork["user"] = user
        return '{"selected_memories":["memory/auth.md"]}'

    monkeypatch.setattr(PrismerDaemonMemoryProvider, "fork_query", fake_fork)

    provider.initialize(session_id="sess_1")
    raw = provider.handle_tool_call("memory_recall", {"query": "auth migration"})
    body = json.loads(raw)
    assert body["query"] == "auth migration"
    assert len(body["results"]) == 1
    assert body["results"][0]["path"] == "memory/auth.md"

    # Selector got the system prompt verbatim and the user message embedded
    # the manifest entry.
    assert "be selective" in captured_fork["system"].lower() or "BE SELECTIVE" in captured_fork["system"].upper() or "Be" in captured_fork["system"]
    assert "memory/auth.md" in captured_fork["user"]
    assert "Query: auth migration" in captured_fork["user"]

    # recall_pull emitted with tool=memory_recall + forkLabel=memory_recall.
    pulls = [
        e for e in daemon.emit_calls()
        if e["eventType"] == "recall_pull" and e.get("metadataJson", {}).get("tool") == "memory_recall"
    ]
    assert len(pulls) == 1
    assert pulls[0]["pageId"] == "p_auth"
    assert pulls[0]["metadataJson"]["forkLabel"] == "memory_recall"


def test_memory_recall_returns_empty_when_fork_returns_garbage(
    daemon: FakeDaemon,
    provider: PrismerDaemonMemoryProvider,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Selector misbehaves → empty list. Never trust the LLM's output blindly."""
    daemon.set_manifest([
        {"path": "memory/a.md", "title": None, "pageType": "leaf", "description": "x", "mtimeMs": 0},
    ])
    daemon.set_finalize_results([])  # never called, but defensively set
    monkeypatch.setattr(
        PrismerDaemonMemoryProvider, "fork_query", lambda self, system, user, *, max_tokens=256: "garbage not json"
    )
    provider.initialize(session_id="sess_1")
    raw = provider.handle_tool_call("memory_recall", {"query": "x"})
    body = json.loads(raw)
    assert body["results"] == []


def test_memory_recall_rejects_missing_query(
    provider: PrismerDaemonMemoryProvider,
) -> None:
    provider.initialize(session_id="sess_1")
    raw = provider.handle_tool_call("memory_recall", {})
    body = json.loads(raw)
    assert body["error"] == "missing_query"
