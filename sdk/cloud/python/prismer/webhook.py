"""
Prismer IM Webhook Handler

Receives, verifies, and parses webhook payloads from Prismer IM server.

Example:
    >>> from prismer.webhook import PrismerWebhook
    >>> webhook = PrismerWebhook(
    ...     secret="my-secret",
    ...     on_message=lambda payload: print(payload.message.content),
    ... )
    >>> # Verify a signature
    >>> webhook.verify(body, signature)
    >>> # Parse a payload
    >>> payload = webhook.parse(body)
"""

import hashlib
import hmac
import json
from typing import Any, Awaitable, Callable, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, Field


# ============================================================================
# Types
# ============================================================================


class WebhookMessage(BaseModel):
    """A message in a webhook payload."""
    id: str
    type: str
    content: str
    sender_id: str = Field(alias="senderId")
    conversation_id: str = Field(alias="conversationId")
    parent_id: Optional[str] = Field(default=None, alias="parentId")
    metadata: Dict[str, Any] = Field(default_factory=dict)
    created_at: str = Field(alias="createdAt")

    class Config:
        populate_by_name = True


class WebhookSender(BaseModel):
    """Sender information in a webhook payload."""
    id: str
    username: str
    display_name: str = Field(alias="displayName")
    role: Literal["human", "agent"]

    class Config:
        populate_by_name = True


class WebhookConversation(BaseModel):
    """Conversation information in a webhook payload."""
    id: str
    type: Literal["direct", "group"]
    title: Optional[str] = None

    class Config:
        populate_by_name = True


class WebhookPayload(BaseModel):
    """Prismer IM webhook payload (POST to agent endpoint)."""
    source: Literal["prismer_im"]
    event: str
    timestamp: int
    message: WebhookMessage
    sender: WebhookSender
    conversation: WebhookConversation

    class Config:
        populate_by_name = True


class WebhookReply(BaseModel):
    """Optional reply from a webhook handler."""
    content: str
    type: Optional[Literal["text", "markdown", "code"]] = None


# ============================================================================
# Standalone Functions
# ============================================================================


def verify_webhook_signature(body: str, signature: str, secret: str) -> bool:
    """
    Verify a Prismer IM webhook signature using HMAC-SHA256.
    Uses timing-safe comparison to prevent timing attacks.

    Args:
        body: Raw request body string.
        signature: Value of X-Prismer-Signature header (e.g. "sha256=abcdef...").
        secret: The webhook secret.

    Returns:
        True if the signature is valid.
    """
    if not body or not signature or not secret:
        return False

    sig = signature[7:] if signature.startswith("sha256=") else signature
    if not sig:
        return False

    expected = hmac.new(
        secret.encode("utf-8"),
        body.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()

    return hmac.compare_digest(sig, expected)


def parse_webhook_payload(body: str) -> WebhookPayload:
    """
    Parse a raw webhook body into a typed WebhookPayload.

    Args:
        body: Raw JSON string from the webhook request.

    Returns:
        Parsed WebhookPayload.

    Raises:
        ValueError: If the body is invalid JSON or missing required fields.
    """
    try:
        data = json.loads(body)
    except (json.JSONDecodeError, TypeError) as e:
        raise ValueError(f"Invalid JSON in webhook body: {e}")

    if not isinstance(data, dict):
        raise ValueError("Webhook body must be a JSON object")

    if data.get("source") != "prismer_im":
        raise ValueError(f"Unknown webhook source: {data.get('source')}")

    if not data.get("event"):
        raise ValueError("Missing event field in webhook payload")

    if not all(k in data for k in ("message", "sender", "conversation")):
        raise ValueError(
            "Missing required fields in webhook payload (message, sender, conversation)"
        )

    return WebhookPayload.model_validate(data)


# ============================================================================
# PrismerWebhook Class
# ============================================================================


class PrismerWebhook:
    """
    Prismer IM Webhook handler.

    Verifies HMAC-SHA256 signatures, parses payloads, and dispatches
    to a user-defined callback.

    Args:
        secret: HMAC-SHA256 secret for verifying webhook signatures.
        on_message: Async callback invoked with a verified WebhookPayload.
                    May return a WebhookReply or None.
    """

    def __init__(
        self,
        secret: str,
        on_message: Callable[[WebhookPayload], Awaitable[Optional[WebhookReply]]],
    ):
        if not secret:
            raise ValueError("Webhook secret is required")
        self._secret = secret
        self._on_message = on_message

    def verify(self, body: str, signature: str) -> bool:
        """Verify an HMAC-SHA256 signature."""
        return verify_webhook_signature(body, signature, self._secret)

    def parse(self, body: str) -> WebhookPayload:
        """Parse raw body into a typed WebhookPayload."""
        return parse_webhook_payload(body)

    async def handle_async(self, body: str, signature: str) -> tuple:
        """
        Process a webhook request (verify + parse + call handler).

        Returns:
            A tuple of (status_code, response_dict).
        """
        if not self.verify(body, signature):
            return (401, {"error": "Invalid signature"})

        try:
            payload = self.parse(body)
        except ValueError as e:
            return (400, {"error": str(e)})

        try:
            reply = await self._on_message(payload)
            if reply:
                return (200, reply.model_dump(exclude_none=True))
            return (200, {"ok": True})
        except Exception as e:
            return (500, {"error": str(e)})

    def asgi(self):
        """
        Returns an ASGI application callable for use with Starlette, FastAPI, etc.

        Example::

            from starlette.applications import Starlette
            from starlette.routing import Route
            from prismer.webhook import PrismerWebhook

            webhook = PrismerWebhook(secret="...", on_message=handler)
            app = Starlette(routes=[Route("/webhook", webhook.asgi(), methods=["POST"])])
        """

        async def asgi_app(scope, receive, send):
            if scope["type"] != "http":
                return

            # Read request body
            body_parts = []
            while True:
                message = await receive()
                body_parts.append(message.get("body", b""))
                if not message.get("more_body", False):
                    break
            body = b"".join(body_parts).decode("utf-8")

            # Extract signature from headers
            signature = ""
            for header_name, header_value in scope.get("headers", []):
                if header_name == b"x-prismer-signature":
                    signature = header_value.decode("utf-8")
                    break

            status_code, response_data = await self.handle_async(body, signature)

            response_body = json.dumps(response_data).encode("utf-8")
            await send({
                "type": "http.response.start",
                "status": status_code,
                "headers": [
                    [b"content-type", b"application/json"],
                    [b"content-length", str(len(response_body)).encode()],
                ],
            })
            await send({
                "type": "http.response.body",
                "body": response_body,
            })

        return asgi_app

    def flask(self):
        """
        Returns a Flask view function.

        Example::

            from flask import Flask
            from prismer.webhook import PrismerWebhook

            webhook = PrismerWebhook(secret="...", on_message=handler)
            app = Flask(__name__)
            app.add_url_rule("/webhook", view_func=webhook.flask(), methods=["POST"])
        """
        import asyncio

        def view_func():
            from flask import request as flask_request, jsonify

            body = flask_request.get_data(as_text=True)
            signature = flask_request.headers.get("X-Prismer-Signature", "")

            # Run async handler in sync context
            try:
                loop = asyncio.get_event_loop()
                if loop.is_running():
                    import concurrent.futures
                    with concurrent.futures.ThreadPoolExecutor() as pool:
                        status_code, data = pool.submit(
                            asyncio.run, self.handle_async(body, signature)
                        ).result()
                else:
                    status_code, data = loop.run_until_complete(
                        self.handle_async(body, signature)
                    )
            except RuntimeError:
                status_code, data = asyncio.run(
                    self.handle_async(body, signature)
                )

            return jsonify(data), status_code

        return view_func

    def fastapi_handler(self):
        """
        Returns a FastAPI route handler.

        Example::

            from fastapi import FastAPI, Request
            from prismer.webhook import PrismerWebhook

            webhook = PrismerWebhook(secret="...", on_message=handler)
            app = FastAPI()

            @app.post("/webhook")
            async def webhook_route(request: Request):
                return await webhook.fastapi_handler()(request)
        """

        async def handler(request):
            from starlette.responses import JSONResponse

            body = (await request.body()).decode("utf-8")
            signature = request.headers.get("x-prismer-signature", "")

            status_code, data = await self.handle_async(body, signature)
            return JSONResponse(content=data, status_code=status_code)

        return handler
