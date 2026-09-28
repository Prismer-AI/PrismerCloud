"""M-ACTOR-THREAD — prismer-recall actor-attribution unit tests.

Covers the env→query-param forwarding contract in __init__.py:

  ① PRISMER_AGENT_IM_USER_ID set  → search & load forward
     actorImUserId=<id> + actorKind=agent on the daemon RPC query string.
  ② env absent / blank / whitespace → params are omitted (empty actor dict),
     so the daemon skips recall_pull emission rather than fabricating an actor.

No daemon is required: we monkeypatch the module's `_http_get` to capture the
path it would have GET'd and parse its query string.

Run (from runtime/):
  pytest plugins/tools/prismer-recall/test_actor_thread.py -v
or with stdlib only:
  python3 -m unittest plugins.tools.prismer-recall.test_actor_thread  # (dir not a pkg)
  python3 -m pytest plugins/tools/prismer-recall/test_actor_thread.py
"""

from __future__ import annotations

import importlib.util
import os
import unittest
import urllib.parse
import json
from pathlib import Path

# The plugin dir name (`prismer-recall`) has a hyphen → not import-as-package.
# Load __init__.py by path so the test is location-robust.
_PLUGIN_INIT = Path(__file__).resolve().parent / "__init__.py"
_spec = importlib.util.spec_from_file_location("prismer_recall_under_test", _PLUGIN_INIT)
assert _spec and _spec.loader
recall = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(recall)  # type: ignore[union-attr]


def _query_of(captured: dict, key: str) -> dict:
    """Parse the captured GET path's query string into a flat dict."""
    path = captured.get(key)
    assert path is not None, f"no {key} request captured"
    qs = path.split("?", 1)[1] if "?" in path else ""
    return {k: v[0] for k, v in urllib.parse.parse_qs(qs).items()}


class ActorThreadTest(unittest.TestCase):
    def setUp(self) -> None:
        # Capture the path each handler hands to _http_get; return a harmless
        # non-None dict so the handler serialises a normal result.
        self._captured: dict = {}

        def fake_get(path, timeout):  # noqa: ANN001
            # Distinguish the two surfaces by their route prefix.
            if path.startswith("/local/memory/search"):
                self._captured["search"] = path
            elif path.startswith("/local/memory/load"):
                self._captured["load"] = path
            return {"ok": True}

        self._orig_http_get = recall._http_get
        recall._http_get = fake_get  # type: ignore[assignment]

        # A workspace must be bound for the search handler to proceed.
        self._saved_env = dict(os.environ)
        os.environ["PRISMER_WORKSPACE_ID"] = "ws_actor_test"

    def tearDown(self) -> None:
        recall._http_get = self._orig_http_get  # type: ignore[assignment]
        os.environ.clear()
        os.environ.update(self._saved_env)

    # ── ① env SET → actor params forwarded ──────────────────────────────
    def test_actor_params_present_when_env_set(self) -> None:
        os.environ["PRISMER_AGENT_IM_USER_ID"] = "im_agent_42"
        # Direct unit on the helper.
        self.assertEqual(
            recall._actor_params(),
            {"actorImUserId": "im_agent_42", "actorKind": "agent"},
        )

    def test_search_forwards_actor_params(self) -> None:
        os.environ["PRISMER_AGENT_IM_USER_ID"] = "im_agent_42"
        recall._handle_memory_search({"query": "oauth decision", "limit": 3})
        q = _query_of(self._captured, "search")
        self.assertEqual(q.get("actorImUserId"), "im_agent_42")
        self.assertEqual(q.get("actorKind"), "agent")
        # Sanity: the core params are still there alongside the actor.
        self.assertEqual(q.get("workspaceId"), "ws_actor_test")
        self.assertEqual(q.get("q"), "oauth decision")

    def test_load_forwards_actor_params(self) -> None:
        os.environ["PRISMER_AGENT_IM_USER_ID"] = "im_agent_42"
        recall._handle_memory_load({"uri": "prismer://workspace/ws_actor_test/memory/auth.md"})
        q = _query_of(self._captured, "load")
        self.assertEqual(q.get("actorImUserId"), "im_agent_42")
        self.assertEqual(q.get("actorKind"), "agent")
        self.assertEqual(q.get("uri"), "prismer://workspace/ws_actor_test/memory/auth.md")

    # ── ② env ABSENT / blank → no actor params ──────────────────────────
    def test_actor_params_empty_when_env_absent(self) -> None:
        os.environ.pop("PRISMER_AGENT_IM_USER_ID", None)
        self.assertEqual(recall._actor_params(), {})

    def test_actor_params_empty_when_env_blank(self) -> None:
        os.environ["PRISMER_AGENT_IM_USER_ID"] = "   "  # whitespace → treated as absent
        self.assertEqual(recall._actor_params(), {})

    def test_search_omits_actor_params_when_env_absent(self) -> None:
        os.environ.pop("PRISMER_AGENT_IM_USER_ID", None)
        recall._handle_memory_search({"query": "oauth decision"})
        q = _query_of(self._captured, "search")
        self.assertNotIn("actorImUserId", q)
        self.assertNotIn("actorKind", q)
        # Core params still present — only the actor pair is dropped.
        self.assertEqual(q.get("workspaceId"), "ws_actor_test")

    def test_load_omits_actor_params_when_env_blank(self) -> None:
        os.environ["PRISMER_AGENT_IM_USER_ID"] = "  "
        recall._handle_memory_load({"workspaceId": "ws_actor_test", "path": "auth.md"})
        q = _query_of(self._captured, "load")
        self.assertNotIn("actorImUserId", q)
        self.assertNotIn("actorKind", q)

    def test_terminal_routing_hook_forwards_only_bounded_response_evidence(self) -> None:
        os.environ["PRISMER_AGENT_IM_USER_ID"] = "im_agent_42"
        captured = {}

        def fake_post(path, body, timeout):  # noqa: ANN001
            captured.update({"path": path, "body": body, "timeout": timeout})
            return {"ok": True}

        original = recall._http_post
        recall._http_post = fake_post
        try:
            response = object()
            recall._record_terminal_routing(
                session_id="api_exact",
                response_model="served-model",
                provider="served-provider",
                response=response,
                assistant_message={"content": "must-not-leak"},
            )
        finally:
            recall._http_post = original

        self.assertEqual(captured["path"], "/v1/hooks/post_api_request")
        self.assertEqual(captured["body"], {
            "session_id": "api_exact",
            "extra": {
                "agent_im_user_id": "im_agent_42",
                "workspace_id": "ws_actor_test",
                "served_model": "served-model",
                "served_provider": "served-provider",
            },
        })
        encoded = json.dumps(captured["body"])
        self.assertNotIn("must-not-leak", encoded)

    def test_terminal_routing_hook_fails_closed_without_response_model(self) -> None:
        os.environ["PRISMER_AGENT_IM_USER_ID"] = "im_agent_42"
        calls = []
        original = recall._http_post
        recall._http_post = lambda *args: calls.append(args)
        try:
            recall._record_terminal_routing(session_id="api_exact", response_model="", provider="configured")
        finally:
            recall._http_post = original
        self.assertEqual(calls, [])

    def test_terminal_routing_hook_uses_request_locked_model_when_response_omits_model(self) -> None:
        os.environ["PRISMER_AGENT_IM_USER_ID"] = "im_agent_42"
        captured = {}
        original = recall._http_post
        recall._http_post = lambda path, body, timeout: captured.update(body)
        try:
            recall._record_terminal_routing(
                session_id="api_exact",
                response_model=None,
                model="request-locked-model",
                provider="served-provider",
            )
        finally:
            recall._http_post = original
        self.assertEqual(captured["extra"]["served_model"], "request-locked-model")


if __name__ == "__main__":
    unittest.main(verbosity=2)
