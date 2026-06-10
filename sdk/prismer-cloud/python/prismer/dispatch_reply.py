"""Wave 5 F2 — Python SDK dispatch reply two-phase transport.

Mirror of `sdk/prismer-cloud/runtime/src/daemon/dispatch-reply-transport.ts` +
`pending-reply-cache.ts` (Wave 4 E7) for the Python SDK.

The legacy single-shot POST /api/im/dispatch/reply call has been split by the
W3 Wave 3.5 server work into:

  1. POST /api/im/dispatch/:taskId/prepare — idempotent on (taskId,
     idempotencyKey). Server writes an im_dispatch_replies row status='prepared'
     and returns ``{ replyId, status, existed }``.
  2. POST /api/im/dispatch/:taskId/commit — idempotent on replyId. Server flips
     status='committed' and writes the chat message + task transition in a
     single transaction.

Between PREPARE and COMMIT the *daemon* owns the replyId and is the only
party who knows the row exists. A crash here leaves the server with a
'prepared' row that never commits — the server-side reaper sweeps these at >1h,
but the daemon should retry commit on cold-start to avoid the reaper aborting
a reply we actually completed.

This module ships:

* :class:`PendingReplyCache` — SQLite-backed persistence over
  ``~/.prismer/cache/dispatch_replies.db`` (override via constructor).
* :func:`send_dispatch_reply_two_phase` — execute the prepare→commit protocol
  end-to-end against ``PrismerClient`` (or any object that exposes a
  ``_request`` method matching the SDK convention).
* :func:`recover_pending_replies` — cold-start drain hook. Replays
  ``pending``/``prepared`` rows.
* :func:`send_dispatch_reply_legacy` — backwards-compat wrapper that hits the
  deprecated ``POST /api/im/dispatch/reply``. Keeps existing callers working
  through the RFC 8594 ``Sunset: 2026-09-01`` window.

Server contract: see ``evidence/14-w3-dispatch-two-phase.md`` for the full
endpoint shape and the orphan reaper window. Wave 4 E7 hand-off explicitly
asked for this Python mirror (§7 row 1).
"""

from __future__ import annotations

import json
import os
import pathlib
import sqlite3
import sys
import time
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Literal, Optional

# ---------------------------------------------------------------------------
# Public surface
# ---------------------------------------------------------------------------

__all__ = [
    "PendingReplyCache",
    "PendingReplyRow",
    "DispatchReplyAbortedError",
    "DispatchReplyPrepareError",
    "DispatchReplyCommitError",
    "send_dispatch_reply_two_phase",
    "recover_pending_replies",
    "send_dispatch_reply_legacy",
    "generate_idempotency_key",
    "DEFAULT_CACHE_DB_PATH",
]

DEFAULT_CACHE_DB_PATH = pathlib.Path.home() / ".prismer" / "cache" / "dispatch_replies.db"

PendingReplyStatus = Literal["pending", "prepared"]
DispatchReplyStatus = Literal["ok", "agent_offline", "timeout", "agent_error"]


# ---------------------------------------------------------------------------
# Errors — mirror of TS DispatchReplyAbortedError / *Error
# ---------------------------------------------------------------------------


class DispatchReplyAbortedError(RuntimeError):
    """Server-side reaper killed the prepared row (>1h since prepare).

    The daemon should drop the local cache entry and surface "dispatch lost"
    to the caller.
    """

    code = "DISPATCH_REPLY_INVALID_STATE"

    def __init__(self, reply_id: str, current_status: Optional[str] = None) -> None:
        super().__init__(
            f"dispatch reply {reply_id} aborted by server (status={current_status or 'unknown'})"
        )
        self.reply_id = reply_id
        self.current_status = current_status


class DispatchReplyPrepareError(RuntimeError):
    """Phase-1 prepare failed (non-recoverable in this attempt)."""

    def __init__(self, code: str, message: str, details: Any = None) -> None:
        super().__init__(f"dispatch prepare failed: {code}: {message}")
        self.code = code
        self.code_message = message
        self.details = details


class DispatchReplyCommitError(RuntimeError):
    """Phase-2 commit failed (non-aborted; transport/timeout/etc.)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"dispatch commit failed: {code}: {message}")
        self.code = code
        self.code_message = message


# ---------------------------------------------------------------------------
# Pending reply cache (SQLite)
# ---------------------------------------------------------------------------


@dataclass
class PendingReplyRow:
    """In-memory representation of a row in ``pending_dispatch_replies``."""

    idempotency_key: str
    task_id: str
    reply_id: Optional[str]
    status: PendingReplyStatus
    payload_json: str
    created_at: int
    prepared_at: Optional[int]
    last_attempt_at: Optional[int]
    attempt_count: int
    last_error: Optional[str]


_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS pending_dispatch_replies (
  idempotency_key TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL,
  reply_id        TEXT,
  status          TEXT NOT NULL CHECK (status IN ('pending','prepared')),
  payload_json    TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  prepared_at     INTEGER,
  last_attempt_at INTEGER,
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT
);
CREATE INDEX IF NOT EXISTS idx_pending_replies_status
  ON pending_dispatch_replies(status, created_at);
"""


class PendingReplyCache:
    """SQLite-backed pending reply persistence.

    Lifecycle (mirrors TS):

    * :meth:`save_pending` — BEFORE the prepare HTTP call.
    * :meth:`mark_prepared` — AFTER prepare 200.
    * :meth:`clear_pending` — AFTER commit 200 (or aborted).
    * :meth:`list_for_recovery` — cold-start drain.
    * :meth:`mark_attempt` — observability for failed prepares/commits.

    The class is **process-local**; opening the same db_path from multiple
    processes is supported (SQLite WAL is enabled by default in Python 3.7+
    via ``isolation_level=None`` + ``journal_mode=WAL`` pragma).
    """

    def __init__(self, db_path: Optional[str | os.PathLike] = None) -> None:
        path = pathlib.Path(db_path) if db_path is not None else DEFAULT_CACHE_DB_PATH
        path.parent.mkdir(parents=True, exist_ok=True)
        # ``check_same_thread=False`` lets test code call the cache from worker
        # threads. We serialise externally where it matters.
        self._conn = sqlite3.connect(str(path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        # WAL keeps a long-lived reader (the daemon) from blocking writers.
        try:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA synchronous=NORMAL")
        except sqlite3.OperationalError:
            pass
        self._conn.executescript(_SCHEMA_SQL)
        self._conn.commit()
        self._db_path = str(path)

    @property
    def db_path(self) -> str:
        return self._db_path

    def close(self) -> None:
        try:
            self._conn.close()
        except sqlite3.Error:
            pass

    def __enter__(self) -> "PendingReplyCache":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    # ── writes ────────────────────────────────────────────────────────────

    def save_pending(
        self,
        idempotency_key: str,
        task_id: str,
        payload_json: str,
        now_ms: Optional[int] = None,
    ) -> None:
        """Insert (or overwrite) a pending row. Idempotent on idempotency_key."""
        ts = now_ms if now_ms is not None else int(time.time() * 1000)
        self._conn.execute(
            """
            INSERT OR REPLACE INTO pending_dispatch_replies
              (idempotency_key, task_id, reply_id, status, payload_json,
               created_at, prepared_at, last_attempt_at, attempt_count, last_error)
            VALUES (?, ?, NULL, 'pending', ?, ?, NULL, NULL, 0, NULL)
            """,
            (idempotency_key, task_id, payload_json, ts),
        )
        self._conn.commit()

    def mark_prepared(
        self, idempotency_key: str, reply_id: str, now_ms: Optional[int] = None
    ) -> None:
        ts = now_ms if now_ms is not None else int(time.time() * 1000)
        self._conn.execute(
            """
            UPDATE pending_dispatch_replies
               SET reply_id = ?, status = 'prepared', prepared_at = ?,
                   last_attempt_at = ?, attempt_count = attempt_count + 1,
                   last_error = NULL
             WHERE idempotency_key = ?
            """,
            (reply_id, ts, ts, idempotency_key),
        )
        self._conn.commit()

    def mark_attempt(
        self,
        idempotency_key: str,
        error: Optional[str] = None,
        now_ms: Optional[int] = None,
    ) -> None:
        ts = now_ms if now_ms is not None else int(time.time() * 1000)
        self._conn.execute(
            """
            UPDATE pending_dispatch_replies
               SET last_attempt_at = ?, attempt_count = attempt_count + 1,
                   last_error = ?
             WHERE idempotency_key = ?
            """,
            (ts, error, idempotency_key),
        )
        self._conn.commit()

    def clear_pending(self, idempotency_key: str) -> None:
        self._conn.execute(
            "DELETE FROM pending_dispatch_replies WHERE idempotency_key = ?",
            (idempotency_key,),
        )
        self._conn.commit()

    # ── reads ─────────────────────────────────────────────────────────────

    def find_by_idempotency_key(self, idempotency_key: str) -> Optional[PendingReplyRow]:
        cur = self._conn.execute(
            "SELECT * FROM pending_dispatch_replies WHERE idempotency_key = ?",
            (idempotency_key,),
        )
        row = cur.fetchone()
        return _row_from_sqlite(row) if row is not None else None

    def list_for_recovery(self) -> List[PendingReplyRow]:
        cur = self._conn.execute(
            """
            SELECT * FROM pending_dispatch_replies
             WHERE status IN ('pending','prepared')
             ORDER BY created_at ASC
            """
        )
        return [_row_from_sqlite(r) for r in cur.fetchall()]

    def count_by_status(self) -> Dict[str, int]:
        cur = self._conn.execute(
            """
            SELECT status, COUNT(*) as cnt FROM pending_dispatch_replies
             WHERE status IN ('pending','prepared') GROUP BY status
            """
        )
        out = {"pending": 0, "prepared": 0}
        for row in cur.fetchall():
            out[row["status"]] = int(row["cnt"])
        return out


def _row_from_sqlite(row: sqlite3.Row) -> PendingReplyRow:
    return PendingReplyRow(
        idempotency_key=row["idempotency_key"],
        task_id=row["task_id"],
        reply_id=row["reply_id"],
        status=row["status"],
        payload_json=row["payload_json"],
        created_at=int(row["created_at"]),
        prepared_at=int(row["prepared_at"]) if row["prepared_at"] is not None else None,
        last_attempt_at=int(row["last_attempt_at"]) if row["last_attempt_at"] is not None else None,
        attempt_count=int(row["attempt_count"]),
        last_error=row["last_error"],
    )


# ---------------------------------------------------------------------------
# Idempotency key (RFC 4122 v4) — mirror of TS generateIdempotencyKey
# ---------------------------------------------------------------------------


def generate_idempotency_key() -> str:
    """Return a UUID v4 string. Used as the server-side idempotency key."""
    return str(uuid.uuid4())


# ---------------------------------------------------------------------------
# Two-phase send
# ---------------------------------------------------------------------------


# Client protocol: caller passes any object with a ``_request`` method whose
# signature matches ``PrismerClient._request``. The SDK already exposes that
# method publicly on the IM sub-clients, so we don't need to depend on the
# concrete PrismerClient class here.
RequestCallable = Callable[..., Any]


def _default_log(line: str) -> None:
    sys.stderr.write(line + "\n")


def _resolve_request_fn(client: Any) -> RequestCallable:
    """Accept either a callable, a ``PrismerClient``-like, or a sub-client.

    The W3 ``/api/im/dispatch/...`` path is daemon-only, so the caller must
    supply a JWT-bearing or api-key-bearing client. We extract the raw
    ``_request`` method without making any assumption about which sub-client
    holds it (PrismerClient itself has it, as do all sub-clients via the
    ``request_fn`` constructor parameter).
    """
    if callable(client) and not hasattr(client, "_request"):
        return client  # caller passed the raw request fn
    if hasattr(client, "_request"):
        return getattr(client, "_request")
    raise TypeError(
        "send_dispatch_reply_two_phase requires a PrismerClient (or any "
        "object exposing `_request`) or a raw request callable"
    )


def _unwrap_envelope(data: Any) -> Dict[str, Any]:
    """The SDK's _request returns the parsed JSON envelope. The W3 endpoints
    consistently respond with ``{"ok": bool, "data": {...}, "error": {...}}``,
    but defensive code handles flat responses too.
    """
    if not isinstance(data, dict):
        return {}
    if isinstance(data.get("data"), dict):
        return data["data"]
    return data


def _envelope_error(data: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(data, dict):
        return None
    err = data.get("error")
    if isinstance(err, dict):
        return err
    if isinstance(err, str):
        return {"code": "ERROR", "message": err}
    return None


def send_dispatch_reply_two_phase(
    client: Any,
    *,
    task_id: str,
    conversation_id: str,
    reply_token: str,
    reply_to_message_id: str,
    agent_im_user_id: str,
    status: DispatchReplyStatus = "ok",
    reply_text: Optional[str] = None,
    asset_ids: Optional[List[str]] = None,
    attachments: Optional[List[Dict[str, Any]]] = None,
    message_content: Optional[Dict[str, Any]] = None,
    metrics: Optional[Dict[str, Any]] = None,
    error: Optional[Dict[str, str]] = None,
    completed_at: Optional[str] = None,
    cache: Optional[PendingReplyCache] = None,
    idempotency_key: Optional[str] = None,
    log: Optional[Callable[[str], None]] = None,
) -> Dict[str, Any]:
    """Run the W3 prepare→commit protocol against ``client``.

    On success returns::

        {
            "taskId": task_id,
            "replyId": "...",
            "status": "committed" | "aborted",
            "alreadyCommitted": bool,
            "messageId": str | None,
            "idempotencyKey": "...",
        }

    On failure raises one of :class:`DispatchReplyPrepareError`,
    :class:`DispatchReplyCommitError`, or :class:`DispatchReplyAbortedError`.

    ``cache`` is optional but strongly recommended — without it a crash between
    prepare and commit cannot be recovered. The caller is responsible for
    closing the cache.
    """
    request = _resolve_request_fn(client)
    log_fn = log or _default_log
    idem = idempotency_key or generate_idempotency_key()
    asset_ids = asset_ids or []
    completed = completed_at or _utc_now_iso()

    payload = {
        "conversationId": conversation_id,
        "replyToken": reply_token,
        "replyToMessageId": reply_to_message_id,
        "agentImUserId": agent_im_user_id,
        "status": status,
        "assetIds": asset_ids,
        "completedAt": completed,
    }
    if reply_text is not None:
        payload["replyText"] = reply_text
    if attachments is not None:
        payload["attachments"] = attachments
    if message_content is not None:
        payload["messageContent"] = message_content
    if metrics is not None:
        payload["metrics"] = metrics
    if error is not None:
        payload["error"] = error

    cache_payload_json = json.dumps(
        {**payload, "_taskId": task_id, "_idempotencyKey": idem},
        separators=(",", ":"),
        sort_keys=False,
    )

    # Persist BEFORE the network call so a process crash here is recoverable.
    if cache is not None:
        cache.save_pending(idem, task_id, cache_payload_json)

    # ── 1. PREPARE ──────────────────────────────────────────────────────
    prep_path = f"/api/im/dispatch/{task_id}/prepare"
    prep_body = {**payload, "idempotencyKey": idem}
    prep_resp = request("POST", prep_path, json=prep_body)
    if not _envelope_ok(prep_resp):
        err = _envelope_error(prep_resp) or {"code": "PREPARE_FAILED", "message": "prepare returned ok=false"}
        if cache is not None:
            cache.mark_attempt(idem, error=f"prepare: {err.get('code')}: {err.get('message')}")
        raise DispatchReplyPrepareError(
            err.get("code") or "PREPARE_FAILED",
            err.get("message") or "prepare failed",
            err.get("details"),
        )

    inner = _unwrap_envelope(prep_resp)
    reply_id = inner.get("replyId") if isinstance(inner, dict) else None
    prepare_status = inner.get("status") if isinstance(inner, dict) else None
    if not isinstance(reply_id, str) or not reply_id:
        if cache is not None:
            cache.mark_attempt(idem, error="prepare: missing replyId")
        raise DispatchReplyPrepareError("PREPARE_FAILED", "prepare returned no replyId")

    if cache is not None:
        cache.mark_prepared(idem, reply_id)
    log_fn(
        f"[prismer.dispatch_reply] prepare task={task_id} replyId={reply_id} "
        f"status={prepare_status} idem={idem}"
    )

    # Server already committed this row on a previous attempt (idempotent
    # re-prepare). Nothing left to do.
    if prepare_status == "committed":
        if cache is not None:
            cache.clear_pending(idem)
        return {
            "taskId": task_id,
            "replyId": reply_id,
            "status": "committed",
            "alreadyCommitted": True,
            "messageId": None,
            "idempotencyKey": idem,
        }

    # ── 2. COMMIT ───────────────────────────────────────────────────────
    try:
        commit = _commit_dispatch_reply(request, task_id, reply_id, log=log_fn)
    except DispatchReplyAbortedError:
        if cache is not None:
            cache.clear_pending(idem)
        log_fn(
            f"[prismer.dispatch_reply] commit aborted task={task_id} "
            f"replyId={reply_id} — dispatch lost"
        )
        return {
            "taskId": task_id,
            "replyId": reply_id,
            "status": "aborted",
            "alreadyCommitted": False,
            "messageId": None,
            "idempotencyKey": idem,
        }
    except DispatchReplyCommitError as e:
        if cache is not None:
            cache.mark_attempt(idem, error=f"commit: {e.code}: {e.code_message}")
        raise

    if cache is not None:
        cache.clear_pending(idem)
    return {
        "taskId": task_id,
        "replyId": reply_id,
        "status": "committed",
        "alreadyCommitted": bool(commit.get("alreadyCommitted")),
        "messageId": commit.get("messageId"),
        "idempotencyKey": idem,
    }


def _commit_dispatch_reply(
    request: RequestCallable,
    task_id: str,
    reply_id: str,
    *,
    log: Callable[[str], None],
) -> Dict[str, Any]:
    path = f"/api/im/dispatch/{task_id}/commit"
    resp = request("POST", path, json={"replyId": reply_id})
    if not _envelope_ok(resp):
        err = _envelope_error(resp) or {"code": "COMMIT_FAILED", "message": "commit returned ok=false"}
        code = err.get("code") or "COMMIT_FAILED"
        if code == "DISPATCH_REPLY_INVALID_STATE":
            current_status = None
            details = err.get("details")
            if isinstance(details, dict):
                current_status = details.get("currentStatus")
            raise DispatchReplyAbortedError(reply_id, current_status)
        raise DispatchReplyCommitError(code, err.get("message") or "commit failed")
    inner = _unwrap_envelope(resp)
    log(
        f"[prismer.dispatch_reply] commit task={task_id} replyId={reply_id} "
        f"alreadyCommitted={inner.get('alreadyCommitted', False)}"
    )
    return inner


def _envelope_ok(resp: Any) -> bool:
    if not isinstance(resp, dict):
        return False
    # SDK envelope reads {"success": True/False} for context APIs and
    # {"ok": True/False} for IM APIs. Be permissive.
    if "ok" in resp:
        return bool(resp.get("ok"))
    if "success" in resp:
        return bool(resp.get("success"))
    # Some endpoints return raw data on 200. Treat presence of replyId or
    # alreadyCommitted as success.
    if "replyId" in resp or "alreadyCommitted" in resp:
        return True
    return False


def _utc_now_iso() -> str:
    """ISO 8601 timestamp the server accepts ("2026-05-21T13:14:15.000Z")."""
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


# ---------------------------------------------------------------------------
# Crash recovery
# ---------------------------------------------------------------------------


def recover_pending_replies(
    client: Any,
    cache: PendingReplyCache,
    *,
    log: Optional[Callable[[str], None]] = None,
) -> Dict[str, int]:
    """Daemon cold-start hook — replay any rows still in cache.

    Returns a summary ``{attempted, committed, aborted, failed}``.
    """
    request = _resolve_request_fn(client)
    log_fn = log or _default_log
    rows = cache.list_for_recovery()
    summary = {"attempted": len(rows), "committed": 0, "aborted": 0, "failed": 0}
    if not rows:
        return summary
    log_fn(f"[prismer.dispatch_reply] recovery: {len(rows)} pending row(s) to replay")

    for row in rows:
        try:
            result = _replay_row(request, cache, row, log_fn)
            if result == "committed":
                summary["committed"] += 1
            elif result == "aborted":
                summary["aborted"] += 1
        except Exception as e:  # noqa: BLE001 - want to log unknowns
            summary["failed"] += 1
            log_fn(
                f"[prismer.dispatch_reply] recovery FAIL idem={row.idempotency_key} "
                f"task={row.task_id}: {e}"
            )

    log_fn(
        f"[prismer.dispatch_reply] recovery done attempted={summary['attempted']} "
        f"committed={summary['committed']} aborted={summary['aborted']} "
        f"failed={summary['failed']}"
    )
    return summary


def _replay_row(
    request: RequestCallable,
    cache: PendingReplyCache,
    row: PendingReplyRow,
    log: Callable[[str], None],
) -> str:
    if row.status == "prepared" and row.reply_id:
        # Server already wrote the prepared row; just commit.
        try:
            _commit_dispatch_reply(request, row.task_id, row.reply_id, log=log)
            cache.clear_pending(row.idempotency_key)
            return "committed"
        except DispatchReplyAbortedError:
            cache.clear_pending(row.idempotency_key)
            return "aborted"

    # status='pending' — reconstruct payload and re-run the full two-phase
    # flow with the persisted idempotency key (server is idempotent on
    # (taskId, idempotencyKey) per W3).
    try:
        parsed = json.loads(row.payload_json)
    except json.JSONDecodeError as e:
        cache.clear_pending(row.idempotency_key)
        raise RuntimeError(
            f"pending row {row.idempotency_key} payload unparseable: {e}"
        ) from e

    # Drop the internal cache markers before re-sending.
    parsed.pop("_taskId", None)
    parsed.pop("_idempotencyKey", None)
    result = send_dispatch_reply_two_phase(
        request,
        task_id=row.task_id,
        conversation_id=parsed.get("conversationId", ""),
        reply_token=parsed.get("replyToken", ""),
        reply_to_message_id=parsed.get("replyToMessageId", ""),
        agent_im_user_id=parsed.get("agentImUserId", ""),
        status=parsed.get("status", "ok"),
        reply_text=parsed.get("replyText"),
        asset_ids=parsed.get("assetIds"),
        attachments=parsed.get("attachments"),
        message_content=parsed.get("messageContent"),
        metrics=parsed.get("metrics"),
        error=parsed.get("error"),
        completed_at=parsed.get("completedAt"),
        cache=cache,
        idempotency_key=row.idempotency_key,
        log=log,
    )
    return str(result.get("status", ""))


# ---------------------------------------------------------------------------
# Legacy single-shot (compat) — for callers that haven't migrated yet
# ---------------------------------------------------------------------------


def send_dispatch_reply_legacy(
    client: Any,
    *,
    conversation_id: str,
    reply_token: str,
    reply_to_message_id: str,
    agent_im_user_id: str,
    status: DispatchReplyStatus = "ok",
    reply_text: Optional[str] = None,
    attachments: Optional[List[Dict[str, Any]]] = None,
    error: Optional[Dict[str, str]] = None,
    completed_at: Optional[str] = None,
) -> Dict[str, Any]:
    """Deprecated — kept compatible with the legacy ``POST /api/im/dispatch/reply``.

    The server returns ``Deprecation: true`` + ``Sunset: 2026-09-01`` headers
    on every response. New code should use :func:`send_dispatch_reply_two_phase`.

    .. deprecated:: 2.0.5
       Use :func:`send_dispatch_reply_two_phase` instead. The legacy endpoint
       is scheduled for removal on 2026-09-01 per the server-side Sunset
       header.
    """
    import warnings

    warnings.warn(
        "send_dispatch_reply_legacy is deprecated — migrate to "
        "send_dispatch_reply_two_phase before 2026-09-01 (server-side Sunset).",
        DeprecationWarning,
        stacklevel=2,
    )
    request = _resolve_request_fn(client)
    payload = {
        "conversationId": conversation_id,
        "replyToken": reply_token,
        "replyToMessageId": reply_to_message_id,
        "agentImUserId": agent_im_user_id,
        "status": status,
        "completedAt": completed_at or _utc_now_iso(),
    }
    if reply_text is not None:
        payload["replyText"] = reply_text
    if attachments is not None:
        payload["attachments"] = attachments
    if error is not None:
        payload["error"] = error
    return request("POST", "/api/im/dispatch/reply", json=payload)
