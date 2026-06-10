"""Wave 5 F2 — Real-docker integration tests for the two-phase dispatch reply
transport in the Python SDK.

NO mocking of the W3 server. NO mocking of MySQL. The test:

1. Connects directly to the local docker MySQL (port 3307) and creates fixture
   rows: an IMUser (workspace owner), an IMUser (agent), an IMWorkspace, an
   IMConversation, two IMParticipants, and an IMAsset with ingestStatus='ready'.
2. Mints an ``adr1`` reply-token signed with the same dev JWT_SECRET the
   running cloud uses (``.env.local`` -> ``local-dev-secret-do-not-use-in-prod``).
3. Mints a workspace-owner JWT and uses the SDK's PrismerClient
   ``_request`` to hit ``http://localhost:3000/api/im/dispatch/...``.
4. Exercises:
   - normal prepare → commit happy path
   - asset-not-ready 400
   - prepare idempotency (re-send same idempotencyKey returns existing row)
   - commit idempotency (re-send same replyId returns alreadyCommitted)
   - simulated crash → cold-start recovery
   - legacy ``POST /dispatch/reply`` backwards-compatibility
5. Verifies the persisted DB state via direct MySQL.

These tests require:

* docker MySQL running on localhost:3307 (``prismer/devpass``)
* the Next.js / IM cloud running on http://localhost:3000
* ``pymysql`` installed in the test venv

Skip cleanly if any of those is unreachable so the suite doesn't fail on a
clean CI machine that hasn't booted the dev stack.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import tempfile
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterator, Optional

import pytest

# Skip the entire module if the dev stack isn't reachable.
pymysql = pytest.importorskip("pymysql")
import httpx  # noqa: E402 — after the importorskip
from prismer import PrismerClient  # noqa: E402
from prismer.dispatch_reply import (  # noqa: E402
    DEFAULT_CACHE_DB_PATH,
    DispatchReplyAbortedError,
    DispatchReplyPrepareError,
    PendingReplyCache,
    generate_idempotency_key,
    recover_pending_replies,
    send_dispatch_reply_legacy,
    send_dispatch_reply_two_phase,
)


# Make sure localhost traffic doesn't get routed through a system HTTP proxy
# (e.g. ClashX on a developer machine). httpx honours $HTTPS_PROXY/$HTTP_PROXY
# via ``trust_env=True``, and macOS' network preferences propagate to the
# shell on login. Force localhost direct.
_existing_no_proxy = os.environ.get("NO_PROXY", "")
_no_proxy_set = {"localhost", "127.0.0.1", "::1"} | {
    h.strip() for h in _existing_no_proxy.split(",") if h.strip()
}
os.environ["NO_PROXY"] = ",".join(sorted(_no_proxy_set))
os.environ["no_proxy"] = os.environ["NO_PROXY"]

CLOUD_BASE = os.environ.get("F2_CLOUD_BASE", "http://localhost:3000")
MYSQL_HOST = os.environ.get("F2_MYSQL_HOST", "127.0.0.1")
MYSQL_PORT = int(os.environ.get("F2_MYSQL_PORT", "3307"))
MYSQL_USER = os.environ.get("F2_MYSQL_USER", "prismer")
MYSQL_PASSWORD = os.environ.get("F2_MYSQL_PASSWORD", "devpass")
MYSQL_DB = os.environ.get("F2_MYSQL_DB", "prismer_cloud")
JWT_SECRET = os.environ.get("F2_JWT_SECRET", "local-dev-secret-do-not-use-in-prod")

RUN_PREFIX = f"f2_{secrets.token_hex(4)}"


# ---------------------------------------------------------------------------
# Liveness checks — skip the whole module if the docker stack isn't up.
# ---------------------------------------------------------------------------


def _stack_up() -> bool:
    try:
        with httpx.Client(timeout=2.0) as c:
            # Hit any IM endpoint; we only need the cloud to be reachable.
            # 401 (no auth) and 200 both prove the cloud is up.
            r = c.post(
                f"{CLOUD_BASE}/api/im/dispatch/_probe/prepare",
                json={"idempotencyKey": "_probe"},
            )
            if r.status_code not in (200, 400, 401, 403, 404, 422):
                return False
    except Exception:
        return False
    try:
        conn = pymysql.connect(
            host=MYSQL_HOST,
            port=MYSQL_PORT,
            user=MYSQL_USER,
            password=MYSQL_PASSWORD,
            database=MYSQL_DB,
            connect_timeout=3,
        )
        conn.close()
        return True
    except Exception:
        return False


if not _stack_up():
    pytest.skip(
        "Wave 5 F2 dispatch reply integration requires local docker stack "
        f"(MySQL @ {MYSQL_HOST}:{MYSQL_PORT}, cloud @ {CLOUD_BASE}). "
        "Start with ./scripts/dev-stack.sh.",
        allow_module_level=True,
    )


# ---------------------------------------------------------------------------
# Helpers — JWT + adr1 reply-token, MySQL fixtures
# ---------------------------------------------------------------------------


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_json(obj: Any) -> str:
    return _b64url_encode(json.dumps(obj, separators=(",", ":")).encode("utf-8"))


def _mint_jwt(*, sub: str, username: str, role: str = "human") -> str:
    """Mint an HS256 JWT using the dev JWT_SECRET. Matches the shape the cloud
    issues at ``/api/im/register`` (sub + username + role + iat + exp)."""
    header = _b64url_json({"alg": "HS256", "typ": "JWT"})
    now = int(time.time())
    payload = _b64url_json(
        {
            "sub": sub,
            "username": username,
            "role": role,
            "numericId": 1,
            "email": f"{username}@test.local",
            "iat": now,
            "exp": now + 3600,
        }
    )
    signing_input = f"{header}.{payload}".encode("ascii")
    sig = hmac.new(JWT_SECRET.encode("utf-8"), signing_input, hashlib.sha256).digest()
    return f"{header}.{payload}.{_b64url_encode(sig)}"


def _mint_adr1_reply_token(
    *, channel_account_id: str, conversation_id: str, message_id: str, agent_im_user_id: str
) -> str:
    """Mint an ``adr1.<claims>.<sig>`` reply-token using the same dev secret
    the server's ``signReplyToken`` reads from JWT_SECRET (see
    ``src/im/services/agent-dispatcher.ts``)."""
    claims = {
        "c": channel_account_id,
        "v": conversation_id,
        "m": message_id,
        "a": agent_im_user_id,
        "exp": int(time.time() * 1000) + 60 * 60 * 1000,  # 1h
        "n": secrets.token_hex(8),
    }
    encoded = _b64url_json(claims)
    sig = hmac.new(JWT_SECRET.encode("utf-8"), encoded.encode("ascii"), hashlib.sha256).digest()
    return f"adr1.{encoded}.{_b64url_encode(sig)}"


@pytest.fixture(scope="module")
def mysql_conn() -> Iterator[Any]:
    conn = pymysql.connect(
        host=MYSQL_HOST,
        port=MYSQL_PORT,
        user=MYSQL_USER,
        password=MYSQL_PASSWORD,
        database=MYSQL_DB,
        autocommit=True,
        cursorclass=pymysql.cursors.DictCursor,
    )
    yield conn
    conn.close()


def _short(prefix: str, suffix: str) -> str:
    return f"{prefix}{suffix}"[:28]


def _make_fixtures(conn: Any, suffix: str) -> Dict[str, str]:
    ws_id = _short("w", f"{RUN_PREFIX}{suffix}")
    owner_id = _short("uo", f"{RUN_PREFIX}{suffix}")
    agent_id = _short("ua", f"{RUN_PREFIX}{suffix}")
    conv_id = _short("c", f"{RUN_PREFIX}{suffix}")
    msg_id = _short("m", f"{RUN_PREFIX}{suffix}")
    task_id = _short("t", f"{RUN_PREFIX}{suffix}")
    asset_id = _short("a", f"{RUN_PREFIX}{suffix}")
    part_owner = _short("po", f"{RUN_PREFIX}{suffix}")
    part_agent = _short("pa", f"{RUN_PREFIX}{suffix}")

    content_hash = secrets.token_hex(32)
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO im_users (id, username, displayName, role, metadata, "
            "numericId) VALUES (%s,%s,%s,'human','{}', NULL)",
            (owner_id, owner_id, f"owner {suffix}"),
        )
        cur.execute(
            "INSERT INTO im_users (id, username, displayName, role, metadata, "
            "numericId) VALUES (%s,%s,%s,'agent','{}', NULL)",
            (agent_id, agent_id, f"agent {suffix}"),
        )
        cur.execute(
            "INSERT INTO im_workspaces (id, ownerImUserId, name, slug, isDefault, "
            "metadata) VALUES (%s,%s,%s,%s,0,'{}')",
            (ws_id, owner_id, f"ws {suffix}", ws_id),
        )
        cur.execute(
            "INSERT INTO im_assets (id, workspaceId, ownerImUserId, contentHash, "
            "storageUri, sizeBytes, mime, kind, metadata, ingestStatus, "
            "ingestVersion, assetIndexSeq, revision, visibility, filename) "
            "VALUES (%s,%s,%s,%s,%s,42,'text/plain','file','{}','ready',1,0,1,'workspace',%s)",
            (asset_id, ws_id, owner_id, content_hash, f"s3://test/{asset_id}", f"{suffix}.txt"),
        )
        cur.execute(
            "INSERT INTO im_conversations (id, type, status, createdById, workspaceId) "
            "VALUES (%s,'direct','active',%s,%s)",
            (conv_id, owner_id, ws_id),
        )
        cur.execute(
            "INSERT INTO im_participants (id, conversationId, imUserId, role) "
            "VALUES (%s,%s,%s,'owner')",
            (part_owner, conv_id, owner_id),
        )
        cur.execute(
            "INSERT INTO im_participants (id, conversationId, imUserId, role) "
            "VALUES (%s,%s,%s,'member')",
            (part_agent, conv_id, agent_id),
        )

    return {
        "workspace_id": ws_id,
        "owner_im_user_id": owner_id,
        "agent_im_user_id": agent_id,
        "conversation_id": conv_id,
        "message_id": msg_id,
        "task_id": task_id,
        "ready_asset_id": asset_id,
        "part_owner_id": part_owner,
        "part_agent_id": part_agent,
    }


def _cleanup_fixtures(conn: Any, f: Dict[str, str]) -> None:
    """Best-effort cascading delete; per-run prefix isolates collisions."""
    with conn.cursor() as cur:
        for sql, args in [
            ("DELETE FROM im_dispatch_replies WHERE taskId=%s", (f["task_id"],)),
            ("DELETE FROM im_messages WHERE conversationId=%s", (f["conversation_id"],)),
            ("DELETE FROM im_participants WHERE conversationId=%s", (f["conversation_id"],)),
            ("DELETE FROM im_conversations WHERE id=%s", (f["conversation_id"],)),
            ("DELETE FROM im_assets WHERE id=%s", (f["ready_asset_id"],)),
            ("DELETE FROM im_workspaces WHERE id=%s", (f["workspace_id"],)),
            ("DELETE FROM im_users WHERE id IN (%s,%s)", (f["owner_im_user_id"], f["agent_im_user_id"])),
        ]:
            try:
                cur.execute(sql, args)
            except Exception:
                pass


@pytest.fixture
def fixtures(request: pytest.FixtureRequest, mysql_conn: Any) -> Iterator[Dict[str, str]]:
    suffix = request.node.name[:8].replace("_", "")[:8] or "x"
    suffix = suffix + secrets.token_hex(2)
    f = _make_fixtures(mysql_conn, suffix)
    f["reply_token"] = _mint_adr1_reply_token(
        channel_account_id=f"chan_{suffix}",
        conversation_id=f["conversation_id"],
        message_id=f["message_id"],
        agent_im_user_id=f["agent_im_user_id"],
    )
    yield f
    _cleanup_fixtures(mysql_conn, f)


@pytest.fixture
def daemon_client(fixtures: Dict[str, str]) -> Iterator[PrismerClient]:
    """A PrismerClient bearing a fresh owner JWT — matches what a daemon does
    after acquiring a workspace-bound api key in production. The W3 server
    contract requires *some* Bearer token (see E7 §6 finding).
    """
    jwt = _mint_jwt(sub=fixtures["owner_im_user_id"], username=fixtures["owner_im_user_id"])
    client = PrismerClient(api_key=jwt, base_url=CLOUD_BASE, timeout=30.0)
    yield client
    client.close()


@pytest.fixture
def cache() -> Iterator[PendingReplyCache]:
    tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    tmp.close()
    c = PendingReplyCache(db_path=tmp.name)
    yield c
    c.close()
    try:
        os.unlink(tmp.name)
    except OSError:
        pass


def _send_payload(fixtures: Dict[str, str], **overrides: Any) -> Dict[str, Any]:
    base = {
        "task_id": fixtures["task_id"],
        "conversation_id": fixtures["conversation_id"],
        "reply_token": fixtures["reply_token"],
        "reply_to_message_id": fixtures["message_id"],
        "agent_im_user_id": fixtures["agent_im_user_id"],
        "status": "ok",
        "reply_text": "hello from python daemon",
        "asset_ids": [],
        "completed_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    base.update(overrides)
    return base


def _db_reply_row(conn: Any, reply_id: str) -> Optional[Dict[str, Any]]:
    with conn.cursor() as cur:
        cur.execute("SELECT * FROM im_dispatch_replies WHERE id=%s", (reply_id,))
        return cur.fetchone()


# ---------------------------------------------------------------------------
# Tests — real cloud, real MySQL
# ---------------------------------------------------------------------------


def test_prepare_commit_happy_path(daemon_client, fixtures, cache, mysql_conn):
    result = send_dispatch_reply_two_phase(
        daemon_client,
        cache=cache,
        **_send_payload(fixtures),
    )
    assert result["status"] == "committed", result
    assert result["alreadyCommitted"] is False
    reply_id = result["replyId"]
    assert reply_id

    row = _db_reply_row(mysql_conn, reply_id)
    assert row is not None, "im_dispatch_replies row should exist"
    assert row["status"] == "committed", row
    assert row["committedAt"] is not None
    # Cache must be drained.
    counts = cache.count_by_status()
    assert counts == {"pending": 0, "prepared": 0}, counts


def test_prepare_with_ready_asset_commits(daemon_client, fixtures, cache, mysql_conn):
    result = send_dispatch_reply_two_phase(
        daemon_client,
        cache=cache,
        **_send_payload(
            fixtures,
            reply_text="with attachment",
            attachments=[{"kind": "file", "assetId": fixtures["ready_asset_id"]}],
            asset_ids=[fixtures["ready_asset_id"]],
        ),
    )
    assert result["status"] == "committed", result
    row = _db_reply_row(mysql_conn, result["replyId"])
    assert row is not None
    assert row["status"] == "committed"
    asset_ids_json = json.loads(row["assetIdsJson"])
    assert asset_ids_json == [fixtures["ready_asset_id"]]


def test_prepare_with_missing_asset_raises(daemon_client, fixtures, cache):
    payload = _send_payload(
        fixtures,
        attachments=[{"kind": "file", "assetId": "a_does_not_exist_xyz"}],
        asset_ids=["a_does_not_exist_xyz"],
    )
    bad_idem = generate_idempotency_key()
    with pytest.raises(DispatchReplyPrepareError) as exc_info:
        send_dispatch_reply_two_phase(
            daemon_client, cache=cache, idempotency_key=bad_idem, **payload
        )
    assert exc_info.value.code == "ASSETS_NOT_READY", exc_info.value.code
    # Cache should retain the row with status=pending for the next retry.
    row = cache.find_by_idempotency_key(bad_idem)
    assert row is not None
    assert row.status == "pending"
    assert row.last_error and "ASSETS_NOT_READY" in row.last_error


def test_prepare_idempotent_resend(daemon_client, fixtures, cache, mysql_conn):
    """Re-sending prepare with the same idempotencyKey returns the existing
    row (server invariant: (taskId, idempotencyKey) UNIQUE)."""
    idem = generate_idempotency_key()
    first = send_dispatch_reply_two_phase(
        daemon_client, cache=cache, idempotency_key=idem, **_send_payload(fixtures)
    )
    assert first["status"] == "committed"
    reply_id_1 = first["replyId"]

    # Second call: cache was drained by the first commit, but the server still
    # has the (taskId, idem) row → re-prepare should return status='committed'
    # with the same replyId.
    second = send_dispatch_reply_two_phase(
        daemon_client, cache=cache, idempotency_key=idem, **_send_payload(fixtures)
    )
    assert second["replyId"] == reply_id_1, (first, second)
    assert second["alreadyCommitted"] is True
    assert second["status"] == "committed"


def test_commit_idempotent_resend(daemon_client, fixtures, cache, mysql_conn):
    """Re-sending commit with the same replyId returns alreadyCommitted=True."""
    result = send_dispatch_reply_two_phase(
        daemon_client, cache=cache, **_send_payload(fixtures)
    )
    reply_id = result["replyId"]
    # Direct commit re-send via the raw client.
    resp = daemon_client._request(
        "POST", f"/api/im/dispatch/{fixtures['task_id']}/commit", json={"replyId": reply_id}
    )
    assert resp.get("ok") is True, resp
    data = resp.get("data") or resp
    assert data.get("alreadyCommitted") is True, data


def test_crash_recovery_commits_prepared_row(daemon_client, fixtures, cache, mysql_conn):
    """Simulate a daemon that crashed AFTER prepare 200 but BEFORE commit. The
    next cold-start must drain the cache by issuing the commit (idempotent on
    replyId)."""
    idem = generate_idempotency_key()
    payload = _send_payload(fixtures)
    # Manually persist+prepare+leave-pending — DO NOT commit.
    cache_payload = {**payload, "_taskId": fixtures["task_id"], "_idempotencyKey": idem}
    cache.save_pending(idem, fixtures["task_id"], json.dumps(cache_payload, separators=(",", ":")))
    prep_body = {
        "conversationId": fixtures["conversation_id"],
        "replyToken": fixtures["reply_token"],
        "replyToMessageId": fixtures["message_id"],
        "agentImUserId": fixtures["agent_im_user_id"],
        "status": "ok",
        "replyText": payload["reply_text"],
        "assetIds": [],
        "completedAt": payload["completed_at"],
        "idempotencyKey": idem,
    }
    prep_resp = daemon_client._request(
        "POST", f"/api/im/dispatch/{fixtures['task_id']}/prepare", json=prep_body
    )
    assert prep_resp.get("ok") is True, prep_resp
    inner = prep_resp.get("data") or prep_resp
    reply_id = inner["replyId"]
    assert inner["status"] == "prepared"
    cache.mark_prepared(idem, reply_id)

    # Verify the row is on the server as 'prepared' but NOT yet committed.
    row = _db_reply_row(mysql_conn, reply_id)
    assert row is not None and row["status"] == "prepared", row

    # Simulate crash: close + reopen the cache against the same on-disk DB.
    dbpath = cache.db_path
    cache.close()

    cache2 = PendingReplyCache(db_path=dbpath)
    try:
        recovery_rows = cache2.list_for_recovery()
        assert len(recovery_rows) == 1, recovery_rows
        assert recovery_rows[0].status == "prepared"
        assert recovery_rows[0].reply_id == reply_id

        summary = recover_pending_replies(daemon_client, cache2)
        assert summary == {"attempted": 1, "committed": 1, "aborted": 0, "failed": 0}, summary

        # DB row should now be committed.
        row2 = _db_reply_row(mysql_conn, reply_id)
        assert row2 is not None and row2["status"] == "committed", row2

        # Cache drained.
        assert cache2.count_by_status() == {"pending": 0, "prepared": 0}
    finally:
        cache2.close()


def test_recovery_handles_server_aborted_row(daemon_client, fixtures, cache, mysql_conn):
    """If the server-side reaper has flipped a stale prepared row to
    'aborted' (>1h cutoff), the daemon's recovery should detect the
    DISPATCH_REPLY_INVALID_STATE error and clear the local cache."""
    idem = generate_idempotency_key()
    reply_id = f"dr_{secrets.token_hex(12)}"
    stale = datetime.now(timezone.utc) - timedelta(minutes=65)
    # Insert a stale aborted row directly via MySQL (skip the cloud).
    with mysql_conn.cursor() as cur:
        cur.execute(
            "INSERT INTO im_dispatch_replies (id, taskId, idempotencyKey, status, "
            "assetIdsJson, messageContentJson, metricsJson, preparedAt, abortedAt) "
            "VALUES (%s,%s,%s,'aborted','[]',NULL,NULL,%s,%s)",
            (reply_id, fixtures["task_id"], idem, stale, datetime.now(timezone.utc)),
        )

    # Local cache thinks it has a prepared row to commit.
    cache.save_pending(idem, fixtures["task_id"], json.dumps({"_taskId": fixtures["task_id"]}))
    cache.mark_prepared(idem, reply_id)

    summary = recover_pending_replies(daemon_client, cache)
    assert summary == {"attempted": 1, "committed": 0, "aborted": 1, "failed": 0}, summary
    assert cache.count_by_status() == {"pending": 0, "prepared": 0}


def test_legacy_endpoint_still_works(daemon_client, fixtures, mysql_conn):
    """Backwards compatibility: the deprecated POST /dispatch/reply continues
    to be wired and reachable until the server Sunset (2026-09-01). Existing
    Python SDK callers don't break the day they ``pip install`` the new SDK.

    Wave 6 G2 (migration 419) lifted the
    ``im_messages.idempotencyKey VARCHAR(64)`` overflow that previously made
    this path return HTTP 500 ``DISPATCH_REPLY_PERSIST_FAILED`` for any
    realistically-sized fixture (the server-side legacy key is
    ``dispatch_reply:{convId}:{msgId}:{agentId}`` — ~92-101 chars with cuid
    IDs). Now the legacy path must succeed end-to-end and the assertion is
    upgraded accordingly:

    1. HTTP envelope has ``ok=True`` (the legacy path persists a real message).
    2. The wrapper emits a DeprecationWarning so users see migration guidance.
    """
    import warnings

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        resp = send_dispatch_reply_legacy(
            daemon_client,
            conversation_id=fixtures["conversation_id"],
            reply_token=fixtures["reply_token"],
            reply_to_message_id=fixtures["message_id"],
            agent_im_user_id=fixtures["agent_im_user_id"],
            status="ok",
            reply_text="from legacy path",
        )
    # Stronger post-G2 assertion: legacy path must SUCCEED (not merely be
    # reachable). A failure here means migration 419 regressed or another
    # legacy-path bug surfaced; treat it as a real regression, not a known
    # quirk.
    assert isinstance(resp, dict), resp
    assert resp.get("ok") is True or resp.get("success") is True, (
        f"legacy /dispatch/reply must succeed end-to-end (Wave 6 G2): {resp}"
    )
    # The response data envelope carries the persisted messageId.
    data = resp.get("data") or {}
    assert isinstance(data.get("messageId"), str) and data["messageId"], (
        f"legacy /dispatch/reply success envelope must include messageId: {resp}"
    )
    # We should have raised a DeprecationWarning.
    assert any(issubclass(w.category, DeprecationWarning) for w in caught), [str(w) for w in caught]
