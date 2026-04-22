"""
test_dispatch_server.py — Unit tests for the Mode B dispatch HTTP surface.

These tests do NOT require a live Hermes install — the runner is faked
via a simple async function. Real-LLM coverage lives in
``test_real_dispatch_e2e.py`` (gated on ``RUN_REAL_DISPATCH_E2E=1``).

We use ``aiohttp.test_utils.TestServer`` + ``TestClient`` directly so we
don't need the ``pytest-aiohttp`` plugin's ``aiohttp_client`` fixture.
This keeps the test dep list down to ``aiohttp + pytest-asyncio``.
"""

from __future__ import annotations

import json
import os
import sys
from contextlib import asynccontextmanager

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

aiohttp = pytest.importorskip("aiohttp", reason="aiohttp not installed; skip dispatch tests")
from aiohttp.test_utils import TestClient, TestServer  # noqa: E402

from prismer_adapter_hermes.dispatch import server as dispatch_server  # noqa: E402


@asynccontextmanager
async def _client_for(app):
    """Context-manage a TestServer/TestClient pair for an aiohttp app."""
    async with TestServer(app) as server:
        async with TestClient(server) as client:
            yield client


async def _fake_runner_ok(**kwargs):
    """Echo runner returning a well-formed success envelope."""
    return {
        "ok": True,
        "output": f"echo:{kwargs['prompt']}",
        "artifacts": [],
        "metadata": {
            "model": "test-model",
            "api_calls": 1,
            "capability": kwargs.get("capability"),
            "stepIdx": kwargs.get("step_idx"),
            "taskId": kwargs.get("task_id"),
        },
    }


async def _fake_runner_raises(**_kwargs):
    raise RuntimeError("boom")


class TestHealth:
    async def test_health_returns_expected_shape(self):
        app = dispatch_server.build_app(runner=_fake_runner_ok)
        async with _client_for(app) as client:
            resp = await client.get("/health")
            assert resp.status == 200
            body = await resp.json()
            assert body == {
                "status": "ok",
                "adapter": "hermes",
                "version": dispatch_server._ADAPTER_VERSION,
            }


class TestDispatchHappyPath:
    async def test_post_dispatch_routes_body_to_runner(self):
        captured = {}

        async def spy(**kwargs):
            captured.update(kwargs)
            return {"ok": True, "output": "ok", "artifacts": [], "metadata": {}}

        app = dispatch_server.build_app(runner=spy)
        async with _client_for(app) as client:
            resp = await client.post(
                "/dispatch",
                json={
                    "taskId": "t-001",
                    "capability": "text/reply",
                    "prompt": "Hello there",
                    "stepIdx": 2,
                    "deadlineAt": 1_776_000_000,
                },
            )
            assert resp.status == 200
            body = await resp.json()
            assert body["ok"] is True
            assert body["output"] == "ok"

        assert captured["task_id"] == "t-001"
        assert captured["capability"] == "text/reply"
        assert captured["prompt"] == "Hello there"
        assert captured["step_idx"] == 2
        assert captured["deadline_at"] == 1_776_000_000

    async def test_config_provider_is_forwarded(self):
        seen_cfg = {}

        async def spy(**kwargs):
            seen_cfg.update(kwargs.get("config") or {})
            return {"ok": True, "output": "x", "artifacts": [], "metadata": {}}

        app = dispatch_server.build_app(
            runner=spy, config_provider=lambda: {"model": "m1", "api_key": "k1"}
        )
        async with _client_for(app) as client:
            resp = await client.post(
                "/dispatch", json={"taskId": "t", "prompt": "p"}
            )
            assert resp.status == 200
        assert seen_cfg == {"model": "m1", "api_key": "k1"}

    async def test_sync_runner_is_also_supported(self):
        """The handler accepts both sync and async runners so unit-test
        mocks can stay simple. Covers the ``hasattr(result, '__await__')``
        branch that defers to await only when the runner is async."""

        def sync_spy(**_kwargs):
            return {"ok": True, "output": "sync", "artifacts": [], "metadata": {}}

        app = dispatch_server.build_app(runner=sync_spy)
        async with _client_for(app) as client:
            resp = await client.post(
                "/dispatch", json={"taskId": "t", "prompt": "p"}
            )
            body = await resp.json()
            assert body["output"] == "sync"


class TestDispatchValidation:
    async def test_malformed_json_returns_400(self):
        app = dispatch_server.build_app(runner=_fake_runner_ok)
        async with _client_for(app) as client:
            resp = await client.post(
                "/dispatch",
                data=b"{not json",
                headers={"Content-Type": "application/json"},
            )
            assert resp.status == 400
            body = await resp.json()
            assert body["ok"] is False
            assert body["error"].startswith("hermes_agent_error:invalid_json")

    async def test_missing_task_id_returns_400(self):
        app = dispatch_server.build_app(runner=_fake_runner_ok)
        async with _client_for(app) as client:
            resp = await client.post("/dispatch", json={"prompt": "hi"})
            assert resp.status == 400
            body = await resp.json()
            assert body["ok"] is False
            assert "missing_taskId" in body["error"]

    async def test_missing_prompt_returns_400(self):
        app = dispatch_server.build_app(runner=_fake_runner_ok)
        async with _client_for(app) as client:
            resp = await client.post("/dispatch", json={"taskId": "t"})
            assert resp.status == 400
            body = await resp.json()
            assert body["ok"] is False
            assert "missing_prompt" in body["error"]

    async def test_body_not_object_returns_400(self):
        app = dispatch_server.build_app(runner=_fake_runner_ok)
        async with _client_for(app) as client:
            resp = await client.post(
                "/dispatch",
                data=json.dumps([1, 2, 3]),
                headers={"Content-Type": "application/json"},
            )
            assert resp.status == 400
            body = await resp.json()
            assert body["error"].endswith("body_not_object")


class TestDispatchErrorSurface:
    async def test_runner_exception_returns_200_with_ok_false(self):
        """The Node adapter expects failures as 200/{ok:false} — NOT 5xx.

        We keep the HTTP status 200 and surface the failure in the body
        so circuit-breakers / retry policies can inspect ``error`` rather
        than racing on status codes.
        """
        app = dispatch_server.build_app(runner=_fake_runner_raises)
        async with _client_for(app) as client:
            resp = await client.post(
                "/dispatch", json={"taskId": "t1", "prompt": "hi"}
            )
            assert resp.status == 200
            body = await resp.json()
            assert body["ok"] is False
            assert body["error"].startswith("hermes_agent_error:RuntimeError:")
            assert "boom" in body["error"]

    async def test_non_dict_result_is_rejected(self):
        async def bad_runner(**_kwargs):
            return "not a dict"

        app = dispatch_server.build_app(runner=bad_runner)
        async with _client_for(app) as client:
            resp = await client.post(
                "/dispatch", json={"taskId": "t1", "prompt": "hi"}
            )
            assert resp.status == 200
            body = await resp.json()
            assert body["ok"] is False
            assert "runner_returned_non_dict" in body["error"]


class TestDefaultConfigFromEnv:
    """The env-derived default config is used by the CLI ``__main__``
    to snapshot credentials once at startup. Keep the precedence rules
    documented in ``server.default_config_from_env`` pinned down here."""

    def test_openai_api_key_takes_precedence(self, monkeypatch):
        monkeypatch.setenv("OPENAI_API_KEY", "a")
        monkeypatch.setenv("HERMES_API_KEY", "b")
        cfg = dispatch_server.default_config_from_env()
        assert cfg["api_key"] == "a"

    def test_falls_back_to_hermes_api_key(self, monkeypatch):
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        monkeypatch.setenv("HERMES_API_KEY", "b")
        cfg = dispatch_server.default_config_from_env()
        assert cfg["api_key"] == "b"

    def test_base_url_precedence(self, monkeypatch):
        monkeypatch.setenv("OPENAI_API_BASE_URL", "api")
        monkeypatch.setenv("OPENAI_BASE_URL", "base")
        monkeypatch.setenv("HERMES_BASE_URL", "hermes")
        cfg = dispatch_server.default_config_from_env()
        assert cfg["base_url"] == "api"
