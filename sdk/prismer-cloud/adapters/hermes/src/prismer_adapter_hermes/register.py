"""
register.py — Hermes plugin entrypoint.

Hermes discovers plugins under ``~/.hermes/plugins/<name>/`` and pip entry
points in the ``hermes_agent.plugins`` group. When a plugin loads, Hermes
calls ``register(ctx)`` where ``ctx`` is a ``PluginContext`` instance
exposing ``ctx.register_hook(hook_name, callback)``.

This module wires HermesParaAdapter methods to the 9 Plugin hooks Hermes
dispatches at runtime (see ``hermes_cli/plugins.py:VALID_HOOKS``). Note:
``gateway:startup`` / ``session:start`` / ``session:end`` / ``session:reset``
/ ``agent:start`` / ``agent:step`` / ``agent:end`` / ``command:*`` are
Gateway-level events (different dispatcher) and are NOT wired here — they
must be emitted from a gateway-side ``~/.hermes/hooks/<name>/handler.py``
if they are needed.

agent.register is emitted directly at plugin load time because Hermes has
no plugin-hook equivalent of ``gateway:startup``.

Usage in your plugin manifest / entry point:
    plugin_module: prismer_adapter_hermes.register
"""

from __future__ import annotations

import os
import sys
from typing import Any, Callable, Optional

from .adapter import HermesParaAdapter
from .descriptor import build_agent_descriptor
from .sink import default_jsonl_sink

# (hermes_plugin_hook_name, HermesParaAdapter_method_name)
# Each name MUST be in hermes_cli.plugins.VALID_HOOKS, otherwise
# Hermes emits a warning and the hook never fires. Kept small and
# intentional — additional Hermes hooks (transform_terminal_output,
# transform_tool_result, pre_api_request, post_api_request) stay unwired
# until we have a concrete PARA need for them.
#
# Note on session lifecycle: Hermes fires `on_session_end` at the end of
# EVERY run_conversation() call — once per turn, not once per session
# (see run_agent.py:11800 comment). Wiring it would make every second
# and subsequent turn's session.ended event get deduped away, producing
# a session.ended at turn 1 followed by silence even though the session
# is still alive. The true session boundary is on_session_finalize
# (gateway/run.py:4915, cli.py:709) — fired when the identity is about
# to be discarded. That is the sole source of agent.session.ended here.
_HOOK_MAP = [
    ("pre_tool_call",      "on_pre_tool_call"),
    ("post_tool_call",     "on_post_tool_call"),
    ("pre_llm_call",       "on_pre_llm_call"),
    ("post_llm_call",      "on_post_llm_call"),
    ("on_session_start",   "on_session_start"),
    ("on_session_reset",   "on_session_reset"),
    ("on_session_finalize","on_session_finalize"),
    ("subagent_stop",      "on_subagent_stop"),
]


def register(
    ctx: Any,
    sink: Optional[Callable[[dict], None]] = None,
    context_provider: Optional[Callable[..., Optional[str]]] = None,
) -> HermesParaAdapter:
    """Hermes plugin entrypoint.

    Wires HermesParaAdapter to the 9 Plugin hooks in _HOOK_MAP and emits a
    single agent.register event so the Prismer runtime can discover this agent.

    Args:
        ctx:              Hermes PluginContext. Must expose register_hook().
        sink:             Optional callable(dict)→None. Defaults to the
                          ~/.prismer/para/events.jsonl sink.
        context_provider: Optional callable invoked on pre_llm_call. If it
                          returns a non-empty string, the adapter returns
                          {"context": <str>} to Hermes, triggering a
                          cache-safe inject (PARA L4).

    Returns:
        The HermesParaAdapter instance — expose it for tests / advanced config.
    """
    actual_sink = sink or default_jsonl_sink
    adapter = HermesParaAdapter(
        dispatcher_emit=actual_sink, context_provider=context_provider
    )

    # Fire agent.register once at load. build_agent_descriptor caches the
    # stable id on disk so restarts produce consistent IDs.
    descriptor = build_agent_descriptor()
    adapter.emit_agent_register(
        agent_id=descriptor["id"],
        version=descriptor.get("version") or "unknown",
        workspace=descriptor.get("workspace") or os.getcwd(),
        workspace_group=descriptor.get("workspaceGroup"),
    )

    if not (hasattr(ctx, "register_hook") and callable(ctx.register_hook)):
        print(
            "[hermes-adapter] ctx has no register_hook() — adapter is a no-op "
            "(are you running against a pre-plugin-api Hermes?)",
            file=sys.stderr,
        )
        return adapter

    wired = 0
    for hook_name, method_name in _HOOK_MAP:
        handler = getattr(adapter, method_name)
        try:
            ctx.register_hook(hook_name, handler)
            wired += 1
        except Exception as exc:
            print(
                f"[hermes-adapter] failed to register hook '{hook_name}': {exc}",
                file=sys.stderr,
            )

    if os.environ.get("PRISMER_DEBUG") == "1":
        print(
            f"[hermes-adapter] registered {wired}/{len(_HOOK_MAP)} hooks",
            file=sys.stderr,
        )
    return adapter
