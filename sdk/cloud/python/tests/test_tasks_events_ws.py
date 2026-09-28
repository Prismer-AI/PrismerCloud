"""release203/12 P3.1 — TasksClient.events over the unified single WebSocket.

Verifies the `tasks` channel of `WS /ws/realtime` is demuxed into the SAME
`{"id","event","data"}` envelopes the legacy SSE path produced, that control
frames + the `sync` channel are ignored, and that the ws(s) URL is derived.
"""
import json
from unittest import mock

import pytest

from prismer.client import TasksClient, AsyncTasksClient


FRAMES = [
    json.dumps({"name": "heartbeat"}),  # control → ignored
    json.dumps({"name": "caught_up", "cursor": 0}),  # control → ignored
    json.dumps({"ch": "sync", "name": "sync", "data": {"seq": 1}}),  # sync chan → ignored
    json.dumps({"ch": "tasks", "name": "task.completed", "data": {"taskId": "t1"}}),
    json.dumps({"ch": "tasks", "name": "task.progress", "data": {"taskId": "t1", "pct": 50}}),
]


class _FakeSyncWs:
    def __init__(self, frames):
        self._frames = frames

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def __iter__(self):
        return iter(self._frames)


def test_sync_events_ws_demuxes_tasks_channel():
    tc = TasksClient(None, base_url="https://cloud.test", get_auth_headers=None)
    with mock.patch(
        "websockets.sync.client.connect", return_value=_FakeSyncWs(FRAMES)
    ) as m:
        got = list(tc.events(token="sk-x"))

    assert got == [
        {"id": None, "event": "task.completed", "data": {"taskId": "t1"}},
        {"id": None, "event": "task.progress", "data": {"taskId": "t1", "pct": 50}},
    ]
    url = m.call_args[0][0]
    assert url.startswith("wss://cloud.test/ws/realtime")
    assert "token=sk-x" in url
    assert "since=0" in url


def test_sync_events_sse_fallback_when_unified_off():
    # unified_ws=False must NOT touch the WS path (it would hit httpx SSE).
    tc = TasksClient(None, base_url="https://cloud.test", get_auth_headers=None)
    with mock.patch("websockets.sync.client.connect") as m:
        gen = tc.events(token="sk-x", unified_ws=False)
        # Pull one item inside a guard: the SSE path will try a real httpx
        # connection and fail — we only assert the WS connect was NOT used.
        with pytest.raises(Exception):
            next(gen)
    m.assert_not_called()


class _FakeAsyncWs:
    def __init__(self, frames):
        self._frames = frames

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    def __aiter__(self):
        async def gen():
            for f in self._frames:
                yield f

        return gen()


@pytest.mark.asyncio
async def test_async_events_ws_demuxes_tasks_channel():
    tc = AsyncTasksClient(None, base_url="http://cloud.test", get_auth_headers=None)
    with mock.patch("websockets.connect", return_value=_FakeAsyncWs(FRAMES)) as m:
        got = [evt async for evt in tc.events(token="sk-x")]

    assert got == [
        {"id": None, "event": "task.completed", "data": {"taskId": "t1"}},
        {"id": None, "event": "task.progress", "data": {"taskId": "t1", "pct": 50}},
    ]
    url = m.call_args[0][0]
    assert url.startswith("ws://cloud.test/ws/realtime")  # http → ws
