"""
Prismer SDK — Offline Manager, Outbox Queue, and Sync Engine (Python).

Port of core offline-first features from the TypeScript SDK.
Provides MemoryStorage, outbox queue with idempotency, and polling sync.

Usage:
    from prismer.offline import OfflineManager, MemoryStorage, OfflineConfig

    storage = MemoryStorage()
    offline = OfflineManager(storage, request_fn, OfflineConfig())
    await offline.init()
"""

import asyncio
import re
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Literal, Optional, Set


# ============================================================================
# Data Types
# ============================================================================

@dataclass
class StoredMessage:
    id: str
    conversation_id: str
    content: str
    type: str
    sender_id: str
    status: str = "confirmed"
    client_id: Optional[str] = None
    parent_id: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None
    created_at: str = ""
    updated_at: Optional[str] = None
    sync_seq: Optional[int] = None


@dataclass
class StoredConversation:
    id: str
    type: str
    title: Optional[str] = None
    last_message: Optional[Dict[str, Any]] = None
    last_message_at: Optional[str] = None
    unread_count: int = 0
    members: Optional[List[Dict[str, Any]]] = None
    metadata: Optional[Dict[str, Any]] = None
    updated_at: Optional[str] = None
    sync_seq: Optional[int] = None


@dataclass
class OutboxOperation:
    id: str
    type: str  # message.send | message.edit | message.delete | conversation.read
    method: str
    path: str
    body: Any = None
    query: Optional[Dict[str, str]] = None
    status: str = "pending"  # pending | sending | failed
    created_at: float = 0
    retries: int = 0
    max_retries: int = 5
    idempotency_key: str = ""
    local_data: Optional[StoredMessage] = None
    error: Optional[str] = None


@dataclass
class SyncEvent:
    seq: int
    type: str
    data: Any
    conversation_id: Optional[str] = None
    at: str = ""


@dataclass
class SyncResult:
    events: List[SyncEvent]
    cursor: int
    has_more: bool


@dataclass
class OfflineConfig:
    sync_on_connect: bool = True
    outbox_retry_limit: int = 5
    outbox_flush_interval: float = 1.0  # seconds
    conflict_strategy: Literal["server", "client"] = "server"


# ============================================================================
# Storage Adapter — MemoryStorage
# ============================================================================

class MemoryStorage:
    """In-memory storage adapter. Matches the TypeScript StorageAdapter interface."""

    def __init__(self) -> None:
        self._messages: Dict[str, StoredMessage] = {}
        self._conversations: Dict[str, StoredConversation] = {}
        self._contacts: List[Dict[str, Any]] = []
        self._cursors: Dict[str, str] = {}
        self._outbox: Dict[str, OutboxOperation] = {}

    async def init(self) -> None:
        pass

    # ── Messages ─────────────────────────────────────────────

    async def get_message(self, message_id: str) -> Optional[StoredMessage]:
        return self._messages.get(message_id)

    async def put_messages(self, messages: List[StoredMessage]) -> None:
        for msg in messages:
            self._messages[msg.id] = msg

    async def get_messages(
        self,
        conversation_id: str,
        *,
        limit: int = 50,
        before: Optional[str] = None,
    ) -> List[StoredMessage]:
        msgs = [m for m in self._messages.values() if m.conversation_id == conversation_id]
        msgs.sort(key=lambda m: m.created_at)
        if before:
            msgs = [m for m in msgs if m.created_at < before]
        return msgs[-limit:]

    async def delete_message(self, message_id: str) -> None:
        self._messages.pop(message_id, None)

    async def search_messages(
        self, query: str, *, conversation_id: Optional[str] = None, limit: int = 50,
    ) -> List[StoredMessage]:
        q = query.lower()
        results = []
        for msg in self._messages.values():
            if conversation_id and msg.conversation_id != conversation_id:
                continue
            if q in msg.content.lower():
                results.append(msg)
                if len(results) >= limit:
                    break
        return results

    # ── Conversations ────────────────────────────────────────

    async def get_conversation(self, conversation_id: str) -> Optional[StoredConversation]:
        return self._conversations.get(conversation_id)

    async def put_conversations(self, conversations: List[StoredConversation]) -> None:
        for conv in conversations:
            self._conversations[conv.id] = conv

    async def get_conversations(self, *, limit: int = 50) -> List[StoredConversation]:
        convs = list(self._conversations.values())
        convs.sort(key=lambda c: c.updated_at or "", reverse=True)
        return convs[:limit]

    # ── Contacts ─────────────────────────────────────────────

    async def get_contacts(self) -> List[Dict[str, Any]]:
        return list(self._contacts)

    async def put_contacts(self, contacts: List[Dict[str, Any]]) -> None:
        self._contacts = list(contacts)

    # ── Cursors ──────────────────────────────────────────────

    async def get_cursor(self, key: str) -> Optional[str]:
        return self._cursors.get(key)

    async def set_cursor(self, key: str, value: str) -> None:
        self._cursors[key] = value

    # ── Outbox ───────────────────────────────────────────────

    async def enqueue(self, op: OutboxOperation) -> None:
        self._outbox[op.id] = op

    async def dequeue_ready(self, limit: int = 10) -> List[OutboxOperation]:
        ready = [
            op for op in self._outbox.values()
            if op.status == "pending" and op.retries < op.max_retries
        ]
        ready.sort(key=lambda o: o.created_at)
        return ready[:limit]

    async def ack(self, op_id: str) -> None:
        self._outbox.pop(op_id, None)

    async def nack(self, op_id: str, error: str, retries: int) -> None:
        op = self._outbox.get(op_id)
        if op:
            op.retries = retries
            op.error = error
            if retries >= op.max_retries:
                op.status = "failed"

    async def get_pending_count(self) -> int:
        return sum(1 for op in self._outbox.values() if op.status == "pending")

    # ── Storage info ─────────────────────────────────────────

    async def get_storage_size(self) -> Dict[str, int]:
        return {
            "messages": len(self._messages),
            "conversations": len(self._conversations),
            "total": len(self._messages) + len(self._conversations),
        }


# ============================================================================
# Write operation detection
# ============================================================================

_WRITE_PATTERNS = [
    ("POST", re.compile(r"/api/im/(messages|direct|groups)/"), "message.send"),
    ("PATCH", re.compile(r"/api/im/messages/"), "message.edit"),
    ("DELETE", re.compile(r"/api/im/messages/"), "message.delete"),
    ("POST", re.compile(r"/api/im/conversations/[^/]+/read"), "conversation.read"),
]


def _match_write_op(method: str, path: str) -> Optional[str]:
    for m, pattern, op_type in _WRITE_PATTERNS:
        if method == m and pattern.search(path):
            return op_type
    return None


# ============================================================================
# Event Emitter
# ============================================================================

Listener = Callable[..., Any]


class _OfflineEmitter:
    """Simple event emitter for offline events."""

    def __init__(self) -> None:
        self._listeners: Dict[str, Set[Listener]] = {}

    def on(self, event: str, callback: Listener) -> None:
        if event not in self._listeners:
            self._listeners[event] = set()
        self._listeners[event].add(callback)

    def off(self, event: str, callback: Listener) -> None:
        listeners = self._listeners.get(event)
        if listeners:
            listeners.discard(callback)

    def emit(self, event: str, payload: Any = None) -> None:
        listeners = self._listeners.get(event)
        if listeners:
            for cb in list(listeners):
                try:
                    cb(payload)
                except Exception:
                    pass

    def remove_all_listeners(self) -> None:
        self._listeners.clear()


# ============================================================================
# Offline Manager
# ============================================================================

class OfflineManager(_OfflineEmitter):
    """
    Manages offline-first IM operations: outbox queue, polling sync, and local cache.

    Usage::

        storage = MemoryStorage()
        offline = OfflineManager(storage, request_fn)
        await offline.init()

        # Dispatch IM requests through offline layer
        result = await offline.dispatch("POST", "/api/im/messages/conv-123", {"content": "hello"})

        # Sync from server
        await offline.sync()
    """

    def __init__(
        self,
        storage: MemoryStorage,
        network_request: Callable,
        config: Optional[OfflineConfig] = None,
    ) -> None:
        super().__init__()
        self.storage = storage
        self._network_request = network_request
        cfg = config or OfflineConfig()
        self._sync_on_connect = cfg.sync_on_connect
        self._outbox_retry_limit = cfg.outbox_retry_limit
        self._outbox_flush_interval = cfg.outbox_flush_interval
        self._conflict_strategy = cfg.conflict_strategy
        self._flush_task: Optional[asyncio.Task] = None
        self._flushing = False
        self._is_online = True
        self._sync_state: str = "idle"  # idle | syncing | error

    @property
    def is_online(self) -> bool:
        return self._is_online

    @property
    def sync_state(self) -> str:
        return self._sync_state

    async def init(self) -> None:
        """Initialize storage and start outbox flush timer."""
        await self.storage.init()
        self._start_flush_timer()

    async def destroy(self) -> None:
        """Stop timers and clean up."""
        self._stop_flush_timer()
        self.remove_all_listeners()

    # ── Network state ─────────────────────────────────────────

    def set_online(self, online: bool) -> None:
        if self._is_online == online:
            return
        self._is_online = online
        self.emit("network.online" if online else "network.offline")
        if online:
            asyncio.ensure_future(self.flush())
            if self._sync_on_connect:
                asyncio.ensure_future(self.sync())

    # ── Request dispatch ──────────────────────────────────────

    async def dispatch(
        self,
        method: str,
        path: str,
        body: Any = None,
        query: Optional[Dict[str, str]] = None,
    ) -> Any:
        """Dispatch an IM request. Writes go through outbox; reads check local cache."""
        op_type = _match_write_op(method, path)
        if op_type:
            return await self._dispatch_write(op_type, method, path, body, query)

        # Reads: try local cache first
        if method == "GET":
            cached = await self._read_from_cache(path, query)
            if cached is not None:
                return cached

        # Network request, then cache
        try:
            result = await self._network_request(method, path, json=body, params=query)
            if method == "GET":
                await self._cache_read_result(path, query, result)
            return result
        except Exception:
            if not self._is_online:
                return {"ok": True, "data": []}
            raise

    # ── Outbox write dispatch ─────────────────────────────────

    async def _dispatch_write(
        self,
        op_type: str,
        method: str,
        path: str,
        body: Any = None,
        query: Optional[Dict[str, str]] = None,
    ) -> Any:
        client_id = str(uuid.uuid4())
        idempotency_key = f"sdk-{client_id}"

        # Inject idempotency key
        enriched_body = body
        if body and isinstance(body, dict) and op_type in ("message.send", "message.edit"):
            enriched_body = {**body}
            metadata = {**(body.get("metadata") or {}), "_idempotencyKey": idempotency_key}
            enriched_body["metadata"] = metadata

        # Build optimistic local message
        local_message: Optional[StoredMessage] = None
        if op_type == "message.send" and isinstance(body, dict):
            conv_match = re.search(r"/(?:messages|direct|groups)/([^/]+)", path)
            conversation_id = conv_match.group(1) if conv_match else ""
            from datetime import datetime, timezone
            local_message = StoredMessage(
                id=f"local-{client_id}",
                client_id=client_id,
                conversation_id=conversation_id,
                content=body.get("content", ""),
                type=body.get("type", "text"),
                sender_id="__self__",
                parent_id=body.get("parentId"),
                status="pending",
                metadata=body.get("metadata"),
                created_at=datetime.now(timezone.utc).isoformat(),
            )
            await self.storage.put_messages([local_message])
            self.emit("message.local", local_message)

        # Enqueue to outbox
        import time
        op = OutboxOperation(
            id=client_id,
            type=op_type,
            method=method,
            path=path,
            body=enriched_body,
            query=query,
            status="pending",
            created_at=time.time(),
            retries=0,
            max_retries=self._outbox_retry_limit,
            idempotency_key=idempotency_key,
            local_data=local_message,
        )
        await self.storage.enqueue(op)

        # If online, trigger immediate flush
        if self._is_online:
            asyncio.ensure_future(self.flush())

        # Return optimistic result
        return {
            "ok": True,
            "data": {
                "conversationId": local_message.conversation_id,
                "message": {
                    "id": local_message.id,
                    "content": local_message.content,
                    "type": local_message.type,
                    "senderId": local_message.sender_id,
                    "status": local_message.status,
                    "createdAt": local_message.created_at,
                },
            } if local_message else None,
            "_pending": True,
            "_clientId": client_id,
        }

    # ── Outbox flush ──────────────────────────────────────────

    def _start_flush_timer(self) -> None:
        self._stop_flush_timer()

        async def _flush_loop() -> None:
            while True:
                await asyncio.sleep(self._outbox_flush_interval)
                try:
                    await self.flush()
                except Exception:
                    pass

        try:
            loop = asyncio.get_running_loop()
            self._flush_task = loop.create_task(_flush_loop())
        except RuntimeError:
            pass

    def _stop_flush_timer(self) -> None:
        if self._flush_task:
            self._flush_task.cancel()
            self._flush_task = None

    async def flush(self) -> None:
        """Flush pending outbox operations to the server."""
        if self._flushing or not self._is_online:
            return
        self._flushing = True

        try:
            ops = await self.storage.dequeue_ready(10)
            for op in ops:
                self.emit("outbox.sending", {"op_id": op.id, "type": op.type})
                try:
                    result = await self._network_request(
                        op.method, op.path, json=op.body, params=op.query,
                    )

                    if result.get("ok"):
                        await self.storage.ack(op.id)
                        self.emit("outbox.confirmed", {"op_id": op.id, "server_data": result.get("data")})

                        # Update local message with server data
                        if op.type == "message.send" and op.local_data:
                            local = op.local_data
                            server_msg = (result.get("data") or {}).get("message")
                            if server_msg:
                                await self.storage.delete_message(local.id)
                                await self.storage.put_messages([StoredMessage(
                                    id=server_msg.get("id", local.id),
                                    client_id=op.id,
                                    conversation_id=server_msg.get("conversationId", local.conversation_id),
                                    content=server_msg.get("content", local.content),
                                    type=server_msg.get("type", local.type),
                                    sender_id=server_msg.get("senderId", local.sender_id),
                                    parent_id=server_msg.get("parentId"),
                                    status="confirmed",
                                    metadata=server_msg.get("metadata"),
                                    created_at=server_msg.get("createdAt", local.created_at),
                                )])
                                self.emit("message.confirmed", {"client_id": op.id, "server_message": server_msg})
                    else:
                        err_code = (result.get("error") or {}).get("code", "")
                        err_msg = (result.get("error") or {}).get("message", "Request failed")
                        if "TIMEOUT" not in err_code and "NETWORK" not in err_code:
                            # Permanent failure
                            await self.storage.nack(op.id, err_msg, op.max_retries)
                            self.emit("outbox.failed", {"op_id": op.id, "error": err_msg, "retries_left": 0})
                            if op.type == "message.send":
                                self.emit("message.failed", {"client_id": op.id, "error": err_msg})
                        else:
                            # Transient error, retry
                            await self.storage.nack(op.id, err_msg, op.retries + 1)
                            self.emit("outbox.failed", {
                                "op_id": op.id, "error": err_msg,
                                "retries_left": op.max_retries - op.retries - 1,
                            })
                except Exception as exc:
                    msg = str(exc)
                    await self.storage.nack(op.id, msg, op.retries + 1)
                    if op.retries + 1 >= op.max_retries:
                        self.emit("outbox.failed", {"op_id": op.id, "error": msg, "retries_left": 0})
                        if op.type == "message.send":
                            self.emit("message.failed", {"client_id": op.id, "error": msg})
        finally:
            self._flushing = False

    async def outbox_size(self) -> int:
        return await self.storage.get_pending_count()

    # ── Sync engine ───────────────────────────────────────────

    async def sync(self) -> None:
        """Pull sync events from the server and apply locally."""
        if self._sync_state == "syncing" or not self._is_online:
            return
        self._sync_state = "syncing"
        self.emit("sync.start")

        total_new = 0
        total_updated = 0

        try:
            cursor = await self.storage.get_cursor("global_sync") or "0"
            has_more = True

            while has_more:
                result = await self._network_request(
                    "GET", "/api/im/sync", params={"since": cursor, "limit": "100"},
                )

                if not result.get("ok") or not result.get("data"):
                    raise RuntimeError(
                        (result.get("error") or {}).get("message", "Sync failed")
                    )

                data = result["data"]
                events_raw = data.get("events", [])
                new_cursor = data.get("cursor", cursor)
                has_more = data.get("hasMore", False)

                for ev_raw in events_raw:
                    event = SyncEvent(
                        seq=ev_raw.get("seq", 0),
                        type=ev_raw.get("type", ""),
                        data=ev_raw.get("data"),
                        conversation_id=ev_raw.get("conversationId"),
                        at=ev_raw.get("at", ""),
                    )
                    await self._apply_sync_event(event)
                    if event.type == "message.new":
                        total_new += 1
                    if event.type.startswith("conversation."):
                        total_updated += 1

                cursor = str(new_cursor)
                await self.storage.set_cursor("global_sync", cursor)
                self.emit("sync.progress", {"synced": len(events_raw), "total": len(events_raw)})

            self._sync_state = "idle"
            self.emit("sync.complete", {"new_messages": total_new, "updated_conversations": total_updated})
        except Exception as exc:
            self._sync_state = "error"
            self.emit("sync.error", {"error": str(exc), "will_retry": False})

    async def _apply_sync_event(self, event: SyncEvent) -> None:
        """Apply a single sync event to local storage."""
        if event.type == "message.new":
            msg = event.data or {}
            await self.storage.put_messages([StoredMessage(
                id=msg.get("id", ""),
                conversation_id=msg.get("conversationId") or event.conversation_id or "",
                content=msg.get("content", ""),
                type=msg.get("type", "text"),
                sender_id=msg.get("senderId", ""),
                parent_id=msg.get("parentId"),
                status="confirmed",
                metadata=msg.get("metadata"),
                created_at=msg.get("createdAt") or event.at,
                sync_seq=event.seq,
            )])

        elif event.type == "message.edit":
            existing = await self.storage.get_message((event.data or {}).get("id", ""))
            if existing:
                d = event.data or {}
                existing.content = d.get("content", existing.content)
                existing.updated_at = event.at
                existing.sync_seq = event.seq
                await self.storage.put_messages([existing])

        elif event.type == "message.delete":
            msg_id = (event.data or {}).get("id")
            if msg_id:
                await self.storage.delete_message(msg_id)

        elif event.type in ("conversation.create", "conversation.update"):
            conv = event.data or {}
            await self.storage.put_conversations([StoredConversation(
                id=conv.get("id") or event.conversation_id or "",
                type=conv.get("type", "direct"),
                title=conv.get("title"),
                unread_count=conv.get("unreadCount", 0),
                members=conv.get("members"),
                metadata=conv.get("metadata"),
                sync_seq=event.seq,
                updated_at=event.at,
                last_message_at=conv.get("lastMessageAt"),
            )])

        elif event.type == "conversation.archive":
            conv_id = (event.data or {}).get("id") or event.conversation_id
            if conv_id:
                existing = await self.storage.get_conversation(conv_id)
                if existing:
                    existing.metadata = {**(existing.metadata or {}), "_archived": True}
                    existing.sync_seq = event.seq
                    existing.updated_at = event.at
                    await self.storage.put_conversations([existing])

        elif event.type == "participant.add":
            conv_id = (event.data or {}).get("conversationId") or event.conversation_id
            if conv_id:
                existing = await self.storage.get_conversation(conv_id)
                if existing and existing.members is not None:
                    d = event.data or {}
                    already = any(m.get("userId") == d.get("userId") for m in existing.members)
                    if not already:
                        existing.members.append({
                            "userId": d.get("userId", ""),
                            "username": d.get("username", ""),
                            "displayName": d.get("displayName"),
                            "role": d.get("role", "member"),
                        })
                        existing.sync_seq = event.seq
                        existing.updated_at = event.at
                        await self.storage.put_conversations([existing])

        elif event.type == "participant.remove":
            conv_id = (event.data or {}).get("conversationId") or event.conversation_id
            if conv_id:
                existing = await self.storage.get_conversation(conv_id)
                if existing and existing.members is not None:
                    user_id = (event.data or {}).get("userId")
                    existing.members = [m for m in existing.members if m.get("userId") != user_id]
                    existing.sync_seq = event.seq
                    existing.updated_at = event.at
                    await self.storage.put_conversations([existing])

    # ── Handle realtime events ────────────────────────────────

    async def handle_realtime_event(self, event_type: str, payload: Any) -> None:
        """Handle a real-time event (from WS/SSE) and store locally."""
        if event_type == "message.new" and payload:
            from datetime import datetime, timezone
            await self.storage.put_messages([StoredMessage(
                id=payload.get("id", ""),
                conversation_id=payload.get("conversationId", ""),
                content=payload.get("content", ""),
                type=payload.get("type", "text"),
                sender_id=payload.get("senderId", ""),
                parent_id=payload.get("parentId"),
                status="confirmed",
                metadata=payload.get("metadata"),
                created_at=payload.get("createdAt") or datetime.now(timezone.utc).isoformat(),
            )])

    # ── Search ────────────────────────────────────────────────

    async def search_messages(
        self, query: str, *, conversation_id: Optional[str] = None, limit: int = 50,
    ) -> List[StoredMessage]:
        """Search messages in local storage."""
        return await self.storage.search_messages(query, conversation_id=conversation_id, limit=limit)

    # ── Read cache ────────────────────────────────────────────

    async def _read_from_cache(self, path: str, query: Optional[Dict[str, str]] = None) -> Any:
        if re.search(r"/api/im/conversations$", path):
            convos = await self.storage.get_conversations(limit=50)
            if convos:
                return {"ok": True, "data": [_conv_to_dict(c) for c in convos]}

        msg_match = re.search(r"/api/im/messages/([^/]+)$", path)
        if msg_match:
            conv_id = msg_match.group(1)
            limit = int((query or {}).get("limit", "50"))
            messages = await self.storage.get_messages(conv_id, limit=limit, before=(query or {}).get("before"))
            if messages:
                return {"ok": True, "data": [_msg_to_dict(m) for m in messages]}

        if re.search(r"/api/im/contacts$", path):
            contacts = await self.storage.get_contacts()
            if contacts:
                return {"ok": True, "data": contacts}

        return None

    async def _cache_read_result(self, path: str, query: Optional[Dict[str, str]], result: Any) -> None:
        if not result or not result.get("ok") or not result.get("data"):
            return
        try:
            data = result["data"]
            if re.search(r"/api/im/conversations$", path) and isinstance(data, list):
                convos = [_dict_to_conv(c) for c in data]
                await self.storage.put_conversations(convos)

            msg_match = re.search(r"/api/im/messages/([^/]+)$", path)
            if msg_match and isinstance(data, list):
                conv_id = msg_match.group(1)
                messages = [_dict_to_msg(m, conv_id) for m in data]
                await self.storage.put_messages(messages)

            if re.search(r"/api/im/contacts$", path) and isinstance(data, list):
                await self.storage.put_contacts(data)
        except Exception:
            pass


# ============================================================================
# Helpers
# ============================================================================

def _msg_to_dict(m: StoredMessage) -> Dict[str, Any]:
    return {
        "id": m.id,
        "conversationId": m.conversation_id,
        "content": m.content,
        "type": m.type,
        "senderId": m.sender_id,
        "parentId": m.parent_id,
        "status": m.status,
        "metadata": m.metadata,
        "createdAt": m.created_at,
        "updatedAt": m.updated_at,
    }


def _conv_to_dict(c: StoredConversation) -> Dict[str, Any]:
    return {
        "id": c.id,
        "type": c.type,
        "title": c.title,
        "lastMessage": c.last_message,
        "lastMessageAt": c.last_message_at,
        "unreadCount": c.unread_count,
        "members": c.members,
        "updatedAt": c.updated_at,
    }


def _dict_to_msg(d: Dict[str, Any], fallback_conv_id: str = "") -> StoredMessage:
    return StoredMessage(
        id=d.get("id", ""),
        conversation_id=d.get("conversationId") or fallback_conv_id,
        content=d.get("content", ""),
        type=d.get("type", "text"),
        sender_id=d.get("senderId", ""),
        parent_id=d.get("parentId"),
        status="confirmed",
        metadata=d.get("metadata"),
        created_at=d.get("createdAt", ""),
    )


def _dict_to_conv(d: Dict[str, Any]) -> StoredConversation:
    from datetime import datetime, timezone
    return StoredConversation(
        id=d.get("id", ""),
        type=d.get("type", "direct"),
        title=d.get("title"),
        last_message=d.get("lastMessage"),
        last_message_at=d.get("lastMessageAt") or d.get("updatedAt"),
        unread_count=d.get("unreadCount", 0),
        members=d.get("members"),
        metadata=d.get("metadata"),
        updated_at=d.get("updatedAt") or datetime.now(timezone.utc).isoformat(),
    )
