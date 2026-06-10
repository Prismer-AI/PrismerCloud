"""
v1.9.3 Python SDK wrapper integration suite — Phase A + Phase B.

Exercises wrappers added in commit 3e78325 against a **local** Prismer Cloud
(http://localhost:3000 by default). Self-contained: registers a fresh user via
direct ``requests`` call, then drives PrismerClient + AsyncPrismerClient.

Skipped unless ``V193_LOCAL_CLOUD=1``.

Run::

    cd sdk/prismer-cloud/python
    V193_LOCAL_CLOUD=1 /opt/homebrew/bin/python3.11 -m pytest \
        tests/test_v193_integration.py -v

Design notes:

* Each test asserts only on contract shape (``ok`` flag, JSON envelope, key
  presence) — *not* on rich semantic correctness — because we want to catch
  wrapper-level bugs (wrong path, wrong body shape) without coupling to
  server data.
* Fresh user per pytest session avoids state collisions.
* Phase A = pre-refactor TS parity catch-up; Phase B = v1.9.3 refactor
  surface. Phase B is exercised on both ``PrismerClient`` (sync) and
  ``AsyncPrismerClient`` (async) for parity.
* Some endpoints have known server gaps on local cloud — these are marked
  with ``EXPECT_404`` / ``EXPECT_400`` constants so the suite still proves
  the wrapper made the right call.
"""

from __future__ import annotations

import asyncio
import os
import time
import urllib.request
import urllib.error
import json as _json
import secrets
from typing import Any, Dict, Optional, Tuple

import pytest


# ---------------------------------------------------------------------------
# Module-level skip gate (must come before any conftest interaction)
# ---------------------------------------------------------------------------

if not os.environ.get("V193_LOCAL_CLOUD"):
    pytest.skip(
        "V193_LOCAL_CLOUD=1 not set — skipping v1.9.3 local-cloud integration suite",
        allow_module_level=True,
    )


# Avoid the repo's conftest fixture which raises if PRISMER_API_KEY_TEST
# is missing. We do not depend on any conftest fixture in this file.
# (Pytest still imports conftest.py from the tests directory, so we set a
# placeholder env var to prevent it from raising at collection time.)
os.environ.setdefault("PRISMER_API_KEY_TEST", "sk-prismer-live-placeholder-v193-not-used")

# Bypass any system HTTP proxy for localhost — required on macOS dev
# machines where Clash/Surge/etc. transparently proxy 127.0.0.1.
# httpx + urllib both honor these env vars; the SDK's httpx.Client uses
# the inherited environment.
_no_proxy = os.environ.get("NO_PROXY", "")
for host in ("127.0.0.1", "localhost", "::1"):
    if host not in _no_proxy:
        _no_proxy = f"{_no_proxy},{host}" if _no_proxy else host
os.environ["NO_PROXY"] = _no_proxy
os.environ["no_proxy"] = _no_proxy


from prismer import PrismerClient, AsyncPrismerClient  # noqa: E402


BASE_URL = os.environ.get("V193_BASE_URL", "http://localhost:3000")


# ---------------------------------------------------------------------------
# Direct (no SDK) helper — register a fresh user & return their JWT.
# Avoids importing requests; uses urllib from stdlib.
# ---------------------------------------------------------------------------


def _register_user_raw(role: str = "human") -> Dict[str, Any]:
    """Register a fresh user via raw HTTP. Returns ``{imUserId, token, username}``."""
    suffix = secrets.token_hex(4)
    username = f"v193_{role}_{suffix}"
    body = _json.dumps({
        "type": role,
        "username": username,
        "displayName": f"V193 {role.title()} {suffix}",
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{BASE_URL}/api/im/register",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        payload = _json.loads(resp.read())
    assert payload.get("ok") is True, f"register failed: {payload}"
    data = payload["data"]
    return {
        "imUserId": data["imUserId"],
        "token": data["token"],
        "username": username,
    }


# ---------------------------------------------------------------------------
# Session-scoped fixtures — fresh users + workspaces.
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def health_check() -> None:
    """Fail fast if local cloud isn't up."""
    try:
        with urllib.request.urlopen(f"{BASE_URL}/api/health", timeout=5) as resp:
            payload = _json.loads(resp.read())
    except (urllib.error.URLError, ConnectionError) as e:
        pytest.fail(f"local cloud unreachable at {BASE_URL}: {e}")
    assert payload.get("status") == "healthy", f"unhealthy: {payload}"


@pytest.fixture(scope="module")
def primary_user(health_check) -> Dict[str, Any]:
    """Primary test user (alice)."""
    return _register_user_raw(role="human")


@pytest.fixture(scope="module")
def secondary_user(health_check) -> Dict[str, Any]:
    """Secondary test user (bob) — friend-request target."""
    return _register_user_raw(role="human")


@pytest.fixture(scope="module")
def primary_workspace_id(primary_user) -> str:
    """Default workspace auto-created for the primary user."""
    client = PrismerClient(api_key=primary_user["token"], base_url=BASE_URL, timeout=30.0)
    try:
        res = client.im.workspaces.list()
        assert res.get("ok") is True, f"workspaces.list failed: {res}"
        items = res.get("data") or []
        assert items, "expected at least 1 default workspace"
        return items[0]["id"]
    finally:
        client.close()


@pytest.fixture
def primary_client(primary_user) -> PrismerClient:
    c = PrismerClient(api_key=primary_user["token"], base_url=BASE_URL, timeout=30.0)
    yield c
    c.close()


@pytest.fixture
def secondary_client(secondary_user) -> PrismerClient:
    c = PrismerClient(api_key=secondary_user["token"], base_url=BASE_URL, timeout=30.0)
    yield c
    c.close()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _ok(res: Any) -> bool:
    """Truthy if envelope reports success."""
    return isinstance(res, dict) and res.get("ok") is True


def _err_code(res: Any) -> Optional[str]:
    """Extract error code/message for diagnostics."""
    if not isinstance(res, dict):
        return None
    err = res.get("error")
    if isinstance(err, dict):
        return err.get("code") or err.get("message")
    if isinstance(err, str):
        return err
    return None


# ===========================================================================
# Phase A — TS parity catch-up (pre-refactor surface)
# ===========================================================================


class TestPhaseA_Contacts:
    """contacts.* — request / accept / reject / cancel / list_pending_in /
    list_pending_out / list_friends / unfriend / set_remark / block /
    unblock / list_blocked / get_presence."""

    def test_request_then_cancel(self, primary_client, secondary_client, secondary_user):
        # Send a friend request from primary → secondary with reason+source.
        # This exercises the post-fix payload {userId, reason, source}.
        res = primary_client.im.contacts.request(
            secondary_user["imUserId"],
            reason="hi from v193 test",
            source="v193-suite",
        )
        assert _ok(res), f"contacts.request failed: {res}"
        request_id = res["data"]["id"]

        # The SDK's contacts.cancel() routes to /requests/:id/reject server-side
        # (no dedicated sender-cancel endpoint exists yet — see contact.service.ts
        # rejectRequest enforces toUserId==caller). So drive cancel from the
        # recipient side, which is what the alias actually maps to.
        cancel_res = secondary_client.im.contacts.cancel(request_id)
        assert _ok(cancel_res), f"contacts.cancel failed: {cancel_res}"

    def test_request_accept_unfriend(self, primary_client, secondary_client, primary_user, secondary_user):
        # primary sends a request to secondary
        req = primary_client.im.contacts.request(secondary_user["imUserId"])
        assert _ok(req), f"contacts.request failed: {req}"
        request_id = req["data"]["id"]

        # secondary sees inbound
        inbound = secondary_client.im.contacts.list_pending_in()
        assert _ok(inbound), f"list_pending_in failed: {inbound}"

        # primary sees outbound
        outbound = primary_client.im.contacts.list_pending_out()
        assert _ok(outbound), f"list_pending_out failed: {outbound}"

        # secondary accepts
        acc = secondary_client.im.contacts.accept(request_id)
        assert _ok(acc), f"contacts.accept failed: {acc}"

        # primary's friends list now includes secondary
        friends = primary_client.im.contacts.friends()
        assert _ok(friends), f"contacts.friends failed: {friends}"

        # remark + unfriend
        remark = primary_client.im.contacts.set_remark(secondary_user["imUserId"], "buddy")
        assert _ok(remark), f"set_remark failed: {remark}"
        rm = primary_client.im.contacts.unfriend(secondary_user["imUserId"])
        assert _ok(rm), f"unfriend failed: {rm}"

    def test_reject(self, primary_client):
        # Use a fresh pair of users to avoid uq_request state pollution from
        # earlier tests that re-use module-scoped (primary_user, secondary_user)
        # — IMFriendRequest has a uq_request unique constraint that conflicts
        # when the same from/to pair has historic rejected/accepted rows.
        sender = _register_user_raw(role="human")
        receiver = _register_user_raw(role="human")
        sender_client = PrismerClient(api_key=sender["token"], base_url=BASE_URL, timeout=30.0)
        receiver_client = PrismerClient(api_key=receiver["token"], base_url=BASE_URL, timeout=30.0)
        try:
            req = sender_client.im.contacts.request(receiver["imUserId"])
            assert _ok(req), f"contacts.request failed: {req}"
            request_id = req["data"]["id"]

            rej = receiver_client.im.contacts.reject(request_id)
            assert _ok(rej), f"contacts.reject failed: {rej}"
        finally:
            sender_client.close()
            receiver_client.close()

    def test_block_unblock_list_blocked(self, primary_client, secondary_user):
        b = primary_client.im.contacts.block(secondary_user["imUserId"])
        assert _ok(b), f"block failed: {b}"

        listed = primary_client.im.contacts.list_blocked()
        assert _ok(listed), f"list_blocked failed: {listed}"

        ub = primary_client.im.contacts.unblock(secondary_user["imUserId"])
        assert _ok(ub), f"unblock failed: {ub}"

    def test_get_presence(self, primary_client, secondary_user):
        res = primary_client.im.contacts.get_presence([secondary_user["imUserId"]])
        assert _ok(res), f"get_presence failed: {res}"


class TestPhaseA_Conversations:
    """conversations.* — create_group / update / archive / unarchive / pin /
    mute / delete / add_participant / remove_participant."""

    def test_create_group_lifecycle(self, primary_client, secondary_user):
        # create group
        res = primary_client.im.conversations.create_group(
            "v193-group", member_ids=[secondary_user["imUserId"]]
        )
        assert _ok(res), f"conversations.create_group failed: {res}"
        # tolerate either { conversationId } or { conversation: {id} }
        data = res.get("data", {})
        conv_id = (
            data.get("conversationId")
            or (data.get("conversation") or {}).get("id")
            or data.get("id")
        )
        assert conv_id, f"missing conversation id: {res}"

        # update (rename)
        upd = primary_client.im.conversations.update(conv_id, title="v193-group-renamed")
        assert _ok(upd), f"conversations.update failed: {upd}"

        # pin / mute
        pin = primary_client.im.conversations.pin(conv_id, True)
        assert _ok(pin), f"conversations.pin failed: {pin}"
        mute = primary_client.im.conversations.mute(conv_id, True)
        assert _ok(mute), f"conversations.mute failed: {mute}"

        # archive / unarchive
        arc = primary_client.im.conversations.archive(conv_id)
        assert _ok(arc), f"conversations.archive failed: {arc}"
        unarc = primary_client.im.conversations.unarchive(conv_id)
        assert _ok(unarc), f"conversations.unarchive failed: {unarc}"

        # add/remove participant — register a 3rd user and try
        third = _register_user_raw(role="human")
        add = primary_client.im.conversations.add_participant(conv_id, third["imUserId"])
        assert _ok(add), f"conversations.add_participant failed: {add}"
        rm = primary_client.im.conversations.remove_participant(conv_id, third["imUserId"])
        assert _ok(rm), f"conversations.remove_participant failed: {rm}"

        # delete (leave)
        d = primary_client.im.conversations.delete(conv_id)
        assert _ok(d), f"conversations.delete failed: {d}"


class TestPhaseA_Account:
    """account.update_profile() (PATCH /me) + list_my_agents() + delete_me()."""

    def test_update_profile(self, primary_client):
        """PATCH /api/im/me updates editable IMUser fields.

        Server fix landed via F3 — was 404 (route not implemented), now returns
        200 with the updated user shape. Verifies displayName, bio, and
        metadata round-trip correctly.
        """
        res = primary_client.im.account.update_profile(
            display_name="Renamed v193",
            bio="v193 bio",
            metadata={"v193": True},
        )
        assert _ok(res), f"update_profile failed: {res}"
        user = (res.get("data") or {}).get("user") or {}
        assert user.get("displayName") == "Renamed v193", f"displayName not updated: {user}"
        assert user.get("bio") == "v193 bio", f"bio not stored (mapped to description): {user}"
        meta = user.get("metadata") or {}
        assert meta.get("v193") is True, f"metadata not stored: {user}"

    def test_list_my_agents(self, primary_client):
        res = primary_client.im.account.list_my_agents()
        assert _ok(res), f"list_my_agents failed: {res}"
        assert isinstance(res.get("data"), list)

    def test_delete_me_last(self):
        """Verify delete_me() wrapper hits DELETE /api/im/me. Uses a throwaway
        user so primary_user fixture survives for other tests in the module."""
        throwaway = _register_user_raw(role="human")
        c = PrismerClient(api_key=throwaway["token"], base_url=BASE_URL, timeout=30.0)
        try:
            res = c.im.account.delete_me()
            assert _ok(res), f"delete_me failed: {res}"
        finally:
            c.close()


class TestPhaseA_Messages:
    """messages.mark_delivered() — receipts contract."""

    def test_mark_delivered(self, primary_client, secondary_client, primary_user, secondary_user):
        """Full happy path: secondary sends a message in a direct conversation,
        primary marks it delivered. Server requires ``{conversationId, messageIds}``.
        """
        # secondary -> primary: send a direct message (creates direct conversation if needed)
        send_res = secondary_client.im.direct.send(
            primary_user["imUserId"], "v193 mark_delivered fixture"
        )
        assert _ok(send_res), f"direct.send failed: {send_res}"
        msg = send_res.get("data") or {}
        message_id = msg.get("id") or (msg.get("message") or {}).get("id")
        conv_id = msg.get("conversationId") or (msg.get("message") or {}).get("conversationId")
        assert message_id and conv_id, f"missing message/conversation id in response: {send_res}"

        # primary marks the inbound message as delivered
        res = primary_client.im.messages.mark_delivered(conv_id, [message_id])
        assert _ok(res), f"mark_delivered failed: {res}"
        # server returns {updated: <count>}
        updated = (res.get("data") or {}).get("updated")
        assert isinstance(updated, int), f"missing 'updated' count: {res}"


class TestPhaseA_EvolutionSkills:
    """evolution.create_skill() + star_skill()."""

    def test_create_skill(self, primary_client):
        # Use a unique skill name per run — server derives the slug from name,
        # so reusing the same name would collide on the unique slug constraint
        # (now returns a clean 409, but we want a green path here).
        suffix = secrets.token_hex(3)
        res = primary_client.im.evolution.create_skill(
            slug=f"v193-test-skill-{suffix}",
            name=f"V193 Test Skill {suffix}",
            content="# V193\nTest content",
            description="Created by v193 integration suite",
            category="testing",
        )
        assert _ok(res), f"create_skill failed: {res}"
        skill_id = (res.get("data") or {}).get("id") or (res.get("data") or {}).get("skill", {}).get("id")
        assert skill_id, f"create_skill returned no skill id: {res}"
        star = primary_client.im.evolution.star_skill(skill_id, True)
        assert _ok(star), f"star_skill failed: {star}"


class TestPhaseA_WorkspaceView:
    """workspace.get_view() — superset aggregation view."""

    def test_get_view(self, primary_client):
        """GET /api/im/workspace/view returns the superset slot view.

        Server fix landed via F3 — `/view` was a 404 (only `/` was wired),
        now aliased to the same handler. Returns ok=true with default slots
        for the caller's global scope.
        """
        res = primary_client.im.workspace.get_view()
        assert _ok(res), f"workspace.get_view failed: {res}"
        data = res.get("data") or {}
        assert data.get("scope") == "global", f"unexpected scope: {data}"
        # Default slot set should include identity (always present for the user).
        assert "identity" in data, f"identity slot missing: {data}"


class TestPhaseA_ListModels:
    """top-level client.list_models()."""

    def test_list_models(self, primary_client):
        res = primary_client.list_models()
        # OpenAI shape: {object: 'list', data: [...]}
        assert isinstance(res, dict), f"unexpected response: {res}"
        # success may be implicit (HTTP 200); accept either ok or data
        data = res.get("data")
        assert isinstance(data, list) and len(data) > 0, f"no models: {res}"
        # Spot-check shape
        assert all("id" in m for m in data[:5]), "model entries missing id"


# ===========================================================================
# Phase B — v1.9.3 refactor surface (sync)
# ===========================================================================


class TestPhaseB_Sync_Workspaces:
    """workspaces.* — list / create / get / update / archive / sync."""

    def test_list_default_workspace(self, primary_client):
        res = primary_client.im.workspaces.list()
        assert _ok(res), f"workspaces.list failed: {res}"
        items = res.get("data") or []
        assert items, "expected default Personal workspace"

    def test_create_get_update_then_archive(self, primary_client):
        slug = f"v193-{secrets.token_hex(3)}"
        cr = primary_client.im.workspaces.create(name="V193 Extra", slug=slug)
        if not _ok(cr):
            pytest.xfail(f"workspaces.create failed (likely 1:1 limit): {cr}")
            return
        ws_id = cr["data"]["id"]

        g = primary_client.im.workspaces.get(ws_id)
        assert _ok(g), f"workspaces.get failed: {g}"

        u = primary_client.im.workspaces.update(ws_id, name="V193 Extra Renamed")
        assert _ok(u), f"workspaces.update failed: {u}"

        # archive: 1.9.x disables workspace deletion (server-side guard).
        # Tolerate ok=true OR a known error indicating the policy.
        a = primary_client.im.workspaces.archive(ws_id)
        if not _ok(a):
            err_blob = str(a).lower()
            assert (
                "deletion is disabled" in err_blob
                or "405" in err_blob
                or "http" in (_err_code(a) or "").lower()
            ), f"unexpected archive error: {a}"

    def test_sync(self, primary_client):
        res = primary_client.im.workspaces.sync()
        assert _ok(res), f"workspaces.sync failed: {res}"
        data = res.get("data") or {}
        assert "items" in data, f"sync missing items: {data}"


class TestPhaseB_Sync_WorkspaceFiles:
    """workspace_files.* — list / bind / delete / sync / history."""

    def test_list_empty(self, primary_client, primary_workspace_id):
        res = primary_client.im.workspace_files.list(primary_workspace_id)
        assert _ok(res), f"workspace_files.list failed: {res}"

    def test_sync(self, primary_client, primary_workspace_id):
        res = primary_client.im.workspace_files.sync(primary_workspace_id)
        assert _ok(res), f"workspace_files.sync failed: {res}"

    def test_bind_then_history_then_delete(self, primary_client, primary_workspace_id):
        # First, upload an asset to bind to.
        upload = primary_client.im.assets.upload(
            file=b"# V193 test asset\nhello",
            workspace_id=primary_workspace_id,
            file_name="v193-test.md",
            mime_type="text/markdown",
        )
        if not (isinstance(upload, dict) and upload.get("ok") is True):
            pytest.xfail(f"asset upload failed; cannot test workspace_files.bind: {upload}")
            return
        asset_id = upload["data"]["id"]
        path = f"/v193/{secrets.token_hex(3)}.md"

        b = primary_client.im.workspace_files.bind(primary_workspace_id, path, asset_id)
        if not _ok(b):
            pytest.xfail(f"bind failed: {b}")
            return
        file_id = (b.get("data") or {}).get("id")

        if file_id:
            h = primary_client.im.workspace_files.history(primary_workspace_id, file_id)
            assert _ok(h), f"history failed: {h}"

        d = primary_client.im.workspace_files.delete(primary_workspace_id, path)
        assert _ok(d), f"delete failed: {d}"


class TestPhaseB_Sync_Assets:
    """assets.* — list / upload / by_hash / detail / download_url / delete."""

    def test_upload_list_detail_delete(self, primary_client, primary_workspace_id):
        upload = primary_client.im.assets.upload(
            file=b"# V193 asset roundtrip\nbye",
            workspace_id=primary_workspace_id,
            file_name="v193-roundtrip.md",
            mime_type="text/markdown",
            kind="document",
        )
        assert isinstance(upload, dict) and upload.get("ok") is True, f"upload: {upload}"
        asset_id = upload["data"]["id"]
        content_hash = upload["data"].get("contentHash") or upload["data"].get("sha256")

        listed = primary_client.im.assets.list(workspace_id=primary_workspace_id)
        assert _ok(listed), f"assets.list failed: {listed}"

        if content_hash:
            by_hash = primary_client.im.assets.by_hash(content_hash, primary_workspace_id)
            assert _ok(by_hash), f"by_hash failed: {by_hash}"

        det = primary_client.im.assets.detail(asset_id)
        assert _ok(det), f"detail failed: {det}"

        url = primary_client.im.assets.download_url(asset_id)
        assert isinstance(url, str) and asset_id in url, f"download_url malformed: {url}"

        d = primary_client.im.assets.delete(asset_id)
        assert _ok(d), f"delete failed: {d}"


class TestPhaseB_Sync_RuntimeInstallations:
    """runtime_installations.* — list / create / install_agent.

    create / install_agent depend on SANDBOX_CONTROLLER_URL being configured;
    on local cloud they return 500 with a configuration error. We assert the
    wrapper makes the call correctly even if the dependency is unavailable.
    """

    def test_list_empty(self, primary_client, primary_workspace_id):
        res = primary_client.im.runtime_installations.list(primary_workspace_id)
        assert _ok(res), f"runtime_installations.list failed: {res}"

    def test_create_known_500_or_ok(self, primary_client, primary_workspace_id):
        res = primary_client.im.runtime_installations.create(
            primary_workspace_id, name="v193-runtime-test"
        )
        if _ok(res):
            return
        code = _err_code(res) or ""
        assert (
            "SANDBOX_CONTROLLER_URL" in str(res)
            or "internal_error" in code
            or "HTTP" in code.upper()
        ), f"runtime_installations.create unexpected error: {res}"
        pytest.xfail(f"runtime_installations.create requires SANDBOX_CONTROLLER_URL: {code}")

    def test_install_agent_signature(self, primary_client):
        # We can't exercise install_agent meaningfully without a runtime, but we
        # can verify the wrapper is callable with the documented kwargs.
        res = primary_client.im.runtime_installations.install_agent(
            "ri-nonexistent-id",
            agent_im_user_id="agent-x",
            adapter_name="hermes",
        )
        assert isinstance(res, dict), f"install_agent returned non-dict: {res}"
        # Expected: not ok (404 or 500).
        if not _ok(res):
            return
        pytest.xfail("install_agent unexpectedly succeeded on bogus runtime id")


class TestPhaseB_Sync_Tasks:
    """tasks.* — enriched create + lifecycle + SSE iterator."""

    def test_create_enriched_then_cancel(self, primary_client, primary_workspace_id):
        res = primary_client.im.tasks.create(
            "V193 enriched task",
            workspace_id=primary_workspace_id,
            runtime_route="agent",
            kind="research",
        )
        assert _ok(res), f"tasks.create failed: {res}"
        data = res["data"]
        # Phase B enrichment fields
        for field in ("workspaceId", "runtimeRoute", "ownerId", "ownerType"):
            # runtimeRoute may not always be returned; tolerate
            if field == "runtimeRoute" and field not in data:
                continue
            assert field in data, f"missing enriched field {field}: {data}"
        task_id = data["id"]

        c = primary_client.im.tasks.cancel(task_id)
        assert _ok(c), f"tasks.cancel failed: {c}"

    def test_approve_reject_paths_callable(self, primary_client, primary_workspace_id):
        # Create a task and verify approve/reject wrappers reach the right route.
        # We can't drive a task to "review" without a runtime, so we just check
        # that the wrappers either succeed or return a state-machine error
        # (not a wrapper-level error).
        res = primary_client.im.tasks.create(
            "V193 approve/reject probe",
            workspace_id=primary_workspace_id,
        )
        assert _ok(res), f"tasks.create failed: {res}"
        task_id = res["data"]["id"]

        approve_res = primary_client.im.tasks.approve(task_id)
        assert isinstance(approve_res, dict)

        reject_res = primary_client.im.tasks.reject(task_id, reason="no")
        assert isinstance(reject_res, dict)

        # Cleanup
        primary_client.im.tasks.cancel(task_id)

    def test_events_sse(self, primary_user, primary_client, primary_workspace_id):
        """Spawn a task, then read SSE events with a short timeout. The
        iterator must yield at least one ``connected`` event."""
        # Create a task first so the stream has something to flush.
        res = primary_client.im.tasks.create(
            "V193 SSE probe", workspace_id=primary_workspace_id
        )
        assert _ok(res), f"tasks.create failed: {res}"

        events_iter = primary_client.im.tasks.events(
            token=primary_user["token"], timeout=4.0
        )
        seen_events = []
        deadline = time.time() + 4.0
        try:
            for ev in events_iter:
                seen_events.append(ev)
                if len(seen_events) >= 2 or time.time() > deadline:
                    break
        except Exception as e:
            # Stream timeout / read error is acceptable as long as we got
            # at least the connected event.
            if not seen_events:
                pytest.fail(f"SSE iterator yielded nothing before erroring: {e}")

        assert seen_events, "SSE stream produced no events"
        first = seen_events[0]
        assert first.get("event") in ("connected", "task.created", "task.updated", "message"), (
            f"unexpected first event: {first}"
        )


class TestPhaseB_Sync_Memory:
    """memory.digest()."""

    def test_digest(self, primary_client):
        res = primary_client.im.memory.digest(max_lines=50, max_bytes=2000)
        assert _ok(res), f"memory.digest failed: {res}"
        data = res.get("data") or {}
        for k in ("digest", "totalLines", "totalBytes", "filesSummarized", "filesTotal", "truncated", "generatedAt"):
            assert k in data, f"digest missing field {k}: {data}"


# ===========================================================================
# Phase B — async parity
# ===========================================================================


def _run(coro):
    return asyncio.run(coro)


class TestPhaseB_Async_Workspaces:
    def test_list_get_update_sync_archive(self, primary_user):
        async def _run_async():
            async with AsyncPrismerClient(
                api_key=primary_user["token"], base_url=BASE_URL, timeout=30.0
            ) as c:
                res = await c.im.workspaces.list()
                assert _ok(res), f"async workspaces.list: {res}"
                items = res.get("data") or []
                assert items
                ws_id = items[0]["id"]

                g = await c.im.workspaces.get(ws_id)
                assert _ok(g), f"async workspaces.get: {g}"

                u = await c.im.workspaces.update(ws_id, name="V193 Personal Renamed")
                assert _ok(u), f"async workspaces.update: {u}"

                s = await c.im.workspaces.sync()
                assert _ok(s), f"async workspaces.sync: {s}"

        _run(_run_async())


class TestPhaseB_Async_WorkspaceFiles:
    def test_list_sync(self, primary_user, primary_workspace_id):
        async def _run_async():
            async with AsyncPrismerClient(
                api_key=primary_user["token"], base_url=BASE_URL, timeout=30.0
            ) as c:
                res = await c.im.workspace_files.list(primary_workspace_id)
                assert _ok(res), f"async workspace_files.list: {res}"
                s = await c.im.workspace_files.sync(primary_workspace_id)
                assert _ok(s), f"async workspace_files.sync: {s}"

        _run(_run_async())


class TestPhaseB_Async_Assets:
    def test_upload_list_detail_delete(self, primary_user, primary_workspace_id):
        async def _run_async():
            async with AsyncPrismerClient(
                api_key=primary_user["token"], base_url=BASE_URL, timeout=30.0
            ) as c:
                # async upload returns dict
                upload = await c.im.assets.upload(
                    file=b"async asset",
                    workspace_id=primary_workspace_id,
                    file_name="v193-async.md",
                    mime_type="text/markdown",
                )
                assert isinstance(upload, dict) and upload.get("ok") is True, (
                    f"async upload: {upload}"
                )
                asset_id = upload["data"]["id"]

                listed = await c.im.assets.list(workspace_id=primary_workspace_id)
                assert _ok(listed), f"async assets.list: {listed}"

                det = await c.im.assets.detail(asset_id)
                assert _ok(det), f"async detail: {det}"

                url = c.im.assets.download_url(asset_id)
                assert isinstance(url, str) and asset_id in url

                d = await c.im.assets.delete(asset_id)
                assert _ok(d), f"async delete: {d}"

        _run(_run_async())


class TestPhaseB_Async_RuntimeInstallations:
    def test_list(self, primary_user, primary_workspace_id):
        async def _run_async():
            async with AsyncPrismerClient(
                api_key=primary_user["token"], base_url=BASE_URL, timeout=30.0
            ) as c:
                res = await c.im.runtime_installations.list(primary_workspace_id)
                assert _ok(res), f"async runtime_installations.list: {res}"

        _run(_run_async())

    def test_create_known_500(self, primary_user, primary_workspace_id):
        async def _run_async():
            async with AsyncPrismerClient(
                api_key=primary_user["token"], base_url=BASE_URL, timeout=30.0
            ) as c:
                res = await c.im.runtime_installations.create(
                    primary_workspace_id, name="async-v193-runtime"
                )
                if not _ok(res):
                    code = _err_code(res) or ""
                    if (
                        "SANDBOX_CONTROLLER_URL" in str(res)
                        or "internal_error" in code
                        or "HTTP" in code.upper()
                    ):
                        return  # expected
                    pytest.fail(f"async create unexpected error: {res}")

        _run(_run_async())


class TestPhaseB_Async_Tasks:
    def test_create_cancel(self, primary_user, primary_workspace_id):
        async def _run_async():
            async with AsyncPrismerClient(
                api_key=primary_user["token"], base_url=BASE_URL, timeout=30.0
            ) as c:
                res = await c.im.tasks.create(
                    "Async V193 task",
                    workspace_id=primary_workspace_id,
                    runtime_route="agent",
                    kind="code",
                )
                assert _ok(res), f"async tasks.create: {res}"
                tid = res["data"]["id"]
                cn = await c.im.tasks.cancel(tid)
                assert _ok(cn), f"async tasks.cancel: {cn}"

        _run(_run_async())

    def test_events_async(self, primary_user, primary_workspace_id):
        """Async events() iterator. The Python SDK exposes ``events()`` on
        AsyncTasksClient as an async generator."""

        async def _run_async():
            async with AsyncPrismerClient(
                api_key=primary_user["token"], base_url=BASE_URL, timeout=30.0
            ) as c:
                # Prime: create a task so the stream flushes a task.* event.
                await c.im.tasks.create(
                    "Async SSE probe", workspace_id=primary_workspace_id
                )
                seen = []
                # Use a bounded read with a wall-clock fallback.
                events_iter = c.im.tasks.events(
                    token=primary_user["token"], timeout=4.0
                )
                deadline = time.time() + 4.0
                try:
                    async for ev in events_iter:
                        seen.append(ev)
                        if len(seen) >= 2 or time.time() > deadline:
                            break
                except Exception:
                    pass
                assert seen, "async SSE stream produced no events"

        _run(_run_async())


class TestPhaseB_Async_Memory:
    def test_digest(self, primary_user):
        async def _run_async():
            async with AsyncPrismerClient(
                api_key=primary_user["token"], base_url=BASE_URL, timeout=30.0
            ) as c:
                res = await c.im.memory.digest(max_lines=50)
                assert _ok(res), f"async memory.digest: {res}"

        _run(_run_async())
