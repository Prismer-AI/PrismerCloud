"""Unit tests for the reversible recall-tools plugin (desktop202 doc 19 §8).

The plugin lives in the runtime package, not the python SDK:
``sdk/prismer/plugins/tools/prismer-recall/__init__.py``. It is a
plain Hermes ``register_tool`` plugin — NOT a MemoryProvider. These tests load
it by file path (it is not importable as a package), drive ``register(ctx)``
with a fake PluginContext, and exercise the two handlers against a mocked
daemon HTTP surface (no live daemon, no network).

Covers:
  1. register(ctx) registers exactly memory_search + memory_load via register_tool
  2. it registers exactly the bounded post_api_request routing hook and no provider
  3. memory_search handler GETs /local/memory/search with workspace+query+topK
  4. memory_load handler GETs /local/memory/load with the uri
  5. handlers degrade safely (no workspace bound / missing query / daemon down)
  6. the plugin source does NOT contain the provider-coercion substrings
"""

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import pytest


# ---------------------------------------------------------------------------
# Load the plugin module by file path (it is not an installed package).
# ---------------------------------------------------------------------------

_PLUGIN_PATH = (
    Path(__file__).resolve().parents[3]
    / "prismer"
    / "plugins"
    / "tools"
    / "prismer-recall"
    / "__init__.py"
)


def _load_plugin():
    spec = importlib.util.spec_from_file_location("prismer_recall_under_test", _PLUGIN_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def plugin():
    assert _PLUGIN_PATH.exists(), f"plugin source not found at {_PLUGIN_PATH}"
    return _load_plugin()


# ---------------------------------------------------------------------------
# Fake PluginContext — records register_tool calls; asserts nothing else used.
# ---------------------------------------------------------------------------

class FakeContext:
    def __init__(self) -> None:
        self.tools: Dict[str, Dict[str, Any]] = {}
        self.hooks: Dict[str, Callable[..., None]] = {}
        self.other_calls: List[str] = []

    def register_tool(self, name, toolset, schema, handler, **kwargs):  # noqa: ANN001
        self.tools[name] = {
            "toolset": toolset,
            "schema": schema,
            "handler": handler,
            "kwargs": kwargs,
        }

    def register_hook(self, name: str, handler: Callable[..., None]) -> None:
        self.hooks[name] = handler

    # Any other registration here would be a contract violation; record it so
    # the test can assert it never happened.
    def __getattr__(self, item: str) -> Callable[..., None]:
        if item.startswith("register_") and item != "register_tool":
            def _rec(*_a: Any, **_k: Any) -> None:
                self.other_calls.append(item)
            return _rec
        raise AttributeError(item)


# ---------------------------------------------------------------------------
# Fake daemon — monkeypatch the plugin's urllib.request.urlopen
# ---------------------------------------------------------------------------

class FakeResp:
    def __init__(self, payload: dict) -> None:
        self._payload = payload

    def read(self) -> bytes:
        return json.dumps(self._payload).encode("utf-8")

    def __enter__(self) -> "FakeResp":
        return self

    def __exit__(self, *_a: Any) -> None:
        return None


@pytest.fixture
def fake_daemon(plugin, monkeypatch: pytest.MonkeyPatch):
    """Patch the plugin module's urlopen; record (method, full_url)."""
    calls: List[Tuple[str, str]] = []
    routes: Dict[str, dict] = {}

    def set_route(path_prefix: str, payload: dict) -> None:
        routes[path_prefix] = payload

    def fake_urlopen(req, timeout: int = 5):  # noqa: ANN001
        url = req.full_url if hasattr(req, "full_url") else str(req)
        calls.append((req.get_method(), url))
        for prefix, payload in routes.items():
            if prefix in url:
                return FakeResp(payload)
        # Default: empty success
        return FakeResp({})

    monkeypatch.setattr(plugin.urllib.request, "urlopen", fake_urlopen)

    class Harness:
        pass

    h = Harness()
    h.calls = calls  # type: ignore[attr-defined]
    h.set_route = set_route  # type: ignore[attr-defined]
    return h


@pytest.fixture(autouse=True)
def env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PRISMER_WORKSPACE_ID", "ws_test")
    monkeypatch.setenv("PRISMER_DAEMON_PORT", "3210")
    monkeypatch.delenv("PRISMER_DAEMON_TOKEN", raising=False)


# ---------------------------------------------------------------------------
# 1 + 2. register(ctx) registers exactly the two FROZEN tools, nothing else
# ---------------------------------------------------------------------------

def test_register_registers_exactly_two_frozen_tools(plugin) -> None:
    ctx = FakeContext()
    plugin.register(ctx)
    assert set(ctx.tools.keys()) == {"memory_search", "memory_load"}
    # Each was registered with a schema carrying its own name + parameters.
    assert ctx.tools["memory_search"]["schema"]["name"] == "memory_search"
    assert "query" in ctx.tools["memory_search"]["schema"]["parameters"]["required"]
    load_props = ctx.tools["memory_load"]["schema"]["parameters"]["properties"]
    assert "uri" in load_props and "path" in load_props


def test_register_uses_only_tools_and_bounded_terminal_hook(plugin) -> None:
    ctx = FakeContext()
    plugin.register(ctx)
    assert set(ctx.hooks.keys()) == {"post_api_request"}
    # No register_memory_provider / register_context_engine etc.
    assert ctx.other_calls == [], f"unexpected non-tool registrations: {ctx.other_calls}"


def test_terminal_hook_forwards_only_bounded_routing_evidence(plugin, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PRISMER_AGENT_IM_USER_ID", "agent_test")
    posts: List[Tuple[str, Dict[str, Any], int]] = []
    monkeypatch.setattr(
        plugin,
        "_http_post",
        lambda path, body, timeout: posts.append((path, body, timeout)),
    )
    ctx = FakeContext()
    plugin.register(ctx)

    ctx.hooks["post_api_request"](
        session_id="session_test",
        response_model="served-model",
        provider="served-provider",
        response={"content": "must not cross the bridge"},
    )

    assert posts == [
        (
            "/v1/hooks/post_api_request",
            {
                "session_id": "session_test",
                "extra": {
                    "agent_im_user_id": "agent_test",
                    "workspace_id": "ws_test",
                    "served_model": "served-model",
                    "served_provider": "served-provider",
                },
            },
            2,
        )
    ]

    posts.clear()
    ctx.hooks["post_api_request"](
        session_id="session_test",
        response_model="",
        provider="served-provider",
    )
    assert posts == []


# ---------------------------------------------------------------------------
# 3. memory_search handler GETs /local/memory/search with the right query
# ---------------------------------------------------------------------------

def test_memory_search_handler_hits_daemon(plugin, fake_daemon) -> None:
    ctx = FakeContext()
    plugin.register(ctx)
    fake_daemon.set_route(
        "/local/memory/search",
        {"query": "auth", "results": [{"pageId": "p_a", "path": "a.md"}]},
    )
    handler = ctx.tools["memory_search"]["handler"]
    raw = handler({"query": "auth", "limit": 7})
    body = json.loads(raw)
    assert body["results"][0]["path"] == "a.md"

    # Exactly one GET to /local/memory/search with workspace + q + topK.
    searches = [u for (m, u) in fake_daemon.calls if m == "GET" and "/local/memory/search" in u]
    assert len(searches) == 1
    url = searches[0]
    assert "workspaceId=ws_test" in url
    assert "q=auth" in url
    assert "topK=7" in url


def test_memory_search_threads_page_type_filter(plugin, fake_daemon) -> None:
    ctx = FakeContext()
    plugin.register(ctx)
    fake_daemon.set_route("/local/memory/search", {"results": []})
    handler = ctx.tools["memory_search"]["handler"]
    handler({"query": "auth", "pageType": ["decision", "leaf"]})
    url = next(u for (m, u) in fake_daemon.calls if "/local/memory/search" in u)
    # Daemon takes a single pageType per request — first element.
    assert "pageType=decision" in url


# ---------------------------------------------------------------------------
# 4. memory_load handler GETs /local/memory/load with the uri
# ---------------------------------------------------------------------------

def test_memory_load_handler_hits_daemon(plugin, fake_daemon) -> None:
    ctx = FakeContext()
    plugin.register(ctx)
    fake_daemon.set_route(
        "/local/memory/load",
        {"page": {"id": "p_xyz", "path": "decisions/auth.md"}, "content": "We chose OAuth."},
    )
    handler = ctx.tools["memory_load"]["handler"]
    raw = handler({"uri": "prismer://workspace/ws_test/memory/decisions/auth.md"})
    body = json.loads(raw)
    assert body["content"] == "We chose OAuth."
    loads = [u for (m, u) in fake_daemon.calls if m == "GET" and "/local/memory/load" in u]
    assert len(loads) == 1
    assert "uri=" in loads[0]


# ---------------------------------------------------------------------------
# 5. Safe degradation
# ---------------------------------------------------------------------------

def test_memory_search_no_workspace_bound(plugin, fake_daemon, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PRISMER_WORKSPACE_ID", raising=False)
    ctx = FakeContext()
    plugin.register(ctx)
    raw = ctx.tools["memory_search"]["handler"]({"query": "x"})
    assert json.loads(raw)["error"] == "no workspace bound"
    # No HTTP call made.
    assert fake_daemon.calls == []


def test_memory_search_missing_query(plugin, fake_daemon) -> None:
    ctx = FakeContext()
    plugin.register(ctx)
    raw = ctx.tools["memory_search"]["handler"]({})
    assert json.loads(raw)["error"] == "missing_query"
    assert fake_daemon.calls == []


def test_memory_load_requires_uri_or_workspace_path(plugin, fake_daemon, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PRISMER_WORKSPACE_ID", raising=False)
    ctx = FakeContext()
    plugin.register(ctx)
    raw = ctx.tools["memory_load"]["handler"]({})
    assert "error" in json.loads(raw)
    assert fake_daemon.calls == []


def test_memory_search_daemon_down_returns_empty(plugin, monkeypatch: pytest.MonkeyPatch) -> None:
    ctx = FakeContext()
    plugin.register(ctx)

    def boom(*_a: Any, **_k: Any):
        raise OSError("connection refused")

    monkeypatch.setattr(plugin.urllib.request, "urlopen", boom)
    raw = ctx.tools["memory_search"]["handler"]({"query": "x"})
    body = json.loads(raw)
    # Degrade-not-break: empty results, no exception.
    assert body["results"] == []


# ---------------------------------------------------------------------------
# 6. Source must avoid the provider-coercion substrings (plugins.py:1318)
# ---------------------------------------------------------------------------

def test_source_avoids_provider_coercion_substrings() -> None:
    text = _PLUGIN_PATH.read_text(encoding="utf-8")[:8192]
    assert "register_memory_provider" not in text
    assert "MemoryProvider" not in text
