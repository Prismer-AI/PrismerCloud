"""Prismer Cloud recall-tools — reversible register_tool plugin lane.

Desktop-202 doc 19 §8 — the *lightest, most reversible* way to give a Hermes
agent the memory recall affordance. It also carries one bounded, signed-runtime
lifecycle bridge needed to bind the provider's actual response routing to the
exact daemon run:

  * It calls ``ctx.register_tool(...)`` TWICE (memory_search / memory_load) so
    the two tools land in ``agent.tools`` via the registry's
    ``get_tool_definitions()`` (agent_init.py:1156-1187 dedupes the memory-
    provider injection against exactly these plugin-registered names).
  * It registers ``post_api_request`` and forwards ONLY session id, the response
    model (or Hermes' request-locked model when the upstream omits that field),
    provider, agent and workspace. Raw response/content never crosses
    this bridge. It still registers NO prefetch / sync / inject / extract /
    compress behaviour and does not register a memory provider, so it does not
    pin ``memory.provider`` or trip Hermes' provider exclusivity.

Reversibility judge (doc 19 §3): delete this dir + drop ``prismer-recall``
from ``plugins.enabled`` = fully gone. No distributed artifact, no version
obligation, no framework lifecycle coupling.

The handlers mirror the daemon-calling logic of the full provider shell
(plugins/memory/prismer/) — plain HTTP GET to the daemon's local loopback
``/local/memory/search`` and ``/local/memory/load`` (FTS5 BM25 + graph, NO
vector) — but as plain callables, not provider methods.

Config (profile .env, written by the daemon / the TS adapter wiring):
  PRISMER_WORKSPACE_ID       — the workspace this profile's agent is bound to
  PRISMER_DAEMON_PORT        — daemon loopback port (default 3210)
  PRISMER_DAEMON_TOKEN       — optional bearer for the local data-plane
  PRISMER_AGENT_IM_USER_ID   — the calling agent's IM user id (M-ACTOR-THREAD).
                               Forwarded as ``actorImUserId`` + ``actorKind=agent``
                               so the daemon attributes the ``recall_pull``
                               observability event to this agent. The hermes
                               gateway already exports this var into the plugin's
                               inherited environment (hermes/index.ts gateway
                               spawn env); when ABSENT the params are omitted and
                               the daemon skips emission rather than fabricating
                               an actor.

NOTE: this file intentionally avoids the substrings the Hermes plugin loader
sniffs for to auto-coerce a plugin to ``kind="exclusive"`` (plugins.py:1318).
It is a plain ``standalone`` tool plugin — see plugin.yaml ``kind: standalone``.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.parse
import urllib.request
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

_DEFAULT_PORT = "3210"
_RECALL_TIMEOUT = 5
_ROUTING_TIMEOUT = 2

# Tool names are FROZEN to mirror the shared TS spec
# (sdk/prismer/src/adapters/memory-tools.ts) and the OpenAI-style
# shapes in the hermes adapter (HERMES_MEMORY_TOOLS). Do NOT rename.
_TOOLSET = "prismer_recall"

_MEMORY_SEARCH_SCHEMA = {
    "name": "memory_search",
    "description": (
        "Search workspace memory (prior decisions, user preferences, knowledge "
        "pages). Use this only when you have a specific question that you believe "
        "past memory would answer — not on every turn. Most queries do not need "
        "this. Returns 0–N ranked snippets with prismer:// URIs; empty results "
        "are normal."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Free-text search query. Whitespace-separated terms are ANDed.",
                "minLength": 1,
            },
            "limit": {
                "type": "integer",
                "description": "Max number of results (default 5, max 20).",
                "minimum": 1,
                "maximum": 20,
                "default": 5,
            },
            "pageType": {
                "type": "array",
                "description": "Optional filter on page kind.",
                "items": {
                    "type": "string",
                    "enum": ["hub", "leaf", "decision", "glossary", "archive"],
                },
            },
        },
        "required": ["query"],
    },
}

_MEMORY_LOAD_SCHEMA = {
    "name": "memory_load",
    "description": (
        "Load a specific memory page by URI "
        "(prismer://workspace/<workspaceId>/memory/<path>) or by "
        "(workspaceId + path). Returns the full page content plus metadata."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "uri": {
                "type": "string",
                "description": "Full prismer:// URI (preferred). Mutually exclusive with workspaceId+path.",
                "pattern": "^prismer://",
            },
            "workspaceId": {
                "type": "string",
                "description": "Workspace identifier (used with `path`).",
            },
            "path": {
                "type": "string",
                "description": "Workspace-relative memory file path (used with `workspaceId`).",
            },
        },
    },
}


def _daemon_base() -> str:
    port = (os.environ.get("PRISMER_DAEMON_PORT") or _DEFAULT_PORT).strip() or _DEFAULT_PORT
    return f"http://127.0.0.1:{port}"


def _headers() -> Dict[str, str]:
    h = {"Content-Type": "application/json"}
    token = (os.environ.get("PRISMER_DAEMON_TOKEN") or "").strip()
    if token:
        h["Authorization"] = f"Bearer {token}"
    # memory203 doc 08 §2 (F4) — forward the daemon-injected per-agent memory
    # capability so the daemon enforces workspace scope on recall RPCs.
    cap = (os.environ.get("PRISMER_MEMORY_CAP") or "").strip()
    if cap:
        h["x-prismer-memory-cap"] = cap
    return h


def _http_get(path: str, timeout: int) -> Optional[dict]:
    url = _daemon_base() + path
    req = urllib.request.Request(url, headers=_headers(), method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as exc:  # noqa: BLE001 — degrade-not-break (doc 19 §8)
        logger.debug("prismer-recall GET %s failed: %s", path, exc)
        return None


def _http_post(path: str, body: Dict[str, Any], timeout: int) -> Optional[dict]:
    url = _daemon_base() + path
    req = urllib.request.Request(
        url,
        data=json.dumps(body, separators=(",", ":")).encode("utf-8"),
        headers=_headers(),
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return json.loads(raw.decode("utf-8")) if raw else {"ok": True}
    except Exception as exc:  # noqa: BLE001 — routing evidence fails closed
        logger.debug("prismer-recall POST %s failed: %s", path, exc)
        return None


def _workspace_id() -> str:
    return (os.environ.get("PRISMER_WORKSPACE_ID") or "").strip()


def _actor_params() -> Dict[str, str]:
    """M-ACTOR-THREAD — the calling agent's actor identity for recall_pull.

    Reads ``PRISMER_AGENT_IM_USER_ID`` from the inherited gateway env. When set,
    returns ``{actorImUserId, actorKind}`` so the daemon RPC handler
    (rpc.ts handleSearch / handleLoad) can attribute the ``recall_pull``
    observability event to this agent. When ABSENT (legacy / anonymous), returns
    ``{}`` so the daemon skips emission rather than fabricating an actor.
    """
    actor = (os.environ.get("PRISMER_AGENT_IM_USER_ID") or "").strip()
    if not actor:
        return {}
    return {"actorImUserId": actor, "actorKind": "agent"}


def _handle_memory_search(args: Dict[str, Any], **_kw: Any) -> str:
    ws = _workspace_id()
    if not ws:
        return json.dumps({"error": "no workspace bound"})
    query = str(args.get("query", "") or "").strip()
    if not query:
        return json.dumps({"error": "missing_query"})
    params = {
        "workspaceId": ws,
        "q": query,
        "topK": str(int(args.get("limit", 5) or 5)),
        **_actor_params(),
    }
    page_type = args.get("pageType")
    if isinstance(page_type, list) and page_type:
        # Daemon accepts a single pageType per request — take the first
        # (mirrors memory-tools.ts:173-176).
        params["pageType"] = str(page_type[0])
    res = _http_get(f"/local/memory/search?{urllib.parse.urlencode(params)}", _RECALL_TIMEOUT)
    return json.dumps(res if res is not None else {"query": query, "results": []})


def _handle_memory_load(args: Dict[str, Any], **_kw: Any) -> str:
    ws = _workspace_id()
    q: Dict[str, str] = {}
    if args.get("uri"):
        q["uri"] = str(args["uri"])
    elif args.get("workspaceId") and args.get("path"):
        q["workspaceId"] = str(args["workspaceId"])
        q["path"] = str(args["path"])
    elif ws and args.get("path"):
        q["workspaceId"] = ws
        q["path"] = str(args["path"])
    else:
        return json.dumps({"error": "memory_load requires either `uri` or `workspaceId`+`path`"})
    q.update(_actor_params())
    res = _http_get(f"/local/memory/load?{urllib.parse.urlencode(q)}", _RECALL_TIMEOUT)
    return json.dumps(res if res is not None else {"error": "not_found"})


def _record_terminal_routing(**kwargs: Any) -> None:
    """Forward bounded post-response evidence; ignore raw response/content."""
    session_id = str(kwargs.get("session_id") or "").strip()
    # Some OpenAI-compatible streaming responses omit the optional `model`
    # field. Hermes still passes `model=agent.model`, which is the model locked
    # onto this exact API request (`require_model_lock=true` on the sessions
    # path). It is terminal lifecycle evidence here, not profile/config fallback.
    served_model = str(kwargs.get("response_model") or kwargs.get("model") or "").strip()
    served_provider = str(kwargs.get("provider") or "").strip()
    agent_im_user_id = (os.environ.get("PRISMER_AGENT_IM_USER_ID") or "").strip()
    workspace_id = _workspace_id()
    if not all((session_id, served_model, served_provider, agent_im_user_id, workspace_id)):
        return
    _http_post(
        "/v1/hooks/post_api_request",
        {
            "session_id": session_id,
            "extra": {
                "agent_im_user_id": agent_im_user_id,
                "workspace_id": workspace_id,
                "served_model": served_model,
                "served_provider": served_provider,
            },
        },
        _ROUTING_TIMEOUT,
    )


def register(ctx) -> None:
    """Register recall tools plus the bounded terminal-routing bridge."""
    ctx.register_tool(
        name="memory_search",
        toolset=_TOOLSET,
        schema=_MEMORY_SEARCH_SCHEMA,
        handler=_handle_memory_search,
        emoji="🔎",
    )
    ctx.register_tool(
        name="memory_load",
        toolset=_TOOLSET,
        schema=_MEMORY_LOAD_SCHEMA,
        handler=_handle_memory_load,
        emoji="📄",
    )
    ctx.register_hook("post_api_request", _record_terminal_routing)
    logger.info("prismer-recall registered tools + bounded post_api_request routing hook")
