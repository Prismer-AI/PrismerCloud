"""
test_adapter.py — Tests for HermesParaAdapter.

All hooks are invoked with **kwargs matching what Hermes actually passes via
``invoke_hook(name, **kwargs)``. The kwargs shapes mirror the real call sites
in ``run_agent.py`` / ``model_tools.py`` / ``tools/delegate_tool.py``.
"""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from prismer_adapter_hermes.adapter import HermesParaAdapter


def make_adapter(context_provider=None):
    emitted = []
    adapter = HermesParaAdapter(
        dispatcher_emit=emitted.append, context_provider=context_provider
    )
    return adapter, emitted


# ── Plugin hook: pre_tool_call ────────────────────────────────────────────────

class TestPreToolCall:
    def test_emits_tool_pre_with_tool_call_id(self):
        adapter, emitted = make_adapter()
        adapter.on_pre_tool_call(
            tool_name="terminal",
            args={"command": "ls"},
            task_id="t1",
            session_id="s1",
            tool_call_id="call_123",
        )
        assert len(emitted) == 1
        evt = emitted[0]
        assert evt["type"] == "agent.tool.pre"
        assert evt["callId"] == "call_123"
        assert evt["tool"] == "terminal"
        assert evt["args"] == {"command": "ls"}

    def test_returns_none_not_blocking(self):
        """Adapter is observer-only — must never accidentally veto tool calls."""
        adapter, _ = make_adapter()
        ret = adapter.on_pre_tool_call(
            tool_name="edit", args={}, task_id="", session_id="", tool_call_id="c1"
        )
        assert ret is None

    def test_missing_kwargs_are_tolerated(self):
        adapter, emitted = make_adapter()
        adapter.on_pre_tool_call(tool_name="x", args={}, task_id="")
        assert emitted[0]["type"] == "agent.tool.pre"
        assert emitted[0]["callId"] == ""


# ── Plugin hook: post_tool_call ──────────────────────────────────────────────

class TestPostToolCall:
    def test_success_emits_tool_post(self):
        adapter, emitted = make_adapter()
        adapter.on_post_tool_call(
            tool_name="edit",
            args={"path": "/f.py"},
            result=json.dumps({"ok": True, "bytes": 42}),
            task_id="t1",
            session_id="s1",
            tool_call_id="c1",
        )
        assert emitted[0]["type"] == "agent.tool.post"
        assert emitted[0]["callId"] == "c1"
        assert emitted[0]["ok"] is True

    def test_error_result_emits_tool_failure(self):
        adapter, emitted = make_adapter()
        adapter.on_post_tool_call(
            tool_name="terminal",
            args={},
            result=json.dumps({"error": "permission denied"}),
            task_id="",
            session_id="",
            tool_call_id="c1",
        )
        assert emitted[0]["type"] == "agent.tool.failure"
        assert "permission denied" in emitted[0]["error"]

    def test_terminal_success_shape_is_not_misclassified_as_failure(self):
        """Real Hermes terminal tool returns {error: None, output: ...} on
        success — the 'error' key is always present. Earlier code keyed off
        membership instead of value and turned every success into a failure;
        this is a regression guard."""
        adapter, emitted = make_adapter()
        adapter.on_post_tool_call(
            tool_name="terminal",
            args={"command": "echo hi"},
            result=json.dumps({
                "output": "hi\n",
                "exit_code": 0,
                "error": None,
            }),
            task_id="",
            session_id="",
            tool_call_id="terminal:0",
        )
        assert emitted[0]["type"] == "agent.tool.post"
        assert emitted[0]["ok"] is True

    def test_empty_string_error_is_not_failure(self):
        """Some tools normalise error to empty string on success; treat as ok."""
        adapter, emitted = make_adapter()
        adapter.on_post_tool_call(
            tool_name="x", args={}, result=json.dumps({"output": "ok", "error": ""}),
            task_id="", session_id="", tool_call_id="c1",
        )
        assert emitted[0]["type"] == "agent.tool.post"

    def test_non_json_string_result_treated_as_success(self):
        adapter, emitted = make_adapter()
        adapter.on_post_tool_call(
            tool_name="x",
            args={},
            result="just a plain string",
            task_id="",
            session_id="",
            tool_call_id="c1",
        )
        assert emitted[0]["type"] == "agent.tool.post"

    def test_summary_is_truncated(self):
        adapter, emitted = make_adapter()
        long_str = "x" * 1000
        adapter.on_post_tool_call(
            tool_name="x",
            args={},
            result=long_str,
            task_id="",
            session_id="",
            tool_call_id="c1",
        )
        assert len(emitted[0]["summary"]) == 200


# ── Plugin hook: pre_llm_call ────────────────────────────────────────────────

class TestPreLlmCall:
    def test_emits_llm_pre(self):
        adapter, emitted = make_adapter()
        ret = adapter.on_pre_llm_call(
            session_id="s1",
            user_message="",  # not first turn → no prompt.submit
            conversation_history=[{"role": "user", "content": "hi"}] * 3,
            is_first_turn=False,
            model="gpt-5",
            platform="cli",
        )
        assert ret == {}
        types_ = [e["type"] for e in emitted]
        assert "agent.llm.pre" in types_
        evt = next(e for e in emitted if e["type"] == "agent.llm.pre")
        assert evt["model"] == "gpt-5"
        assert evt["conversationLength"] == 3

    def test_first_turn_also_emits_prompt_submit(self):
        adapter, emitted = make_adapter()
        adapter.on_pre_llm_call(
            session_id="s1",
            user_message="hello",
            conversation_history=[],
            is_first_turn=True,
            model="m",
            platform="cli",
        )
        types_ = [e["type"] for e in emitted]
        assert types_[:2] == ["agent.prompt.submit", "agent.llm.pre"]

    def test_context_provider_inject(self):
        def provider(**kwargs):
            return f"[memory for {kwargs.get('session_id')}]"

        adapter, emitted = make_adapter(context_provider=provider)
        ret = adapter.on_pre_llm_call(
            session_id="s1",
            user_message="hi",
            conversation_history=[],
            is_first_turn=True,
            model="m",
            platform="cli",
        )
        assert ret == {"context": "[memory for s1]"}

    def test_context_provider_returning_none_yields_empty(self):
        adapter, _ = make_adapter(context_provider=lambda **k: None)
        ret = adapter.on_pre_llm_call(
            session_id="s1",
            user_message="",
            conversation_history=[],
            is_first_turn=False,
            model="m",
            platform="cli",
        )
        assert ret == {}

    def test_context_provider_exception_does_not_propagate(self):
        def bad(**kwargs):
            raise RuntimeError("boom")

        adapter, _ = make_adapter(context_provider=bad)
        ret = adapter.on_pre_llm_call(
            session_id="s1",
            user_message="",
            conversation_history=[],
            is_first_turn=False,
            model="m",
            platform="cli",
        )
        assert ret == {}  # swallowed

    def test_platform_not_in_source_enum_falls_back_to_user(self):
        adapter, emitted = make_adapter()
        adapter.on_pre_llm_call(
            session_id="s1",
            user_message="hi",
            conversation_history=[],
            is_first_turn=True,
            model="m",
            platform="discord",  # not in source enum
        )
        submit = next(e for e in emitted if e["type"] == "agent.prompt.submit")
        assert submit["source"] == "user"


# ── Plugin hook: post_llm_call ───────────────────────────────────────────────

class TestPostLlmCall:
    def test_emits_llm_post_and_turn_end(self):
        adapter, emitted = make_adapter()
        adapter.on_post_llm_call(
            session_id="s1",
            user_message="hi",
            assistant_response="hello back",
            conversation_history=[],
            model="m",
            platform="cli",
        )
        types_ = [e["type"] for e in emitted]
        assert "agent.llm.post" in types_
        assert "agent.turn.end" in types_
        end_evt = next(e for e in emitted if e["type"] == "agent.turn.end")
        assert end_evt["lastAssistantMessage"] == "hello back"


# ── Plugin hook: on_session_start ────────────────────────────────────────────

class TestSessionStart:
    def test_emits_session_started(self):
        adapter, emitted = make_adapter()
        adapter.on_session_start(session_id="s1", model="m", platform="cli")
        assert emitted[0]["type"] == "agent.session.started"
        assert emitted[0]["sessionId"] == "s1"
        assert emitted[0]["scope"] == "cli"

    def test_dedupes_same_session(self):
        adapter, emitted = make_adapter()
        adapter.on_session_start(session_id="s1", model="m", platform="cli")
        adapter.on_session_start(session_id="s1", model="m", platform="cli")
        assert len(emitted) == 1

    def test_distinct_sessions_both_emit(self):
        adapter, emitted = make_adapter()
        adapter.on_session_start(session_id="s1", model="m", platform="cli")
        adapter.on_session_start(session_id="s2", model="m", platform="cli")
        assert len(emitted) == 2


# ── Plugin hook: on_session_end ──────────────────────────────────────────────

class TestSessionEnd:
    """on_session_end is NOT auto-wired (fires per-turn in Hermes; wrong
    semantics for PARA session lifecycle). Tests keep the method contract
    for future gateway-side usage / manual invocation."""

    def test_completed_maps_to_reason_completed(self):
        adapter, emitted = make_adapter()
        adapter.on_session_end(
            session_id="s1", completed=True, interrupted=False, model="m", platform="cli"
        )
        assert emitted[0]["reason"] == "completed"

    def test_interrupted_maps_to_reason_interrupted(self):
        adapter, emitted = make_adapter()
        adapter.on_session_end(
            session_id="s1", completed=False, interrupted=True, model="m", platform="cli"
        )
        assert emitted[0]["reason"] == "interrupted"

    def test_does_not_dedupe_manual_calls(self):
        """No dedup: callers who manually invoke this method own idempotency."""
        adapter, emitted = make_adapter()
        adapter.on_session_end(
            session_id="s1", completed=True, interrupted=False, model="m", platform="cli"
        )
        adapter.on_session_end(
            session_id="s1", completed=True, interrupted=False, model="m", platform="cli"
        )
        assert len(emitted) == 2


# ── Plugin hook: on_session_reset ────────────────────────────────────────────

class TestSessionReset:
    def test_emits_session_reset_with_new_session_id(self):
        adapter, emitted = make_adapter()
        adapter.on_session_reset(session_id="s_new", platform="cli")
        assert emitted[0]["type"] == "agent.session.reset"
        assert emitted[0]["sessionId"] == "s_new"


# ── Plugin hook: on_session_finalize ─────────────────────────────────────────

class TestSessionFinalize:
    def test_emits_session_ended_with_finalize_reason(self):
        adapter, emitted = make_adapter()
        adapter.on_session_finalize(session_id="s1", platform="cli")
        assert emitted[0]["type"] == "agent.session.ended"
        assert emitted[0]["reason"] == "finalize"

    def test_missing_session_id_is_noop(self):
        adapter, emitted = make_adapter()
        adapter.on_session_finalize(session_id=None, platform="cli")
        assert emitted == []


# ── Plugin hook: subagent_stop ───────────────────────────────────────────────

class TestSubagentStop:
    def test_completed_status(self):
        adapter, emitted = make_adapter()
        adapter.on_subagent_stop(
            parent_session_id="p1",
            child_role="researcher",
            child_summary="found 3 links",
            child_status="completed",
            duration_ms=1250,
        )
        evt = emitted[0]
        assert evt["type"] == "agent.subagent.ended"
        assert evt["parentSessionId"] == "p1"
        assert evt["subagentType"] == "researcher"
        assert evt["summary"] == "found 3 links"
        assert evt["status"] == "completed"
        assert evt["durationMs"] == 1250.0

    def test_interrupted_maps_to_cancelled(self):
        """Hermes uses 'interrupted' but the PARA Status enum uses 'cancelled'."""
        adapter, emitted = make_adapter()
        adapter.on_subagent_stop(
            parent_session_id="p1",
            child_role=None,
            child_summary=None,
            child_status="interrupted",
            duration_ms=500,
        )
        assert emitted[0]["status"] == "cancelled"

    def test_parent_session_id_none_omits_field(self):
        """Hermes delegate_tool passes parent_session_id=getattr(..., None);
        emit parentSessionId absent rather than empty-string sentinel."""
        adapter, emitted = make_adapter()
        adapter.on_subagent_stop(
            parent_session_id=None,
            child_role="r",
            child_summary=None,
            child_status="completed",
            duration_ms=0,
        )
        assert "parentSessionId" not in emitted[0]

    def test_parent_session_id_empty_string_omits_field(self):
        adapter, emitted = make_adapter()
        adapter.on_subagent_stop(
            parent_session_id="",
            child_role="r",
            child_summary=None,
            child_status="completed",
            duration_ms=0,
        )
        assert "parentSessionId" not in emitted[0]

    def test_fires_multiple_times_per_delegation(self):
        """delegate_task fires subagent_stop once per child — must not dedupe."""
        adapter, emitted = make_adapter()
        for i in range(3):
            adapter.on_subagent_stop(
                parent_session_id="p1",
                child_role=f"child_{i}",
                child_summary="",
                child_status="completed",
                duration_ms=100,
            )
        assert len(emitted) == 3


# ── Public helper: emit_agent_register (fired at plugin load) ────────────────

class TestEmitAgentRegister:
    def test_emits_register_event(self):
        adapter, emitted = make_adapter()
        adapter.emit_agent_register(
            agent_id="hermes-abc",
            version="0.10.0",
            workspace="/tmp/ws",
        )
        evt = emitted[0]
        assert evt["type"] == "agent.register"
        assert evt["agent"]["id"] == "hermes-abc"
        assert evt["agent"]["adapter"] == "hermes"
        assert evt["agent"]["version"] == "0.10.0"
        assert evt["agent"]["workspace"] == "/tmp/ws"
        assert 4 in evt["agent"]["tiersSupported"]
        assert "cache-safe-inject" in evt["agent"]["capabilityTags"]


# ── Public helper: emit_state ────────────────────────────────────────────────

class TestEmitState:
    def test_valid_statuses_pass_through(self):
        adapter, emitted = make_adapter()
        for s in ["idle", "thinking", "tool", "awaiting_approval", "error"]:
            adapter.emit_state(s)
        assert [e["status"] for e in emitted] == [
            "idle", "thinking", "tool", "awaiting_approval", "error",
        ]

    def test_invalid_status_is_dropped(self):
        adapter, emitted = make_adapter()
        adapter.emit_state("sleeping")  # not in enum
        assert emitted == []


# ── Thread safety: dedup set under concurrent session.started ────────────────

class TestConcurrency:
    def test_session_start_dedup_under_threads(self):
        """Simulate delegate_task firing session.started across 3 worker threads."""
        import threading

        adapter, emitted = make_adapter()
        barrier = threading.Barrier(8)

        def worker(sid):
            barrier.wait()
            for _ in range(100):
                adapter.on_session_start(
                    session_id=sid, model="m", platform="cli"
                )

        threads = [
            threading.Thread(target=worker, args=(f"s{i}",))
            for i in range(8)
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        # Exactly one emit per distinct sessionId despite 100 attempts each.
        started = [e for e in emitted if e["type"] == "agent.session.started"]
        assert len(started) == 8
        assert sorted(e["sessionId"] for e in started) == [f"s{i}" for i in range(8)]
