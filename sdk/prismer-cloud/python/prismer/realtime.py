"""
Prismer Cloud Real-Time Client — WebSocket & SSE transports.

Example (async)::

    ws = client.im.connect_ws(RealtimeConfig(token=jwt_token))
    await ws.connect()

    @ws.on("message.new")
    async def on_message(payload):
        print(f"New: {payload['content']}")

    await ws.join_conversation("conv-123")
    await ws.send_message("conv-123", "Hello!")

Example (sync)::

    ws = client.im.connect_ws(RealtimeConfig(token=jwt_token))
    ws.connect()
    ws.on("message.new", lambda payload: print(payload["content"]))
    ws.join_conversation("conv-123")
"""

from __future__ import annotations

import asyncio
import json
import math
import random
import threading
import time
import uuid
from typing import Any, Callable, Dict, List, Literal, Optional

from pydantic import BaseModel, Field


# ============================================================================
# Event Payload Types
# ============================================================================

class AuthenticatedPayload(BaseModel):
    user_id: str = Field(alias="userId")
    username: str

    class Config:
        populate_by_name = True


class MessageNewPayload(BaseModel):
    id: str
    conversation_id: str = Field(alias="conversationId")
    content: str
    type: str
    sender_id: str = Field(alias="senderId")
    routing: Optional[Dict[str, Any]] = None
    metadata: Optional[Dict[str, Any]] = None
    created_at: str = Field(alias="createdAt")

    class Config:
        populate_by_name = True


class TypingIndicatorPayload(BaseModel):
    conversation_id: str = Field(alias="conversationId")
    user_id: str = Field(alias="userId")
    is_typing: bool = Field(alias="isTyping")

    class Config:
        populate_by_name = True


class PresenceChangedPayload(BaseModel):
    user_id: str = Field(alias="userId")
    status: str

    class Config:
        populate_by_name = True


class PongPayload(BaseModel):
    request_id: str = Field(alias="requestId")

    class Config:
        populate_by_name = True


class ErrorPayload(BaseModel):
    message: str


class DisconnectedPayload(BaseModel):
    code: int
    reason: str


class ReconnectingPayload(BaseModel):
    attempt: int
    delay: float


# ============================================================================
# Configuration
# ============================================================================

class RealtimeConfig(BaseModel):
    """Configuration for real-time clients."""
    token: str
    auto_reconnect: bool = True
    max_reconnect_attempts: int = 10
    reconnect_base_delay: float = 1.0
    reconnect_max_delay: float = 30.0
    heartbeat_interval: float = 25.0


RealtimeState = Literal["disconnected", "connecting", "connected", "reconnecting"]


# ============================================================================
# Event Emitter
# ============================================================================

class EventEmitter:
    """Thread-safe typed event emitter."""

    def __init__(self) -> None:
        self._listeners: Dict[str, List[Callable]] = {}
        self._once_wrappers: Dict[int, Callable] = {}
        self._lock = threading.Lock()

    def on(self, event: str, callback: Optional[Callable] = None) -> Any:
        """Register event listener. Can be used as decorator."""
        if callback is None:
            # Used as decorator: @emitter.on("event")
            def decorator(fn: Callable) -> Callable:
                self._add_listener(event, fn)
                return fn
            return decorator
        self._add_listener(event, callback)
        return self

    def off(self, event: str, callback: Callable) -> Any:
        """Remove event listener."""
        with self._lock:
            listeners = self._listeners.get(event)
            if listeners:
                # Check if this was a once-wrapped callback
                wrapper_id = id(callback)
                if wrapper_id in self._once_wrappers:
                    actual = self._once_wrappers.pop(wrapper_id)
                    try:
                        listeners.remove(actual)
                    except ValueError:
                        pass
                else:
                    try:
                        listeners.remove(callback)
                    except ValueError:
                        pass
        return self

    def once(self, event: str, callback: Callable) -> Any:
        """Register one-time event listener."""
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            self.off(event, wrapper)
            return callback(*args, **kwargs)

        with self._lock:
            self._once_wrappers[id(callback)] = wrapper
        self._add_listener(event, wrapper)
        return self

    def _add_listener(self, event: str, callback: Callable) -> None:
        with self._lock:
            if event not in self._listeners:
                self._listeners[event] = []
            self._listeners[event].append(callback)

    def _emit(self, event: str, payload: Any = None) -> None:
        with self._lock:
            listeners = list(self._listeners.get(event, []))
        for cb in listeners:
            try:
                cb(payload)
            except Exception:
                pass

    async def _emit_async(self, event: str, payload: Any = None) -> None:
        with self._lock:
            listeners = list(self._listeners.get(event, []))
        for cb in listeners:
            try:
                if asyncio.iscoroutinefunction(cb):
                    await cb(payload)
                else:
                    cb(payload)
            except Exception:
                pass

    def _clear(self) -> None:
        with self._lock:
            self._listeners.clear()
            self._once_wrappers.clear()


# ============================================================================
# Reconnector
# ============================================================================

class Reconnector:
    """Exponential backoff with jitter."""

    def __init__(self, config: RealtimeConfig) -> None:
        self._base_delay = config.reconnect_base_delay
        self._max_delay = config.reconnect_max_delay
        self._max_attempts = config.max_reconnect_attempts
        self._attempt = 0
        self._connected_at = 0.0

    @property
    def should_reconnect(self) -> bool:
        return self._max_attempts == 0 or self._attempt < self._max_attempts

    @property
    def current_attempt(self) -> int:
        return self._attempt

    def mark_connected(self) -> None:
        self._connected_at = time.monotonic()

    def next_delay(self) -> float:
        if self._connected_at > 0 and time.monotonic() - self._connected_at > 60:
            self._attempt = 0
        jitter = random.random() * self._base_delay * 0.5
        delay = min(self._base_delay * math.pow(2, self._attempt) + jitter, self._max_delay)
        self._attempt += 1
        return delay

    def reset(self) -> None:
        self._attempt = 0
        self._connected_at = 0.0


# ============================================================================
# Async WebSocket Client
# ============================================================================

class AsyncRealtimeWSClient(EventEmitter):
    """Async WebSocket real-time client with auto-reconnect and heartbeat."""

    def __init__(self, base_url: str, config: RealtimeConfig) -> None:
        super().__init__()
        ws_base = base_url.replace("https://", "wss://").replace("http://", "ws://")
        self._ws_url = f"{ws_base}/ws?token={config.token}"
        self._config = config
        self._reconnector = Reconnector(config)
        self._ws: Any = None  # websockets connection
        self._receive_task: Optional[asyncio.Task] = None
        self._heartbeat_task: Optional[asyncio.Task] = None
        self._reconnect_task: Optional[asyncio.Task] = None
        self._state: RealtimeState = "disconnected"
        self._intentional_close = False
        self._pending_pings: Dict[str, asyncio.Future] = {}
        self._ping_counter = 0

    @property
    def state(self) -> RealtimeState:
        return self._state

    async def connect(self) -> None:
        if self._state in ("connected", "connecting"):
            return

        import websockets

        self._state = "connecting"
        self._intentional_close = False

        self._ws = await websockets.connect(self._ws_url)

        # Wait for authenticated event
        raw = await self._ws.recv()
        msg = json.loads(raw)
        if msg.get("type") != "authenticated":
            await self._ws.close()
            self._state = "disconnected"
            raise ConnectionError(f"Expected 'authenticated', got '{msg.get('type')}'")

        self._state = "connected"
        self._reconnector.mark_connected()
        await self._emit_async("authenticated", msg.get("payload", {}))
        await self._emit_async("connected", None)

        self._receive_task = asyncio.create_task(self._receive_loop())
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())

    async def disconnect(self, code: int = 1000, reason: str = "client disconnect") -> None:
        self._intentional_close = True
        self._cancel_tasks()
        self._clear_pending_pings()
        if self._ws:
            try:
                await self._ws.close(code, reason)
            except Exception:
                pass
            self._ws = None
        self._state = "disconnected"
        await self._emit_async("disconnected", {"code": code, "reason": reason})

    # --- Commands ---

    async def join_conversation(self, conversation_id: str) -> None:
        await self._send_raw({"type": "conversation.join", "payload": {"conversationId": conversation_id}})

    async def send_message(self, conversation_id: str, content: str, type: str = "text", *, metadata: dict | None = None, parent_id: str | None = None) -> None:
        self._ping_counter += 1
        payload: dict = {"conversationId": conversation_id, "content": content, "type": type}
        if metadata is not None:
            payload["metadata"] = metadata
        if parent_id is not None:
            payload["parentId"] = parent_id
        await self._send_raw({
            "type": "message.send",
            "payload": payload,
            "requestId": f"msg-{self._ping_counter}",
        })

    async def start_typing(self, conversation_id: str) -> None:
        await self._send_raw({"type": "typing.start", "payload": {"conversationId": conversation_id}})

    async def stop_typing(self, conversation_id: str) -> None:
        await self._send_raw({"type": "typing.stop", "payload": {"conversationId": conversation_id}})

    async def update_presence(self, status: str) -> None:
        await self._send_raw({"type": "presence.update", "payload": {"status": status}})

    async def send(self, command: Dict[str, Any]) -> None:
        await self._send_raw(command)

    async def ping(self) -> Dict[str, Any]:
        request_id = f"ping-{uuid.uuid4().hex[:8]}"
        loop = asyncio.get_event_loop()
        future: asyncio.Future = loop.create_future()
        self._pending_pings[request_id] = future
        await self._send_raw({"type": "ping", "payload": {"requestId": request_id}})
        try:
            return await asyncio.wait_for(future, timeout=10.0)
        except asyncio.TimeoutError:
            self._pending_pings.pop(request_id, None)
            raise TimeoutError("Ping timeout")

    # --- Context Manager ---

    async def __aenter__(self) -> "AsyncRealtimeWSClient":
        await self.connect()
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.disconnect()

    # --- Internal ---

    async def _send_raw(self, data: Any) -> None:
        if self._ws:
            try:
                await self._ws.send(json.dumps(data))
            except Exception:
                pass

    async def _receive_loop(self) -> None:
        import websockets

        try:
            async for raw in self._ws:
                msg = json.loads(raw)
                event_type = msg.get("type", "")
                payload = msg.get("payload", {})

                # Resolve pending pings
                if event_type == "pong" and "requestId" in payload:
                    future = self._pending_pings.pop(payload["requestId"], None)
                    if future and not future.done():
                        future.set_result(payload)

                await self._emit_async(event_type, payload)
        except websockets.ConnectionClosed as e:
            if self._intentional_close:
                return
            self._state = "disconnected"
            await self._emit_async("disconnected", {"code": e.code, "reason": str(e.reason)})
            if self._config.auto_reconnect and self._reconnector.should_reconnect:
                await self._schedule_reconnect()
        except Exception:
            if self._intentional_close:
                return
            self._state = "disconnected"
            await self._emit_async("disconnected", {"code": 0, "reason": "receive error"})
            if self._config.auto_reconnect and self._reconnector.should_reconnect:
                await self._schedule_reconnect()

    async def _heartbeat_loop(self) -> None:
        while self._state == "connected":
            await asyncio.sleep(self._config.heartbeat_interval)
            if self._state != "connected":
                break
            request_id = f"hb-{uuid.uuid4().hex[:8]}"
            await self._send_raw({"type": "ping", "payload": {"requestId": request_id}})

            # Wait for pong within 10s
            loop = asyncio.get_event_loop()
            future: asyncio.Future = loop.create_future()
            self._pending_pings[request_id] = future
            try:
                await asyncio.wait_for(future, timeout=10.0)
            except asyncio.TimeoutError:
                self._pending_pings.pop(request_id, None)
                # Force close to trigger reconnect
                if self._ws:
                    try:
                        await self._ws.close(4000, "heartbeat timeout")
                    except Exception:
                        pass
                break

    async def _schedule_reconnect(self) -> None:
        delay = self._reconnector.next_delay()
        self._state = "reconnecting"
        await self._emit_async("reconnecting", {"attempt": self._reconnector.current_attempt, "delay": delay})
        await asyncio.sleep(delay)
        try:
            await self.connect()
        except Exception:
            if self._config.auto_reconnect and self._reconnector.should_reconnect:
                await self._schedule_reconnect()
            else:
                self._state = "disconnected"

    def _cancel_tasks(self) -> None:
        for task in (self._receive_task, self._heartbeat_task, self._reconnect_task):
            if task and not task.done():
                task.cancel()
        self._receive_task = None
        self._heartbeat_task = None
        self._reconnect_task = None

    def _clear_pending_pings(self) -> None:
        for future in self._pending_pings.values():
            if not future.done():
                future.cancel()
        self._pending_pings.clear()


# ============================================================================
# Async SSE Client
# ============================================================================

class AsyncRealtimeSSEClient(EventEmitter):
    """Async SSE real-time client (server-push only) with auto-reconnect."""

    def __init__(self, base_url: str, config: RealtimeConfig) -> None:
        super().__init__()
        self._sse_url = f"{base_url}/sse?token={config.token}"
        self._config = config
        self._reconnector = Reconnector(config)
        self._state: RealtimeState = "disconnected"
        self._intentional_close = False
        self._read_task: Optional[asyncio.Task] = None
        self._watchdog_task: Optional[asyncio.Task] = None
        self._last_data_time = 0.0
        self._httpx_client: Any = None

    @property
    def state(self) -> RealtimeState:
        return self._state

    async def connect(self) -> None:
        if self._state in ("connected", "connecting"):
            return

        import httpx

        self._state = "connecting"
        self._intentional_close = False

        self._httpx_client = httpx.AsyncClient(timeout=None)
        self._last_data_time = time.monotonic()

        # Start reading in the background
        self._read_task = asyncio.create_task(self._read_stream())

        # Wait briefly for the authenticated event
        auth_event = asyncio.get_event_loop().create_future()

        def on_auth(payload: Any) -> None:
            if not auth_event.done():
                auth_event.set_result(payload)

        self.once("authenticated", on_auth)

        try:
            await asyncio.wait_for(auth_event, timeout=10.0)
        except asyncio.TimeoutError:
            self._cancel_tasks()
            if self._httpx_client:
                await self._httpx_client.aclose()
                self._httpx_client = None
            self._state = "disconnected"
            raise ConnectionError("SSE authentication timeout")

    async def disconnect(self) -> None:
        self._intentional_close = True
        self._cancel_tasks()
        if self._httpx_client:
            await self._httpx_client.aclose()
            self._httpx_client = None
        self._state = "disconnected"
        await self._emit_async("disconnected", {"code": 1000, "reason": "client disconnect"})

    async def __aenter__(self) -> "AsyncRealtimeSSEClient":
        await self.connect()
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.disconnect()

    # --- Internal ---

    async def _read_stream(self) -> None:
        import httpx

        try:
            async with self._httpx_client.stream(
                "GET",
                self._sse_url,
                headers={"Accept": "text/event-stream"},
            ) as response:
                if response.status_code != 200:
                    self._state = "disconnected"
                    await self._emit_async("error", {"message": f"SSE HTTP {response.status_code}"})
                    return

                self._state = "connected"
                self._reconnector.mark_connected()
                self._watchdog_task = asyncio.create_task(self._heartbeat_watchdog())
                await self._emit_async("connected", None)

                async for line in response.aiter_lines():
                    if self._intentional_close:
                        return

                    self._last_data_time = time.monotonic()

                    if line.startswith(":"):
                        continue  # heartbeat comment

                    if line.startswith("data: "):
                        json_str = line[6:]
                        try:
                            msg = json.loads(json_str)
                            await self._emit_async(msg.get("type", ""), msg.get("payload", {}))
                        except json.JSONDecodeError:
                            pass
        except Exception:
            if self._intentional_close:
                return

        # Stream ended
        if self._intentional_close:
            return

        self._state = "disconnected"
        self._cancel_watchdog()
        await self._emit_async("disconnected", {"code": 0, "reason": "stream ended"})

        if self._config.auto_reconnect and self._reconnector.should_reconnect:
            await self._schedule_reconnect()

    async def _heartbeat_watchdog(self) -> None:
        while self._state == "connected":
            await asyncio.sleep(15.0)
            if time.monotonic() - self._last_data_time > 45.0:
                # Stream stale — close and reconnect
                if self._httpx_client:
                    await self._httpx_client.aclose()
                    self._httpx_client = None
                break

    async def _schedule_reconnect(self) -> None:
        delay = self._reconnector.next_delay()
        self._state = "reconnecting"
        await self._emit_async("reconnecting", {"attempt": self._reconnector.current_attempt, "delay": delay})
        await asyncio.sleep(delay)

        import httpx
        self._httpx_client = httpx.AsyncClient(timeout=None)

        try:
            self._read_task = asyncio.create_task(self._read_stream())
            # Wait for connected state
            connected_event = asyncio.get_event_loop().create_future()

            def on_connected(payload: Any) -> None:
                if not connected_event.done():
                    connected_event.set_result(True)

            self.once("connected", on_connected)
            await asyncio.wait_for(connected_event, timeout=10.0)
        except Exception:
            if self._config.auto_reconnect and self._reconnector.should_reconnect:
                await self._schedule_reconnect()
            else:
                self._state = "disconnected"

    def _cancel_tasks(self) -> None:
        for task in (self._read_task, self._watchdog_task):
            if task and not task.done():
                task.cancel()
        self._read_task = None
        self._watchdog_task = None

    def _cancel_watchdog(self) -> None:
        if self._watchdog_task and not self._watchdog_task.done():
            self._watchdog_task.cancel()
        self._watchdog_task = None


# ============================================================================
# Sync WebSocket Client (background thread)
# ============================================================================

class RealtimeWSClient(EventEmitter):
    """Synchronous WebSocket real-time client. Runs receive loop in background thread."""

    def __init__(self, base_url: str, config: RealtimeConfig) -> None:
        super().__init__()
        ws_base = base_url.replace("https://", "wss://").replace("http://", "ws://")
        self._ws_url = f"{ws_base}/ws?token={config.token}"
        self._config = config
        self._reconnector = Reconnector(config)
        self._ws: Any = None
        self._thread: Optional[threading.Thread] = None
        self._state: RealtimeState = "disconnected"
        self._intentional_close = False
        self._ping_counter = 0
        self._pending_pings: Dict[str, threading.Event] = {}
        self._pong_results: Dict[str, Dict[str, Any]] = {}

    @property
    def state(self) -> RealtimeState:
        return self._state

    def connect(self) -> None:
        if self._state in ("connected", "connecting"):
            return

        from websockets.sync.client import connect as ws_connect

        self._state = "connecting"
        self._intentional_close = False

        self._ws = ws_connect(self._ws_url)

        # Wait for authenticated
        raw = self._ws.recv()
        msg = json.loads(raw)
        if msg.get("type") != "authenticated":
            self._ws.close()
            self._state = "disconnected"
            raise ConnectionError(f"Expected 'authenticated', got '{msg.get('type')}'")

        self._state = "connected"
        self._reconnector.mark_connected()
        self._emit("authenticated", msg.get("payload", {}))
        self._emit("connected", None)

        self._thread = threading.Thread(target=self._receive_loop, daemon=True)
        self._thread.start()

    def disconnect(self, code: int = 1000, reason: str = "client disconnect") -> None:
        self._intentional_close = True
        if self._ws:
            try:
                self._ws.close(code, reason)
            except Exception:
                pass
            self._ws = None
        self._state = "disconnected"
        self._emit("disconnected", {"code": code, "reason": reason})

    # --- Commands ---

    def join_conversation(self, conversation_id: str) -> None:
        self._send_raw({"type": "conversation.join", "payload": {"conversationId": conversation_id}})

    def send_message(self, conversation_id: str, content: str, type: str = "text", *, metadata: dict | None = None, parent_id: str | None = None) -> None:
        self._ping_counter += 1
        payload: dict = {"conversationId": conversation_id, "content": content, "type": type}
        if metadata is not None:
            payload["metadata"] = metadata
        if parent_id is not None:
            payload["parentId"] = parent_id
        self._send_raw({
            "type": "message.send",
            "payload": payload,
            "requestId": f"msg-{self._ping_counter}",
        })

    def start_typing(self, conversation_id: str) -> None:
        self._send_raw({"type": "typing.start", "payload": {"conversationId": conversation_id}})

    def stop_typing(self, conversation_id: str) -> None:
        self._send_raw({"type": "typing.stop", "payload": {"conversationId": conversation_id}})

    def update_presence(self, status: str) -> None:
        self._send_raw({"type": "presence.update", "payload": {"status": status}})

    def send(self, command: Dict[str, Any]) -> None:
        self._send_raw(command)

    def ping(self, timeout: float = 10.0) -> Dict[str, Any]:
        request_id = f"ping-{uuid.uuid4().hex[:8]}"
        event = threading.Event()
        self._pending_pings[request_id] = event
        self._send_raw({"type": "ping", "payload": {"requestId": request_id}})
        if not event.wait(timeout):
            self._pending_pings.pop(request_id, None)
            raise TimeoutError("Ping timeout")
        self._pending_pings.pop(request_id, None)
        return self._pong_results.pop(request_id, {})

    # --- Context Manager ---

    def __enter__(self) -> "RealtimeWSClient":
        self.connect()
        return self

    def __exit__(self, *args: Any) -> None:
        self.disconnect()

    # --- Internal ---

    def _send_raw(self, data: Any) -> None:
        if self._ws:
            try:
                self._ws.send(json.dumps(data))
            except Exception:
                pass

    def _receive_loop(self) -> None:
        from websockets.exceptions import ConnectionClosed

        try:
            for raw in self._ws:
                msg = json.loads(raw)
                event_type = msg.get("type", "")
                payload = msg.get("payload", {})

                # Resolve pending pings
                if event_type == "pong" and "requestId" in payload:
                    rid = payload["requestId"]
                    self._pong_results[rid] = payload
                    event_obj = self._pending_pings.get(rid)
                    if event_obj:
                        event_obj.set()

                self._emit(event_type, payload)
        except ConnectionClosed as e:
            if self._intentional_close:
                return
            self._state = "disconnected"
            self._emit("disconnected", {"code": e.code, "reason": str(e.reason)})
            if self._config.auto_reconnect and self._reconnector.should_reconnect:
                self._sync_reconnect()
        except Exception:
            if self._intentional_close:
                return
            self._state = "disconnected"
            self._emit("disconnected", {"code": 0, "reason": "receive error"})
            if self._config.auto_reconnect and self._reconnector.should_reconnect:
                self._sync_reconnect()

    def _sync_reconnect(self) -> None:
        delay = self._reconnector.next_delay()
        self._state = "reconnecting"
        self._emit("reconnecting", {"attempt": self._reconnector.current_attempt, "delay": delay})
        time.sleep(delay)
        try:
            self.connect()
        except Exception:
            if self._config.auto_reconnect and self._reconnector.should_reconnect:
                self._sync_reconnect()
            else:
                self._state = "disconnected"


# ============================================================================
# Sync SSE Client (background thread)
# ============================================================================

class RealtimeSSEClient(EventEmitter):
    """Synchronous SSE real-time client. Runs receive loop in background thread."""

    def __init__(self, base_url: str, config: RealtimeConfig) -> None:
        super().__init__()
        self._sse_url = f"{base_url}/sse?token={config.token}"
        self._config = config
        self._reconnector = Reconnector(config)
        self._state: RealtimeState = "disconnected"
        self._intentional_close = False
        self._thread: Optional[threading.Thread] = None
        self._last_data_time = 0.0
        self._httpx_client: Any = None

    @property
    def state(self) -> RealtimeState:
        return self._state

    def connect(self) -> None:
        if self._state in ("connected", "connecting"):
            return

        import httpx

        self._state = "connecting"
        self._intentional_close = False
        self._last_data_time = time.monotonic()

        # Start reading in background thread
        auth_event = threading.Event()
        auth_result: List[Any] = [None]

        original_on = self.on

        def on_auth(payload: Any) -> None:
            auth_result[0] = payload
            auth_event.set()

        self.once("authenticated", on_auth)

        self._thread = threading.Thread(target=self._read_stream_sync, daemon=True)
        self._thread.start()

        if not auth_event.wait(timeout=10.0):
            self._intentional_close = True
            self._state = "disconnected"
            raise ConnectionError("SSE authentication timeout")

    def disconnect(self) -> None:
        self._intentional_close = True
        if self._httpx_client:
            self._httpx_client.close()
            self._httpx_client = None
        self._state = "disconnected"
        self._emit("disconnected", {"code": 1000, "reason": "client disconnect"})

    def __enter__(self) -> "RealtimeSSEClient":
        self.connect()
        return self

    def __exit__(self, *args: Any) -> None:
        self.disconnect()

    # --- Internal ---

    def _read_stream_sync(self) -> None:
        import httpx

        try:
            self._httpx_client = httpx.Client(timeout=None)
            with self._httpx_client.stream(
                "GET",
                self._sse_url,
                headers={"Accept": "text/event-stream"},
            ) as response:
                if response.status_code != 200:
                    self._state = "disconnected"
                    self._emit("error", {"message": f"SSE HTTP {response.status_code}"})
                    return

                self._state = "connected"
                self._reconnector.mark_connected()
                self._emit("connected", None)

                for line in response.iter_lines():
                    if self._intentional_close:
                        return

                    self._last_data_time = time.monotonic()

                    if line.startswith(":"):
                        continue

                    if line.startswith("data: "):
                        json_str = line[6:]
                        try:
                            msg = json.loads(json_str)
                            self._emit(msg.get("type", ""), msg.get("payload", {}))
                        except json.JSONDecodeError:
                            pass
        except Exception:
            if self._intentional_close:
                return

        # Stream ended
        if self._intentional_close:
            return

        self._state = "disconnected"
        self._emit("disconnected", {"code": 0, "reason": "stream ended"})

        if self._config.auto_reconnect and self._reconnector.should_reconnect:
            self._sync_reconnect()

    def _sync_reconnect(self) -> None:
        delay = self._reconnector.next_delay()
        self._state = "reconnecting"
        self._emit("reconnecting", {"attempt": self._reconnector.current_attempt, "delay": delay})
        time.sleep(delay)

        import httpx
        self._httpx_client = httpx.Client(timeout=None)

        try:
            self._thread = threading.Thread(target=self._read_stream_sync, daemon=True)
            self._thread.start()

            connected_event = threading.Event()

            def on_connected(payload: Any) -> None:
                connected_event.set()

            self.once("connected", on_connected)
            if not connected_event.wait(timeout=10.0):
                raise ConnectionError("SSE reconnect timeout")
        except Exception:
            if self._config.auto_reconnect and self._reconnector.should_reconnect:
                self._sync_reconnect()
            else:
                self._state = "disconnected"
