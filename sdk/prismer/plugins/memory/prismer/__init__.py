"""Prismer Cloud memory provider — MemoryProvider ABC thin shell.

Desktop-202 doc 18 §4 — the **main正门** for Hermes memory integration. This is
a ~200-line protocol-translation shell: all memory logic lives in the Prismer
daemon (TypeScript). Every method here is a thin HTTP call to the daemon's
local loopback endpoints (``127.0.0.1:$PRISMER_DAEMON_PORT``, doc 18 §4c). The
daemon owns the SQLite FTS5 store, the cloud sync, the ACL predicate, and the
extract pipeline — the shell only speaks the Hermes ABC and forwards.

Activating this provider (``memory.provider: prismer`` in the profile config,
written by the daemon's ``ensureService``) **structurally excludes Honcho**:
Hermes allows exactly one external provider (doc 18 §4b#1). The four悬案 of the
double-memory-stack (envelope.recent redundancy / L2 double-compress /
user-profiling ownership) are resolved by ceding the whole layer.

Verb mapping (doc 18 §3a/§4c, v8.1 召回哲学):
  - prefetch()         → SHADOW only. Returns "" (NO injection). Archive recall
                         is agent-driven via tools, not per-turn auto-inject;
                         prefetch fires a shadow-observe ping the daemon counts.
  - get_tool_schemas() → recall-tools正门 (P0): memory_search / memory_load,
                         registered with the model so the AGENT decides when to
                         recall. handle_tool_call forwards to the daemon store.
                         memory_curate (MVP4 phase-1) is also registered here —
                         a knowledge-base maintenance verb that forwards to the
                         CLOUD curation endpoints (orchestrator-gated cloud-side).
  - sync_turn()        → in-process automatic-extraction TRIGGER (memory203/14):
                         POSTs the turn to the daemon's post_llm_call hook intake
                         with at-least-once delivery + a chain trace_id
                         (memory203/18 R9.1/R8.1). The extraction LLM runs in the
                         agent's own pod runtime — never the cloud (§0.5).
  - on_pre_compress()  → NO-OP (memory203/13 §0.5). Same reason — no cloud extract
                         forward; in-runtime auto-extraction is the replacement.
  - on_memory_write()  → built-in MEMORY.md收编: mirror agent add/replace/remove
                         into the substrate (agent-private files).
  - system_prompt_block() → the C channel (core-inject) is delivered by the
                         daemon writing the MEMORY.md managed section directly;
                         this block carries only a one-line provider status.

Config (profile .env, written by the daemon — user-invisible):
  PRISMER_DAEMON_PORT   — daemon loopback port (default 7878)
  PRISMER_DAEMON_TOKEN  — optional bearer for the local data-plane (doc 11 §3a)
  PRISMER_WORKSPACE_ID  — the workspace this profile's agent is bound to

NOTE: ``/local/memory/search`` + ``/local/memory/load`` + ``/local/memory/write``
+ ``/local/memory/mirror`` are the daemon loopback routes this shell uses. The
shell degrades gracefully (logs, no-throw) if the daemon predates them, per the
"降级不中断" failure mode (doc 18 §4c). The old ``/extract-turn`` /
``/extract-compress`` extract-forwarding is retired (memory203/13 §0.5) — this
shell no longer calls it (sync_turn / on_pre_compress are no-ops).
"""

from __future__ import annotations

import json
import logging
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any, Dict, List, Optional

from agent.memory_provider import MemoryProvider

logger = logging.getLogger(__name__)

# memory203 doc 10 §3 — the daemon's real loopback port (7878 in agent-rt;
# local-server.ts publishes it to PRISMER_DAEMON_PORT). The daemon writes that
# env into the profile .env, so this fallback only fires when the env is unset.
_DEFAULT_PORT = "7878"
_RECALL_TIMEOUT = 5
_WRITE_TIMEOUT = 8
# Curation forwards to cloud (page-dream / promote / supersede / rebuild) which
# can do real work; give it a wider budget than a local recall/write.
_CURATE_TIMEOUT = 30
# Web search/load forwards to the cloud Load API (Exa search + per-URL
# compression) via the daemon; the daemon's own forward timeout is 120s
# (live-measured: a cold 3-result query took 59s), so the shell waits slightly
# longer — the daemon, not the shell, is the timeout authority (a shell
# timeout would drop the daemon's structured error).
_WEB_TIMEOUT = 130
# Native PKF operations are local CPU work over a bounded 5 MiB source.
_PKF_TIMEOUT = 20
_PKF_BUNDLE_TIMEOUT = 125

# Hermes gateways are long-running per-profile processes while cap v2 lasts
# only 15 minutes. Keep the currently renewed token in process memory; never
# write it to profile config or logs. The initial value still comes from the
# daemon-spawned environment.
_memory_cap = (os.environ.get("PRISMER_MEMORY_CAP") or "").strip()


def _daemon_base() -> str:
    port = (os.environ.get("PRISMER_DAEMON_PORT") or _DEFAULT_PORT).strip() or _DEFAULT_PORT
    return f"http://127.0.0.1:{port}"


def _headers() -> Dict[str, str]:
    h = {"Content-Type": "application/json"}
    token = (os.environ.get("PRISMER_DAEMON_TOKEN") or "").strip()
    if token:
        h["Authorization"] = f"Bearer {token}"
    # memory203 doc 08 §2 (F4) — per-agent scoped memory capability. The daemon
    # injects PRISMER_MEMORY_CAP into this gateway process env at spawn; forward
    # it on every memory RPC so the daemon can enforce workspace scope. Absent →
    # omit (daemon treats as unscoped/legacy under enforce-off).
    cap = _memory_cap or (os.environ.get("PRISMER_MEMORY_CAP") or "").strip()
    if cap:
        h["x-prismer-memory-cap"] = cap
    # Public PKF routes use a domain-neutral actor hint. This value comes from
    # the per-profile Runtime spawn environment, never from model tool args.
    agent_im_user_id = (os.environ.get("PRISMER_AGENT_IM_USER_ID") or "").strip()
    if agent_im_user_id:
        h["X-Prismer-Agent"] = agent_im_user_id
    return h


def _decode_json(raw: bytes) -> Any:
    if not raw:
        return {}
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception:  # noqa: BLE001 — transport helper returns opaque failure
        return None


def _refresh_memory_cap() -> bool:
    """Exchange a stale signed v2 cap for current-authority claims once.

    The daemon accepts renewal only when the old token is authentic for this
    daemon boot and the current Cloud authority snapshot still grants its
    actor/workspace. Revocation, lease expiry, tampering, and restart remain
    fail-closed. This function never logs or persists either token.
    """
    global _memory_cap
    presented = _memory_cap or (os.environ.get("PRISMER_MEMORY_CAP") or "").strip()
    if not presented:
        return False
    url = _daemon_base() + "/local/memory/cap/refresh"
    req = urllib.request.Request(
        url,
        data=b"{}",
        headers={"Content-Type": "application/json", "x-prismer-memory-cap": presented},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=_RECALL_TIMEOUT) as resp:
            payload = _decode_json(resp.read())
    except Exception:  # noqa: BLE001 — caller preserves the original failure
        return False
    renewed = payload.get("cap") if isinstance(payload, dict) else None
    if not isinstance(renewed, str) or not renewed.strip():
        return False
    _memory_cap = renewed.strip()
    return True


def _request_with_status(path: str, method: str, body: Optional[dict], timeout: int) -> Dict[str, Any]:
    """Run one daemon request and renew+retry once on cap expiry."""
    url = _daemon_base() + path
    data = json.dumps(body).encode("utf-8") if body is not None else None

    def once() -> Dict[str, Any]:
        req = urllib.request.Request(url, data=data, headers=_headers(), method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return {"status": resp.status, "body": _decode_json(resp.read())}
        except urllib.error.HTTPError as exc:
            return {"status": exc.code, "body": _decode_json(exc.read())}
        except Exception as exc:  # noqa: BLE001 — degrade-not-break boundary
            return {"status": 0, "body": None, "error": str(exc)}

    result = once()
    payload = result.get("body")
    if (
        result.get("status") == 401
        and isinstance(payload, dict)
        and payload.get("error") == "memory_cap_invalid"
        and _refresh_memory_cap()
    ):
        return once()
    return result


def _http_get(path: str, timeout: int) -> Optional[dict]:
    result = _request_with_status(path, "GET", None, timeout)
    if 200 <= result.get("status", 0) < 300:
        return result.get("body")
    logger.debug("prismer provider GET %s failed: status=%s", path, result.get("status", 0))
    return None


def _http_get_with_status(path: str, timeout: int) -> Dict[str, Any]:
    """GET that preserves daemon status/body for model-visible tool calls.

    Shadow prefetch intentionally keeps the degrade-not-break ``_http_get``
    behavior. Explicit tools must not turn a fail-closed 401/403 into an empty
    result or the transport-only ``daemon_unreachable`` error.
    """
    return _request_with_status(path, "GET", None, timeout)


def _http_post(path: str, body: dict, timeout: int) -> Optional[dict]:
    result = _request_with_status(path, "POST", body, timeout)
    if 200 <= result.get("status", 0) < 300:
        return result.get("body")
    logger.debug("prismer provider POST %s failed: status=%s", path, result.get("status", 0))
    return None


def _http_post_with_status(path: str, body: dict, timeout: int) -> Dict[str, Any]:
    """POST that preserves the daemon's status + JSON body even on non-2xx.

    Unlike ``_http_post`` (which swallows HTTP errors and returns ``None`` for
    the degrade-not-break recall/write paths), curation needs the daemon's
    error body to flow back to the agent — specifically the cloud's
    ``orchestrator_only`` 403 passthrough — so a non-orchestrator agent sees a
    clear "you are not the orchestrator" rather than a silent no-op. Returns
    ``{"status": int, "body": dict|None}``; a transport failure (daemon
    unreachable) yields ``status=0``.
    """
    return _request_with_status(path, "POST", body, timeout)


_ATTACHED_ASSETS_BLOCK_RE = re.compile(r"<attached_assets>(.*?)</attached_assets>", re.S)
_ASSET_ID_RE = re.compile(r'<asset\s[^>]*?\bid="([^"]+)"')


def _parse_attached_asset_ids(user_content: str, max_ids: int = 20) -> List[str]:
    """memory203/20 §2.1 — recover attached asset ids from the turn text.

    The dispatch composer (daemon/conversation-context.ts) stamps
    ``<attached_assets><asset id="…" …/></attached_assets>`` into the rendered
    user message; Hermes hands that same text back to ``sync_turn``. Parsing the
    ids out here lets the daemon extraction prompt list the real
    ``prismer://asset/<id>`` pointer URIs. Deduped, order-preserving, bounded.
    """
    out: List[str] = []
    seen = set()
    for block in _ATTACHED_ASSETS_BLOCK_RE.findall(user_content or ""):
        for asset_id in _ASSET_ID_RE.findall(block):
            asset_id = asset_id.strip()
            if not asset_id or asset_id in seen:
                continue
            seen.add(asset_id)
            out.append(asset_id)
            if len(out) >= max_ids:
                return out
    return out


# ─── Memory tool schemas — GENERATED, single source (memory211/01 W5 轴 H) ───
#
# The five memory tool schemas are NOT written here any more. They are
# generated from the FROZEN TS spec (`sdk/prismer/src/adapters/memory-tools.ts`,
# the single source of truth) into `tool-schemas.generated.json`, and this shell
# LOADS that file at runtime — so a hand-edited plugin schema can no longer
# drift from the tool spec. This is the structural extinction of the D1 class of
# defect (the same parameter spelled `parentHubPath` on one surface,
# `parent_hub_path` on another, and taught as a third spelling in the skill).
#
# Regenerate after changing the TS spec:
#   npx tsx scripts/memory211/generate-memory-tool-contract.ts
#
# The contract test (scripts/__tests__/memory211-tool-contract.test.ts) asserts
# the committed artifact matches a regeneration AND that every declared
# parameter is actually forwarded by handle_tool_call below.

from pathlib import Path as _Path

_TOOL_SCHEMAS_PATH = _Path(__file__).with_name("tool-schemas.generated.json")


def _load_memory_tool_schemas() -> Dict[str, Dict[str, Any]]:
    try:
        data = json.loads(_TOOL_SCHEMAS_PATH.read_text(encoding="utf-8"))
    except OSError as exc:  # a truncated / missing artifact must be LOUD
        raise RuntimeError(
            f"memory tool schemas missing at {_TOOL_SCHEMAS_PATH} — regenerate with "
            "`npx tsx scripts/memory211/generate-memory-tool-contract.ts`"
        ) from exc
    return {tool["name"]: tool for tool in data["memoryTools"]}


_MEMORY_TOOL_SCHEMAS = _load_memory_tool_schemas()
_MEMORY_SEARCH_SCHEMA = _MEMORY_TOOL_SCHEMAS["memory_search"]
_MEMORY_LOAD_SCHEMA = _MEMORY_TOOL_SCHEMAS["memory_load"]
_MEMORY_BROWSE_SCHEMA = _MEMORY_TOOL_SCHEMAS["memory_browse"]
_MEMORY_WRITE_SCHEMA = _MEMORY_TOOL_SCHEMAS["memory_write"]
_MEMORY_CURATE_SCHEMA = _MEMORY_TOOL_SCHEMAS["memory_curate"]



# ─── Workspace WEB tools (NOT memory ops) ────────────────────────────────────
#
# web_search / web_load are workspace-CONTEXT tools, not memory verbs. They
# cohabit this provider shell because get_tool_schemas() is the established
# seam for registering daemon-backed tools with the Hermes model — the same
# path the 5 memory tools ride. Rationale (release203 web-capability fix, user
# ruling "we ARE the search backend"):
#   - Hermes' native web toolset is schema-dropped in agent-rt pods (all 7
#     upstream search backends unconfigured → check_fn removes web_search /
#     web_extract), so agents scripted raw HTTP via execute_code+subprocess.
#   - We do NOT install third-party search keys/packages into pods. The cloud
#     Load API (POST /api/context/load: search + cache + compress + deposit,
#     Exa server-side) is the workspace's search backend; the daemon holds the
#     cloud credential and forwards (daemon/web/rpc.ts → /local/web/*).
#
# Name note: `workspace_web_search`, NOT `web_search` — Hermes v0.17 guards
# provider tools that shadow RESERVED CORE tool names even when the core tool
# itself is check_fn-dropped ("Memory provider 'prismer' tool 'web_search'
# shadows a reserved core tool name; registration ignored. Core tools always
# win" — live-hit 2026-07-03). The event-stream mapper (tool-call-mapper.ts
# SEARCH_TOOLS) maps this name onto the first-class `web_search` search row,
# so the UI surface is unchanged. `web_load` has no core counterpart and
# keeps the plain name.
_WEB_SEARCH_SCHEMA = {
    "name": "workspace_web_search",
    "description": (
        "Search the web through the workspace cloud (cached, billed to your "
        "workspace). Returns ranked results with compressed page content. Use "
        "this for ANY web research instead of scripting HTTP calls with "
        "execute_code/subprocess."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Web search query.", "minLength": 1},
            "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 10,
                "default": 5,
                "description": "Max results to return (default 5).",
            },
        },
        "required": ["query"],
    },
}

_WEB_LOAD_SCHEMA = {
    "name": "web_load",
    "description": (
        "Load web pages OR workspace assets/files (prismer://asset/… URIs) "
        "through the workspace cloud (cached, billed to your workspace). "
        "Returns compressed content. Use this to read a specific URL instead "
        "of scripting HTTP calls with execute_code/subprocess — and use it "
        "instead of re-reading raw sources when memory already references "
        "them by a prismer:// pointer. Accepts http(s) and prismer:// URIs."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "url": {"type": "string", "description": "Single http(s) or prismer:// URI to load."},
            "urls": {
                "type": "array",
                "items": {"type": "string"},
                "maxItems": 5,
                "description": "Batch of http(s)/prismer:// URIs to load (max 5).",
            },
        },
    },
}


# ─── Native PKF tools ────────────────────────────────────────────────────────
# These are function-call tools, not shell binaries. The provider forwards the
# source to the signed Runtime's loopback endpoints, which use the bundled
# @prismer/pkf-core. This prevents an agent from probing PATH or inventing a
# Python validator when following pkf-writing.
_PKF_SOURCE_PROPERTY = {
    "type": "string",
    "description": "Full PKF source (maximum 5 MiB).",
}

_PKF_MINT_SIDS_SCHEMA = {
    "name": "pkf_mint_sids",
    "description": (
        "Mint canonical stable PKF section ids. Call once before authoring "
        "sections and preserve the returned ids; never write a generator script."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "count": {"type": "integer", "minimum": 1, "maximum": 50, "default": 1},
        },
        "additionalProperties": False,
    },
}

_PKF_VALIDATE_SCHEMA = {
    "name": "pkf_validate",
    "description": "Validate PKF with the signed Runtime core. Native function tool; never run it in a terminal.",
    "parameters": {
        "type": "object",
        "properties": {
            "source": _PKF_SOURCE_PROPERTY,
            "level": {"type": "string", "enum": ["structure", "resolved"], "default": "structure"},
            "workspaceId": {"type": "string"},
        },
        "required": ["source"],
        "additionalProperties": False,
    },
}

# pkf209/07 §5 — controlled-svg authoring loop. Mirrors the TS
# PKF_SVG_CHECK_TOOL input schema 1:1 (parity is test-locked).
_PKF_SVG_CHECK_SCHEMA = {
    "name": "pkf_svg_check",
    "description": (
        "Validate one controlled svg markup in-process (frozen whitelist + quality "
        "floors; stable svg-* codes with fix-oriented diagnostics). Offline — never "
        "shells out. Check-then-fix loop for prismer-svg authoring; a fail means "
        "the svg must be repaired before persisting."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "svg": {
                "type": "string",
                "description": (
                    "Complete controlled svg markup (the <svg>…</svg> inner block "
                    "of a prismer-svg element)."
                ),
            },
        },
        "required": ["svg"],
        "additionalProperties": False,
    },
}

# pkf209 — mechanical inline-PKF delivery. Mirrors the TS
# PKF_REPLY_INLINE_TOOL input schema 1:1 (parity is test-locked). The model
# passes a FILE PATH only; the daemon validates the bytes against the calling
# agent's in-flight dispatch scope and the dispatch terminal state attaches
# the inline ContentBlock. This is the answer to the 2026-08-20 matrix gap:
# weak models completed every step but the last (pasting sentinel-wrapped
# bytes into the reply) — that burden is now the Runtime's.
_PKF_REPLY_INLINE_SCHEMA = {
    "name": "pkf_reply_inline",
    "description": (
        "Deliver your final report as the message-inline PKF ContentBlock, "
        "mechanically. Write the complete PKF v1.1 to a file in your task "
        "scratch dir, pass pkf_validate on it, then call this tool ONCE with "
        "the file path — the Runtime re-validates the file and attaches the "
        "inline ContentBlock to your reply for you. Never paste sentinel "
        "comments into the reply; never attach the .pkf as a file. Keep the "
        "reply text as the readable markdown projection."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": (
                    "Path of the validated .pkf file — relative to your task "
                    "scratch dir (e.g. \"memo.pkf\") or absolute inside the "
                    "task scratch/workdir."
                ),
                "minLength": 1,
            },
        },
        "required": ["path"],
        "additionalProperties": False,
    },
}

_PKF_OUTLINE_SCHEMA = {
    "name": "pkf_outline",
    "description": "Return a bounded semantic outline of PKF source. Native function tool, not a shell command.",
    "parameters": {
        "type": "object",
        "properties": {
            "source": _PKF_SOURCE_PROPERTY,
            "documentUri": {"type": "string"},
            "revisionId": {"type": "string"},
            "cursor": {"type": "string"},
        },
        "required": ["source"],
        "additionalProperties": False,
    },
}

_PKF_SEARCH_SCHEMA = {
    "name": "pkf_search",
    "description": "Search PKF source with bounded snippets. Native function tool, not a shell command.",
    "parameters": {
        "type": "object",
        "properties": {
            "source": _PKF_SOURCE_PROPERTY,
            "documentUri": {"type": "string"},
            "revisionId": {"type": "string"},
            "query": {"type": "string", "minLength": 1},
            "limit": {"type": "integer", "minimum": 1},
        },
        "required": ["source", "query"],
        "additionalProperties": False,
    },
}

_PKF_READ_SCHEMA = {
    "name": "pkf_read",
    "description": "Read one bounded PKF section. Native function tool, not a shell command.",
    "parameters": {
        "type": "object",
        "properties": {
            "source": _PKF_SOURCE_PROPERTY,
            "documentUri": {"type": "string"},
            "revisionId": {"type": "string"},
            "anchorSlug": {"type": "string"},
            "sectionSid": {"type": "string"},
            "maxBytes": {"type": "integer", "minimum": 1, "maximum": 65536},
        },
        "required": ["source"],
        "additionalProperties": False,
    },
}

_PKF_BUNDLE_COMMIT_SCHEMA = {
    "name": "pkf_bundle_commit",
    "description": (
        "Atomically commit one logical PKF root with all JS/CSS/media/CSV or other "
        "dependencies, then verify the canonical Cloud readback. Reuse one stable "
        "idempotencyKey on retry; never upload dependencies separately or claim "
        "relationships in prose."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "idempotencyKey": {"type": "string", "minLength": 1, "maxLength": 191},
            "root": {
                "type": "object",
                "properties": {
                    "filename": {"type": "string", "minLength": 1, "maxLength": 191},
                    "source": {"type": "string", "minLength": 1},
                    "sourceHash": {"type": "string", "pattern": "^[0-9a-f]{64}$"},
                },
                "required": ["filename", "source", "sourceHash"],
                "additionalProperties": False,
            },
            "resources": {
                "type": "array",
                "minItems": 1,
                "maxItems": 256,
                "items": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "minLength": 1, "maxLength": 500},
                        "fromPath": {"type": "string", "minLength": 1, "maxLength": 500},
                        "bytesBase64": {"type": "string", "minLength": 1},
                        "contentHash": {"type": "string", "pattern": "^[0-9a-f]{64}$"},
                        "integrity": {"type": "string", "pattern": "^sha256-[A-Za-z0-9+/]+={0,2}$"},
                        "mime": {"type": "string", "minLength": 1, "maxLength": 191},
                        "usage": {
                            "type": "string",
                            "enum": [
                                "harness-manifest", "harness-script", "harness-style",
                                "harness-resource", "image", "video", "audio", "file", "data",
                            ],
                        },
                    },
                    "required": ["path", "bytesBase64", "contentHash", "integrity", "mime", "usage"],
                    "additionalProperties": False,
                },
            },
        },
        "required": ["idempotencyKey", "root", "resources"],
        "additionalProperties": False,
    },
}


class PrismerMemoryProvider(MemoryProvider):
    """Hermes MemoryProvider that delegates to the Prismer daemon (local-first)."""

    def __init__(self) -> None:
        self._workspace_id: str = ""
        self._agent_context: str = "primary"
        self._session_id: str = ""
        # Successful direct writes are authoritative already.  Hold their
        # structured receipts until sync_turn delivers the terminal snapshot,
        # so Runtime can classify the explicit lane without extracting and
        # creating a duplicate Page revision.
        self._pending_explicit_receipts: List[Dict[str, Any]] = []

    @property
    def name(self) -> str:
        return "prismer"

    def is_available(self) -> bool:
        # Config-only check (no network, per ABC). The daemon endpoint is the
        # backend; a workspace binding is the minimum needed to scope recall.
        return bool((os.environ.get("PRISMER_WORKSPACE_ID") or "").strip())

    def initialize(self, session_id: str, **kwargs: Any) -> None:
        self._session_id = session_id or ""
        self._workspace_id = (os.environ.get("PRISMER_WORKSPACE_ID") or "").strip()
        # scratch/eval isolation (doc 18 §4c): non-primary contexts are read-only.
        self._agent_context = str(kwargs.get("agent_context") or "primary")
        logger.info(
            "prismer memory provider initialized session=%s workspace=%s context=%s",
            session_id, self._workspace_id, self._agent_context,
        )

    def system_prompt_block(self) -> str:
        # The C channel (core-inject) is delivered out-of-band by the daemon
        # writing the MEMORY.md managed section directly (≤1,800 chars). Here we
        # only declare the recall affordance so the model knows the tools exist.
        return (
            "Workspace memory is available via the memory_search / memory_load "
            "tools (Prismer local store). Call memory_search when a task needs "
            "prior decisions, preferences, or knowledge you don't already have."
        )

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        # v8.1: per-turn auto-injection is RETIRED → shadow observe only. We do
        # NOT return recall context (archive recall is agent-driven via tools).
        # Fire a best-effort shadow ping the daemon counts (shadowFiredCount).
        if self._is_readonly() or not query.strip() or not self._workspace_id:
            return ""
        params = urllib.parse.urlencode({
            "workspaceId": self._workspace_id,
            "q": query[:240],
            "shadow": "1",
        })
        _http_get(f"/local/memory/search?{params}", _RECALL_TIMEOUT)
        return ""

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        # recall-tools正门 (P0): the agent self-recalls archive via these. The
        # third tool (memory_curate, MVP4 phase-1) enacts knowledge-base
        # maintenance — offered to every agent, but orchestrator-gated cloud-side.
        # memory_browse (memory203/18 R6.2) is the write-time structure view —
        # browse → decide placement → memory_write(parentHubPath)  # W5 轴H: camelCase, per the generated schema.
        # web_search / web_load are workspace-context tools (NOT memory ops —
        # see the schema block comment); registered here because this shell is
        # the daemon-backed tool-registration seam.
        return [
            _MEMORY_SEARCH_SCHEMA,
            _MEMORY_LOAD_SCHEMA,
            _MEMORY_BROWSE_SCHEMA,
            _MEMORY_WRITE_SCHEMA,
            _MEMORY_CURATE_SCHEMA,
            _WEB_SEARCH_SCHEMA,
            _WEB_LOAD_SCHEMA,
            _PKF_MINT_SIDS_SCHEMA,
            _PKF_VALIDATE_SCHEMA,
            _PKF_OUTLINE_SCHEMA,
            _PKF_SEARCH_SCHEMA,
            _PKF_READ_SCHEMA,
            _PKF_BUNDLE_COMMIT_SCHEMA,
            _PKF_SVG_CHECK_SCHEMA,
            _PKF_REPLY_INLINE_SCHEMA,
        ]

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs: Any) -> str:
        # PKF query/validation is pure local CPU work. It deliberately precedes
        # the Memory workspace guard: a cold agent, evaluator, or self-check can
        # validate an inline document before any workspace has been bound.
        if tool_name == "pkf_mint_sids":
            count = args.get("count", 1)
            if not isinstance(count, int) or isinstance(count, bool) or count < 1 or count > 50:
                return json.dumps({"ok": False, "error": "pkf_sid_count_invalid", "min": 1, "max": 50})
            result = _http_post_with_status(
                "/local/pkf/mint-sids", {"count": count}, _PKF_TIMEOUT
            )
            status = result.get("status", 0)
            payload = result.get("body")
            if status == 0:
                return json.dumps({"ok": False, "error": "daemon_unreachable"})
            if not (200 <= status < 300):
                return json.dumps(
                    payload if isinstance(payload, dict) else {"ok": False, "error": f"pkf_mint_sids_failed_{status}"}
                )
            return json.dumps(payload or {"ok": True, "sids": []})

        if tool_name in ("pkf_validate", "pkf_outline", "pkf_search", "pkf_read"):
            source = args.get("source")
            if not isinstance(source, str) or not source:
                return json.dumps({"ok": False, "error": "pkf_source_required"})
            operation = tool_name.removeprefix("pkf_")
            allowed: Dict[str, tuple[str, ...]] = {
                "validate": ("source", "level", "workspaceId"),
                "outline": ("source", "documentUri", "revisionId", "cursor"),
                "search": ("source", "documentUri", "revisionId", "query", "limit"),
                "read": ("source", "documentUri", "revisionId", "anchorSlug", "sectionSid", "maxBytes"),
            }
            body = {key: args[key] for key in allowed[operation] if key in args}
            result = _http_post_with_status(f"/local/pkf/{operation}", body, _PKF_TIMEOUT)
            status = result.get("status", 0)
            payload = result.get("body")
            if status == 0:
                return json.dumps({"ok": False, "error": "daemon_unreachable"})
            if not (200 <= status < 300):
                return json.dumps(
                    payload if isinstance(payload, dict) else {"ok": False, "error": f"pkf_{operation}_failed_{status}"}
                )
            return json.dumps(payload or {"ok": True})

        if tool_name == "pkf_svg_check":
            # pkf209/07 §5 — controlled-svg check loop. Takes `svg` (not
            # `source`); the daemon route runs the same local audit as the TS
            # in-process tool.
            svg = args.get("svg")
            if not isinstance(svg, str) or not svg.strip():
                return json.dumps({"ok": False, "error": "pkf_svg_required"})
            result = _http_post_with_status("/local/pkf/svg-check", {"svg": svg}, _PKF_TIMEOUT)
            status = result.get("status", 0)
            payload = result.get("body")
            if status == 0:
                return json.dumps({"ok": False, "error": "daemon_unreachable"})
            if not (200 <= status < 300):
                return json.dumps(
                    payload if isinstance(payload, dict) else {"ok": False, "error": f"pkf_svg_check_failed_{status}"}
                )
            return json.dumps(payload or {"ok": False, "error": "pkf_svg_check_empty_result"})

        if tool_name == "pkf_reply_inline":
            # pkf209 — mechanical inline-PKF delivery. Takes `path` only; the
            # daemon resolves the calling agent's in-flight dispatch scope (the
            # X-Prismer-Agent header this shell already forwards), validates the
            # file bytes, and writes the per-task marker the dispatch terminal
            # state turns into the inline ContentBlock.
            path = args.get("path")
            if not isinstance(path, str) or not path.strip():
                return json.dumps({"ok": False, "error": "pkf_reply_inline_path_required"})
            result = _http_post_with_status(
                "/local/pkf/reply-inline", {"path": path}, _PKF_TIMEOUT
            )
            status = result.get("status", 0)
            payload = result.get("body")
            if status == 0:
                return json.dumps({"ok": False, "error": "daemon_unreachable"})
            if not (200 <= status < 300):
                return json.dumps(
                    payload if isinstance(payload, dict) else {"ok": False, "error": f"pkf_reply_inline_failed_{status}"}
                )
            return json.dumps(payload or {"ok": False, "error": "pkf_reply_inline_empty_result"})

        if tool_name == "pkf_bundle_commit":
            if not self._workspace_id:
                return json.dumps({"ok": False, "error": "pkf_bundle_workspace_unbound"})
            allowed = ("idempotencyKey", "root", "resources")
            body = {key: args[key] for key in allowed if key in args}
            result = _http_post_with_status(
                "/local/pkf/bundle-commit", body, _PKF_BUNDLE_TIMEOUT
            )
            status = result.get("status", 0)
            payload = result.get("body")
            if status == 0:
                return json.dumps({"ok": False, "error": "daemon_unreachable"})
            if not (200 <= status < 300):
                return json.dumps(
                    payload if isinstance(payload, dict) else {"ok": False, "error": f"pkf_bundle_commit_failed_{status}"}
                )
            return json.dumps(payload or {"ok": False, "error": "pkf_bundle_commit_empty_receipt"})

        if not self._workspace_id:
            return json.dumps({"error": "no workspace bound"})
        if tool_name == "memory_search":
            # memory211/01 轴C W1a 遗留补齐 — the batch `queries` param travels
            # JSON-encoded in ONE `queries` param (the RPC is a GET). `q` is
            # still sent so an OLDER daemon without batch support keeps working
            # with just the first query.
            search: Dict[str, str] = {
                "workspaceId": self._workspace_id,
                "q": str(args.get("query", "")),
                "topK": str(int(args.get("limit", 5) or 5)),
            }
            queries = args.get("queries")
            if isinstance(queries, list) and queries:
                search["queries"] = json.dumps([str(x) for x in queries[:8] if str(x).strip()])
            page_types = args.get("pageType")
            if isinstance(page_types, list) and page_types:
                search["pageType"] = str(page_types[0])
            if args.get("sourceWorkspaceId"):
                search["sourceWorkspaceId"] = str(args["sourceWorkspaceId"])
            params = urllib.parse.urlencode(search)
            result = _http_get_with_status(f"/local/memory/search?{params}", _RECALL_TIMEOUT)
            status = result.get("status", 0)
            res = result.get("body")
            if status == 0:
                return json.dumps({"ok": False, "error": "daemon_unreachable"})
            if not (200 <= status < 300):
                return json.dumps(
                    res if isinstance(res, dict) else {"ok": False, "error": f"memory_search_failed_{status}"}
                )
            return json.dumps(res or {"results": []})
        if tool_name == "memory_load":
            q: Dict[str, str] = {"workspaceId": self._workspace_id}
            if args.get("uri"):
                q = {"uri": str(args["uri"])}
            elif args.get("path"):
                q["path"] = str(args["path"])
            if args.get("sourceWorkspaceId"):
                q["sourceWorkspaceId"] = str(args["sourceWorkspaceId"])
            result = _http_get_with_status(
                f"/local/memory/load?{urllib.parse.urlencode(q)}", _RECALL_TIMEOUT
            )
            status = result.get("status", 0)
            res = result.get("body")
            if status == 0:
                return json.dumps({"ok": False, "error": "daemon_unreachable"})
            if not (200 <= status < 300):
                return json.dumps(
                    res if isinstance(res, dict) else {"ok": False, "error": f"memory_load_failed_{status}"}
                )
            return json.dumps(res or {"error": "not found"})
        if tool_name == "memory_browse":
            # memory203/18 R6.2 — write-time structure view. Same shape the
            # daemon's own extraction leg sees: {index, hubs[], nearest[]};
            # hub rows carry children+updatedAt and hubsByRecent[] is the
            # recency sequence (memory211/03 §7 B1).
            q = {"workspaceId": self._workspace_id}
            if args.get("query"):
                q["q"] = str(args["query"])
            result = _http_get_with_status(
                f"/local/memory/place-context?{urllib.parse.urlencode(q)}", _RECALL_TIMEOUT
            )
            status = result.get("status", 0)
            res = result.get("body")
            if status == 0:
                return json.dumps({"ok": False, "error": "daemon_unreachable"})
            if not (200 <= status < 300):
                return json.dumps(
                    res if isinstance(res, dict) else {"ok": False, "error": f"memory_browse_failed_{status}"}
                )
            return json.dumps(
                res or {"index": None, "hubs": [], "hubsByRecent": [], "nearest": []}
            )
        if tool_name == "memory_write":
            path = str(args.get("path", "")).strip()
            content = str(args.get("content", ""))
            if not path or not content:
                return json.dumps({"ok": False, "error": "memory_write requires path + content"})
            # memory203/13 §0.5: DIRECT write of the page the AGENT authored. The
            # daemon (POST /local/memory/write → handleWrite) does store.write +
            # outbox up-sync; the cloud materialize path anchors it to INDEX. NO
            # cloud LLM, NO extraction queue. actorImUserId / actorKind are filled
            # daemon-side from the verified cap.
            body: Dict[str, Any] = {
                "workspaceId": self._workspace_id,
                "path": path,
                "content": content,
                "actorKind": "agent",
            }
            # Bind this direct write to the exact provider session registered by
            # Runtime. The daemon resolves the opaque session server-side and
            # only emits a canonical durability commit key when workspace,
            # actor and active Cloud run all match; a forged/stale id remains a
            # normal local-first write and cannot claim another turn.
            if self._session_id:
                body["providerSessionId"] = self._session_id
                body["durabilityReceiptIndex"] = len(self._pending_explicit_receipts)
            if args.get("title"):
                body["title"] = str(args["title"])
            # memory203/18 R1.1 — structural placement pass-through. The daemon
            # (handleWrite) mirrors the auto-extract leg and emits the page→hub
            # edge as a memory.link.upsert graph event.
            # memory211/01 W5 轴 H — camelCase names EXACTLY as the frozen tool
            # spec declares them (was `parent_hub_path`, a D1-class divergence
            # from the skill's `parentHubPath`).
            if args.get("parentHubPath"):
                body["parentHubPath"] = str(args["parentHubPath"])
                body["relation"] = str(args.get("relation") or "child-of")
            if args.get("visibility"):
                body["visibility"] = str(args["visibility"])
            # memory203/18 R6.4 — section-op pass-through (RPC body is camelCase
            # `op`/`section`; the tool arg names match).
            if args.get("op"):
                body["op"] = str(args["op"])
            if args.get("section"):
                body["section"] = str(args["section"])
            # memory203/18 R6.3 — status-preserving POST: a structured daemon
            # rejection (e.g. 422 `placement_required` with hub candidates, or a
            # section-op 404/503) must reach the MODEL verbatim so it can pick a
            # hub / fall back — _http_post would swallow it into None →
            # "daemon_unreachable", which teaches the agent nothing.
            result = _http_post_with_status("/local/memory/write", body, _WRITE_TIMEOUT)
            status = result.get("status", 0)
            res = result.get("body")
            if status == 0:
                return json.dumps({"ok": False, "error": "daemon_unreachable"})
            if not (200 <= status < 300):
                return json.dumps(
                    res
                    if isinstance(res, dict)
                    else {"ok": False, "error": f"memory_write_failed_{status}"}
                )
            # Direct write → daemon returns `{ page: {...} }`. (A 202 `{ queued }`
            # shape would only come from a legacy daemon still on the retired
            # extract lane — surface it as ok too so an older daemon never breaks.)
            if isinstance(res, dict) and res.get("queued"):
                return json.dumps({"ok": True, "queued": True, "path": path})
            page = res.get("page") if isinstance(res, dict) else None
            page_id = (page or {}).get("id") if isinstance(page, dict) else None
            page_path = (page or {}).get("path") if isinstance(page, dict) else None
            page_version = (page or {}).get("version") if isinstance(page, dict) else None
            content_hash = (page or {}).get("contentHash") if isinstance(page, dict) else None
            authority = res.get("authority") if isinstance(res, dict) else None
            authority_event_id = res.get("outboxEventId") if isinstance(res, dict) else None
            if (
                isinstance(page_id, str) and page_id
                and isinstance(page_path, str) and page_path
                and isinstance(page_version, int) and page_version > 0
                and isinstance(content_hash, str) and content_hash
            ):
                receipt = {
                    "pageId": page_id,
                    "path": page_path,
                    "version": page_version,
                    "contentHash": content_hash,
                }
                if authority in ("cloud", "outbox"):
                    receipt["authority"] = authority
                if isinstance(authority_event_id, str) and authority_event_id:
                    receipt["authorityEventId"] = authority_event_id
                if receipt not in self._pending_explicit_receipts:
                    self._pending_explicit_receipts.append(receipt)
            return json.dumps({
                "ok": True,
                "path": page_path or path,
                "pageId": page_id,
                **({"version": page_version} if isinstance(page_version, int) else {}),
                **({"contentHash": content_hash} if isinstance(content_hash, str) else {}),
            })
        if tool_name == "memory_curate":
            op = str(args.get("op", ""))
            # candidates = the READ half of convergence. It is NOT a write verb, so
            # it routes to the daemon's /local/memory/health (GET), not
            # /local/memory/curate (which only accepts the 3 write verbs). Without
            # this branch the orchestrator has no native way to READ orphans /
            # duplicates / stale and cannot start convergence (the live failure:
            # it replied CURATE_UNAVAILABLE because the only enactment surface it
            # had was write-only).
            if op == "candidates":
                q: Dict[str, str] = {"workspaceId": self._workspace_id}
                if args.get("kind"):
                    q["kind"] = str(args["kind"])
                if args.get("limit") is not None:
                    q["limit"] = str(int(args["limit"]))
                result = _http_get_with_status(
                    f"/local/memory/health?{urllib.parse.urlencode(q)}", _RECALL_TIMEOUT
                )
                status = result.get("status", 0)
                res = result.get("body")
                if status == 0:
                    return json.dumps({"ok": False, "op": op, "error": "daemon_unreachable"})
                if not (200 <= status < 300):
                    return json.dumps(
                        res
                        if isinstance(res, dict)
                        else {"ok": False, "op": op, "error": f"memory_health_failed_{status}"}
                    )
                return json.dumps(res or {"ok": True, "op": op, "candidates": []})
            body: Dict[str, Any] = {"workspaceId": self._workspace_id, "op": op}
            if args.get("pageId"):
                body["pageId"] = str(args["pageId"])
            if args.get("reason"):
                body["reason"] = str(args["reason"])
            # memory203/18 R1.3 — promote_to_hub 挂子 pass-through.
            if isinstance(args.get("childPaths"), list):
                body["childPaths"] = [str(p) for p in args["childPaths"] if p]
            # memory211/01 W5 轴 G — section-level verbs, forwarded verbatim;
            # the daemon shape-checks, the cloud owns authority. Unrolled (not a
            # tuple loop) so the contract test can see each forwarding.
            if args.get("section"):
                body["section"] = str(args["section"])
            if args.get("targetSection"):
                body["targetSection"] = str(args["targetSection"])
            if args.get("sourcePageId"):
                body["sourcePageId"] = str(args["sourcePageId"])
            if args.get("sourceSection"):
                body["sourceSection"] = str(args["sourceSection"])
            if args.get("mergedContent"):
                body["mergedContent"] = str(args["mergedContent"])
            if args.get("supersededByPageId"):
                body["supersededByPageId"] = str(args["supersededByPageId"])
            if args.get("supersededBySection"):
                body["supersededBySection"] = str(args["supersededBySection"])
            if args.get("linkId"):
                body["linkId"] = str(args["linkId"])
            if args.get("toPageId"):
                body["toPageId"] = str(args["toPageId"])
            if args.get("toPath"):
                body["toPath"] = str(args["toPath"])
            if args.get("toSection"):
                body["toSection"] = str(args["toSection"])
            result = _http_post_with_status("/local/memory/curate", body, _CURATE_TIMEOUT)
            status = result.get("status", 0)
            payload = result.get("body")
            if status == 403:
                # Cloud orchestrator_only passthrough — surface cleanly so the
                # agent learns it is not the orchestrator (not a crash).
                return json.dumps(
                    payload
                    or {
                        "ok": False,
                        "op": op,
                        "error": "orchestrator_only",
                        "message": "This curation op is orchestrator-only — you are not the workspace orchestrator.",
                    }
                )
            if status == 0:
                return json.dumps({"ok": False, "op": op, "error": "daemon_unreachable"})
            if not (200 <= status < 300):
                return json.dumps(
                    payload or {"ok": False, "op": op, "error": f"memory_curate_failed_{status}"}
                )
            return json.dumps(payload or {"ok": True, "op": op})
        if tool_name == "workspace_web_search":
            # Workspace web search (NOT a memory op) — forwards to the daemon's
            # /local/web/search, which calls the cloud Load API with the
            # daemon's own credential ([web-tool] logs land daemon-side).
            query = str(args.get("query", "")).strip()
            if not query:
                return json.dumps({"ok": False, "error": "workspace_web_search requires a non-empty query"})
            body: Dict[str, Any] = {"query": query}
            if args.get("limit") is not None:
                body["limit"] = int(args["limit"])
            result = _http_post_with_status("/local/web/search", body, _WEB_TIMEOUT)
            status = result.get("status", 0)
            payload = result.get("body")
            if status == 0:
                return json.dumps({"ok": False, "error": "daemon_unreachable"})
            if not (200 <= status < 300):
                return json.dumps(
                    payload if isinstance(payload, dict) else {"ok": False, "error": f"web_search_failed_{status}"}
                )
            return json.dumps(payload or {"ok": True, "results": []})
        if tool_name == "web_load":
            # Workspace web page load (NOT a memory op) — same daemon lane as
            # web_search. Scheme allowlist http(s) | prismer:// (memory203/20
            # §2.2 / 19 B9: memory pages point at assets/files by prismer://
            # URI; agents load them here instead of re-reading raw sources).
            # Validated shell-side FIRST so a bad input never even hits the
            # daemon (it re-validates anyway).
            raw = args.get("urls") if isinstance(args.get("urls"), list) else None
            urls = [str(u).strip() for u in raw if str(u).strip()] if raw is not None else []
            if not urls and args.get("url"):
                urls = [str(args["url"]).strip()]
            urls = [u for u in urls if u]
            if not urls:
                return json.dumps({"ok": False, "error": "web_load requires `url` or `urls`"})
            _ok_schemes = ("http://", "https://", "prismer://")
            bad = [u for u in urls if not u.lower().startswith(_ok_schemes)]
            if bad:
                return json.dumps({
                    "ok": False,
                    "error": "invalid_url",
                    "message": f"web_load only accepts http(s) or prismer:// URIs (got: {bad[0][:120]})",
                })
            result = _http_post_with_status("/local/web/load", {"urls": urls}, _WEB_TIMEOUT)
            status = result.get("status", 0)
            payload = result.get("body")
            if status == 0:
                return json.dumps({"ok": False, "error": "daemon_unreachable"})
            if not (200 <= status < 300):
                return json.dumps(
                    payload if isinstance(payload, dict) else {"ok": False, "error": f"web_load_failed_{status}"}
                )
            return json.dumps(payload or {"ok": True})
        raise NotImplementedError(f"prismer provider does not handle tool {tool_name}")

    def sync_turn(self, user_content: str, assistant_content: str, *, session_id: str = "") -> None:
        # memory203/14 (2026-07-01) — IN-PROCESS automatic-extraction TRIGGER.
        #
        # Background (why this is no longer a NO-OP): §0.5 retired CLOUD extraction
        # and assumed Hermes's native background_review would do the automatic leg
        # — but that forks with skip_memory=True, so our memory_write tool is never
        # injected and nothing reaches the PKF wiki. The daemon instead owns the
        # extraction (post_llm_call → runBackgroundExtraction: local recall-context
        # → IN-POD gateway-LLM extract → direct write; cloud does ZERO LLM). That
        # was triggered by a config.yaml shell hook, but a long-running gateway
        # never registers a hook added after startup, so it never fired on the
        # sessions dispatch path.
        #
        # sync_turn runs IN-PROCESS and conversation_loop invokes it reliably after
        # every turn — so it is the correct trigger. We fire-and-forget a POST to
        # the daemon's post_llm_call hook intake (same loopback the shell hook
        # targeted); the daemon resolves our agent+workspace identity from the body
        # and runs the in-pod extraction detached (responds 204 immediately, so this
        # never stalls the turn). This is §0.5-compliant: the extraction LLM runs in
        # THIS agent's pod runtime, never the cloud.
        if self._is_readonly() or not self._workspace_id:
            return
        if not (user_content.strip() or assistant_content.strip()):
            return
        agent_im_user_id = (os.environ.get("PRISMER_AGENT_IM_USER_ID") or "").strip()
        if not agent_im_user_id:
            return  # cannot resolve which agent's wiki to extract into
        # memory203/18 R8.1 — chain trace id: session id + a short random suffix.
        # The daemon threads it through extraction into the outbox envelopes and
        # every [memory-trace] stage log, so one grep follows the whole chain.
        trace_id = f"{(session_id or 'turn')}-{uuid.uuid4().hex[:8]}"
        body = {
            "session_id": session_id or "",
            "extra": {
                "user_message": user_content,
                "assistant_response": assistant_content,
                "agent_im_user_id": agent_im_user_id,
                "workspace_id": self._workspace_id,
                "trace_id": trace_id,
            },
        }
        # memory203/20 §2.1 — ADDITIVE field: asset ids attached to this turn.
        # The dispatch composer stamps `<attached_assets><asset id="…"/></…>`
        # into the rendered user message; parse the ids back out so the daemon
        # extraction prompt can reference the REAL prismer://asset/<id> pointer
        # URIs (short description + rel="derived-from" pointer, never a copy).
        asset_ids = _parse_attached_asset_ids(user_content)
        if asset_ids:
            body["extra"]["attached_asset_ids"] = asset_ids
        # Direct memory_write is already durable.  Attach its receipts to the
        # same terminal snapshot so all explicit/pre-reply/async observations
        # converge on one canonical commit key.  Keep them pending across the
        # local retry; clear only after a successful hook acknowledgement.
        explicit_receipts = list(self._pending_explicit_receipts)
        if explicit_receipts:
            body["extra"]["explicit_memory_receipts"] = explicit_receipts
        # memory203/18 R9.1 — at-least-once delivery instead of the old bare
        # `except: pass` black hole (the G1 root fix's observability half): one
        # local retry after ~1s, and the terminal outcome — delivered or FAILED
        # (with the exception class) — always lands as ONE structured stderr
        # line the R8.2 counters/trace can corroborate. Still fire-and-forget
        # semantics: nothing here ever raises into the turn.
        last_exc: Optional[BaseException] = None
        for attempt in range(2):
            try:
                url = _daemon_base() + "/v1/hooks/post_llm_call"
                data = json.dumps(body).encode("utf-8")
                # No profile query param → the daemon resolves context from the
                # body's agent+workspace identity (memory203/14 resolveContext
                # fallback). urllib is used directly (not _http_post) because the
                # generic helper swallows the exception we need to classify.
                req = urllib.request.Request(url, data=data, headers=_headers(), method="POST")
                with urllib.request.urlopen(req, timeout=_WRITE_TIMEOUT):
                    pass
                sys.stderr.write(
                    f"[memory-trace] sync_turn delivered session={session_id} trace={trace_id}\n"
                )
                if explicit_receipts:
                    sent = {
                        (r.get("pageId"), r.get("path"), r.get("version"), r.get("contentHash"))
                        for r in explicit_receipts
                    }
                    self._pending_explicit_receipts = [
                        r for r in self._pending_explicit_receipts
                        if (r.get("pageId"), r.get("path"), r.get("version"), r.get("contentHash")) not in sent
                    ]
                return
            except Exception as exc:  # noqa: BLE001 — classified below, never raised
                last_exc = exc
                if attempt == 0:
                    time.sleep(1.0)
        try:
            sys.stderr.write(
                f"[memory-trace] sync_turn delivery FAILED err={type(last_exc).__name__}: {last_exc}\n"
            )
        except Exception:  # noqa: BLE001 — even the log line must never raise
            pass
        return

    def on_pre_compress(self, messages: List[Dict[str, Any]]) -> str:
        # memory203/13 §0.5 — NO-OP. The 压缩前抢救 rescue used to forward the
        # soon-to-be-summarized turns to the daemon extract route (→ cloud LLM).
        # Cloud extraction is retired; in-runtime auto-extraction (Hermes
        # background_review → memory_write) is the replacement, so we no longer
        # forward to the cloud. Returns "" (never contributed to the summary).
        return ""

    def on_memory_write(
        self,
        action: str,
        target: str,
        content: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        # 内置 MEMORY.md收编 (doc 18 §4b#3): mirror the agent's built-in memory
        # edits into the substrate (agent-private files). Direction is one-way
        # (Hermes → substrate); the reverse only writes the managed section.
        if self._is_readonly() or not self._workspace_id:
            return
        _http_post(
            "/local/memory/mirror",
            {
                "workspaceId": self._workspace_id,
                "action": action,
                "target": target,
                "content": content,
                "metadata": metadata or {},
            },
            _WRITE_TIMEOUT,
        )

    def get_config_schema(self) -> List[Dict[str, Any]]:
        # Daemon writes everything via ensureService → all env-var, user-invisible.
        return [
            {"key": "daemon_port", "description": "Prismer daemon loopback port",
             "secret": False, "required": False, "default": _DEFAULT_PORT,
             "env_var": "PRISMER_DAEMON_PORT"},  # default 7878 (doc 10 §3)
            {"key": "daemon_token", "description": "Prismer daemon local bearer token",
             "secret": True, "required": False, "env_var": "PRISMER_DAEMON_TOKEN"},
            {"key": "workspace_id", "description": "Bound workspace id",
             "secret": False, "required": True, "env_var": "PRISMER_WORKSPACE_ID"},
        ]

    def shutdown(self) -> None:
        logger.info("prismer memory provider shutdown")

    def _is_readonly(self) -> bool:
        return self._agent_context not in ("primary", "")
