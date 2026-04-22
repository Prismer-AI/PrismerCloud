"""
adapter.py — HermesParaAdapter class.

Translates Hermes Plugin Hooks to PARA events.

Hermes dispatches via `invoke_hook(name, **kwargs)` → `cb(**kwargs)`, so every
callback method MUST accept **kwargs (not a single `ctx` dict). Kwargs names
are authoritative — see hermes_cli/plugins.py:VALID_HOOKS and the invoke_hook
call sites in run_agent.py / model_tools.py / tools/delegate_tool.py.

Gateway-only events (session:*, agent:*, command:*) are NOT Plugin hooks; they
live in a separate dispatcher used by ~/.hermes/hooks/*/HOOK.yaml handlers.
The methods on_gateway_startup / on_agent_start / on_agent_step / on_agent_end
/ on_command remain on the class for a future Gateway-side handler, but they
are NOT auto-wired through register.py's plugin-hook map.
"""

from __future__ import annotations

import json
import sys
import threading
import time
from collections import deque
from typing import Any, Callable, Deque, Optional

from .event_builder import (
    make_agent_register,
    make_agent_state,
    make_command,
    make_llm_post,
    make_llm_pre,
    make_prompt_submit,
    make_session_ended,
    make_session_reset,
    make_session_started,
    make_subagent_ended,
    make_tool_failure,
    make_tool_post,
    make_tool_pre,
    make_turn_end,
    make_turn_step,
)
from .wire import PrismerWire


def _validate(evt: dict) -> Optional[dict]:
    """Structural validation against the generated wire parser.

    Returns the event on success, None (with stderr warning) on failure —
    matching the TS dispatcher semantics (invalid events dropped silently).
    """
    try:
        PrismerWire.from_dict(evt)
        return evt
    except Exception as exc:
        print(
            f"[hermes-adapter] dropping invalid {evt.get('type')} event: {exc}",
            file=sys.stderr,
        )
        return None


def _safe_emit(emit_fn: Callable[[dict], None], evt: dict) -> None:
    validated = _validate(evt)
    if validated is not None:
        emit_fn(validated)


class HermesParaAdapter:
    """Translate Hermes Plugin Hooks to PARA event dicts and emit them.

    Usage:
        adapter = HermesParaAdapter(dispatcher_emit=my_sink)
        ctx.register_hook("pre_tool_call", adapter.on_pre_tool_call)
        ...

    Each `on_*` method below matches a Hermes Plugin hook's kwargs contract.
    """

    _DEDUP_CAPACITY = 10_000

    def __init__(
        self,
        dispatcher_emit: Callable[[dict], None],
        context_provider: Optional[Callable[..., Optional[str]]] = None,
    ) -> None:
        self._emit = dispatcher_emit
        self._lock = threading.Lock()
        self._seen: set = set()
        self._order: Deque[str] = deque()
        self._agent_id: Optional[str] = None
        # Optional callback invoked on pre_llm_call. If it returns a non-empty
        # string, that string becomes the value of the {"context": ...} dict
        # returned to Hermes — triggering cache-safe inject (PARA L4).
        self._context_provider = context_provider

    # ── helpers ────────────────────────────────────────────────────────────────

    def set_context_provider(
        self, fn: Optional[Callable[..., Optional[str]]]
    ) -> None:
        """Register (or clear) the cache-safe inject provider for pre_llm_call.

        fn receives the same kwargs Hermes passes (session_id, user_message,
        conversation_history, is_first_turn, model, platform, ...) and must
        return a string to inject, or None/empty to inject nothing.
        """
        self._context_provider = fn

    def _remember(self, key: str) -> bool:
        """Bounded FIFO dedup (thread-safe). Returns True if new."""
        with self._lock:
            if key in self._seen:
                return False
            self._seen.add(key)
            self._order.append(key)
            if len(self._order) > self._DEDUP_CAPACITY:
                oldest = self._order.popleft()
                self._seen.discard(oldest)
            return True

    # ── Plugin hooks (auto-wired in register.py) ───────────────────────────────

    def on_pre_tool_call(self, **kwargs: Any) -> Optional[dict]:
        """Hermes Plugin hook: pre_tool_call.

        Kwargs (from hermes_cli/plugins.py:856 and model_tools.py:503):
            tool_name: str
            args: dict
            task_id: str
            session_id: str
            tool_call_id: str

        Returns None (observer-only). A future enforcement adapter could return
        {"action": "block", "message": "..."} to veto the call.
        """
        tool_name = kwargs.get("tool_name") or ""
        args = kwargs.get("args") or {}
        tool_call_id = kwargs.get("tool_call_id") or ""
        evt = make_tool_pre(
            call_id=tool_call_id,
            tool=tool_name,
            args=args,
            risk_tag=None,
        )
        _safe_emit(self._emit, evt)
        return None

    def on_post_tool_call(self, **kwargs: Any) -> None:
        """Hermes Plugin hook: post_tool_call.

        Kwargs (from model_tools.py:541):
            tool_name: str
            args: dict
            result: str (JSON-serialised tool result; errors look like
                        {"error": "..."})
            task_id: str
            session_id: str
            tool_call_id: str
        """
        tool_call_id = kwargs.get("tool_call_id") or ""
        result_str = kwargs.get("result") or ""

        parsed: Any = None
        if isinstance(result_str, str) and result_str:
            try:
                parsed = json.loads(result_str)
            except (ValueError, TypeError):
                parsed = None
        elif isinstance(result_str, dict):
            parsed = result_str

        # Hermes tools include an "error" field unconditionally — set to
        # None / "" on success, populated on failure (see e.g.
        # tools/terminal_tool.py result_data shape). Check the VALUE,
        # not just the key, otherwise every successful tool call is
        # misclassified as a failure.
        err_value = parsed.get("error") if isinstance(parsed, dict) else None
        is_error = bool(err_value)
        if is_error:
            error_msg = str(err_value)
            evt = make_tool_failure(call_id=tool_call_id, error=error_msg)
        else:
            summary_src = (
                result_str if isinstance(result_str, str) else json.dumps(parsed or {})
            )
            evt = make_tool_post(
                call_id=tool_call_id,
                ok=True,
                duration_ms=0.0,  # Hermes plugin hook doesn't provide duration
                summary=summary_src[:200],
            )
        _safe_emit(self._emit, evt)

    def on_pre_llm_call(self, **kwargs: Any) -> dict:
        """Hermes Plugin hook: pre_llm_call.

        Kwargs (from run_agent.py:8832):
            session_id: str
            user_message: str
            conversation_history: list
            is_first_turn: bool
            model: str
            platform: str
            sender_id: str (optional)

        Emits agent.llm.pre. If a context_provider is configured and returns
        a non-empty string, the adapter returns {"context": <str>}, which
        Hermes appends to the current turn's user message (cache-safe — the
        system prompt is untouched, preserving prompt-cache hits). This is
        the PARA L4 wire.
        """
        session_id = kwargs.get("session_id") or ""
        model = kwargs.get("model") or ""
        conversation_history = kwargs.get("conversation_history") or []
        is_first_turn = bool(kwargs.get("is_first_turn") or False)
        conversation_length = len(conversation_history)

        # Emit the turn-boundary observation event first — prompt.submit only
        # makes sense at the turn origin so we can capture the user message
        # alongside the LLM call that it kicks off.
        user_message = kwargs.get("user_message") or ""
        if is_first_turn and user_message:
            source = kwargs.get("platform") or "user"
            if source not in ("user", "remote", "subagent"):
                source = "user"
            _safe_emit(
                self._emit,
                make_prompt_submit(
                    session_id=session_id, prompt=user_message, source=source
                ),
            )

        _safe_emit(
            self._emit,
            make_llm_pre(
                session_id=session_id,
                model=model,
                conversation_length=conversation_length,
                is_first_turn=is_first_turn,
            ),
        )

        if self._context_provider is not None:
            try:
                injected = self._context_provider(**kwargs)
            except Exception as exc:
                print(
                    f"[hermes-adapter] context provider raised: {exc}",
                    file=sys.stderr,
                )
                injected = None
            if isinstance(injected, str) and injected:
                return {"context": injected}
        return {}

    def on_post_llm_call(self, **kwargs: Any) -> None:
        """Hermes Plugin hook: post_llm_call.

        Kwargs (from run_agent.py:11700):
            session_id: str
            user_message: str
            assistant_response: str
            conversation_history: list
            model: str
            platform: str
        """
        session_id = kwargs.get("session_id") or ""
        assistant_response = kwargs.get("assistant_response") or ""

        # Hermes doesn't surface tokens_used / stop_reason to this hook. Emit
        # zero/empty so the event is still valid against the wire schema; a
        # future enrichment could carry provider telemetry via the llm
        # provider hooks (pre_api_request / post_api_request).
        _safe_emit(
            self._emit,
            make_llm_post(session_id=session_id, tokens_used=0, stop_reason=""),
        )
        _safe_emit(
            self._emit,
            make_turn_end(
                session_id=session_id,
                last_assistant_message=assistant_response or None,
            ),
        )

    def on_session_start(self, **kwargs: Any) -> None:
        """Hermes Plugin hook: on_session_start.

        Kwargs (from run_agent.py:8731):
            session_id: str
            model: str
            platform: str

        Fires exactly once per session lifecycle (see run_agent.py:8725
        "else: # First turn of a new session"); the dedup guard exists to
        catch pathological retries, not normal fire patterns.
        """
        session_id = kwargs.get("session_id") or ""
        scope = kwargs.get("platform") or "workspace"
        evt = make_session_started(session_id=session_id, scope=scope)
        # Validate BEFORE claiming the dedup slot so a bad event doesn't
        # block a subsequent well-formed retry from emitting.
        if _validate(evt) is None:
            return
        if not self._remember(f"session.started:{session_id}"):
            return
        self._emit(evt)

    def on_session_end(self, **kwargs: Any) -> None:
        """Hermes Plugin hook: on_session_end. NOT auto-wired by register.py.

        Hermes fires this at the end of every run_conversation call — i.e.
        once per turn, not once per session (see run_agent.py:11801 comment).
        Wiring it would mean turn 1 emits agent.session.ended, then turns
        2..N would either be deduped away or re-emit session.ended while
        the session is still alive. Neither is correct PARA semantics, so
        register.py does not subscribe this hook. on_session_finalize is
        the authoritative session-end signal.

        This method remains on the class for a future gateway-side
        integration or manual invocation by advanced plugin code.

        Kwargs (from run_agent.py:11805):
            session_id: str
            completed: bool
            interrupted: bool
            model: str
            platform: str
        """
        session_id = kwargs.get("session_id") or ""
        if kwargs.get("interrupted"):
            reason = "interrupted"
        elif kwargs.get("completed"):
            reason = "completed"
        else:
            reason = "stop"
        evt = make_session_ended(session_id=session_id, reason=reason)
        if _validate(evt) is None:
            return
        self._emit(evt)

    def on_session_reset(self, **kwargs: Any) -> None:
        """Hermes Plugin hook: on_session_reset.

        Kwargs (from gateway/run.py:4951):
            session_id: str (the NEW session id)
            platform: str
        """
        session_id = kwargs.get("session_id") or ""
        reason = kwargs.get("reason") or "reset"
        _safe_emit(
            self._emit,
            make_session_reset(session_id=session_id, reason=reason),
        )

    def on_session_finalize(self, **kwargs: Any) -> None:
        """Hermes Plugin hook: on_session_finalize.

        Kwargs (from gateway/run.py:4915 and cli.py:709):
            session_id: str | None
            platform: str

        Fires when an active session is torn down before its identity is
        discarded. Maps to agent.session.ended with reason="finalize".
        """
        session_id = kwargs.get("session_id") or ""
        if not session_id:
            return
        evt = make_session_ended(session_id=session_id, reason="finalize")
        if _validate(evt) is None:
            return
        if not self._remember(f"session.finalize:{session_id}"):
            return
        self._emit(evt)

    def on_subagent_stop(self, **kwargs: Any) -> None:
        """Hermes Plugin hook: subagent_stop.

        Kwargs (from tools/delegate_tool.py:944):
            parent_session_id: str
            child_role: str | None
            child_summary: str | None
            child_status: str ("completed" | "failed" | "interrupted" | "error")
            duration_ms: int
        """
        # Pass None through; make_subagent_ended omits the field when falsy
        # so PARA consumers see absence rather than an empty string sentinel.
        parent_session_id = kwargs.get("parent_session_id")
        child_role = kwargs.get("child_role")
        child_summary = kwargs.get("child_summary")
        # Hermes emits "interrupted" but the PARA Status enum uses "cancelled"
        # for user-initiated termination. Normalise so wire validation passes.
        raw_status = kwargs.get("child_status") or "completed"
        child_status = "cancelled" if raw_status == "interrupted" else raw_status
        duration_ms = float(kwargs.get("duration_ms") or 0)
        _safe_emit(
            self._emit,
            make_subagent_ended(
                parent_session_id=parent_session_id,
                subagent_type=child_role,
                summary=child_summary,
                status=child_status,
                duration_ms=duration_ms,
            ),
        )

    # ── Gateway-side hooks (NOT auto-wired — reserved for gateway handler.py) ─

    def on_gateway_startup(self, **kwargs: Any) -> None:
        """Gateway Event hook: gateway:startup.

        This is a GATEWAY event, not a Plugin hook. It fires only when invoked
        from a ~/.hermes/hooks/*/HOOK.yaml handler — see hermes_cli/hooks.py.
        The plugin-side register.py emits agent.register directly at load time
        instead of relying on this hook.
        """
        workspace = kwargs.get("workspace") or kwargs.get("cwd") or "."
        version = str(kwargs.get("version") or kwargs.get("hermes_version") or "unknown")
        agent_id = kwargs.get("agent_id") or f"hermes-{int(time.time())}"
        self._agent_id = agent_id
        _safe_emit(
            self._emit,
            make_agent_register(
                agent_id=agent_id,
                adapter="hermes",
                version=version,
                tiers_supported=[1, 2, 3, 4],
                capability_tags=["code", "llm", "cache-safe-inject"],
                workspace=workspace,
            ),
        )

    def on_agent_start(self, **kwargs: Any) -> None:
        """Gateway Event hook: agent:start. Not auto-wired."""
        session_id = kwargs.get("session_id") or ""
        prompt = kwargs.get("prompt") or kwargs.get("message") or ""
        platform = kwargs.get("platform") or "user"
        source = platform if platform in ("user", "remote", "subagent") else "user"
        _safe_emit(
            self._emit,
            make_prompt_submit(session_id=session_id, prompt=prompt, source=source),
        )

    def on_agent_step(self, **kwargs: Any) -> None:
        """Gateway Event hook: agent:step. Not auto-wired."""
        session_id = kwargs.get("session_id") or ""
        iteration = int(kwargs.get("iteration") or 0)
        tool_names = kwargs.get("tool_names") or []
        _safe_emit(
            self._emit,
            make_turn_step(
                session_id=session_id,
                iteration=iteration,
                tool_names=list(tool_names),
            ),
        )

    def on_agent_end(self, **kwargs: Any) -> None:
        """Gateway Event hook: agent:end. Not auto-wired."""
        session_id = kwargs.get("session_id") or ""
        last_msg = kwargs.get("response") or kwargs.get("last_message") or None
        _safe_emit(
            self._emit,
            make_turn_end(session_id=session_id, last_assistant_message=last_msg),
        )

    def on_command(self, **kwargs: Any) -> None:
        """Gateway Event hook: command:*. Not auto-wired."""
        command = kwargs.get("command") or kwargs.get("event_name") or ""
        if ":" in command:
            command = command.split(":", 1)[1]
        kind_map = {"new": "new", "reset": "reset", "stop": "stop"}
        command_kind = kind_map.get(command, "other")
        _safe_emit(
            self._emit,
            make_command(
                command=command,
                command_kind=command_kind,
                args=kwargs.get("args"),
                source=kwargs.get("source"),
            ),
        )

    # ── Public helpers ─────────────────────────────────────────────────────────

    def emit_agent_register(
        self,
        agent_id: str,
        version: str,
        workspace: str,
        workspace_group: Optional[str] = None,
    ) -> None:
        """Emit agent.register at plugin load time.

        Called from register.py once Hermes hands us a PluginContext. Hermes
        has no gateway:startup equivalent in the plugin hook set, so agent
        discovery fires here.
        """
        self._agent_id = agent_id
        _safe_emit(
            self._emit,
            make_agent_register(
                agent_id=agent_id,
                adapter="hermes",
                version=version,
                tiers_supported=[1, 2, 3, 4],
                capability_tags=["code", "llm", "cache-safe-inject"],
                workspace=workspace,
                workspace_group=workspace_group,
            ),
        )

    def emit_state(self, status: str) -> None:
        """Emit an agent.state event manually. Valid statuses:
        idle / thinking / tool / awaiting_approval / error."""
        _safe_emit(self._emit, make_agent_state(status))
