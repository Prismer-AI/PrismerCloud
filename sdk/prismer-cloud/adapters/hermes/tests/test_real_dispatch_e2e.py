"""
test_real_dispatch_e2e.py — End-to-end Mode B dispatch test against a
real LLM provider.

Gate
----
    Skipped unless ``RUN_REAL_DISPATCH_E2E=1`` is set in the environment.
    When enabled, we:
        1. Build a temporary Hermes plugin dir layout under
           ``$HERMES_HOME/plugins/prismer-adapter-hermes/`` so Hermes's
           normal plugin-discovery path can find us if it runs.
        2. Register our adapter directly with Hermes's module-level
           ``PluginManager`` (same technique as ``__main__.main``) so
           ``invoke_hook`` calls inside ``AIAgent.run_conversation`` hit
           our sink without depending on the config.yaml ``enabled`` list.
        3. Spin up the dispatch ``web.Application`` via ``AppRunner`` on
           127.0.0.1:8765 in-process.
        4. POST /dispatch with a real prompt → expect ``"PRISMER_DISPATCH_OK"``
           in the output and a full PARA event sequence in events.jsonl.

Credentials
-----------
    Use the pre-verified provider bundle:
        OPENAI_API_KEY=sk-JNQdVfQyeTmPqdrKl0oDe2lcocVgWzt9IhBjHtGaP13fFBUX
        OPENAI_API_BASE_URL=http://34.60.178.0:3000/v1
        AGENT_DEFAULT_MODEL=us-kimi-k2.5
    (exported by the caller; the test honours the env but does not embed
    the key).

Why in-process
--------------
    We deliberately avoid ``subprocess`` here so the plugin registration
    is observable from the test's own Python process — easier to debug
    and avoids having to stream logs out of a child.
"""

from __future__ import annotations

import asyncio
import json
import os
import socket
import sys
from pathlib import Path

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

RUN_REAL = os.environ.get("RUN_REAL_DISPATCH_E2E") == "1"

pytestmark = pytest.mark.skipif(
    not RUN_REAL,
    reason="Set RUN_REAL_DISPATCH_E2E=1 to run the real dispatch E2E",
)


def _events_file() -> Path:
    return Path.home() / ".prismer" / "para" / "events.jsonl"


def _read_events() -> list[dict]:
    path = _events_file()
    if not path.exists():
        return []
    out = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except Exception:
            continue
    return out


def _write_plugin_scaffold(hermes_home: Path) -> None:
    """Create a minimal plugin.yaml + __init__.py under HERMES_HOME.

    Hermes also needs the plugin name in ``plugins.enabled`` in its
    ``config.yaml`` to load it via the normal discovery path. We supply
    the file for completeness (daemons will inherit it) but the E2E
    test bypasses the gate by registering with the singleton directly.
    """
    plugin_dir = hermes_home / "plugins" / "prismer-adapter-hermes"
    plugin_dir.mkdir(parents=True, exist_ok=True)
    (plugin_dir / "plugin.yaml").write_text(
        "name: prismer-adapter-hermes\n"
        "version: 0.2.0\n"
        "description: Prismer PARA adapter (dispatch E2E scaffold)\n"
        "author: prismer\n"
    )
    (plugin_dir / "__init__.py").write_text(
        "from prismer_adapter_hermes.register import register  # noqa: F401\n"
    )


def _register_adapter_directly():
    """Mirror of ``dispatch.__main__._register_plugin_with_hermes`` —
    intentionally duplicated here so a test failure localises the fault
    instead of getting swallowed by CLI glue."""
    from hermes_cli.plugins import (  # type: ignore[import]
        PluginContext,
        PluginManifest,
        get_plugin_manager,
    )

    from prismer_adapter_hermes.register import register as prismer_register

    manager = get_plugin_manager()
    manifest = PluginManifest(
        name="prismer-adapter-hermes",
        version="0.2.0",
        source="user",
    )
    ctx = PluginContext(manifest, manager)
    prismer_register(ctx)
    # Prevent discover_and_load() from later wiping us out.
    manager._discovered = True  # type: ignore[attr-defined]


def _port_is_free(host: str, port: int) -> bool:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.2)
            return s.connect_ex((host, port)) != 0
    except Exception:
        return True


@pytest.fixture(scope="module", autouse=True)
def _dispatch_env_setup():
    """Module-level setup: scaffold plugin + register with Hermes."""
    hermes_home = Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes"))
    hermes_home.mkdir(parents=True, exist_ok=True)
    _write_plugin_scaffold(hermes_home)
    _register_adapter_directly()
    yield


async def _start_server_and_dispatch(payload: dict) -> tuple[dict, int]:
    """Start the dispatch app on 8765 via AppRunner and POST one request."""
    from aiohttp import web, ClientSession

    from prismer_adapter_hermes.dispatch.server import (
        build_app,
        default_config_from_env,
    )

    snapshot = default_config_from_env()
    app = build_app(config_provider=lambda: snapshot)

    port = 8765
    host = "127.0.0.1"
    if not _port_is_free(host, port):
        # CI / dev machines sometimes leave 8765 held. Fall back to any
        # free ephemeral port rather than crashing.
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, host=host, port=port)
    await site.start()
    try:
        async with ClientSession() as client:
            async with client.post(
                f"http://{host}:{port}/dispatch", json=payload, timeout=120
            ) as resp:
                body = await resp.json()
                status = resp.status
    finally:
        await runner.cleanup()
    return body, status


class TestRealDispatchE2E:
    """The single source of truth for "Mode B actually works against a
    real model". A regression here means we ship broken. Keep the asserts
    strict but the prompts deterministic."""

    def test_dispatch_text_only(self):
        before = len(_read_events())
        payload = {
            "taskId": "repro-001",
            "capability": "text/reply",
            "prompt": (
                "Reply with exactly PRISMER_DISPATCH_OK and nothing else."
            ),
            "stepIdx": 0,
        }
        body, status = asyncio.run(_start_server_and_dispatch(payload))

        assert status == 200, body
        assert body["ok"] is True, body
        assert "PRISMER_DISPATCH_OK" in body["output"], body

        events = _read_events()[before:]
        types = [e["type"] for e in events]

        # The full lifecycle we expect for a first-turn, tool-free
        # conversation. agent.register may already have fired at plugin
        # registration time so don't gate on it here.
        required = [
            "agent.session.started",
            "agent.prompt.submit",
            "agent.llm.pre",
            "agent.llm.post",
            "agent.turn.end",
        ]
        for t in required:
            assert t in types, (
                f"missing PARA event {t!r}; got {types}"
            )

        # sessionId MUST match the dispatch-{taskId} convention — this
        # is how the Node side correlates events back to a task.
        session_started = next(
            e for e in events if e["type"] == "agent.session.started"
        )
        assert session_started["sessionId"] == "dispatch-repro-001"

    def test_dispatch_with_tool_call(self):
        """A prompt that should trigger terminal tool use. This is the
        only place that exercises ``agent.tool.pre`` / ``agent.tool.post``
        from the real Hermes plugin hook API end to end."""
        before = len(_read_events())
        payload = {
            "taskId": "repro-tool-001",
            "capability": "code/shell",
            "prompt": (
                "Run the shell command `echo DISPATCH_TOOL_OK` using your "
                "terminal tool, then tell me the output verbatim."
            ),
        }
        body, status = asyncio.run(_start_server_and_dispatch(payload))

        assert status == 200, body
        assert body["ok"] is True, body

        events = _read_events()[before:]
        types = [e["type"] for e in events]

        assert "agent.tool.pre" in types, (
            f"missing agent.tool.pre; got {types}"
        )
        # Either .post (success) or .failure — the assertion is that
        # a tool outcome event was emitted. We also assert ok:True on
        # at least one .post if present.
        post_events = [e for e in events if e["type"] == "agent.tool.post"]
        failure_events = [
            e for e in events if e["type"] == "agent.tool.failure"
        ]
        assert post_events or failure_events, (
            f"no agent.tool.post or .failure observed; got {types}"
        )
        if post_events:
            assert any(
                e.get("ok") is True for e in post_events
            ), f"no successful tool post; got {post_events}"
