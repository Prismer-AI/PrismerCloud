"""Unit tests for offline.py — MemoryStorage + OfflineManager.

Tests MemoryStorage (all 14+ methods) and OfflineManager lifecycle.
"""

import asyncio
import time

import pytest
import pytest_asyncio

from prismer.offline import (
    MemoryStorage,
    OfflineConfig,
    OfflineManager,
    OutboxOperation,
    StoredConversation,
    StoredMessage,
)


# ===========================================================================
# MemoryStorage — Messages
# ===========================================================================

class TestMemoryStorageMessages:
    @pytest.fixture
    def storage(self):
        return MemoryStorage()

    @pytest.mark.asyncio
    async def test_put_and_get_message(self, storage):
        msg = StoredMessage(
            id="msg-1", conversation_id="conv-1",
            content="hello", type="text", sender_id="user-1",
            created_at="2026-01-01T00:00:00Z",
        )
        await storage.put_messages([msg])
        result = await storage.get_message("msg-1")
        assert result is not None
        assert result.content == "hello"
        assert result.conversation_id == "conv-1"

    @pytest.mark.asyncio
    async def test_get_message_not_found(self, storage):
        result = await storage.get_message("nonexistent")
        assert result is None

    @pytest.mark.asyncio
    async def test_put_multiple_messages(self, storage):
        msgs = [
            StoredMessage(id=f"msg-{i}", conversation_id="conv-1",
                          content=f"msg {i}", type="text", sender_id="u1",
                          created_at=f"2026-01-01T00:0{i}:00Z")
            for i in range(3)
        ]
        await storage.put_messages(msgs)
        for i in range(3):
            assert await storage.get_message(f"msg-{i}") is not None

    @pytest.mark.asyncio
    async def test_get_messages_by_conversation(self, storage):
        for i in range(5):
            conv = "conv-1" if i < 3 else "conv-2"
            await storage.put_messages([StoredMessage(
                id=f"msg-{i}", conversation_id=conv,
                content=f"msg {i}", type="text", sender_id="u1",
                created_at=f"2026-01-01T00:0{i}:00Z",
            )])
        msgs = await storage.get_messages("conv-1")
        assert len(msgs) == 3
        assert all(m.conversation_id == "conv-1" for m in msgs)

    @pytest.mark.asyncio
    async def test_get_messages_limit(self, storage):
        for i in range(10):
            await storage.put_messages([StoredMessage(
                id=f"msg-{i}", conversation_id="conv-1",
                content=f"msg {i}", type="text", sender_id="u1",
                created_at=f"2026-01-01T00:{i:02d}:00Z",
            )])
        msgs = await storage.get_messages("conv-1", limit=3)
        assert len(msgs) == 3

    @pytest.mark.asyncio
    async def test_get_messages_before(self, storage):
        for i in range(5):
            await storage.put_messages([StoredMessage(
                id=f"msg-{i}", conversation_id="conv-1",
                content=f"msg {i}", type="text", sender_id="u1",
                created_at=f"2026-01-01T00:0{i}:00Z",
            )])
        msgs = await storage.get_messages("conv-1", before="2026-01-01T00:03:00Z")
        assert len(msgs) == 3
        assert all(m.created_at < "2026-01-01T00:03:00Z" for m in msgs)

    @pytest.mark.asyncio
    async def test_delete_message(self, storage):
        msg = StoredMessage(
            id="msg-1", conversation_id="conv-1",
            content="hello", type="text", sender_id="u1",
            created_at="2026-01-01T00:00:00Z",
        )
        await storage.put_messages([msg])
        assert await storage.get_message("msg-1") is not None

        await storage.delete_message("msg-1")
        assert await storage.get_message("msg-1") is None

    @pytest.mark.asyncio
    async def test_delete_nonexistent_message_no_error(self, storage):
        await storage.delete_message("nonexistent")  # should not raise

    @pytest.mark.asyncio
    async def test_search_messages(self, storage):
        await storage.put_messages([
            StoredMessage(id="m1", conversation_id="c1", content="hello world",
                          type="text", sender_id="u1", created_at="2026-01-01T00:00:00Z"),
            StoredMessage(id="m2", conversation_id="c1", content="goodbye world",
                          type="text", sender_id="u1", created_at="2026-01-01T00:01:00Z"),
            StoredMessage(id="m3", conversation_id="c1", content="hello again",
                          type="text", sender_id="u1", created_at="2026-01-01T00:02:00Z"),
        ])
        results = await storage.search_messages("hello")
        assert len(results) == 2

    @pytest.mark.asyncio
    async def test_search_messages_by_conversation(self, storage):
        await storage.put_messages([
            StoredMessage(id="m1", conversation_id="c1", content="hello",
                          type="text", sender_id="u1", created_at="2026-01-01T00:00:00Z"),
            StoredMessage(id="m2", conversation_id="c2", content="hello",
                          type="text", sender_id="u1", created_at="2026-01-01T00:01:00Z"),
        ])
        results = await storage.search_messages("hello", conversation_id="c1")
        assert len(results) == 1
        assert results[0].conversation_id == "c1"

    @pytest.mark.asyncio
    async def test_search_messages_limit(self, storage):
        for i in range(10):
            await storage.put_messages([StoredMessage(
                id=f"m{i}", conversation_id="c1", content="match",
                type="text", sender_id="u1", created_at=f"2026-01-01T00:0{i}:00Z",
            )])
        results = await storage.search_messages("match", limit=3)
        assert len(results) == 3

    @pytest.mark.asyncio
    async def test_search_case_insensitive(self, storage):
        await storage.put_messages([StoredMessage(
            id="m1", conversation_id="c1", content="Hello World",
            type="text", sender_id="u1", created_at="2026-01-01T00:00:00Z",
        )])
        results = await storage.search_messages("hello world")
        assert len(results) == 1


# ===========================================================================
# MemoryStorage — Conversations
# ===========================================================================

class TestMemoryStorageConversations:
    @pytest.fixture
    def storage(self):
        return MemoryStorage()

    @pytest.mark.asyncio
    async def test_put_and_get_conversation(self, storage):
        conv = StoredConversation(id="c1", type="direct", title="Test")
        await storage.put_conversations([conv])
        result = await storage.get_conversation("c1")
        assert result is not None
        assert result.title == "Test"

    @pytest.mark.asyncio
    async def test_get_conversation_not_found(self, storage):
        result = await storage.get_conversation("nonexistent")
        assert result is None

    @pytest.mark.asyncio
    async def test_get_conversations_sorted_by_updated_at(self, storage):
        await storage.put_conversations([
            StoredConversation(id="c1", type="direct", updated_at="2026-01-01T00:01:00Z"),
            StoredConversation(id="c2", type="direct", updated_at="2026-01-01T00:03:00Z"),
            StoredConversation(id="c3", type="group", updated_at="2026-01-01T00:02:00Z"),
        ])
        convs = await storage.get_conversations()
        assert len(convs) == 3
        assert convs[0].id == "c2"  # most recent
        assert convs[1].id == "c3"
        assert convs[2].id == "c1"

    @pytest.mark.asyncio
    async def test_get_conversations_limit(self, storage):
        for i in range(10):
            await storage.put_conversations([StoredConversation(
                id=f"c{i}", type="direct", updated_at=f"2026-01-01T00:{i:02d}:00Z",
            )])
        convs = await storage.get_conversations(limit=3)
        assert len(convs) == 3


# ===========================================================================
# MemoryStorage — Contacts
# ===========================================================================

class TestMemoryStorageContacts:
    @pytest.fixture
    def storage(self):
        return MemoryStorage()

    @pytest.mark.asyncio
    async def test_put_and_get_contacts(self, storage):
        contacts = [{"id": "u1", "name": "Alice"}, {"id": "u2", "name": "Bob"}]
        await storage.put_contacts(contacts)
        result = await storage.get_contacts()
        assert len(result) == 2
        assert result[0]["name"] == "Alice"

    @pytest.mark.asyncio
    async def test_get_contacts_empty(self, storage):
        result = await storage.get_contacts()
        assert result == []

    @pytest.mark.asyncio
    async def test_put_contacts_replaces(self, storage):
        await storage.put_contacts([{"id": "u1"}])
        await storage.put_contacts([{"id": "u2"}, {"id": "u3"}])
        result = await storage.get_contacts()
        assert len(result) == 2


# ===========================================================================
# MemoryStorage — Cursors
# ===========================================================================

class TestMemoryStorageCursors:
    @pytest.fixture
    def storage(self):
        return MemoryStorage()

    @pytest.mark.asyncio
    async def test_set_and_get_cursor(self, storage):
        await storage.set_cursor("sync", "42")
        result = await storage.get_cursor("sync")
        assert result == "42"

    @pytest.mark.asyncio
    async def test_get_cursor_not_found(self, storage):
        result = await storage.get_cursor("nonexistent")
        assert result is None

    @pytest.mark.asyncio
    async def test_cursor_overwrite(self, storage):
        await storage.set_cursor("key", "1")
        await storage.set_cursor("key", "2")
        assert await storage.get_cursor("key") == "2"


# ===========================================================================
# MemoryStorage — Outbox
# ===========================================================================

class TestMemoryStorageOutbox:
    @pytest.fixture
    def storage(self):
        return MemoryStorage()

    def _make_op(self, id="op-1", status="pending", retries=0, created_at=0):
        return OutboxOperation(
            id=id, type="message.send", method="POST",
            path="/api/im/messages/conv-1", body={"content": "hi"},
            status=status, created_at=created_at,
            retries=retries, max_retries=5,
            idempotency_key=f"sdk-{id}",
        )

    @pytest.mark.asyncio
    async def test_enqueue_and_dequeue(self, storage):
        op = self._make_op()
        await storage.enqueue(op)
        ready = await storage.dequeue_ready()
        assert len(ready) == 1
        assert ready[0].id == "op-1"

    @pytest.mark.asyncio
    async def test_dequeue_respects_status(self, storage):
        await storage.enqueue(self._make_op(id="op-1", status="pending"))
        await storage.enqueue(self._make_op(id="op-2", status="failed"))
        ready = await storage.dequeue_ready()
        assert len(ready) == 1
        assert ready[0].id == "op-1"

    @pytest.mark.asyncio
    async def test_dequeue_respects_max_retries(self, storage):
        await storage.enqueue(self._make_op(id="op-1", retries=5))
        ready = await storage.dequeue_ready()
        assert len(ready) == 0

    @pytest.mark.asyncio
    async def test_dequeue_sorted_by_created_at(self, storage):
        await storage.enqueue(self._make_op(id="op-2", created_at=200))
        await storage.enqueue(self._make_op(id="op-1", created_at=100))
        await storage.enqueue(self._make_op(id="op-3", created_at=300))
        ready = await storage.dequeue_ready()
        assert [o.id for o in ready] == ["op-1", "op-2", "op-3"]

    @pytest.mark.asyncio
    async def test_dequeue_limit(self, storage):
        for i in range(10):
            await storage.enqueue(self._make_op(id=f"op-{i}", created_at=i))
        ready = await storage.dequeue_ready(limit=3)
        assert len(ready) == 3

    @pytest.mark.asyncio
    async def test_ack_removes_operation(self, storage):
        await storage.enqueue(self._make_op(id="op-1"))
        await storage.ack("op-1")
        ready = await storage.dequeue_ready()
        assert len(ready) == 0

    @pytest.mark.asyncio
    async def test_nack_increments_retries(self, storage):
        op = self._make_op(id="op-1")
        await storage.enqueue(op)
        await storage.nack("op-1", "network error", 1)

        ready = await storage.dequeue_ready()
        assert len(ready) == 1
        assert ready[0].retries == 1
        assert ready[0].error == "network error"

    @pytest.mark.asyncio
    async def test_nack_marks_failed_at_max_retries(self, storage):
        op = self._make_op(id="op-1")
        await storage.enqueue(op)
        await storage.nack("op-1", "fatal error", 5)  # max_retries=5

        ready = await storage.dequeue_ready()
        assert len(ready) == 0  # status is now "failed"

    @pytest.mark.asyncio
    async def test_get_pending_count(self, storage):
        await storage.enqueue(self._make_op(id="op-1", status="pending"))
        await storage.enqueue(self._make_op(id="op-2", status="pending"))
        await storage.enqueue(self._make_op(id="op-3", status="failed"))
        count = await storage.get_pending_count()
        assert count == 2


# ===========================================================================
# MemoryStorage — Storage info
# ===========================================================================

class TestMemoryStorageInfo:
    @pytest.fixture
    def storage(self):
        return MemoryStorage()

    @pytest.mark.asyncio
    async def test_get_storage_size_empty(self, storage):
        size = await storage.get_storage_size()
        assert size == {"messages": 0, "conversations": 0, "total": 0}

    @pytest.mark.asyncio
    async def test_get_storage_size_with_data(self, storage):
        await storage.put_messages([StoredMessage(
            id="m1", conversation_id="c1", content="hi",
            type="text", sender_id="u1", created_at="2026-01-01T00:00:00Z",
        )])
        await storage.put_conversations([StoredConversation(id="c1", type="direct")])
        size = await storage.get_storage_size()
        assert size == {"messages": 1, "conversations": 1, "total": 2}


# ===========================================================================
# MemoryStorage — init()
# ===========================================================================

class TestMemoryStorageInit:
    @pytest.mark.asyncio
    async def test_init_is_noop(self):
        storage = MemoryStorage()
        await storage.init()  # should not raise


# ===========================================================================
# OfflineManager — Lifecycle
# ===========================================================================

class TestOfflineManagerLifecycle:
    @pytest.mark.asyncio
    async def test_init_and_destroy(self):
        storage = MemoryStorage()

        async def noop_request(*args, **kwargs):
            return {"ok": True, "data": {}}

        manager = OfflineManager(storage, noop_request, OfflineConfig(
            outbox_flush_interval=100.0,  # very long to avoid background tasks
        ))
        await manager.init()
        assert manager.is_online is True
        assert manager.sync_state == "idle"
        await manager.destroy()

    @pytest.mark.asyncio
    async def test_default_config(self):
        storage = MemoryStorage()

        async def noop_request(*args, **kwargs):
            return {"ok": True, "data": {}}

        manager = OfflineManager(storage, noop_request)
        assert manager.is_online is True
        await manager.destroy()


# ===========================================================================
# OfflineManager — Network state
# ===========================================================================

class TestOfflineManagerNetwork:
    @pytest.mark.asyncio
    async def test_set_online_false(self):
        storage = MemoryStorage()
        events = []

        async def noop_request(*args, **kwargs):
            return {"ok": True, "data": {"events": [], "cursor": "0", "hasMore": False}}

        manager = OfflineManager(storage, noop_request, OfflineConfig(
            outbox_flush_interval=100.0,
            sync_on_connect=False,
        ))
        manager.on("network.offline", lambda _: events.append("offline"))
        manager.on("network.online", lambda _: events.append("online"))

        manager.set_online(False)
        assert manager.is_online is False
        assert "offline" in events

        await manager.destroy()

    @pytest.mark.asyncio
    async def test_set_online_true_emits_event(self):
        storage = MemoryStorage()
        events = []

        async def noop_request(*args, **kwargs):
            return {"ok": True, "data": {"events": [], "cursor": "0", "hasMore": False}}

        manager = OfflineManager(storage, noop_request, OfflineConfig(
            outbox_flush_interval=100.0,
            sync_on_connect=False,
        ))
        manager.set_online(False)
        manager.on("network.online", lambda _: events.append("online"))
        manager.set_online(True)
        assert manager.is_online is True
        assert "online" in events

        await manager.destroy()

    @pytest.mark.asyncio
    async def test_set_online_same_state_noop(self):
        storage = MemoryStorage()
        events = []

        async def noop_request(*args, **kwargs):
            return {"ok": True, "data": {}}

        manager = OfflineManager(storage, noop_request, OfflineConfig(
            outbox_flush_interval=100.0,
        ))
        manager.on("network.online", lambda _: events.append("online"))

        # Already online, setting online again should not emit
        manager.set_online(True)
        assert len(events) == 0

        await manager.destroy()


# ===========================================================================
# OfflineManager — Dispatch (write operations)
# ===========================================================================

class TestOfflineManagerDispatch:
    @pytest.mark.asyncio
    async def test_dispatch_write_returns_optimistic(self):
        storage = MemoryStorage()
        requests = []

        async def mock_request(method, path, **kwargs):
            requests.append((method, path))
            return {"ok": True, "data": {"message": {"id": "server-1", "content": "hi"}}}

        manager = OfflineManager(storage, mock_request, OfflineConfig(
            outbox_flush_interval=100.0,
        ))

        result = await manager.dispatch(
            "POST", "/api/im/messages/conv-123", {"content": "hi", "type": "text"}
        )

        assert result["ok"] is True
        assert result["_pending"] is True
        assert result["_clientId"] is not None
        assert result["data"]["message"]["content"] == "hi"
        assert result["data"]["message"]["status"] == "pending"

        # Let flush run
        await asyncio.sleep(0.05)
        await manager.destroy()

    @pytest.mark.asyncio
    async def test_dispatch_write_stores_local_message(self):
        storage = MemoryStorage()

        async def mock_request(method, path, **kwargs):
            return {"ok": True, "data": {"message": {"id": "server-1"}}}

        manager = OfflineManager(storage, mock_request, OfflineConfig(
            outbox_flush_interval=100.0,
        ))

        await manager.dispatch(
            "POST", "/api/im/messages/conv-1", {"content": "hello", "type": "text"}
        )

        msgs = await storage.get_messages("conv-1")
        assert len(msgs) == 1
        assert msgs[0].content == "hello"
        assert msgs[0].status == "pending"
        assert msgs[0].id.startswith("local-")

        await manager.destroy()

    @pytest.mark.asyncio
    async def test_dispatch_enqueues_to_outbox(self):
        storage = MemoryStorage()

        async def mock_request(method, path, **kwargs):
            return {"ok": True, "data": {"message": {"id": "s1"}}}

        manager = OfflineManager(storage, mock_request, OfflineConfig(
            outbox_flush_interval=100.0,
        ))
        # Set offline so flush doesn't run
        manager.set_online(False)

        await manager.dispatch(
            "POST", "/api/im/direct/conv-1", {"content": "test"}
        )

        count = await manager.outbox_size()
        assert count == 1

        await manager.destroy()


# ===========================================================================
# OfflineManager — Flush
# ===========================================================================

class TestOfflineManagerFlush:
    @pytest.mark.asyncio
    async def test_flush_sends_pending_ops(self):
        storage = MemoryStorage()
        sent = []

        async def mock_request(method, path, **kwargs):
            sent.append((method, path))
            return {"ok": True, "data": {"message": {"id": "srv-1", "content": "hi",
                                                       "conversationId": "c1",
                                                       "type": "text", "senderId": "u1",
                                                       "createdAt": "2026-01-01T00:00:00Z"}}}

        manager = OfflineManager(storage, mock_request, OfflineConfig(
            outbox_flush_interval=100.0,
        ))

        # Set offline first to prevent auto-flush
        manager.set_online(False)
        await manager.dispatch("POST", "/api/im/messages/c1", {"content": "hi"})
        assert await manager.outbox_size() == 1

        # Now go online and flush manually
        manager._is_online = True
        await manager.flush()

        assert len(sent) == 1
        assert await manager.outbox_size() == 0

        await manager.destroy()

    @pytest.mark.asyncio
    async def test_flush_skipped_when_offline(self):
        storage = MemoryStorage()
        sent = []

        async def mock_request(method, path, **kwargs):
            sent.append((method, path))
            return {"ok": True, "data": {}}

        manager = OfflineManager(storage, mock_request, OfflineConfig(
            outbox_flush_interval=100.0,
        ))
        manager.set_online(False)

        # Manually enqueue
        op = OutboxOperation(
            id="test-op", type="message.send", method="POST",
            path="/api/im/messages/c1", body={"content": "hi"},
            status="pending", created_at=time.time(),
            max_retries=5, idempotency_key="sdk-test",
        )
        await storage.enqueue(op)

        await manager.flush()
        assert len(sent) == 0  # nothing sent because offline

        await manager.destroy()

    @pytest.mark.asyncio
    async def test_flush_emits_events(self):
        storage = MemoryStorage()
        events = []

        async def mock_request(method, path, **kwargs):
            return {"ok": True, "data": {"message": {"id": "srv-1", "content": "hi",
                                                       "conversationId": "c1",
                                                       "type": "text", "senderId": "u1"}}}

        manager = OfflineManager(storage, mock_request, OfflineConfig(
            outbox_flush_interval=100.0,
        ))
        manager.on("outbox.sending", lambda p: events.append(("sending", p)))
        manager.on("outbox.confirmed", lambda p: events.append(("confirmed", p)))

        manager.set_online(False)
        await manager.dispatch("POST", "/api/im/messages/c1", {"content": "hi"})

        manager._is_online = True
        await manager.flush()

        event_types = [e[0] for e in events]
        assert "sending" in event_types
        assert "confirmed" in event_types

        await manager.destroy()

    @pytest.mark.asyncio
    async def test_flush_handles_network_error(self):
        storage = MemoryStorage()
        call_count = 0

        async def failing_request(method, path, **kwargs):
            nonlocal call_count
            call_count += 1
            raise ConnectionError("network down")

        manager = OfflineManager(storage, failing_request, OfflineConfig(
            outbox_flush_interval=100.0,
        ))

        manager.set_online(False)
        op = OutboxOperation(
            id="test-op", type="message.send", method="POST",
            path="/api/im/messages/c1", body={"content": "hi"},
            status="pending", created_at=time.time(),
            max_retries=5, idempotency_key="sdk-test",
        )
        await storage.enqueue(op)

        manager._is_online = True
        await manager.flush()

        # Operation should still exist with incremented retries
        ready = await storage.dequeue_ready()
        assert len(ready) == 1
        assert ready[0].retries == 1

        await manager.destroy()


# ===========================================================================
# OfflineManager — Event emitter
# ===========================================================================

class TestOfflineManagerEvents:
    @pytest.mark.asyncio
    async def test_on_and_emit(self):
        storage = MemoryStorage()

        async def noop(*args, **kwargs):
            return {"ok": True, "data": {}}

        manager = OfflineManager(storage, noop, OfflineConfig(outbox_flush_interval=100.0))
        received = []
        manager.on("test.event", lambda p: received.append(p))
        manager.emit("test.event", {"key": "value"})
        assert len(received) == 1
        assert received[0]["key"] == "value"

        await manager.destroy()

    @pytest.mark.asyncio
    async def test_off_removes_listener(self):
        storage = MemoryStorage()

        async def noop(*args, **kwargs):
            return {"ok": True, "data": {}}

        manager = OfflineManager(storage, noop, OfflineConfig(outbox_flush_interval=100.0))
        received = []
        cb = lambda p: received.append(p)
        manager.on("test.event", cb)
        manager.off("test.event", cb)
        manager.emit("test.event", "data")
        assert len(received) == 0

        await manager.destroy()

    @pytest.mark.asyncio
    async def test_remove_all_listeners(self):
        storage = MemoryStorage()

        async def noop(*args, **kwargs):
            return {"ok": True, "data": {}}

        manager = OfflineManager(storage, noop, OfflineConfig(outbox_flush_interval=100.0))
        manager.on("a", lambda p: None)
        manager.on("b", lambda p: None)
        manager.remove_all_listeners()
        # No error emitting after removal
        manager.emit("a", "data")
        manager.emit("b", "data")

        await manager.destroy()
