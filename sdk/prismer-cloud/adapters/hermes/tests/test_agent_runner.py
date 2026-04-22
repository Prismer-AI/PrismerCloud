"""
test_agent_runner.py — Unit tests for the AIAgent→dispatch-envelope bridge.

Heavily mocked: we never hit the real Hermes runtime. The real-LLM
integration test lives in ``test_real_dispatch_e2e.py``.
"""

from __future__ import annotations

import asyncio
import os
import sys
from unittest.mock import patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from prismer_adapter_hermes.dispatch import agent_runner  # noqa: E402


class _FakeAgent:
    """Stand-in for ``run_agent.AIAgent``. Records the constructor and
    ``run_conversation`` kwargs so tests can assert them."""

    last_init_kwargs: dict = {}
    last_run_kwargs: dict = {}
    # Result returned by ``run_conversation``; overridden per-test.
    result_override = None

    session_prompt_tokens = 10
    session_completion_tokens = 5
    session_total_tokens = 15

    def __init__(self, **kwargs):
        _FakeAgent.last_init_kwargs = kwargs

    def run_conversation(self, **kwargs):
        _FakeAgent.last_run_kwargs = kwargs
        if _FakeAgent.result_override is not None:
            return _FakeAgent.result_override
        return {
            "final_response": "ok-reply",
            "messages": [],
            "api_calls": 2,
            "completed": True,
            "failed": False,
            "error": None,
        }


@pytest.fixture
def fake_aiagent(monkeypatch):
    """Install FakeAgent so _build_agent picks it up."""
    _FakeAgent.last_init_kwargs = {}
    _FakeAgent.last_run_kwargs = {}
    _FakeAgent.result_override = None
    fake_module = type(sys)("run_agent")
    fake_module.AIAgent = _FakeAgent
    monkeypatch.setitem(sys.modules, "run_agent", fake_module)
    return _FakeAgent


class TestSessionIdDerivation:
    def test_session_id_is_dispatch_prefixed(self):
        assert agent_runner._session_id_for("abc") == "dispatch-abc"

    def test_session_id_is_deterministic(self):
        a = agent_runner._session_id_for("task-42")
        b = agent_runner._session_id_for("task-42")
        assert a == b == "dispatch-task-42"


class TestRunOneHappyPath:
    def test_success_envelope_shape(self, fake_aiagent):
        env = asyncio.run(
            agent_runner.run_one(
                task_id="t-100",
                capability="text/reply",
                prompt="Hi",
                step_idx=0,
                config={"model": "m", "api_key": "k", "base_url": "http://x"},
            )
        )
        assert env["ok"] is True
        assert env["output"] == "ok-reply"
        assert env["artifacts"] == []
        meta = env["metadata"]
        assert meta["model"] == "m"
        assert meta["api_calls"] == 2
        assert meta["completed"] is True
        assert meta["input_tokens"] == 10
        assert meta["output_tokens"] == 5
        assert meta["total_tokens"] == 15
        assert meta["sessionId"] == "dispatch-t-100"
        assert meta["capability"] == "text/reply"
        assert meta["stepIdx"] == 0

    def test_session_id_and_task_id_are_wired_to_run_conversation(
        self, fake_aiagent
    ):
        asyncio.run(
            agent_runner.run_one(
                task_id="t-9",
                capability=None,
                prompt="Hello",
                config={"model": "m", "api_key": "k", "base_url": "http://x"},
            )
        )
        assert fake_aiagent.last_init_kwargs["session_id"] == "dispatch-t-9"
        assert fake_aiagent.last_init_kwargs["model"] == "m"
        assert fake_aiagent.last_init_kwargs["api_key"] == "k"
        assert fake_aiagent.last_init_kwargs["base_url"] == "http://x"
        assert fake_aiagent.last_init_kwargs["persist_session"] is False

        assert fake_aiagent.last_run_kwargs["user_message"] == "Hello"
        assert fake_aiagent.last_run_kwargs["task_id"] == "t-9"
        assert fake_aiagent.last_run_kwargs["conversation_history"] == []

    def test_config_falls_back_to_env(self, fake_aiagent, monkeypatch):
        monkeypatch.setenv("OPENAI_API_KEY", "env-key")
        monkeypatch.setenv("OPENAI_API_BASE_URL", "http://env")
        monkeypatch.setenv("AGENT_DEFAULT_MODEL", "env-model")
        asyncio.run(
            agent_runner.run_one(
                task_id="t-env",
                capability=None,
                prompt="hey",
                config=None,
            )
        )
        assert fake_aiagent.last_init_kwargs["api_key"] == "env-key"
        assert fake_aiagent.last_init_kwargs["base_url"] == "http://env"
        assert fake_aiagent.last_init_kwargs["model"] == "env-model"


class TestRunOneErrorMapping:
    def test_failed_true_becomes_ok_false(self, fake_aiagent):
        fake_aiagent.result_override = {
            "final_response": None,
            "messages": [],
            "api_calls": 0,
            "completed": False,
            "failed": True,
            "error": "rate_limited",
        }
        env = asyncio.run(
            agent_runner.run_one(
                task_id="t-f", capability=None, prompt="x", config={"model": "m"}
            )
        )
        assert env["ok"] is False
        assert env["error"] == "hermes_agent_error:rate_limited"
        assert env["metadata"]["completed"] is False

    def test_missing_final_response_becomes_ok_false(self, fake_aiagent):
        fake_aiagent.result_override = {
            "final_response": None,
            "messages": [],
            "api_calls": 0,
            "completed": True,
            "failed": False,
            "error": None,
        }
        env = asyncio.run(
            agent_runner.run_one(
                task_id="t-m", capability=None, prompt="x", config={"model": "m"}
            )
        )
        assert env["ok"] is False
        assert env["error"].startswith("hermes_agent_error:")

    def test_non_dict_result_surfaces_as_ok_false(self, fake_aiagent):
        fake_aiagent.result_override = "not a dict"
        env = asyncio.run(
            agent_runner.run_one(
                task_id="t-bad", capability=None, prompt="x", config={"model": "m"}
            )
        )
        assert env["ok"] is False
        assert "unexpected_result_type" in env["error"]

    def test_run_conversation_exception_becomes_ok_false(
        self, fake_aiagent, monkeypatch
    ):
        def _boom(self, **_kwargs):
            raise RuntimeError("kaboom")

        monkeypatch.setattr(_FakeAgent, "run_conversation", _boom)
        env = asyncio.run(
            agent_runner.run_one(
                task_id="t-x", capability=None, prompt="x", config={"model": "m"}
            )
        )
        assert env["ok"] is False
        assert env["error"].startswith("hermes_agent_error:RuntimeError:")
        assert "kaboom" in env["error"]


class TestWarnIfMissing:
    def test_warn_when_no_key(self, capsys, monkeypatch):
        for k in ("OPENAI_API_KEY", "HERMES_API_KEY"):
            monkeypatch.delenv(k, raising=False)
        agent_runner.warn_if_missing_llm_env()
        err = capsys.readouterr().err
        assert "no OPENAI_API_KEY" in err
