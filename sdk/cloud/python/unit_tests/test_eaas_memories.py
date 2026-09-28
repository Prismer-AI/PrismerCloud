from unittest.mock import AsyncMock, Mock

import pytest
from prismer import client


def test_fresh_conversation():
    request = Mock(return_value={"success": True})
    client.EnvironmentsClient(request, "https://example.test").create_conversation("env/a")
    request.assert_called_once_with("POST", "/api/v1/environments/env%2Fa/conversations", json={"newConversation": True})


@pytest.mark.asyncio
async def test_async_fresh_conversation():
    request = AsyncMock(return_value={"success": True})
    await client.AsyncEnvironmentsClient(request, "https://example.test").create_conversation("env/a")
    request.assert_awaited_once_with("POST", "/api/v1/environments/env%2Fa/conversations", json={"newConversation": True})


def test_environment_memory_write():
    request = Mock(return_value={"success": True})
    client.EaasMemoriesClient(request).write({"path": "a.md", "content": "source A"},
                                           environment_id="env/a", idempotency_key="from-a")
    request.assert_called_once_with("POST", "/api/v1/environments/env%2Fa/memories",
                                    json={"path": "a.md", "content": "source A"},
                                    headers={"Idempotency-Key": "from-a"})


@pytest.mark.asyncio
async def test_async_environment_memory_write():
    request = AsyncMock(return_value={"success": True})
    await client.AsyncEaasMemoriesClient(request).write({"path": "a.md", "content": "source A"},
                                                      environment_id="env/a", idempotency_key="from-a")
    request.assert_awaited_once_with("POST", "/api/v1/environments/env%2Fa/memories",
                                    json={"path": "a.md", "content": "source A"},
                                    headers={"Idempotency-Key": "from-a"})


def test_tenant_memory_transport():
    request = Mock(return_value={"success": True, "data": {"acked": ["a"]}})
    api = client.EaasMemoriesClient(request)
    result = api.write({"path": "a.md", "content": "hello"}, idempotency_key="one")
    assert result["data"]["acked"] == ["a"]
    request.assert_called_with("POST", "/api/v1/memories", json={"path": "a.md", "content": "hello"}, headers={"Idempotency-Key": "one"})
    api.search(query="hello", limit=2, environment_id="env/a")
    request.assert_called_with("GET", "/api/v1/environments/env%2Fa/memories", params={"q": "hello", "limit": 2})
    api.grant_environment("env/a")
    request.assert_called_with("POST", "/api/v1/environments/env%2Fa/memories/grants")
    api.revoke_environment("env/a")
    request.assert_called_with("DELETE", "/api/v1/environments/env%2Fa/memories/grants")


@pytest.mark.asyncio
async def test_async_memory_transport():
    request = AsyncMock(return_value={"success": True})
    api = client.AsyncEaasMemoriesClient(request)
    await api.write({"path": "a.md", "content": "hello"}, idempotency_key="one")
    request.assert_awaited_once()
    await api.search(query="hello")
    request.assert_awaited_with("GET", "/api/v1/memories", params={"q": "hello"})
    await api.grant_environment("env/a")
    request.assert_awaited_with("POST", "/api/v1/environments/env%2Fa/memories/grants")
    await api.revoke_environment("env/a")
    request.assert_awaited_with("DELETE", "/api/v1/environments/env%2Fa/memories/grants")
