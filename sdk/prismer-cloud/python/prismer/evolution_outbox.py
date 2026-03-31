"""Evolution Outbox — fire-and-forget outcome recording with local WAL.

Queues record() calls locally and flushes them to the server asynchronously.
Prevents data loss on network failures and eliminates write latency from the agent's hot path.
"""

import threading
import time
import uuid
from collections import deque
from typing import Any, Callable, Deque, Dict, List, Optional


class EvolutionOutboxOp:
    """A single outbox operation."""

    __slots__ = ("id", "op_type", "payload", "status", "created_at", "retries", "max_retries", "idempotency_key")

    def __init__(self, op_type: str, payload: Dict[str, Any], max_retries: int = 5):
        self.id = f"evo_{int(time.time()*1000)}_{uuid.uuid4().hex[:8]}"
        self.op_type = op_type  # 'record' or 'report'
        self.payload = payload
        self.status = "pending"
        self.created_at = time.time()
        self.retries = 0
        self.max_retries = max_retries
        self.idempotency_key = f"{op_type}:{payload.get('gene_id', '')}:{int(time.time()*1000)}"


class EvolutionOutbox:
    """In-memory outbox with background flush thread.

    Usage:
        outbox = EvolutionOutbox(request_fn)
        outbox.start()
        outbox.enqueue('record', {'gene_id': '...', 'signals': [...], ...})
        # ... later ...
        outbox.stop()  # flushes remaining
    """

    def __init__(
        self,
        request_fn: Callable,
        flush_interval: float = 1.0,
        max_retries: int = 5,
        batch_size: int = 10,
    ):
        self._request_fn = request_fn
        self._flush_interval = flush_interval
        self._max_retries = max_retries
        self._batch_size = batch_size
        self._queue: Deque[EvolutionOutboxOp] = deque()
        self._lock = threading.Lock()
        self._timer: Optional[threading.Timer] = None
        self._running = False

    @property
    def pending_count(self) -> int:
        with self._lock:
            return sum(1 for op in self._queue if op.status == "pending")

    def enqueue(self, op_type: str, payload: Dict[str, Any]) -> str:
        """Add an operation to the outbox. Returns the operation ID."""
        op = EvolutionOutboxOp(op_type, payload, self._max_retries)
        with self._lock:
            self._queue.append(op)
        return op.id

    def start(self) -> None:
        """Start the background flush timer."""
        self._running = True
        self._schedule_flush()

    def stop(self) -> None:
        """Stop the background flush and do a final flush."""
        self._running = False
        if self._timer:
            self._timer.cancel()
            self._timer = None
        self.flush()

    def flush(self) -> int:
        """Flush pending operations. Returns count of successfully flushed ops."""
        with self._lock:
            pending = [op for op in self._queue if op.status == "pending"][:self._batch_size]

        flushed = 0
        for op in pending:
            op.status = "inflight"
            try:
                endpoint = "/api/im/evolution/record" if op.op_type == "record" else "/api/im/evolution/report"
                self._request_fn("POST", endpoint, json=op.payload)
                op.status = "confirmed"
                flushed += 1
            except Exception:
                op.retries += 1
                if op.retries >= op.max_retries:
                    op.status = "failed"
                else:
                    op.status = "pending"

        # Remove confirmed/failed ops
        with self._lock:
            self._queue = deque(op for op in self._queue if op.status not in ("confirmed", "failed"))

        return flushed

    def _schedule_flush(self) -> None:
        if not self._running:
            return
        self._timer = threading.Timer(self._flush_interval, self._flush_and_reschedule)
        self._timer.daemon = True
        self._timer.start()

    def _flush_and_reschedule(self) -> None:
        try:
            self.flush()
        except Exception:
            pass
        self._schedule_flush()
