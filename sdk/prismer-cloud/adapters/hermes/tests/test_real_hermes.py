"""
test_real_hermes.py — End-to-end integration against a real Hermes checkout.

Skipped unless the HERMES_REPO environment variable points at a working
Hermes source tree (e.g. /Users/me/workspace/hermes-agent). This is the test
that would have caught the original 0.1.0 bug — we load our plugin the way
Hermes actually loads plugins and then fire invoke_hook() with the real
kwargs shape.

Run with:
    HERMES_REPO=/path/to/hermes-agent pytest tests/test_real_hermes.py -v
"""

import os
import sys

import pytest


HERMES_REPO = os.environ.get("HERMES_REPO")

pytestmark = pytest.mark.skipif(
    not HERMES_REPO or not os.path.isdir(HERMES_REPO),
    reason="HERMES_REPO env not set or path invalid — skipping real integration",
)


@pytest.fixture(scope="module", autouse=True)
def hermes_on_path():
    """Prepend the Hermes repo to sys.path so we import the real modules."""
    sys.path.insert(0, HERMES_REPO)
    # Adapter src dir (normal discovery also works, but keep it deterministic)
    sys.path.insert(
        0, os.path.join(os.path.dirname(__file__), "..", "src")
    )
    yield
    # Don't pop — test isolation isn't needed at module scope


def _load():
    from hermes_cli.plugins import (
        PluginContext,
        PluginManager,
        PluginManifest,
        VALID_HOOKS,
    )
    from prismer_adapter_hermes.register import register

    mgr = PluginManager()
    manifest = PluginManifest(
        name="prismer-adapter-hermes",
        version="0.1.1",
        source="user",
    )
    ctx = PluginContext(manifest, mgr)

    emitted = []
    adapter = register(ctx, sink=emitted.append)
    return mgr, adapter, emitted, VALID_HOOKS


class TestRealHermesIntegration:
    def test_all_hook_names_are_in_valid_hooks(self):
        _, _, _, valid = _load()
        from prismer_adapter_hermes.register import _HOOK_MAP
        for hook_name, _m in _HOOK_MAP:
            assert hook_name in valid, (
                f"{hook_name} rejected by real Hermes VALID_HOOKS"
            )

    def test_plugin_registers_all_hooks_without_errors(self):
        mgr, _, _, _ = _load()
        from prismer_adapter_hermes.register import _HOOK_MAP
        registered = sum(1 for cbs in mgr._hooks.values() if cbs)
        assert registered == len(_HOOK_MAP)

    def test_pre_tool_call_fires_via_invoke_hook(self):
        mgr, _, emitted, _ = _load()
        emitted.clear()
        mgr.invoke_hook(
            "pre_tool_call",
            tool_name="terminal",
            args={"command": "ls"},
            task_id="t1",
            session_id="s1",
            tool_call_id="call_xyz",
        )
        tool_pre = [e for e in emitted if e["type"] == "agent.tool.pre"]
        assert len(tool_pre) == 1
        assert tool_pre[0]["callId"] == "call_xyz"
        assert tool_pre[0]["tool"] == "terminal"

    def test_pre_llm_call_returns_context_when_provider_set(self):
        """Covers the PARA L4 cache-safe inject path end-to-end."""
        from hermes_cli.plugins import PluginContext, PluginManager, PluginManifest
        from prismer_adapter_hermes.register import register as prismer_register

        mgr = PluginManager()
        manifest = PluginManifest(
            name="prismer-adapter-hermes",
            version="0.1.1",
            source="user",
        )
        ctx = PluginContext(manifest, mgr)
        emitted = []
        prismer_register(
            ctx,
            sink=emitted.append,
            context_provider=lambda **kw: "[recalled]",
        )

        results = mgr.invoke_hook(
            "pre_llm_call",
            session_id="s1",
            user_message="hi",
            conversation_history=[],
            is_first_turn=True,
            model="gpt-5",
            platform="cli",
        )
        # Hermes collects non-None return values; ours should carry the inject.
        assert results == [{"context": "[recalled]"}]

    def test_subagent_stop_fires_and_normalises_interrupted(self):
        mgr, _, emitted, _ = _load()
        emitted.clear()
        mgr.invoke_hook(
            "subagent_stop",
            parent_session_id="p1",
            child_role="researcher",
            child_summary="n/a",
            child_status="interrupted",
            duration_ms=333,
        )
        ended = [e for e in emitted if e["type"] == "agent.subagent.ended"]
        assert len(ended) == 1
        assert ended[0]["status"] == "cancelled"  # normalised
