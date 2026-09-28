"""Synthetic request-port contracts, not live provider acceptance."""
import asyncio
import pytest
from prismer import client as module
from prismer import types

POLICY = {"maxReady": 2, "dailyBudgetCredits": "12.123456", "defaultPoolId": "a", "fallbackPoolIds": ["b"], "pools": [
    {"poolId": "a", "enabled": True, "minReady": 1, "maxReady": 2, "idleRetentionSeconds": 30, "priority": 9, "onMiss": "reject"},
    {"poolId": "b", "enabled": False, "minReady": 0, "maxReady": 0, "idleRetentionSeconds": 0, "priority": 0, "onMiss": "cold"},
]}
STATUS = {"revision": 4, "observedRevision": 3, "configRevision": "cfg-1", "allowedPoolIds": ["a", "b"], "policy": POLICY}

@pytest.mark.parametrize("asynchronous", [False, True])
def test_policy_get_patch_and_pagination(asynchronous):
    calls = []
    response = {"success": True, "data": STATUS, "requestId": "test"}
    def request(*args, **kwargs):
        calls.append((args, kwargs))
        return response
    async def async_request(*args, **kwargs):
        return request(*args, **kwargs)
    prefix = "Async" if asynchronous else ""
    client = getattr(module, prefix + "PoolPolicyClient")(async_request if asynchronous else request)
    pools = getattr(module, prefix + "ProjectPoolsClient")(async_request if asynchronous else request)
    def call(value):
        return asyncio.run(value) if asynchronous else value
    assert call(client.get("p/a")) == response
    assert calls[-1][0] == ("GET", "/api/v1/projects/p%2Fa/pool-policy")
    for dry_run in [True, False, None]:
        model = getattr(types, "ProjectPoolManagement").model_validate(POLICY)
        assert call(client.patch("p/a", model, config_revision="cfg-1", revision=4, dry_run=dry_run, idempotency_key="same")) == response
        args, kwargs = calls[-1]
        assert args == ("PATCH", "/api/v1/projects/p%2Fa/pool-policy")
        assert kwargs["headers"] == {"If-Match": "4", "Idempotency-Key": "same"}
        assert kwargs["json"] == {"configRevision": "cfg-1", "policy": POLICY, **({} if dry_run is None else {"dryRun": dry_run})}
    call(client.patch("p", POLICY, config_revision="cfg-1", revision=0))
    assert len(calls[-1][1]["headers"]["Idempotency-Key"]) == 36
    response["data"] = {"pools": [{"inventory": {"known": False, "ready": None}}], "nextCursor": "b"}
    assert call(pools.list("p/a", cursor="a/b +", limit=1)) == response
    assert calls[-1] == (("GET", "/api/v1/projects/p%2Fa/pools"), {"params": {"cursor": "a/b +", "limit": "1"}})
    assert response["data"]["pools"][0]["inventory"]["ready"] is None

@pytest.mark.parametrize("asynchronous", [False, True])
def test_offline_failure_not_success(asynchronous):
    calls = []
    def request(*args, **kwargs):
        calls.append(args)
        raise ConnectionError("synthetic offline")
    async def async_request(*args, **kwargs):
        return request(*args, **kwargs)
    client = getattr(module, ("Async" if asynchronous else "") + "PoolPolicyClient")(async_request if asynchronous else request)
    with pytest.raises(ConnectionError, match="synthetic offline"):
        value = client.patch("p", POLICY, config_revision="cfg-1", revision=4)
        if asynchronous:
            asyncio.run(value)
    assert len(calls) == 1

@pytest.mark.parametrize("asynchronous", [False, True])
@pytest.mark.parametrize("code", ["invalid_request", "invalid_policy", "scope_denied", "not_owned", "state_conflict", "idempotency_conflict", "revision_conflict", "budget_exhausted", "quota_exceeded", "pricing_unavailable", "provider_unavailable"])
def test_error_envelope_preserved(asynchronous, code):
    calls = []
    failure = {"success": False, "error": {"code": code, "message": "synthetic"}}
    def request(*args, **kwargs):
        calls.append(args)
        return failure
    async def async_request(*args, **kwargs):
        return request(*args, **kwargs)
    client = getattr(module, ("Async" if asynchronous else "") + "PoolPolicyClient")(async_request if asynchronous else request)
    value = client.patch("p", POLICY, config_revision="cfg-1", revision=4)
    assert (asyncio.run(value) if asynchronous else value) == failure
    assert len(calls) == 1

def test_public_clients_and_status_models():
    for name in ["PrismerClient", "AsyncPrismerClient"]:
        client = getattr(module, name)(api_key="sk-eaas-synthetic", base_url="https://test.invalid")
        assert callable(client.pool_policy.patch)
        assert callable(client.project_pools.list)
    assert getattr(types, "PoolPolicyStatus").model_validate(STATUS).model_dump(by_alias=True) == STATUS


def test_inventory_model_roundtrip_preserves_unknown_and_terminal_cursor():
    page = {"pools": [{"poolId": "b", "placementId": "place", "providerKind": "e2b", "mode": "provider-managed",
                      "default": False, "desired": {"minReady": 0, "maxReady": 0}, "effectiveTarget": None,
                      "state": "unknown", "inventory": {"known": False, "source": "provider", "ready": None,
                      "provisioning": None, "terminating": None, "observedAt": None}, "retiredInventory": 0,
                      "reason": "provider_inventory_unknown"}], "nextCursor": None, "policyRevision": 4,
            "observedAt": "2026-09-24T00:00:00Z", "activation": {"desiredRevision": "cfg-1", "observedRevision": None,
            "phase": "local-unverified", "freshUntil": None}}
    model = getattr(types, "ProjectPoolsPage").model_validate(page)
    assert model.pools[0].available is None
    assert "available" not in model.pools[0].model_fields_set
    # Omitted additive fields stay omitted, while explicit unknown/null values survive.
    assert model.model_dump(by_alias=True, exclude_unset=True) == page
    page["pools"][0]["available"] = False
    page["pools"][0]["mappingRevision"] = None
    model = getattr(types, "ProjectPoolsPage").model_validate(page)
    assert model.pools[0].available is False
    assert model.model_dump(by_alias=True, exclude_unset=True) == page
