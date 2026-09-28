"""Unit tests for the EaaS clients (`client.environments`, `client.warm_pool`).

Mirror of the TS assertion face (`sdk/cloud/tests/unit/environment-client.test.ts`,
eaas-gate-a Task 12) for the Python parity delivery (eaas-gate-b Task 15).

Mocks the transport — no network, no live credentials:
  * envelope face  → a recorder ``request_fn`` (same pattern as
    ``tests/test_v200_content_block_idempotency.py``)
  * binary file face → a recorder ``raw_request_fn`` (the TS ``fetchAuthed`` seam)

Pins request paths / methods / headers (Authorization Bearer, Idempotency-Key,
If-Match) plus envelope parsing, and the fail-through contract: a 503
`warm_capacity_unavailable` is surfaced verbatim — no retry, no automatic cold
downgrade.

Usage (no conftest / no PRISMER_API_KEY_TEST needed — this is NOT a live test):
    cd sdk/cloud/python && PYTHONPATH=. pytest unit_tests/test_environment_client.py
"""

from __future__ import annotations

import re

import pytest

from prismer.client import (
    AsyncEaasClient,
    AsyncEaasSkillsClient,
    AsyncEnvironmentsClient,
    AsyncPublishableKeysClient,
    AsyncWarmPoolClient,
    EaasClient,
    EaasSkillsClient,
    EnvironmentsClient,
    PublishableKeysClient,
    WarmPoolClient,
)
from prismer.types import (
    EAAS_ERROR_CODES,
    EaasClientError,
    EnvironmentCreateSpec,
    EnvironmentStatus,
    ProjectPoolStatus,
    PoolActivationStatus,
    WarmPoolPolicy,
    WarmPoolStatus,
    EaasSendMessageResult,
    EaasRunView,
    EaasCreatedPublishableKey,
    EaasPrincipalSessionView,
    EaasPrincipalMessageView,
    EaasArtifactList,
    EaasEventReplayPage,
    EaasPrivateSkillDetail,
    EaasPrivateSkillView,
    EaasSkillPublishPending,
    EaasSkillPublishPublished,
)

UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[089ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)

BASE = "https://eaas.example.com"
AUTH = {"Authorization": "Bearer sk-eaas-live-testtoken"}


def test_unconfigured_pool_activation_accepts_null_desired_revision():
    activation = PoolActivationStatus.model_validate({
        "desiredRevision": None, "observedRevision": None,
        "phase": "unconfigured", "freshUntil": None,
    })
    assert activation.desired_revision is None


# ---------------------------------------------------------------------------
# Helpers (mock transports)
# ---------------------------------------------------------------------------


def _ok_data(over: dict | None = None) -> dict:
    data = {
        "environmentId": "env_testenvstatus000001",
        "state": "provisioning",
        "revision": 1,
        "epoch": 1,
        "readiness": {"sandbox": False, "services": False, "agent": None},
        "startupPath": "cold",
        "templateVersion": "ubuntu@sha256:abc",
        "expiresAt": "2026-09-09T00:00:00.000Z",
        "milestones": [],
    }
    data.update(over or {})
    return data


def _make_recorder(response: dict | None = None):
    """Envelope-face mock: records (method, path, json, params, headers) calls."""
    calls: list[dict] = []

    def request_fn(method, path, *, json=None, params=None, headers=None):
        calls.append(
            {"method": method, "path": path, "json": json, "params": params, "headers": headers or {}}
        )
        if response is not None:
            return response
        return {"success": True, "data": _ok_data(), "requestId": "req-ok"}

    return request_fn, calls


def _make_async_recorder(response: dict | None = None):
    """Async mirror of :func:`_make_recorder` — the async sub-clients await
    their ``request_fn`` (the real one is ``AsyncPrismerClient._request``)."""
    calls: list[dict] = []

    async def request_fn(method, path, *, json=None, params=None, headers=None):
        calls.append(
            {"method": method, "path": path, "json": json, "params": params, "headers": headers or {}}
        )
        if response is not None:
            return response
        return {"success": True, "data": _ok_data(), "requestId": "req-ok"}

    return request_fn, calls


def _make_async_raw_recorder(responses=None):
    """Async mirror of :func:`_make_raw_recorder`."""
    calls: list[dict] = []
    queued = list(responses or [])

    async def raw_request_fn(method, url, *, headers=None, content=None):
        calls.append({"method": method, "url": url, "headers": headers or {}, "content": content})
        if queued:
            return queued.pop(0)
        return _RawResponse(status_code=200, content=b"", body={"success": True, "data": {}})

    return raw_request_fn, calls


class _RawResponse:
    def __init__(self, status_code=200, content=b"", headers=None, body=None):
        self.status_code = status_code
        self.content = content
        self.headers = headers or {}
        self._body = body

    def json(self):
        if self._body is not None:
            return self._body
        raise ValueError("not json")


def _make_raw_recorder(responses=None):
    """Binary-face mock: records raw requests, replays queued responses."""
    calls: list[dict] = []
    queued = list(responses or [])

    def raw_request_fn(method, url, *, headers=None, content=None):
        calls.append({"method": method, "url": url, "headers": headers or {}, "content": content})
        if queued:
            return queued.pop(0)
        return _RawResponse(status_code=200, content=b"", body={"success": True, "data": {}})

    return raw_request_fn, calls


def _client(response: dict | None = None, raw_responses=None):
    request_fn, calls = _make_recorder(response)
    raw_fn, raw_calls = _make_raw_recorder(raw_responses)
    client = EnvironmentsClient(request_fn, BASE, lambda: dict(AUTH), raw_request_fn=raw_fn)
    return client, calls, raw_calls


def _fail_envelope(status_ignored: int, code: str, message: str) -> dict:
    return {"success": False, "error": {"code": code, "message": message, "details": None}, "requestId": "req-fail"}


# ---------------------------------------------------------------------------
# Contract mirror — error code set + typed models
# ---------------------------------------------------------------------------



def test_gate_b_response_models_parse_camel_case_wire_fields():
    sent = EaasSendMessageResult.model_validate({
        "conversationId": "conv_1", "messageId": "msg_1", "runId": "run_1", "deduplicated": False
    })
    assert sent.run_id == "run_1"
    run = EaasRunView.model_validate({
        "runId": "run_1",
        "status": "completed",
        "recoveryState": "none",
        "message": {"conversationId": "conv_1", "messageId": "msg_1"},
        "artifactRefs": [],
        "durability": {"terminal": True, "artifactsConfirmed": False},
        "usage": {"promptTokens": 1, "completionTokens": 2},
        "createdAt": "2026-09-09T00:00:00.000Z",
        "startedAt": None,
        "completedAt": "2026-09-09T00:00:01.000Z",
    })
    assert run.artifact_refs == []
    key = EaasCreatedPublishableKey.model_validate({
        "id": "eak_1", "key": "pk-eaas-full", "keyPrefix": "pk-eaas", "name": "browser", "version": 1, "scopes": []
    })
    assert key.key_prefix == "pk-eaas"
    session = EaasPrincipalSessionView.model_validate({
        "id": "eps_1", "principalId": "prn_1", "projectId": "prj_1", "environmentId": "env_1",
        "provider": "identity", "scopes": [], "expiresAt": "2026-09-10T00:00:00.000Z",
        "revokedAt": None, "createdAt": "2026-09-09T00:00:00.000Z"
    })
    assert session.principal_id == "prn_1"

def test_error_code_set_pins_the_server_contract_exactly():
    # Global Constraint 5 — code → HTTP status. Any change on the server
    # contract must land here AND in sdk/cloud/src/environment-contract.ts.
    # Gate B T5/T7 additions (sessions + conversation faces) synced at Task 19.
    assert EAAS_ERROR_CODES == {
        "invalid_policy": 400,
        "invalid_request": 400,
        "invalid_token": 401,
        "invalid_session": 401,
        "publishable_key_invalid": 401,
        "session_expired": 401,
        "budget_exhausted": 402,
        "scope_denied": 403,
        "capability_denied": 403,
        "invalid_asset": 400,
        "not_owned": 404,
        "state_conflict": 409,
        "idempotency_conflict": 409,
        "revision_conflict": 412,
        "template_unavailable": 422,
        "capability_unavailable": 422,
        "quota_exceeded": 429,
        "rate_limited": 429,
        "warm_capacity_unavailable": 503,
        "provider_unavailable": 503,
        "pricing_unavailable": 503,
        "runtime_unavailable": 503,
    }


def test_status_and_warm_pool_models_parse_the_wire_shape():
    status = EnvironmentStatus.model_validate(_ok_data())
    assert status.environment_id == "env_testenvstatus000001"
    assert status.state == "provisioning"
    assert status.readiness.services is False
    assert status.readiness.agent is None
    assert status.startup_path == "cold"
    # round-trips back to camelCase wire keys
    dumped = status.model_dump(by_alias=True, exclude_none=True)
    assert dumped["environmentId"] == "env_testenvstatus000001"
    assert dumped["startupPath"] == "cold"

    pool = WarmPoolStatus.model_validate(
        {
            "revision": 4,
            "observedRevision": 4,
            "desired": {
                "minReady": 1,
                "maxReady": 2,
                "idleRetentionSeconds": 300,
                "dailyBudgetCredits": "10.000",
                "onMiss": "fail",
            },
            "effective": {"state": "ready", "ready": 1, "provisioning": 0, "terminating": 0},
            "cost": {
                "rateVersion": None,
                "estimatedHourlyCredits": "0.000",
                "spentTodayCredits": "0.025",
                "reservedCredits": "0.000",
                "remainingTodayCredits": "9.975",
                "periodStart": "2026-09-10T00:00:00Z",
                "periodEnd": "2026-09-11T00:00:00Z",
            },
        }
    )
    assert pool.desired.on_miss == "fail"
    assert pool.effective.ready == 1
    assert pool.cost.rate_version is None


def test_create_spec_serialises_camel_case_and_drops_nones():
    spec = EnvironmentCreateSpec(
        project_id="prj_abc",
        template="ubuntu@sha256:abc",
        profile="2c4g",
        pool_id="kind-alt",
        placement_id="kind-alt-place",
    )
    assert spec.model_dump(by_alias=True, exclude_none=True) == {
        "projectId": "prj_abc",
        "template": "ubuntu@sha256:abc",
        "profile": "2c4g",
        "poolId": "kind-alt",
        "placementId": "kind-alt-place",
    }
    assert EnvironmentCreateSpec().model_dump(by_alias=True, exclude_none=True) == {}


def test_eaas_client_error_carries_code():
    err = EaasClientError("timeout", "too slow")
    assert err.code == "timeout"
    assert "too slow" in str(err)


@pytest.mark.parametrize("profile", ["4c8g", "future-profile-v2"])
def test_create_spec_preserves_registry_profile(profile):
    spec = EnvironmentCreateSpec(profile=profile)
    assert spec.model_dump(by_alias=True, exclude_none=True) == {"profile": profile}


def test_status_retains_historical_mapping_coordinates():
    revisions = {
        "mappingRevision": "mapping-1", "profileRevision": "burst-1",
        "networkPolicyRevision": "network@1", "storagePolicyRevision": "ephemeral@1",
    }
    result = EnvironmentStatus(**_ok_data(revisions)).model_dump(by_alias=True, exclude_none=True)
    for key, value in revisions.items():
        assert result.get(key) == value


@pytest.mark.parametrize("reason", ["mapping_not_activated", "template_binding_required", "pricing_unavailable"])
def test_pool_status_retains_unavailability_and_mapping_projection(reason):
    data = {
        "poolId": "large", "placementId": "kind", "providerKind": "k8s",
        "mode": "cold", "default": True, "desired": {"minReady": 0, "maxReady": 0},
        "effectiveTarget": None, "state": "unknown", "available": False,
        "inventory": {"known": False, "source": "eaas", "ready": None,
                      "provisioning": None, "terminating": None, "observedAt": None},
        "retiredInventory": 0, "reason": reason,
        "mappingRevision": "m1", "profileRevision": "p1", "templateVersion": "t1",
        "networkPolicyRevision": "n1", "storagePolicyRevision": "s1",
        "resources": {"cpuRequest": "1000m", "cpuLimit": "4000m",
                      "memoryRequest": "4Gi", "memoryLimit": "8Gi"},
    }
    assert ProjectPoolStatus(**data).model_dump(by_alias=True) == data


# ---------------------------------------------------------------------------
# EnvironmentsClient — write surface idempotency headers
# ---------------------------------------------------------------------------


def test_create_posts_environments_with_auto_idempotency_key():
    client, calls, _ = _client()
    res = client.create({"projectId": "prj_abc", "template": "ubuntu@sha256:abc", "profile": "2c4g"})
    assert res["success"] is True
    assert len(calls) == 1
    call = calls[0]
    assert call["path"] == "/api/v1/environments"
    assert call["method"] == "POST"
    assert UUID_RE.match(call["headers"]["Idempotency-Key"])
    assert call["json"] == {"projectId": "prj_abc", "template": "ubuntu@sha256:abc", "profile": "2c4g"}


def test_create_allows_empty_spec_for_server_defaults():
    client, calls, _ = _client()
    res = client.create({})
    assert res["success"] is True
    assert calls[0]["path"] == "/api/v1/environments"
    assert calls[0]["json"] == {}
    assert UUID_RE.match(calls[0]["headers"]["Idempotency-Key"])


def test_eaas_context_gets_context_endpoint():
    request_fn, calls = _make_recorder({
        "success": True,
        "data": {
            "credential": {"kind": "machine", "keyId": "eak_1", "scopes": [], "expiresAt": None},
            "tenant": {"id": "tnt_1", "name": "Tenant"},
            "project": {"id": "prj_1", "name": "default"},
            "defaults": {"template": "node20-web", "profile": "2c4g", "ttlSeconds": 3600},
            "capabilities": {
                "templates": ["node20-web"],
                "profiles": ["2c4g"],
                "lifecycleActions": ["delete"],
                "placements": [{"id": "kind-local", "providerKind": "k8s", "region": "kind-local", "revision": 1}],
                "delegation": False,
            },
            "limits": {"maxTtlSeconds": 86400, "observedAt": "2026-09-24T00:00:00.000Z"},
        },
        "requestId": "req-ok",
    })
    client = EaasClient(request_fn)
    res = client.context()
    assert res["success"] is True
    assert res["data"]["capabilities"]["placements"][0]["providerKind"] == "k8s"
    assert res["data"]["capabilities"]["lifecycleActions"] == ["delete"]
    assert calls == [{"method": "GET", "path": "/api/v1/context", "json": None, "params": None, "headers": {}}]


@pytest.mark.asyncio
async def test_async_eaas_context_gets_context_endpoint():
    capabilities = {"placements": [{"id": "acs-place", "providerKind": "acs", "region": "cn", "revision": 1}], "lifecycleActions": ["pause", "wake", "delete"]}
    request_fn, calls = _make_async_recorder({"success": True, "data": {"capabilities": capabilities}, "requestId": "req-ok"})
    client = AsyncEaasClient(request_fn)
    res = await client.context()
    assert res["success"] is True
    assert res["data"]["capabilities"] == capabilities
    assert calls == [{"method": "GET", "path": "/api/v1/context", "json": None, "params": None, "headers": {}}]


def test_create_accepts_the_typed_spec_and_serialises_camel_case():
    client, calls, _ = _client()
    client.create(EnvironmentCreateSpec(project_id="prj_abc", template="t", profile="2c4g"))
    assert calls[0]["json"] == {"projectId": "prj_abc", "template": "t", "profile": "2c4g"}


def test_create_reuses_caller_supplied_key_across_retries():
    client, calls, _ = _client()
    for _ in range(2):
        client.create(
            {"projectId": "prj_abc", "template": "t", "profile": "2c4g"},
            idempotency_key="caller-fixed-key",
        )
    assert calls[0]["headers"]["Idempotency-Key"] == "caller-fixed-key"
    assert calls[1]["headers"]["Idempotency-Key"] == "caller-fixed-key"


def test_two_writes_get_distinct_auto_keys():
    client, calls, _ = _client()
    client.create({"projectId": "p", "template": "t", "profile": "2c4g"})
    client.create({"projectId": "p", "template": "t", "profile": "2c4g"})
    k1 = calls[0]["headers"]["Idempotency-Key"]
    k2 = calls[1]["headers"]["Idempotency-Key"]
    assert k1 and k2 and k1 != k2


def test_lifecycle_subpaths_post_with_idempotency_key():
    paused = {"success": True, "data": _ok_data({"state": "paused"}), "requestId": "r"}
    client, calls, _ = _client(paused)
    env_id = "env_testlifecycle000001"

    client.pause(env_id)
    assert calls[0]["path"] == f"/api/v1/environments/{env_id}/pause"
    assert calls[0]["method"] == "POST"
    assert UUID_RE.match(calls[0]["headers"]["Idempotency-Key"])

    client.wake(env_id, idempotency_key="wake-key-1")
    assert calls[1]["path"] == f"/api/v1/environments/{env_id}/wake"
    assert calls[1]["headers"]["Idempotency-Key"] == "wake-key-1"

    client.suspend(env_id)
    assert calls[2]["path"] == f"/api/v1/environments/{env_id}/suspend"
    assert UUID_RE.match(calls[2]["headers"]["Idempotency-Key"])


def test_delete_sends_delete_with_idempotency_key():
    client, calls, _ = _client()
    client.delete("env_testdeleterow000001")
    assert calls[0]["method"] == "DELETE"
    assert calls[0]["path"] == "/api/v1/environments/env_testdeleterow000001"
    assert UUID_RE.match(calls[0]["headers"]["Idempotency-Key"])


# ---------------------------------------------------------------------------
# EnvironmentsClient — read surface
# ---------------------------------------------------------------------------


def test_get_reads_the_environment_path():
    client, calls, _ = _client()
    client.get("env_testreadsingle00001")
    assert calls[0]["path"] == "/api/v1/environments/env_testreadsingle00001"
    assert calls[0]["method"] == "GET"
    assert calls[0]["headers"] == {}


def test_list_forwards_cursor_and_limit():
    client, calls, _ = _client({"success": True, "data": {"environments": [], "nextCursor": None}, "requestId": "r"})
    client.list(cursor="abc", limit=20)
    assert calls[0]["path"] == "/api/v1/environments"
    assert calls[0]["params"] == {"cursor": "abc", "limit": 20}


def test_list_without_options_omits_params():
    client, calls, _ = _client()
    client.list()
    assert calls[0]["params"] is None


# ---------------------------------------------------------------------------
# EnvironmentsClient — exec / files / snapshots / services
# ---------------------------------------------------------------------------


def test_exec_posts_command_body_with_idempotency_key():
    client, calls, _ = _client(
        {
            "success": True,
            "data": {
                "execId": "exec_1", "status": "exited", "exitCode": 0,
                "stdout": "ok", "stderr": "", "startedAt": "t", "finishedAt": "t",
            },
            "requestId": "r",
        }
    )
    client.exec("env_testexecsurface0001", ["echo", "hi"], timeout_ms=5000)
    assert calls[0]["path"] == "/api/v1/environments/env_testexecsurface0001/execs"
    assert calls[0]["method"] == "POST"
    assert calls[0]["json"] == {"command": ["echo", "hi"], "timeoutMs": 5000}
    assert UUID_RE.match(calls[0]["headers"]["Idempotency-Key"])


def test_exec_without_timeout_omits_the_field():
    client, calls, _ = _client()
    client.exec("env_1", ["true"])
    assert calls[0]["json"] == {"command": ["true"]}


def test_get_exec_reads_the_handle_with_cursor():
    client, calls, _ = _client()
    client.get_exec("env_testexecsurface0001", "exec_1", cursor=1024)
    assert calls[0]["path"] == "/api/v1/environments/env_testexecsurface0001/execs/exec_1"
    assert calls[0]["params"] == {"cursor": 1024}


def test_put_file_uses_the_raw_seam_with_octet_stream_and_auth():
    raw_fn, raw_calls = _make_raw_recorder(
        [_RawResponse(body={"success": True, "data": {"environmentId": "env_1", "path": "a/b.txt", "size": 5, "sha256": "deadbeef"}})]
    )
    request_fn, _ = _make_recorder()
    client = EnvironmentsClient(request_fn, BASE, lambda: dict(AUTH), raw_request_fn=raw_fn)

    res = client.put_file("env_testfileputcase0001", "a/b.txt", b"hello")
    assert res["data"]["sha256"] == "deadbeef"
    call = raw_calls[0]
    assert call["method"] == "PUT"
    assert call["url"] == f"{BASE}/api/v1/environments/env_testfileputcase0001/files/a/b.txt"
    assert call["headers"]["Content-Type"] == "application/octet-stream"
    # the raw seam is authenticated — the JSON pipeline default headers do not apply here
    assert call["headers"]["Authorization"] == "Bearer sk-eaas-live-testtoken"
    assert call["content"] == b"hello"


def test_put_file_encodes_each_path_segment_individually():
    raw_fn, raw_calls = _make_raw_recorder()
    request_fn, _ = _make_recorder()
    client = EnvironmentsClient(request_fn, BASE, lambda: dict(AUTH), raw_request_fn=raw_fn)
    client.put_file("env id", "a dir/b file.txt", b"x")
    assert raw_calls[0]["url"].endswith("/api/v1/environments/env%20id/files/a%20dir/b%20file.txt")


def test_get_file_returns_bytes_and_sha256_header():
    request_fn, _ = _make_recorder()
    raw_fn, raw_calls = _make_raw_recorder(
        [_RawResponse(content=b"file-bytes", headers={"X-Eaas-File-Sha256": "cafebabe"})]
    )
    client = EnvironmentsClient(request_fn, BASE, lambda: dict(AUTH), raw_request_fn=raw_fn)

    res = client.get_file("env_testfilegetcase0001", "a/b.txt")
    assert res["success"] is True
    assert res["bytes"] == b"file-bytes"
    assert res["sha256"] == "cafebabe"  # case-insensitive header lookup
    assert raw_calls[0]["method"] == "GET"
    assert raw_calls[0]["headers"]["Authorization"] == "Bearer sk-eaas-live-testtoken"


def test_put_file_bare_404_synthesizes_http_error_envelope():
    # FF off → bare 404 with an empty body; json() raises.
    request_fn, _ = _make_recorder()
    raw_fn, _ = _make_raw_recorder([_RawResponse(status_code=404)])
    client = EnvironmentsClient(request_fn, BASE, lambda: dict(AUTH), raw_request_fn=raw_fn)

    res = client.put_file("env_testfileputffoff0001", "a.txt", b"x")
    assert res["success"] is False
    assert res["error"]["code"] == "http_error"
    assert "404" in res["error"]["message"]
    assert res["requestId"] == ""


def test_put_file_gateway_html_body_also_lands_on_http_error():
    request_fn, _ = _make_recorder()
    raw_fn, _ = _make_raw_recorder([_RawResponse(status_code=502, content=b"<html>oops</html>")])
    client = EnvironmentsClient(request_fn, BASE, lambda: dict(AUTH), raw_request_fn=raw_fn)

    res = client.put_file("env_testfileputhtml0001", "a.txt", b"x")
    assert res["success"] is False
    assert res["error"]["code"] == "http_error"


def test_put_file_server_error_envelope_passes_through_verbatim():
    envelope = _fail_envelope(409, "state_conflict", "environment not running")
    request_fn, _ = _make_recorder()
    raw_fn, _ = _make_raw_recorder([_RawResponse(status_code=409, body=envelope)])
    client = EnvironmentsClient(request_fn, BASE, lambda: dict(AUTH), raw_request_fn=raw_fn)

    res = client.put_file("env_testfileputconflict01", "a.txt", b"x")
    assert res == envelope
    assert res["error"]["code"] == "state_conflict"


def test_get_file_error_response_goes_through_the_same_envelope_path():
    request_fn, _ = _make_recorder()
    raw_fn, _ = _make_raw_recorder([_RawResponse(status_code=404)])
    client = EnvironmentsClient(request_fn, BASE, lambda: dict(AUTH), raw_request_fn=raw_fn)

    res = client.get_file("env_testfilegetmiss0001", "missing.txt")
    assert res["success"] is False
    assert res["error"]["code"] == "http_error"


def test_snapshot_face_hits_the_snapshot_subpaths():
    client, calls, _ = _client(
        {"success": True, "data": {"environmentId": "env_1", "snapshotId": "snap_1", "state": "pending", "operationId": "op_1"}, "requestId": "r"}
    )
    env_id = "env_testsnapshotface001"

    client.create_snapshot(env_id)
    assert calls[0]["path"] == f"/api/v1/environments/{env_id}/snapshots"
    assert calls[0]["method"] == "POST"
    assert UUID_RE.match(calls[0]["headers"]["Idempotency-Key"])

    client.list_snapshots(env_id)
    assert calls[1]["path"] == f"/api/v1/environments/{env_id}/snapshots"
    assert calls[1]["method"] == "GET"

    client.restore(env_id, "snap_9", idempotency_key="restore-key-1")
    assert calls[2]["path"] == f"/api/v1/environments/{env_id}/snapshots/snap_9/restore"
    assert calls[2]["method"] == "POST"
    assert calls[2]["headers"]["Idempotency-Key"] == "restore-key-1"


def test_list_services_reads_the_services_projection():
    client, calls, _ = _client(
        {"success": True, "data": {"environmentId": "env_1", "services": [], "gatewayUrl": "https://gw/x"}, "requestId": "r"}
    )
    client.list_services("env_testservicesproj001")
    assert calls[0]["path"] == "/api/v1/environments/env_testservicesproj001/services"


# ---------------------------------------------------------------------------
# wait_until_ready — readiness-driven polling
# ---------------------------------------------------------------------------


def test_wait_until_ready_polls_until_services_flip_true():
    calls = {"n": 0}

    def request_fn(method, path, *, json=None, params=None, headers=None):
        calls["n"] += 1
        ready = calls["n"] >= 3
        return {
            "success": True,
            "data": _ok_data({"readiness": {"sandbox": True, "services": ready, "agent": None}}),
            "requestId": "r",
        }

    client = EnvironmentsClient(request_fn, BASE, lambda: dict(AUTH))
    status = client.wait_until_ready("env_testwaitready00001", timeout_ms=2000, poll_ms=1)
    assert status["readiness"]["services"] is True
    assert calls["n"] == 3


def test_wait_until_ready_rejects_agent_capability_without_polling():
    request_fn, calls = _make_recorder()
    client = EnvironmentsClient(request_fn, BASE, lambda: dict(AUTH))
    with pytest.raises(EaasClientError) as excinfo:
        client.wait_until_ready("env_testwaitagent000001", capability="agent")
    assert excinfo.value.code == "capability_unavailable"
    assert calls == []


def test_wait_until_ready_times_out():
    request_fn, _ = _make_recorder(
        {"success": True, "data": _ok_data({"readiness": {"sandbox": True, "services": False, "agent": None}}), "requestId": "r"}
    )
    client = EnvironmentsClient(request_fn, BASE, lambda: dict(AUTH))
    with pytest.raises(EaasClientError) as excinfo:
        client.wait_until_ready("env_testwaittimeout0001", timeout_ms=40, poll_ms=10)
    assert excinfo.value.code == "timeout"


def test_wait_until_ready_propagates_the_server_code():
    request_fn, _ = _make_recorder(_fail_envelope(404, "not_owned", "no such environment"))
    client = EnvironmentsClient(request_fn, BASE, lambda: dict(AUTH))
    with pytest.raises(EaasClientError) as excinfo:
        client.wait_until_ready("env_testwaitnotowned01", timeout_ms=500, poll_ms=10)
    assert excinfo.value.code == "not_owned"


# ---------------------------------------------------------------------------
# WarmPoolClient — If-Match bare revision + 503 fail-through
# ---------------------------------------------------------------------------


def test_warm_pool_get_reads_the_project_path():
    request_fn, calls = _make_recorder({"success": True, "data": {"revision": 1}, "requestId": "r"})
    WarmPoolClient(request_fn).get("prj_warmpoolget00001")
    assert calls[0]["path"] == "/api/v1/projects/prj_warmpoolget00001/warm-pool"
    assert calls[0]["method"] == "GET"


def test_warm_pool_patch_sends_bare_if_match_and_key_and_body():
    request_fn, calls = _make_recorder({"success": True, "data": {"revision": 4}, "requestId": "r"})
    policy = {
        "minReady": 1,
        "maxReady": 2,
        "idleRetentionSeconds": 300,
        "dailyBudgetCredits": "10.000",
        "onMiss": "fail",
    }
    WarmPoolClient(request_fn).patch(
        "prj_warmpoolpatch0001", policy, revision=3, dry_run=True, idempotency_key="fixed-key"
    )
    call = calls[0]
    assert call["path"] == "/api/v1/projects/prj_warmpoolpatch0001/warm-pool"
    assert call["method"] == "PATCH"
    # T8-(d) contract: the server parseIfMatch only accepts a bare integer —
    # no weak-validator quoting, no etag quotes.
    assert call["headers"]["If-Match"] == "3"
    assert call["headers"]["Idempotency-Key"] == "fixed-key"
    assert call["json"] == {"policy": policy, "dryRun": True}


def test_warm_pool_patch_omits_dry_run_when_not_asked():
    request_fn, calls = _make_recorder()
    WarmPoolClient(request_fn).patch("prj_1", {"onMiss": "fail"}, revision=0)
    assert calls[0]["json"] == {"policy": {"onMiss": "fail"}}
    assert UUID_RE.match(calls[0]["headers"]["Idempotency-Key"])


def test_warm_pool_503_passes_through_verbatim_no_retry_no_cold_downgrade():
    fail = _fail_envelope(503, "warm_capacity_unavailable", "no warm capacity and onMiss=fail")
    request_fn, calls = _make_recorder(fail)
    policy = WarmPoolPolicy(
        min_ready=1, max_ready=2, idle_retention_seconds=300,
        daily_budget_credits="10.000", on_miss="fail",
    )

    res: dict = WarmPoolClient(request_fn).patch(
        "prj_warmpool503case0001", policy, revision=3, idempotency_key="fixed-key"
    )
    assert res == fail
    assert res["error"]["code"] == "warm_capacity_unavailable"
    assert "onMiss=fail" in res["error"]["message"]
    # Exactly one HTTP attempt: no SDK-side retry loop.
    assert len(calls) == 1
    # The request body was NOT rewritten to degrade onMiss fail → cold.
    assert calls[0]["json"]["policy"]["onMiss"] == "fail"


def test_warm_pool_get_not_owned_surfaces_the_fail_envelope():
    request_fn, _ = _make_recorder(_fail_envelope(404, "not_owned", "project not found"))
    res = WarmPoolClient(request_fn).get("prj_notownedcase0001")
    assert res["success"] is False
    assert res["error"]["code"] == "not_owned"



# ---------------------------------------------------------------------------
# Gate B T14 parity — sessions, conversations, runs, publishable keys
# ---------------------------------------------------------------------------


def test_environment_principal_conversation_and_run_paths_are_exposed():
    client, calls, _ = _client()
    client.issue_session({"anonymous": True, "environmentId": "env_1"})
    client.ensure_conversation("env_1")
    client.list_conversations("env_1")
    client.send_message("env_1", "conv_1", "hello", idempotency_key="msg-key")
    client.list_messages("env_1", "conv_1", limit=25)
    client.get_run("env_1", "run_1")
    client.cancel_run("env_1", "run_1")
    client.list_run_events("env_1", "run_1", cursor="2026-09-09T00:00:00.000Z", limit=20)
    client.list_sessions("env_1", limit=10)
    client.revoke_session("env_1", "eps_1")
    client.billing("prj_1", from_="2026-09-11T00:00:00.000Z", limit=5)
    client.issue_access_session(
        "env_1",
        {"subject": "end-user-42", "scopes": ["exec:read"], "ttlSeconds": 600},
        idempotency_key="delegate-key-1",
    )
    client.list_access_sessions("env_1", limit=3, cursor="page/+2")
    client.revoke_access_session("env_1", "psess_1")

    assert calls[0] == {"method": "POST", "path": "/api/v1/sessions", "json": {"anonymous": True, "environmentId": "env_1"}, "params": None, "headers": {}}
    assert calls[1]["path"] == "/api/v1/environments/env_1/conversations"
    # ensure_conversation is NOT idempotency-keyed — the server route ignores the
    # header entirely (empty-body contract; the TS client never sent one).
    assert calls[1]["headers"] == {}
    assert calls[2]["method"] == "GET"
    assert calls[2]["path"] == "/api/v1/environments/env_1/conversations"
    assert calls[3]["path"] == "/api/v1/environments/env_1/conversations/conv_1/messages"
    assert calls[11]["path"] == "/api/v1/environments/env_1/access-sessions"
    assert calls[11]["json"] == {"subject": "end-user-42", "scopes": ["exec:read"], "ttlSeconds": 600}
    assert calls[11]["headers"]["Idempotency-Key"] == "delegate-key-1"
    assert calls[12]["path"] == "/api/v1/environments/env_1/access-sessions"
    assert calls[12]["params"] == {"limit": 3, "cursor": "page/+2"}
    assert calls[13]["path"] == "/api/v1/environments/env_1/access-sessions/psess_1/revoke"
    assert calls[3]["json"] == {"content": "hello"}
    assert calls[3]["headers"]["Idempotency-Key"] == "msg-key"
    assert calls[4]["params"] == {"limit": 25}
    assert calls[5]["path"] == "/api/v1/environments/env_1/runs/run_1"
    assert calls[6]["path"] == "/api/v1/environments/env_1/runs/run_1/cancel"
    assert calls[7]["params"] == {"cursor": "2026-09-09T00:00:00.000Z", "limit": 20}
    assert calls[8]["path"] == "/api/v1/environments/env_1/sessions"
    assert calls[8]["params"] == {"limit": 10}
    assert calls[9]["path"] == "/api/v1/environments/env_1/sessions/eps_1/revoke"
    assert calls[10]["path"] == "/api/v1/projects/prj_1/billing"
    assert calls[10]["params"] == {"from": "2026-09-11T00:00:00.000Z", "limit": 5}


def test_publishable_keys_client_uses_project_management_paths():
    request_fn, calls = _make_recorder()
    client = PublishableKeysClient(request_fn)
    client.list("prj_1", limit=10)
    client.create("prj_1", name="browser", scopes=["env:exec"])
    client.revoke("prj_1", "eak_1")

    assert calls[0]["method"] == "GET"
    assert calls[0]["path"] == "/api/v1/projects/prj_1/publishable-keys"
    assert calls[0]["params"] == {"limit": 10}
    assert calls[1]["method"] == "POST"
    assert calls[1]["json"] == {"name": "browser", "scopes": ["env:exec"]}
    assert calls[2]["path"] == "/api/v1/projects/prj_1/publishable-keys/eak_1/revoke"


@pytest.mark.asyncio
async def test_async_environment_and_publishable_key_parity_paths():
    request_fn, calls = _make_async_recorder()
    envs = AsyncEnvironmentsClient(request_fn, BASE, lambda: dict(AUTH))
    keys = AsyncPublishableKeysClient(request_fn)
    await envs.issue_session({"anonymous": True})
    await envs.send_message("env_1", "conv_1", "hello", idempotency_key="msg-key")
    await envs.cancel_run("env_1", "run_1")
    await envs.billing("prj_1", limit=5)
    await keys.create("prj_1", name="browser")
    await envs.issue_access_session("env_1", {"subject": "end-user-42"}, idempotency_key="delegate-key-1")
    await envs.list_access_sessions("env_1", limit=2, cursor="page/+2")
    await envs.revoke_access_session("env_1", "psess_1")

    assert calls[0]["path"] == "/api/v1/sessions"
    assert calls[1]["path"] == "/api/v1/environments/env_1/conversations/conv_1/messages"
    assert calls[1]["headers"]["Idempotency-Key"] == "msg-key"
    assert calls[2]["path"] == "/api/v1/environments/env_1/runs/run_1/cancel"
    assert calls[3]["path"] == "/api/v1/projects/prj_1/billing"
    assert calls[3]["params"] == {"limit": 5}
    assert calls[5]["path"] == "/api/v1/environments/env_1/access-sessions"
    assert calls[5]["headers"]["Idempotency-Key"] == "delegate-key-1"
    assert calls[6]["path"] == "/api/v1/environments/env_1/access-sessions"
    assert calls[6]["params"] == {"limit": 2, "cursor": "page/+2"}
    assert calls[7]["path"] == "/api/v1/environments/env_1/access-sessions/psess_1/revoke"
    assert calls[4]["path"] == "/api/v1/projects/prj_1/publishable-keys"
    assert calls[4]["json"] == {"name": "browser"}


# ---------------------------------------------------------------------------
# Async face — pins the same wire contract (create + 503 fail-through + files)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_async_create_and_lifecycle_match_the_sync_wire_contract():
    request_fn, calls = _make_async_recorder()
    client = AsyncEnvironmentsClient(request_fn, BASE, lambda: dict(AUTH))
    await client.create({"projectId": "p", "template": "t", "profile": "2c4g"}, idempotency_key="k1")
    await client.pause("env_1", idempotency_key="k2")
    assert calls[0]["path"] == "/api/v1/environments"
    assert calls[0]["headers"]["Idempotency-Key"] == "k1"
    assert calls[1]["path"] == "/api/v1/environments/env_1/pause"
    assert calls[1]["headers"]["Idempotency-Key"] == "k2"


@pytest.mark.asyncio
async def test_async_warm_pool_503_passes_through_verbatim():
    request_fn, calls = _make_async_recorder(
        _fail_envelope(503, "warm_capacity_unavailable", "no warm capacity and onMiss=fail")
    )
    res = await AsyncWarmPoolClient(request_fn).patch("prj_1", {"onMiss": "fail"}, revision=2)
    assert res["error"]["code"] == "warm_capacity_unavailable"
    assert len(calls) == 1
    assert calls[0]["headers"]["If-Match"] == "2"


@pytest.mark.asyncio
async def test_async_put_and_get_file_use_the_raw_seam():
    request_fn, _ = _make_async_recorder()
    raw_fn, raw_calls = _make_async_raw_recorder(
        [
            _RawResponse(body={"success": True, "data": {"sha256": "a"}}),
            _RawResponse(content=b"bytes", headers={"x-eaas-file-sha256": "b"}),
        ]
    )
    client = AsyncEnvironmentsClient(request_fn, BASE, lambda: dict(AUTH), raw_request_fn=raw_fn)
    await client.put_file("env_1", "a.txt", b"hello")
    got = await client.get_file("env_1", "a.txt")
    assert raw_calls[0]["method"] == "PUT"
    assert raw_calls[0]["content"] == b"hello"
    assert raw_calls[0]["headers"]["Content-Type"] == "application/octet-stream"
    assert got == {"success": True, "bytes": b"bytes", "sha256": "b"}


@pytest.mark.asyncio
async def test_async_wait_until_ready_rejects_agent_capability():
    request_fn, calls = _make_async_recorder()
    client = AsyncEnvironmentsClient(request_fn, BASE, lambda: dict(AUTH))
    with pytest.raises(EaasClientError) as excinfo:
        await client.wait_until_ready("env_1", capability="agent")
    assert excinfo.value.code == "capability_unavailable"
    assert calls == []


# ---------------------------------------------------------------------------
# update — PATCH with If-Match bare revision (fix round 1 / C2)
# ---------------------------------------------------------------------------


def test_update_patches_with_bare_if_match_revision():
    client, calls, _ = _client()
    body = {"expiresAt": "2026-09-11T00:00:00.000Z", "metadata": {"k": "v"}}
    client.update("env_testupdaterev0000001", body, revision=7)
    call = calls[0]
    assert call["path"] == "/api/v1/environments/env_testupdaterev0000001"
    assert call["method"] == "PATCH"
    # server parseIfMatch only accepts a bare non-negative integer — no W/"…".
    assert call["headers"]["If-Match"] == "7"
    # update is NOT idempotency-keyed (it is a revision-CAS write, like TS)
    assert "Idempotency-Key" not in call["headers"]
    assert call["json"] == body


def test_update_accepts_partial_bodies():
    client, calls, _ = _client()
    client.update("env_1", {"metadata": {"only": "this"}}, revision=0)
    assert calls[0]["json"] == {"metadata": {"only": "this"}}
    assert calls[0]["headers"]["If-Match"] == "0"


@pytest.mark.asyncio
async def test_async_update_patches_with_bare_if_match_revision():
    request_fn, calls = _make_async_recorder()
    client = AsyncEnvironmentsClient(request_fn, BASE, lambda: dict(AUTH))
    await client.update("env_1", {"metadata": {"k": "v"}}, revision=3)
    assert calls[0]["method"] == "PATCH"
    assert calls[0]["path"] == "/api/v1/environments/env_1"
    assert calls[0]["headers"]["If-Match"] == "3"


# ---------------------------------------------------------------------------
# usage — project metering ledger (Gate B Task 19, mirrors TS usage() tests)
# ---------------------------------------------------------------------------

_USAGE_PAGE = {
    "items": [
        {
            "intervalStart": "2026-09-10T00:00:00.000Z",
            "dimension": "warm_compute",
            "seconds": 60,
            "credits": "0.025000",
            "rateVersion": "r1",
            "resourceId": "inv_1",
            "environmentId": "env_1",
        },
        {
            "intervalStart": "2026-09-10T00:01:00.000Z",
            "dimension": "environment_compute",
            "seconds": 30,
            "credits": "0.010000",
            "rateVersion": "r1",
            "resourceId": "env_1",
        },
    ],
    "nextCursor": "aW52XzE6NjA=",
    "rateVersion": "r1",
    "periodSpent": {"warmCredits": "0.025000", "activeCredits": "0.010000"},
}


def test_usage_reads_the_project_usage_path_with_query_params():
    client, calls, _ = _client({"success": True, "data": _USAGE_PAGE, "requestId": "r"})
    res = client.usage(
        "prj_usageface0000001",
        from_="2026-09-10T00:00:00.000Z",
        to="2026-09-11T00:00:00.000Z",
        cursor="aW52XzE6NjA=",
        limit=25,
    )
    assert res["success"] is True
    assert res["data"] == _USAGE_PAGE
    assert calls[0]["method"] == "GET"
    assert calls[0]["path"] == "/api/v1/projects/prj_usageface0000001/usage"
    assert calls[0]["params"] == {
        "from": "2026-09-10T00:00:00.000Z",
        "to": "2026-09-11T00:00:00.000Z",
        "cursor": "aW52XzE6NjA=",
        "limit": 25,
    }


def test_usage_omits_unset_params():
    client, calls, _ = _client({"success": True, "data": _USAGE_PAGE, "requestId": "r"})
    client.usage("prj_usagedefaultwin01")
    assert calls[0]["path"] == "/api/v1/projects/prj_usagedefaultwin01/usage"
    assert calls[0]["params"] is None


def test_usage_passes_server_denials_through_verbatim():
    client, _, _ = _client(_fail_envelope(404, "not_owned", "project not found"))
    res = client.usage("prj_usagenotowned0001")
    assert res["success"] is False
    assert res["error"]["code"] == "not_owned"

    client2, _, _ = _client(_fail_envelope(403, "scope_denied", "key is pinned to project prj_other"))
    res2 = client2.usage("prj_usagepinned00001")
    assert res2["success"] is False
    assert res2["error"]["code"] == "scope_denied"


@pytest.mark.asyncio
async def test_async_usage_matches_the_sync_wire_contract():
    request_fn, calls = _make_async_recorder({"success": True, "data": _USAGE_PAGE, "requestId": "r"})
    client = AsyncEnvironmentsClient(request_fn, BASE, lambda: dict(AUTH))
    res = await client.usage("prj_usageasync0000001", limit=10)
    assert res["success"] is True
    assert calls[0]["path"] == "/api/v1/projects/prj_usageasync0000001/usage"
    assert calls[0]["params"] == {"limit": 10}


# ---------------------------------------------------------------------------
# send_message — multimodal contentBlocks + HITL answer kwargs (additive)
# ---------------------------------------------------------------------------


def test_send_message_default_body_stays_exactly_content_only():
    client, calls, _ = _client()
    client.send_message("env_1", "conv_1", "hello", idempotency_key="msg-key")
    assert calls[0]["json"] == {"content": "hello"}


def test_send_message_adds_content_blocks_and_answer_only_when_supplied():
    client, calls, _ = _client()
    blocks = [{"kind": "image", "assetId": "asset_1", "mediaType": "image/png"}]
    client.send_message(
        "env_1", "conv_1", "look",
        content_blocks=blocks,
        answer={"questionId": "run_1#q1", "optionId": "opt_a"},
        idempotency_key="msg-key",
    )
    assert calls[0]["json"] == {
        "content": "look",
        "contentBlocks": blocks,
        "answer": {"questionId": "run_1#q1", "optionId": "opt_a"},
    }
    # kwargs are independent — answer alone keeps the body minimal.
    client.send_message("env_1", "conv_1", "ans", answer={"questionId": "run_1#q1"})
    assert calls[1]["json"] == {"content": "ans", "answer": {"questionId": "run_1#q1"}}


# ---------------------------------------------------------------------------
# upload_asset — raw seam POST (multimodal asset front door, TS mirror)
# ---------------------------------------------------------------------------


def test_upload_asset_posts_bytes_with_declared_media_type():
    request_fn, _ = _make_recorder()
    raw_fn, raw_calls = _make_raw_recorder(
        [_RawResponse(body={"success": True, "data": {"assetId": "asset_1", "contentHash": "h", "sizeBytes": 3, "mediaType": "image/png", "deduplicated": False}})]
    )
    client = EnvironmentsClient(request_fn, BASE, lambda: dict(AUTH), raw_request_fn=raw_fn)

    res = client.upload_asset("env_testassetupload01", b"abc", "image/jpeg")
    assert res["data"]["assetId"] == "asset_1"
    call = raw_calls[0]
    assert call["method"] == "POST"
    assert call["url"] == f"{BASE}/api/v1/environments/env_testassetupload01/assets"
    assert call["headers"]["Content-Type"] == "image/jpeg"
    assert call["headers"]["Authorization"] == "Bearer sk-eaas-live-testtoken"
    assert call["content"] == b"abc"


def test_upload_asset_defaults_to_image_png():
    request_fn, _ = _make_recorder()
    raw_fn, raw_calls = _make_raw_recorder()
    client = EnvironmentsClient(request_fn, BASE, lambda: dict(AUTH), raw_request_fn=raw_fn)
    client.upload_asset("env_1", b"x")
    assert raw_calls[0]["headers"]["Content-Type"] == "image/png"


def test_upload_asset_bare_404_synthesizes_http_error_envelope():
    request_fn, _ = _make_recorder()
    raw_fn, _ = _make_raw_recorder([_RawResponse(status_code=404)])
    client = EnvironmentsClient(request_fn, BASE, lambda: dict(AUTH), raw_request_fn=raw_fn)
    res = client.upload_asset("env_1", b"x")
    assert res["success"] is False
    assert res["error"]["code"] == "http_error"


# ---------------------------------------------------------------------------
# artifacts — list (envelope) + content download (raw seam)
# ---------------------------------------------------------------------------


_ARTIFACT_PAGE = {
    "environmentId": "env_1",
    "artifacts": [
        {
            "artifactId": "eart_1",
            "filename": "report.md",
            "mime": "text/markdown",
            "contentHash": "deadbeef",
            "sizeBytes": 12,
            "conversationId": "conv_1",
            "messageId": "msg_1",
            "createdAt": "2026-09-09T00:00:00.000Z",
        }
    ],
    "truncated": False,
}


def test_list_artifacts_reads_the_artifacts_path_with_limit():
    client, calls, _ = _client({"success": True, "data": _ARTIFACT_PAGE, "requestId": "r"})
    res = client.list_artifacts("env_testartifactlist1", limit=25)
    assert res["data"] == _ARTIFACT_PAGE
    assert calls[0]["method"] == "GET"
    assert calls[0]["path"] == "/api/v1/environments/env_testartifactlist1/artifacts"
    assert calls[0]["params"] == {"limit": 25}


def test_list_artifacts_without_limit_omits_params():
    client, calls, _ = _client({"success": True, "data": _ARTIFACT_PAGE, "requestId": "r"})
    client.list_artifacts("env_1")
    assert calls[0]["params"] is None


def test_get_artifact_returns_bytes_and_artifact_sha256_header():
    request_fn, _ = _make_recorder()
    raw_fn, raw_calls = _make_raw_recorder(
        [_RawResponse(content=b"artifact-bytes", headers={"X-Eaas-Artifact-Sha256": "cafebabe"})]
    )
    client = EnvironmentsClient(request_fn, BASE, lambda: dict(AUTH), raw_request_fn=raw_fn)

    res = client.get_artifact("env_testartifactget001", "eart_1")
    assert res == {"success": True, "bytes": b"artifact-bytes", "sha256": "cafebabe"}
    call = raw_calls[0]
    assert call["method"] == "GET"
    assert call["url"] == f"{BASE}/api/v1/environments/env_testartifactget001/artifacts/eart_1"
    assert call["headers"]["Authorization"] == "Bearer sk-eaas-live-testtoken"


def test_get_artifact_miss_goes_through_the_fail_envelope_path():
    request_fn, _ = _make_recorder()
    raw_fn, _ = _make_raw_recorder([_RawResponse(status_code=404)])
    client = EnvironmentsClient(request_fn, BASE, lambda: dict(AUTH), raw_request_fn=raw_fn)
    res = client.get_artifact("env_testartifactmiss01", "eart_x")
    assert res["success"] is False
    assert res["error"]["code"] == "http_error"


# ---------------------------------------------------------------------------
# list_events — tenant-level JSON replay
# ---------------------------------------------------------------------------


_EVENT_PAGE = {"events": [], "nextCursor": "42", "truncated": False}


def test_list_events_joins_cursor_limit_and_csv_filters():
    client, calls, _ = _client({"success": True, "data": _EVENT_PAGE, "requestId": "r"})
    res = client.list_events(
        cursor="7", limit=100, environment_ids=["env_1", "env_2"], project_ids=["prj_1"],
    )
    assert res["data"] == _EVENT_PAGE
    assert calls[0]["method"] == "GET"
    assert calls[0]["path"] == "/api/v1/events"
    assert calls[0]["params"] == {
        "cursor": "7",
        "limit": 100,
        "environmentIds": "env_1,env_2",
        "projectIds": "prj_1",
    }


def test_list_events_without_options_omits_params():
    client, calls, _ = _client({"success": True, "data": _EVENT_PAGE, "requestId": "r"})
    client.list_events()
    assert calls[0]["params"] is None


def test_list_events_surfaces_the_409_state_conflict_resync_envelope_verbatim():
    fail = _fail_envelope(
        409, "state_conflict", "event cursor is no longer serviceable — resync from an authorized snapshot"
    )
    fail["error"]["details"] = {"resync": "eaas.resync", "lastSeq": "128"}
    client, _, _ = _client(fail)
    res = client.list_events(cursor="1")
    assert res == fail
    assert res["error"]["code"] == "state_conflict"
    assert res["error"]["details"]["lastSeq"] == "128"


# ---------------------------------------------------------------------------
# EaasSkillsClient — tenant-private skill catalog (operator-only face)
# ---------------------------------------------------------------------------


_SKILL_VIEW = {
    "skillId": "eskl_1",
    "tenantId": "tnt_1",
    "slug": "report-writer",
    "name": "Report Writer",
    "description": "",
    "license": "",
    "status": "private",
    "contentManifest": None,
    "approvalId": None,
    "publishedAt": None,
    "createdAt": "2026-09-09T00:00:00.000Z",
    "updatedAt": "2026-09-09T00:00:00.000Z",
}


def test_skills_client_hits_the_tenant_scoped_root_paths():
    request_fn, calls = _make_recorder({"success": True, "data": _SKILL_VIEW, "requestId": "r"})
    client = EaasSkillsClient(request_fn)

    client.list(status="private")
    assert calls[0]["method"] == "GET"
    assert calls[0]["path"] == "/api/v1/skills"
    assert calls[0]["params"] == {"status": "private"}

    client.create({"slug": "report-writer", "name": "Report Writer", "content": "body"})
    assert calls[1]["method"] == "POST"
    assert calls[1]["path"] == "/api/v1/skills"
    assert calls[1]["json"] == {"slug": "report-writer", "name": "Report Writer", "content": "body"}
    # The face is NOT idempotency-keyed (publish dedup rides the approval
    # operationKey; CRUD is a direct state flip — server route declaration).
    assert calls[1]["headers"] == {}

    client.get("eskl_1")
    assert calls[2]["path"] == "/api/v1/skills/eskl_1"

    client.update("eskl_1", {"description": "updated"})
    assert calls[3]["method"] == "PATCH"
    assert calls[3]["path"] == "/api/v1/skills/eskl_1"
    assert calls[3]["json"] == {"description": "updated"}

    client.delete("eskl_1")
    assert calls[4]["method"] == "DELETE"
    assert calls[4]["path"] == "/api/v1/skills/eskl_1"

    client.publish("eskl_1")
    assert calls[5]["method"] == "POST"
    assert calls[5]["path"] == "/api/v1/skills/eskl_1/publish"


def test_skills_list_without_status_omits_params():
    request_fn, calls = _make_recorder({"success": True, "data": {"skills": []}, "requestId": "r"})
    EaasSkillsClient(request_fn).list()
    assert calls[0]["params"] is None


def test_skills_publish_surfaces_the_202_pending_approval_payload_verbatim():
    pending = {"status": "pending_approval", "approvalId": "apr_1", "skillStatus": "private"}
    request_fn, _ = _make_recorder({"success": True, "data": pending, "requestId": "r"})
    res = EaasSkillsClient(request_fn).publish("eskl_1")
    assert res["success"] is True
    assert res["data"] == pending


# ---------------------------------------------------------------------------
# New-face model parses (typed mirrors)
# ---------------------------------------------------------------------------


def test_richer_principal_message_view_parses_content_blocks_question_answer():
    msg = EaasPrincipalMessageView.model_validate({
        "id": "msg_1",
        "role": "agent",
        "content": "which color?",
        "createdAt": "2026-09-09T00:00:00.000Z",
        "kind": "agent_question",
        "model": None,
        "contentBlocks": [{"kind": "text", "text": "which color?"}],
        "question": {
            "questionId": "run_1#q1",
            "text": "which color?",
            "options": [{"id": "opt_a", "label": "Red"}, {"id": "opt_b", "label": "Blue"}],
        },
        "answer": None,
        "spans": None,
    })
    assert msg.question is not None
    assert msg.question.question_id == "run_1#q1"
    assert [o.id for o in msg.question.options] == ["opt_a", "opt_b"]
    assert msg.content_blocks is not None and msg.content_blocks[0].kind == "text"
    assert msg.answer is None

    answered = EaasPrincipalMessageView.model_validate({
        "id": "msg_2",
        "role": "principal",
        "content": "Red",
        "createdAt": "2026-09-09T00:00:01.000Z",
        "kind": "principal_answer",
        "answer": {"questionId": "run_1#q1", "optionId": "opt_a"},
    })
    assert answered.answer is not None
    assert answered.answer.option_id == "opt_a"
    assert answered.question is None


def test_artifact_and_event_replay_models_parse_the_wire_shape():
    page = EaasArtifactList.model_validate(_ARTIFACT_PAGE)
    assert page.artifacts[0].artifact_id == "eart_1"
    assert page.artifacts[0].content_hash == "deadbeef"
    assert page.truncated is False

    replay = EaasEventReplayPage.model_validate(
        {"events": [{"v": 1, "eventId": "tnt_1:42", "cursor": "42", "type": "environment.ready",
                     "at": "2026-09-09T00:00:00.000Z", "payload": {}}],
         "nextCursor": "42", "truncated": True}
    )
    assert replay.next_cursor == "42"
    assert replay.truncated is True
    assert replay.events[0].event_id == "tnt_1:42"


def test_private_skill_models_parse_the_wire_shape():
    view = EaasPrivateSkillView.model_validate(_SKILL_VIEW)
    assert view.skill_id == "eskl_1"
    assert view.status == "private"
    assert view.content_manifest is None

    detail = EaasPrivateSkillDetail.model_validate({**_SKILL_VIEW, "content": "---\nname: x\n---\nbody"})
    assert detail.content.startswith("---")

    # EaasSkillPublishResult is a Union alias — validate its concrete members.
    published = EaasSkillPublishPublished.model_validate(
        {"status": "published", "approvalId": None, "alreadyPublished": True}
    )
    assert published.status == "published"
    pending = EaasSkillPublishPending.model_validate(
        {"status": "pending_approval", "approvalId": "apr_1", "skillStatus": "private"}
    )
    assert pending.status == "pending_approval"


# ---------------------------------------------------------------------------
# Async twins — new faces
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_async_new_faces_match_the_sync_wire_contract():
    request_fn, calls = _make_async_recorder()
    client = AsyncEnvironmentsClient(request_fn, BASE, lambda: dict(AUTH))
    await client.ensure_conversation("env_1")
    await client.send_message("env_1", "conv_1", "hello")
    await client.send_message(
        "env_1", "conv_1", "look", content_blocks=[{"kind": "text", "text": "look"}],
    )
    await client.list_artifacts("env_1", limit=10)
    await client.list_events(cursor="9", limit=50, project_ids=["prj_1"])
    await client.revoke_session("env_1", "eps_1")

    # ensure_conversation async: no Idempotency-Key (server ignores it).
    assert calls[0]["path"] == "/api/v1/environments/env_1/conversations"
    assert calls[0]["headers"] == {}
    assert calls[1]["json"] == {"content": "hello"}
    assert calls[2]["json"] == {"content": "look", "contentBlocks": [{"kind": "text", "text": "look"}]}
    assert calls[3]["path"] == "/api/v1/environments/env_1/artifacts"
    assert calls[3]["params"] == {"limit": 10}
    assert calls[4]["path"] == "/api/v1/events"
    assert calls[4]["params"] == {"cursor": "9", "limit": 50, "projectIds": "prj_1"}
    assert calls[5]["path"] == "/api/v1/environments/env_1/sessions/eps_1/revoke"


@pytest.mark.asyncio
async def test_async_upload_asset_and_get_artifact_use_the_raw_seam():
    request_fn, _ = _make_async_recorder()
    raw_fn, raw_calls = _make_async_raw_recorder(
        [
            _RawResponse(body={"success": True, "data": {"assetId": "asset_1"}}),
            _RawResponse(content=b"bytes", headers={"x-eaas-artifact-sha256": "hash1"}),
        ]
    )
    client = AsyncEnvironmentsClient(request_fn, BASE, lambda: dict(AUTH), raw_request_fn=raw_fn)
    up = await client.upload_asset("env_1", b"png-bytes", "image/webp")
    got = await client.get_artifact("env_1", "eart_1")
    assert up["data"]["assetId"] == "asset_1"
    assert raw_calls[0]["method"] == "POST"
    assert raw_calls[0]["url"].endswith("/api/v1/environments/env_1/assets")
    assert raw_calls[0]["headers"]["Content-Type"] == "image/webp"
    assert got == {"success": True, "bytes": b"bytes", "sha256": "hash1"}
    assert raw_calls[1]["url"].endswith("/api/v1/environments/env_1/artifacts/eart_1")


@pytest.mark.asyncio
async def test_async_skills_client_matches_the_sync_wire_contract():
    request_fn, calls = _make_async_recorder({"success": True, "data": _SKILL_VIEW, "requestId": "r"})
    client = AsyncEaasSkillsClient(request_fn)
    await client.list(status="published")
    await client.create({"slug": "s", "name": "n", "content": "c"})
    await client.publish("eskl_1")
    assert calls[0]["path"] == "/api/v1/skills"
    assert calls[0]["params"] == {"status": "published"}
    assert calls[1]["json"] == {"slug": "s", "name": "n", "content": "c"}
    assert calls[2]["path"] == "/api/v1/skills/eskl_1/publish"
