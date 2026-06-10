"""v2.0 §3.0.2 Gap A-④ + §4.6 — ContentBlock types + send X-Idempotency-Key.

Wave 3 Agent D1 (track 14 §3.0.2): protocol-layer SDK upgrades.

Covers:
  1. ContentBlock 8-variant Pydantic union round-trips through model_dump.
  2. _build_send_payload generates an idempotency key when not passed.
  3. MessagesClient.send / DirectClient.send / GroupsClient.send call
     request_fn with X-Idempotency-Key header (mock fetch).
  4. Same key reused across explicit retries.
  5. ContentBlock[] serialises into body.contentBlocks.
"""

from __future__ import annotations

import re

import pytest

from prismer.types import (
    ChatMessage,
    ContentBlock,
    ContentBlockAudio,
    ContentBlockFile,
    ContentBlockImage,
    ContentBlockReasoning,
    ContentBlockText,
    ContentBlockToolResult,
    ContentBlockToolUse,
    ContentBlockVideo,
    IMMessage,
    TaskInput,
)
from prismer.client import (
    DirectClient,
    GroupsClient,
    MessagesClient,
    _build_send_payload,
    _generate_idempotency_key,
)


UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[089ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


# ────────────────────────────────────────────────────────────────────────────
# 1. ContentBlock 8-variant Pydantic union round-trips
# ────────────────────────────────────────────────────────────────────────────


def test_content_block_8_variants_roundtrip():
    blocks: list[ContentBlock] = [
        ContentBlockText(text="hi"),
        ContentBlockImage(asset_id="a1", media_type="image/png", alt="pic"),
        ContentBlockAudio(asset_id="a2", media_type="audio/mpeg", duration_ms=120),
        ContentBlockVideo(asset_id="a3", media_type="video/mp4", duration_ms=4000,
                          thumbnail_url="https://x/y.jpg"),
        ContentBlockFile(asset_id="a4", media_type="application/pdf", filename="spec.pdf"),
        ContentBlockToolUse(tool_call_id="t1", tool_name="image_generate",
                            input_json={"prompt": "cat"}),
        ContentBlockToolResult(tool_call_id="t1", output=[ContentBlockText(text="ok")]),
        ContentBlockReasoning(text="thinking", redacted=False),
    ]
    kinds = [b.kind for b in blocks]
    assert kinds == [
        "text", "image", "audio", "video", "file", "tool_use", "tool_result", "reasoning",
    ]
    # Dump → camelCase aliases (server-shape JSON)
    dumped = [b.model_dump(by_alias=True, exclude_none=True) for b in blocks]
    assert dumped[1]["assetId"] == "a1"
    assert dumped[1]["mediaType"] == "image/png"
    assert dumped[5]["toolCallId"] == "t1"
    assert dumped[5]["inputJson"] == {"prompt": "cat"}
    assert dumped[6]["output"][0] == {"kind": "text", "text": "ok"}


def test_chat_message_accepts_string_or_blocks():
    a = ChatMessage(role="user", content="hello")
    b = ChatMessage(role="user", content=[ContentBlockText(text="see"),
                                          ContentBlockImage(asset_id="x",
                                                             media_type="image/png")])
    assert a.content == "hello"
    assert isinstance(b.content, list)
    assert b.content[1].kind == "image"


def test_task_input_messages_optional_extra_allowed():
    ti = TaskInput(prompt="legacy", messages=[ChatMessage(role="user", content="hi")])
    d = ti.model_dump(by_alias=True, exclude_none=True)
    assert d["prompt"] == "legacy"
    assert d["messages"][0]["content"] == "hi"
    # extra capability-specific args allowed
    ti2 = TaskInput.model_validate({"prompt": "x", "captureScreenshot": True})
    assert ti2.model_dump(exclude_none=True).get("captureScreenshot") is True


def test_im_message_optional_content_blocks_and_boundary_seq():
    m = IMMessage.model_validate({
        "id": "m1", "content": "hi", "type": "text", "senderId": "u1",
        "createdAt": "2026-05-21T00:00:00Z",
        "contentBlocks": [{"kind": "text", "text": "hi"}],
        "boundarySeq": 42,
    })
    assert m.boundary_seq == 42
    assert m.content_blocks is not None and m.content_blocks[0].kind == "text"


# ────────────────────────────────────────────────────────────────────────────
# 2. _build_send_payload + _generate_idempotency_key
# ────────────────────────────────────────────────────────────────────────────


def test_generate_idempotency_key_is_uuid_v4():
    k = _generate_idempotency_key()
    assert UUID_RE.match(k), f"not uuid4: {k}"
    # uniqueness check
    assert len({_generate_idempotency_key() for _ in range(50)}) == 50


def test_build_send_payload_string_content_autogenerates_key():
    body, headers = _build_send_payload("hello")
    assert body["content"] == "hello"
    assert body["type"] == "text"
    assert UUID_RE.match(body["idempotencyKey"])
    assert headers["X-Idempotency-Key"] == body["idempotencyKey"]
    # body must NOT have contentBlocks when only string given
    assert "contentBlocks" not in body


def test_build_send_payload_explicit_key_passthrough():
    body, headers = _build_send_payload("retry me", idempotency_key="custom-key-1")
    assert body["idempotencyKey"] == "custom-key-1"
    assert headers["X-Idempotency-Key"] == "custom-key-1"


def test_build_send_payload_content_blocks_list_serialises():
    blocks = [ContentBlockText(text="see"),
              ContentBlockImage(asset_id="a1", media_type="image/png")]
    body, headers = _build_send_payload(blocks)
    assert body["content"] == ""  # placeholder during double-write window
    assert body["contentBlocks"][0] == {"kind": "text", "text": "see"}
    assert body["contentBlocks"][1] == {
        "kind": "image", "assetId": "a1", "mediaType": "image/png",
    }
    assert UUID_RE.match(headers["X-Idempotency-Key"])


def test_build_send_payload_dict_blocks_also_accepted():
    body, _ = _build_send_payload([{"kind": "text", "text": "x"}])
    assert body["contentBlocks"] == [{"kind": "text", "text": "x"}]


# ────────────────────────────────────────────────────────────────────────────
# 3. MessagesClient / DirectClient / GroupsClient — mock request_fn
# ────────────────────────────────────────────────────────────────────────────


def _make_recorder():
    calls: list[dict] = []

    def fn(method, path, *, json=None, params=None, headers=None):
        calls.append({"method": method, "path": path, "json": json,
                      "params": params, "headers": headers or {}})
        return {"ok": True, "success": True, "data": {"messageId": "m1"}}

    return fn, calls


def test_messages_client_send_stamps_header():
    fn, calls = _make_recorder()
    client = MessagesClient(fn)
    client.send("cid-1", "hello")
    assert len(calls) == 1
    c = calls[0]
    assert c["path"] == "/api/im/messages/cid-1"
    key = c["headers"]["X-Idempotency-Key"]
    assert UUID_RE.match(key)
    # body mirror for offline path
    assert c["json"]["idempotencyKey"] == key
    assert c["json"]["content"] == "hello"


def test_messages_client_two_sends_get_distinct_keys():
    fn, calls = _make_recorder()
    client = MessagesClient(fn)
    client.send("cid-1", "first")
    client.send("cid-1", "second")
    k1 = calls[0]["headers"]["X-Idempotency-Key"]
    k2 = calls[1]["headers"]["X-Idempotency-Key"]
    assert k1 and k2 and k1 != k2


def test_messages_client_retry_loop_with_same_key():
    fn, calls = _make_recorder()
    client = MessagesClient(fn)
    shared = "11111111-2222-4333-8444-555555555555"
    for _ in range(3):
        client.send("cid-1", "crashy", idempotency_key=shared)
    assert len(calls) == 3
    for c in calls:
        assert c["headers"]["X-Idempotency-Key"] == shared
        assert c["json"]["idempotencyKey"] == shared


def test_direct_and_groups_clients_also_stamp_header():
    fn, calls = _make_recorder()
    DirectClient(fn).send("user-1", "dm")
    GroupsClient(fn).send("group-1", "gm")
    assert calls[0]["path"] == "/api/im/direct/user-1/messages"
    assert calls[1]["path"] == "/api/im/groups/group-1/messages"
    assert calls[0]["headers"]["X-Idempotency-Key"]
    assert calls[1]["headers"]["X-Idempotency-Key"]
    assert calls[0]["headers"]["X-Idempotency-Key"] != calls[1]["headers"]["X-Idempotency-Key"]


def test_messages_client_content_blocks_passthrough():
    fn, calls = _make_recorder()
    client = MessagesClient(fn)
    blocks = [ContentBlockText(text="x"),
              ContentBlockImage(asset_id="a", media_type="image/png")]
    client.send("cid-1", blocks)
    body = calls[0]["json"]
    assert body["content"] == ""
    assert body["contentBlocks"][0] == {"kind": "text", "text": "x"}
    assert body["contentBlocks"][1]["assetId"] == "a"
