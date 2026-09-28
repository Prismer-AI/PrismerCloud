"""
Webhook module unit tests
"""

import hashlib
import hmac
import json

import pytest

from prismer.webhook import (
    PrismerWebhook,
    WebhookPayload,
    WebhookReply,
    parse_webhook_payload,
    verify_webhook_signature,
)

# ============================================================================
# Test Helpers
# ============================================================================

TEST_SECRET = "test-webhook-secret-key"


def make_signature(body: str, secret: str = TEST_SECRET) -> str:
    return "sha256=" + hmac.new(
        secret.encode("utf-8"), body.encode("utf-8"), hashlib.sha256
    ).hexdigest()


def make_payload(**overrides) -> dict:
    payload = {
        "source": "prismer_im",
        "event": "message.new",
        "timestamp": 1700000000,
        "message": {
            "id": "msg-001",
            "type": "text",
            "content": "Hello from test",
            "senderId": "user-001",
            "conversationId": "conv-001",
            "parentId": None,
            "metadata": {},
            "createdAt": "2026-01-01T00:00:00Z",
        },
        "sender": {
            "id": "user-001",
            "username": "testuser",
            "displayName": "Test User",
            "role": "human",
        },
        "conversation": {
            "id": "conv-001",
            "type": "direct",
            "title": None,
        },
    }
    payload.update(overrides)
    return payload


def make_payload_string(**overrides) -> str:
    return json.dumps(make_payload(**overrides))


# ============================================================================
# verify_webhook_signature
# ============================================================================


class TestVerifyWebhookSignature:
    def test_valid_signature(self):
        body = make_payload_string()
        sig = make_signature(body)
        assert verify_webhook_signature(body, sig, TEST_SECRET) is True

    def test_valid_without_prefix(self):
        body = make_payload_string()
        sig = make_signature(body).replace("sha256=", "")
        assert verify_webhook_signature(body, sig, TEST_SECRET) is True

    def test_wrong_signature(self):
        body = make_payload_string()
        sig = "sha256=" + "0" * 64
        assert verify_webhook_signature(body, sig, TEST_SECRET) is False

    def test_wrong_secret(self):
        body = make_payload_string()
        sig = make_signature(body, "wrong-secret")
        assert verify_webhook_signature(body, sig, TEST_SECRET) is False

    def test_tampered_body(self):
        body = make_payload_string()
        sig = make_signature(body)
        assert verify_webhook_signature(body + "tampered", sig, TEST_SECRET) is False

    def test_empty_body(self):
        assert verify_webhook_signature("", "sha256=abc", TEST_SECRET) is False

    def test_empty_signature(self):
        assert verify_webhook_signature("body", "", TEST_SECRET) is False

    def test_empty_secret(self):
        assert verify_webhook_signature("body", "sha256=abc", "") is False

    def test_sha256_prefix_only(self):
        assert verify_webhook_signature("body", "sha256=", TEST_SECRET) is False


# ============================================================================
# parse_webhook_payload
# ============================================================================


class TestParseWebhookPayload:
    def test_valid_payload(self):
        body = make_payload_string()
        payload = parse_webhook_payload(body)
        assert payload.source == "prismer_im"
        assert payload.event == "message.new"
        assert payload.message.id == "msg-001"
        assert payload.sender.username == "testuser"
        assert payload.conversation.type == "direct"

    def test_invalid_json(self):
        with pytest.raises(ValueError, match="Invalid JSON"):
            parse_webhook_payload("not json")

    def test_non_object_json(self):
        with pytest.raises(ValueError, match="must be a JSON object"):
            parse_webhook_payload('"string"')

    def test_unknown_source(self):
        body = json.dumps({**make_payload(), "source": "unknown"})
        with pytest.raises(ValueError, match="Unknown webhook source"):
            parse_webhook_payload(body)

    def test_missing_event(self):
        body = json.dumps({**make_payload(), "event": ""})
        with pytest.raises(ValueError, match="Missing event"):
            parse_webhook_payload(body)

    def test_missing_message(self):
        data = make_payload()
        del data["message"]
        with pytest.raises(ValueError, match="Missing required fields"):
            parse_webhook_payload(json.dumps(data))

    def test_missing_sender(self):
        data = make_payload()
        del data["sender"]
        with pytest.raises(ValueError, match="Missing required fields"):
            parse_webhook_payload(json.dumps(data))

    def test_missing_conversation(self):
        data = make_payload()
        del data["conversation"]
        with pytest.raises(ValueError, match="Missing required fields"):
            parse_webhook_payload(json.dumps(data))


# ============================================================================
# PrismerWebhook constructor
# ============================================================================


class TestPrismerWebhookInit:
    def test_empty_secret_raises(self):
        with pytest.raises(ValueError, match="secret is required"):
            PrismerWebhook(secret="", on_message=self._noop)

    def test_valid_creation(self):
        wh = PrismerWebhook(secret=TEST_SECRET, on_message=self._noop)
        assert wh is not None

    @staticmethod
    async def _noop(payload):
        return None


# ============================================================================
# PrismerWebhook.verify / .parse
# ============================================================================


class TestPrismerWebhookMethods:
    @staticmethod
    async def _noop(payload):
        return None

    def test_verify_valid(self):
        wh = PrismerWebhook(secret=TEST_SECRET, on_message=self._noop)
        body = make_payload_string()
        assert wh.verify(body, make_signature(body)) is True

    def test_verify_invalid(self):
        wh = PrismerWebhook(secret=TEST_SECRET, on_message=self._noop)
        body = make_payload_string()
        assert wh.verify(body, "sha256=bad") is False

    def test_parse_valid(self):
        wh = PrismerWebhook(secret=TEST_SECRET, on_message=self._noop)
        payload = wh.parse(make_payload_string())
        assert payload.source == "prismer_im"

    def test_parse_invalid(self):
        wh = PrismerWebhook(secret=TEST_SECRET, on_message=self._noop)
        with pytest.raises(ValueError):
            wh.parse("invalid")


# ============================================================================
# PrismerWebhook.handle_async
# ============================================================================


class TestPrismerWebhookHandleAsync:
    @pytest.mark.asyncio
    async def test_invalid_signature(self):
        wh = PrismerWebhook(secret=TEST_SECRET, on_message=self._noop)
        body = make_payload_string()
        status, data = await wh.handle_async(body, "sha256=bad")
        assert status == 401
        assert "Invalid signature" in data["error"]

    @pytest.mark.asyncio
    async def test_malformed_payload(self):
        wh = PrismerWebhook(secret=TEST_SECRET, on_message=self._noop)
        body = '{"source": "unknown"}'
        sig = make_signature(body)
        status, data = await wh.handle_async(body, sig)
        assert status == 400

    @pytest.mark.asyncio
    async def test_success_void(self):
        wh = PrismerWebhook(secret=TEST_SECRET, on_message=self._noop)
        body = make_payload_string()
        sig = make_signature(body)
        status, data = await wh.handle_async(body, sig)
        assert status == 200
        assert data["ok"] is True

    @pytest.mark.asyncio
    async def test_success_with_reply(self):
        async def handler(payload):
            return WebhookReply(content=f"Echo: {payload.message.content}")

        wh = PrismerWebhook(secret=TEST_SECRET, on_message=handler)
        body = make_payload_string()
        sig = make_signature(body)
        status, data = await wh.handle_async(body, sig)
        assert status == 200
        assert data["content"] == "Echo: Hello from test"

    @pytest.mark.asyncio
    async def test_handler_error(self):
        async def handler(payload):
            raise RuntimeError("Something broke")

        wh = PrismerWebhook(secret=TEST_SECRET, on_message=handler)
        body = make_payload_string()
        sig = make_signature(body)
        status, data = await wh.handle_async(body, sig)
        assert status == 500
        assert "Something broke" in data["error"]

    @pytest.mark.asyncio
    async def test_full_payload_passed(self):
        received = {}

        async def handler(payload):
            received["payload"] = payload
            return None

        wh = PrismerWebhook(secret=TEST_SECRET, on_message=handler)
        body = make_payload_string()
        sig = make_signature(body)
        await wh.handle_async(body, sig)

        p = received["payload"]
        assert p.message.content == "Hello from test"
        assert p.sender.role == "human"
        assert p.conversation.id == "conv-001"

    @staticmethod
    async def _noop(payload):
        return None
