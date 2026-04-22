"""
test_register.py — Tests for the register() plugin entrypoint.

MockCtx mimics the Hermes PluginContext.register_hook() contract. A separate
test_real_hermes.py integrates against a real Hermes repo when HERMES_REPO
is set in the environment.
"""

import os
import sys
from unittest.mock import MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from prismer_adapter_hermes.adapter import HermesParaAdapter
from prismer_adapter_hermes.register import _HOOK_MAP, register


class MockCtx:
    """Stand-in for hermes_cli.plugins.PluginContext — records register_hook()."""

    def __init__(self):
        self.hooks: dict = {}

    def register_hook(self, hook_name: str, callback) -> None:
        self.hooks[hook_name] = callback


class TestRegister:
    def test_returns_adapter_instance(self):
        ctx = MockCtx()
        emitted = []
        adapter = register(ctx, sink=emitted.append)
        assert isinstance(adapter, HermesParaAdapter)

    def test_emits_agent_register_on_load(self):
        ctx = MockCtx()
        emitted = []
        register(ctx, sink=emitted.append)
        assert any(e["type"] == "agent.register" for e in emitted)

    def test_wires_all_8_plugin_hooks(self):
        """_HOOK_MAP intentionally excludes on_session_end (per-turn fire) —
        on_session_finalize owns the session-end signal in PARA semantics."""
        ctx = MockCtx()
        register(ctx, sink=MagicMock())
        assert len(ctx.hooks) == len(_HOOK_MAP) == 8

    def test_on_session_end_is_not_auto_wired(self):
        """on_session_end fires per-turn in Hermes (run_agent.py:11801); wiring
        it would either dedup turns 2..N away or double-emit session.ended on
        every turn. Either is wrong — on_session_finalize is authoritative."""
        ctx = MockCtx()
        register(ctx, sink=MagicMock())
        assert "on_session_end" not in ctx.hooks

    def test_all_hook_names_are_valid(self):
        """Every name we wire MUST be in Hermes's VALID_HOOKS set, otherwise
        Hermes will ignore us silently. We encode VALID_HOOKS inline to avoid
        making the unit test depend on a Hermes checkout — the integration
        test validates the real source."""
        HERMES_VALID_HOOKS = {
            "pre_tool_call", "post_tool_call",
            "transform_terminal_output", "transform_tool_result",
            "pre_llm_call", "post_llm_call",
            "pre_api_request", "post_api_request",
            "on_session_start", "on_session_end",
            "on_session_finalize", "on_session_reset",
            "subagent_stop",
        }
        for hook_name, _ in _HOOK_MAP:
            assert hook_name in HERMES_VALID_HOOKS, (
                f"Hook '{hook_name}' is not in Hermes VALID_HOOKS — it will "
                "never fire. Either add to Hermes upstream or remove here."
            )

    def test_wired_handlers_are_bound_methods_on_adapter(self):
        ctx = MockCtx()
        adapter = register(ctx, sink=MagicMock())
        for hook_name, method_name in _HOOK_MAP:
            wired = ctx.hooks.get(hook_name)
            assert wired is not None, f"{hook_name} was not wired"
            assert wired.__func__ is getattr(HermesParaAdapter, method_name)
            assert wired.__self__ is adapter

    def test_ctx_without_register_hook_is_a_no_op(self, capsys):
        """Defence-in-depth: exotic ctx (or pre-plugin-api Hermes) logs to
        stderr and emits agent.register but wires no hooks."""

        class DeadCtx:
            pass

        emitted = []
        adapter = register(DeadCtx(), sink=emitted.append)
        assert any(e["type"] == "agent.register" for e in emitted)
        assert "no register_hook()" in capsys.readouterr().err

    def test_hook_subscription_failure_does_not_abort_others(self, capsys):
        calls = []

        class PartialCtx:
            def register_hook(self, name, handler):
                if name == "pre_llm_call":
                    raise RuntimeError("simulated subscribe error")
                calls.append(name)

        register(PartialCtx(), sink=MagicMock())
        # All other 8 hooks still got through
        assert len(calls) == len(_HOOK_MAP) - 1
        assert "pre_llm_call" in capsys.readouterr().err

    def test_uses_default_sink_when_none(self, tmp_path, monkeypatch):
        """Smoke-test: default sink path doesn't crash (writes under tmp HOME)."""
        monkeypatch.setenv("HOME", str(tmp_path))
        ctx = MockCtx()
        adapter = register(ctx)
        assert isinstance(adapter, HermesParaAdapter)
        events_file = tmp_path / ".prismer" / "para" / "events.jsonl"
        assert events_file.exists()

    def test_context_provider_is_forwarded_to_adapter(self):
        ctx = MockCtx()
        probe = []

        def provider(**kwargs):
            probe.append(kwargs.get("session_id"))
            return "[injected]"

        emitted = []
        adapter = register(ctx, sink=emitted.append, context_provider=provider)

        pre_llm = ctx.hooks["pre_llm_call"]
        ret = pre_llm(
            session_id="s1",
            user_message="hi",
            conversation_history=[],
            is_first_turn=True,
            model="m",
            platform="cli",
        )
        assert ret == {"context": "[injected]"}
        assert probe == ["s1"]
