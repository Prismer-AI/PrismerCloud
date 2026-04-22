"""
test_event_builder.py — Tests for pure event builder helpers.
Verifies that each make_Xxx() produces the correct dict shape per PARA spec §4.3.
"""

import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from prismer_adapter_hermes.event_builder import (
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


class TestMakeAgentRegister:
    def test_required_fields(self):
        evt = make_agent_register(
            agent_id="test-id",
            adapter="hermes",
            version="0.1.0",
            tiers_supported=[1, 2, 3, 4],
            capability_tags=["code"],
            workspace="/tmp/ws",
        )
        assert evt["type"] == "agent.register"
        assert evt["agent"]["id"] == "test-id"
        assert evt["agent"]["adapter"] == "hermes"
        assert evt["agent"]["tiersSupported"] == [1, 2, 3, 4]
        assert evt["agent"]["capabilityTags"] == ["code"]
        assert evt["agent"]["workspace"] == "/tmp/ws"

    def test_optional_workspace_group_excluded_when_none(self):
        evt = make_agent_register("id", "hermes", "1.0", [1], [], "/ws")
        assert "workspaceGroup" not in evt["agent"]

    def test_optional_workspace_group_included_when_provided(self):
        evt = make_agent_register("id", "hermes", "1.0", [1], [], "/ws", workspace_group="g1")
        assert evt["agent"]["workspaceGroup"] == "g1"


class TestMakeSessionStarted:
    def test_required_fields(self):
        evt = make_session_started("sess-1", "workspace")
        assert evt["type"] == "agent.session.started"
        assert evt["sessionId"] == "sess-1"
        assert evt["scope"] == "workspace"
        assert "parentSessionId" not in evt

    def test_optional_parent_included(self):
        evt = make_session_started("sess-1", "workspace", parent_session_id="parent-sess")
        assert evt["parentSessionId"] == "parent-sess"


class TestMakeSessionEnded:
    def test_defaults(self):
        evt = make_session_ended("sess-1")
        assert evt["type"] == "agent.session.ended"
        assert evt["sessionId"] == "sess-1"
        assert evt["reason"] == "stop"

    def test_custom_reason(self):
        evt = make_session_ended("sess-1", reason="crash")
        assert evt["reason"] == "crash"


class TestMakeSessionReset:
    def test_defaults(self):
        evt = make_session_reset("sess-1")
        assert evt["type"] == "agent.session.reset"
        assert evt["reason"] == "reset"


class TestMakePromptSubmit:
    def test_fields(self):
        evt = make_prompt_submit("sess-1", "hello world", "user")
        assert evt["type"] == "agent.prompt.submit"
        assert evt["prompt"] == "hello world"
        assert evt["source"] == "user"


class TestMakeLlmPre:
    def test_fields(self):
        evt = make_llm_pre("sess-1", "gpt-4", 5, True)
        assert evt["type"] == "agent.llm.pre"
        assert evt["model"] == "gpt-4"
        assert evt["conversationLength"] == 5
        assert evt["isFirstTurn"] is True


class TestMakeLlmPost:
    def test_fields(self):
        evt = make_llm_post("sess-1", 1234, "stop")
        assert evt["type"] == "agent.llm.post"
        assert evt["tokensUsed"] == 1234
        assert evt["stopReason"] == "stop"


class TestMakeTurnStep:
    def test_defaults(self):
        evt = make_turn_step("sess-1", 0)
        assert evt["type"] == "agent.turn.step"
        assert evt["iteration"] == 0
        assert evt["toolNames"] == []

    def test_with_tools(self):
        evt = make_turn_step("sess-1", 2, ["bash", "edit"])
        assert evt["toolNames"] == ["bash", "edit"]


class TestMakeTurnEnd:
    def test_without_last_message(self):
        evt = make_turn_end("sess-1")
        assert evt["type"] == "agent.turn.end"
        assert "lastAssistantMessage" not in evt

    def test_with_last_message(self):
        evt = make_turn_end("sess-1", last_assistant_message="Done!")
        assert evt["lastAssistantMessage"] == "Done!"


class TestMakeToolPre:
    def test_required(self):
        evt = make_tool_pre("call-1", "bash", {"cmd": "ls"})
        assert evt["type"] == "agent.tool.pre"
        assert evt["callId"] == "call-1"
        assert evt["tool"] == "bash"
        assert evt["args"] == {"cmd": "ls"}
        assert "riskTag" not in evt

    def test_risk_tag(self):
        evt = make_tool_pre("call-1", "bash", {}, risk_tag="high")
        assert evt["riskTag"] == "high"


class TestMakeToolPost:
    def test_success(self):
        evt = make_tool_post("call-1", ok=True, duration_ms=42.5, summary="ok output")
        assert evt["type"] == "agent.tool.post"
        assert evt["ok"] is True
        assert evt["durationMs"] == 42.5
        assert evt["summary"] == "ok output"


class TestMakeToolFailure:
    def test_required(self):
        evt = make_tool_failure("call-1", "timeout")
        assert evt["type"] == "agent.tool.failure"
        assert evt["error"] == "timeout"
        assert "signalPattern" not in evt

    def test_optional_fields(self):
        evt = make_tool_failure("c", "err", signal_pattern="SIGKILL", is_interrupt=True)
        assert evt["signalPattern"] == "SIGKILL"
        assert evt["isInterrupt"] is True


class TestMakeCommand:
    def test_defaults(self):
        evt = make_command("new")
        assert evt["type"] == "agent.command"
        assert evt["commandKind"] == "other"  # "new" maps to "other" only via explicit kind arg
        assert evt["command"] == "new"

    def test_explicit_kind(self):
        evt = make_command("new", command_kind="new")
        assert evt["commandKind"] == "new"


class TestMakeSubagentEnded:
    def test_required_and_optional_fields(self):
        evt = make_subagent_ended(
            parent_session_id="p1",
            subagent_type="researcher",
            summary="found 3 links",
            status="completed",
            duration_ms=1250.0,
        )
        assert evt["type"] == "agent.subagent.ended"
        assert evt["parentSessionId"] == "p1"
        assert evt["subagentType"] == "researcher"
        assert evt["summary"] == "found 3 links"
        assert evt["status"] == "completed"
        assert evt["durationMs"] == 1250.0

    def test_none_optionals_omitted(self):
        evt = make_subagent_ended(
            parent_session_id="p1",
            subagent_type=None,
            summary=None,
            status="failed",
            duration_ms=0.0,
        )
        assert "subagentType" not in evt
        assert "summary" not in evt

    def test_parent_session_id_falsy_omits_field(self):
        for pid in (None, ""):
            evt = make_subagent_ended(
                parent_session_id=pid,
                subagent_type="r",
                summary=None,
                status="completed",
                duration_ms=0.0,
            )
            assert "parentSessionId" not in evt


class TestMakeAgentState:
    def test_field(self):
        evt = make_agent_state("thinking")
        assert evt["type"] == "agent.state"
        assert evt["status"] == "thinking"
