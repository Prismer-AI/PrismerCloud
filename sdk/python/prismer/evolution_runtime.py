"""EvolutionRuntime — High-level evolution API for Python agents.

Composes EvolutionCache + SignalEnrichment + async outbox into two simple methods:
  - suggest(error, context?) → strategy recommendation (<1ms local, fallback to server)
  - learned(error, outcome, summary, gene_id?) → fire-and-forget outcome recording

Port of sdk/typescript/src/evolution-runtime.ts.

Usage:
    from prismer import PrismerClient
    from prismer.evolution_runtime import EvolutionRuntime

    client = PrismerClient(api_key="sk-...")
    runtime = EvolutionRuntime(client.im.evolution)
    await runtime.start()

    fix = await runtime.suggest("ETIMEDOUT: connection timed out")
    # ... agent applies fix.strategy ...
    runtime.learned("ETIMEDOUT", "success", "Fixed by increasing timeout")
"""

from __future__ import annotations

import asyncio
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Protocol

from .evolution_cache import EvolutionCache, GeneSelectionResult, SignalTag
from .signal_rules import extract_signals


# ─── Protocols ──────────────────────────────────────────

class EvolutionClientLike(Protocol):
    """Minimal interface — works with both sync and async EvolutionClient."""

    def get_sync_snapshot(self, since: int = 0) -> Any: ...
    def analyze(self, **kwargs: Any) -> Any: ...
    def record(self, gene_id: str, signals: list, outcome: str, summary: str, **kwargs: Any) -> Any: ...
    def sync(self, push: Any = None, pull: Any = None) -> Any: ...


class AsyncEvolutionClientLike(Protocol):
    async def get_sync_snapshot(self, since: int = 0) -> Any: ...
    async def analyze(self, **kwargs: Any) -> Any: ...
    async def record(self, gene_id: str, signals: list, outcome: str, summary: str, **kwargs: Any) -> Any: ...
    async def sync(self, push: Any = None, pull: Any = None) -> Any: ...


# ─── Types ──────────────────────────────────────────────

@dataclass
class EvolutionRuntimeConfig:
    sync_interval_s: float = 60.0
    scope: str = "global"
    outbox_max_size: int = 50
    outbox_flush_s: float = 5.0


@dataclass
class Suggestion:
    action: str  # 'apply_gene' | 'create_suggested' | 'none'
    gene_id: Optional[str] = None
    gene: Optional[Dict[str, Any]] = None
    strategy: Optional[List[str]] = None
    confidence: float = 0.0
    signals: List[Dict[str, str]] = field(default_factory=list)
    from_cache: bool = False
    reason: Optional[str] = None
    alternatives: Optional[List[Dict[str, Any]]] = None


@dataclass
class EvolutionSession:
    """Tracks a single suggest→learned cycle."""
    id: str
    suggested_at: float
    suggested_gene_id: Optional[str] = None
    used_gene_id: Optional[str] = None
    signals: List[Dict[str, str]] = field(default_factory=list)
    adopted: bool = False
    completed_at: Optional[float] = None
    outcome: Optional[str] = None
    duration_ms: Optional[float] = None
    confidence: float = 0.0
    from_cache: bool = False


@dataclass
class SessionMetrics:
    """Aggregate session metrics for benchmarking."""
    total_suggestions: int = 0
    suggestions_with_gene: int = 0
    total_learned: int = 0
    adopted_count: int = 0
    gene_utilization_rate: float = 0.0
    avg_duration_ms: float = 0.0
    adopted_success_rate: float = 0.0
    non_adopted_success_rate: float = 0.0
    cache_hit_rate: float = 0.0


@dataclass
class _OutboxEntry:
    gene_id: str
    signals: List[Dict[str, str]]
    outcome: str
    summary: str
    score: Optional[float] = None
    metadata: Optional[Dict[str, Any]] = None
    timestamp: float = 0.0


# ─── Async Runtime ──────────────────────────────────────

class AsyncEvolutionRuntime:
    """Async evolution runtime for asyncio-based agents."""

    def __init__(
        self,
        client: AsyncEvolutionClientLike,
        config: Optional[EvolutionRuntimeConfig] = None,
    ) -> None:
        self._client = client
        self._config = config or EvolutionRuntimeConfig()
        self._cache = EvolutionCache()
        self._outbox: List[_OutboxEntry] = []
        self._last_suggested_gene_id: Optional[str] = None
        self._started = False
        self._sync_task: Optional[asyncio.Task[None]] = None
        self._flush_task: Optional[asyncio.Task[None]] = None
        self._sessions: List[EvolutionSession] = []
        self._active_session: Optional[EvolutionSession] = None
        self._session_counter = 0

    async def start(self) -> None:
        """Bootstrap: load snapshot + start sync + start flush."""
        if self._started:
            return
        self._started = True

        try:
            result = self._client.get_sync_snapshot(0)
            if asyncio.iscoroutine(result):
                result = await result
            data = getattr(result, "data", None) or (result if isinstance(result, dict) else None)
            if isinstance(data, dict) and "data" in data:
                data = data["data"]
            if data:
                self._cache.load_snapshot(data)
        except Exception:
            pass

        if self._config.sync_interval_s > 0:
            self._sync_task = asyncio.create_task(self._sync_loop())
        self._flush_task = asyncio.create_task(self._flush_loop())

    async def stop(self) -> None:
        """Stop timers + flush remaining outbox."""
        self._started = False
        if self._sync_task:
            self._sync_task.cancel()
        if self._flush_task:
            self._flush_task.cancel()
        await self._flush()

    async def suggest(
        self,
        error: str,
        *,
        provider: Optional[str] = None,
        stage: Optional[str] = None,
        severity: Optional[str] = None,
        tags: Optional[List[str]] = None,
    ) -> Suggestion:
        """Get a strategy recommendation. Cache first (<1ms), server fallback."""
        signals = extract_signals(
            error=error, provider=provider, stage=stage, severity=severity, tags=tags,
        )
        if not signals:
            return Suggestion(action="none", reason="no signals extracted from error")

        signal_tags = [SignalTag(type=s["type"]) for s in signals]

        # Try local cache
        if self._cache.gene_count > 0:
            local = self._cache.select_gene(signal_tags)
            if local.action == "apply_gene" and local.confidence > 0.3:
                self._last_suggested_gene_id = local.gene_id
                self._start_session(local.gene_id, signals, local.confidence, True)
                return Suggestion(
                    action=local.action,
                    gene_id=local.gene_id,
                    gene=local.gene,
                    strategy=local.strategy,
                    confidence=local.confidence,
                    signals=signals,
                    from_cache=True,
                    reason=local.reason,
                    alternatives=local.alternatives,
                )

        # Fallback to server
        try:
            result = self._client.analyze(signals=signals, scope=self._config.scope)
            if asyncio.iscoroutine(result):
                result = await result
            data = getattr(result, "data", None)
            if isinstance(result, dict):
                data = result.get("data", result)
            if data:
                self._last_suggested_gene_id = data.get("gene_id")
                self._start_session(data.get("gene_id"), signals, data.get("confidence", 0), False)
                return Suggestion(
                    action=data.get("action", "none"),
                    gene_id=data.get("gene_id"),
                    gene=data.get("gene"),
                    strategy=data.get("strategy"),
                    confidence=data.get("confidence", 0),
                    signals=signals,
                    from_cache=False,
                    reason=data.get("reason"),
                    alternatives=data.get("alternatives"),
                )
        except Exception:
            # Server unreachable — use cache even if low confidence
            local = self._cache.select_gene(signal_tags)
            self._last_suggested_gene_id = local.gene_id
            self._start_session(local.gene_id, signals, local.confidence, True)
            return Suggestion(
                action=local.action,
                gene_id=local.gene_id,
                gene=local.gene,
                strategy=local.strategy,
                confidence=local.confidence,
                signals=signals,
                from_cache=True,
                reason="server unreachable, using cache fallback",
            )

        return Suggestion(action="none", signals=signals, reason="no recommendation")

    def _start_session(self, gene_id: Optional[str], signals: List[Dict[str, str]], confidence: float, from_cache: bool) -> None:
        self._session_counter += 1
        self._active_session = EvolutionSession(
            id=f"ses_{self._session_counter}_{int(time.time()*1000)}",
            suggested_at=time.time(),
            suggested_gene_id=gene_id,
            signals=signals,
            confidence=confidence,
            from_cache=from_cache,
        )

    def _complete_session(self, gene_id: str, outcome: str) -> None:
        if self._active_session:
            s = self._active_session
            s.used_gene_id = gene_id
            s.adopted = gene_id == s.suggested_gene_id
            s.completed_at = time.time()
            s.outcome = outcome
            s.duration_ms = (s.completed_at - s.suggested_at) * 1000
            self._sessions.append(s)
            self._active_session = None

    @property
    def sessions(self) -> List[EvolutionSession]:
        return list(self._sessions)

    def get_metrics(self) -> SessionMetrics:
        ss = self._sessions
        total = len(ss)
        with_gene = sum(1 for s in ss if s.suggested_gene_id)
        learned = sum(1 for s in ss if s.completed_at)
        adopted = [s for s in ss if s.adopted and s.completed_at]
        non_adopted = [s for s in ss if not s.adopted and s.completed_at]
        durations = [s.duration_ms for s in ss if s.duration_ms is not None]
        cache_hits = sum(1 for s in ss if s.from_cache)

        return SessionMetrics(
            total_suggestions=total,
            suggestions_with_gene=with_gene,
            total_learned=learned,
            adopted_count=len(adopted),
            gene_utilization_rate=round(len(adopted) / with_gene, 2) if with_gene else 0,
            avg_duration_ms=round(sum(durations) / len(durations)) if durations else 0,
            adopted_success_rate=round(sum(1 for s in adopted if s.outcome == "success") / len(adopted), 2) if adopted else 0,
            non_adopted_success_rate=round(sum(1 for s in non_adopted if s.outcome == "success") / len(non_adopted), 2) if non_adopted else 0,
            cache_hit_rate=round(cache_hits / total, 2) if total else 0,
        )

    def reset_metrics(self) -> None:
        """Clear all sessions and reset counter."""
        self._sessions.clear()
        self._active_session = None
        self._session_counter = 0

    def learned(
        self,
        error: str,
        outcome: str,
        summary: str,
        gene_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Record outcome. Fire-and-forget — never blocks, never throws."""
        signals = extract_signals(error=error)
        resolved = gene_id or self._last_suggested_gene_id
        if not resolved:
            return

        self._complete_session(resolved, outcome)

        self._outbox.append(_OutboxEntry(
            gene_id=resolved,
            signals=signals,
            outcome=outcome,
            summary=summary,
            metadata=metadata,
            timestamp=time.time(),
        ))

        if len(self._outbox) >= self._config.outbox_max_size:
            asyncio.ensure_future(self._flush())

    # ─── Internal ───────────────────────────────────────

    async def _sync_loop(self) -> None:
        while self._started:
            await asyncio.sleep(self._config.sync_interval_s)
            try:
                result = self._client.sync(pull={"since": self._cache.cursor})
                if asyncio.iscoroutine(result):
                    result = await result
                data = getattr(result, "data", None) or (result if isinstance(result, dict) else None)
                if isinstance(data, dict) and "pulled" in data:
                    self._cache.apply_delta({"pulled": data["pulled"]})
            except Exception:
                pass

    async def _flush_loop(self) -> None:
        while self._started:
            await asyncio.sleep(self._config.outbox_flush_s)
            await self._flush()

    async def _flush(self) -> None:
        if not self._outbox:
            return
        batch = self._outbox[: self._config.outbox_max_size]
        self._outbox = self._outbox[self._config.outbox_max_size :]

        for entry in batch:
            try:
                result = self._client.record(
                    gene_id=entry.gene_id,
                    signals=[s["type"] for s in entry.signals],
                    outcome=entry.outcome,
                    summary=entry.summary,
                    scope=self._config.scope,
                )
                if asyncio.iscoroutine(result):
                    await result
            except Exception:
                self._outbox.append(entry)


# ─── Sync Runtime (thread-based) ────────────────────────

class EvolutionRuntime:
    """Sync evolution runtime for thread-based agents.

    Wraps AsyncEvolutionRuntime via threading for agents that don't use asyncio.
    """

    def __init__(
        self,
        client: EvolutionClientLike,
        config: Optional[EvolutionRuntimeConfig] = None,
    ) -> None:
        self._client = client
        self._config = config or EvolutionRuntimeConfig()
        self._cache = EvolutionCache()
        self._outbox: List[_OutboxEntry] = []
        self._last_suggested_gene_id: Optional[str] = None
        self._started = False
        self._lock = threading.Lock()
        self._flush_timer: Optional[threading.Timer] = None
        self._sessions: List[EvolutionSession] = []
        self._active_session: Optional[EvolutionSession] = None
        self._session_counter = 0

    def start(self) -> None:
        """Bootstrap: load snapshot synchronously."""
        if self._started:
            return
        self._started = True

        try:
            result = self._client.get_sync_snapshot(0)
            data = getattr(result, "data", None) or (result if isinstance(result, dict) else None)
            if isinstance(data, dict) and "data" in data:
                data = data["data"]
            if data:
                self._cache.load_snapshot(data)
        except Exception:
            pass

        self._schedule_flush()

    def stop(self) -> None:
        self._started = False
        if self._flush_timer:
            self._flush_timer.cancel()
        self._flush()

    def suggest(
        self,
        error: str,
        *,
        provider: Optional[str] = None,
        stage: Optional[str] = None,
        severity: Optional[str] = None,
        tags: Optional[List[str]] = None,
    ) -> Suggestion:
        """Get a strategy recommendation. Cache first, server fallback."""
        signals = extract_signals(error=error, provider=provider, stage=stage, severity=severity, tags=tags)
        if not signals:
            return Suggestion(action="none", reason="no signals extracted")

        signal_tags = [SignalTag(type=s["type"]) for s in signals]

        if self._cache.gene_count > 0:
            local = self._cache.select_gene(signal_tags)
            if local.action == "apply_gene" and local.confidence > 0.3:
                self._last_suggested_gene_id = local.gene_id
                self._start_session(local.gene_id, signals, local.confidence, True)
                return Suggestion(
                    action=local.action, gene_id=local.gene_id, gene=local.gene,
                    strategy=local.strategy, confidence=local.confidence,
                    signals=signals, from_cache=True, reason=local.reason,
                )

        try:
            result = self._client.analyze(signals=signals, scope=self._config.scope)
            data = getattr(result, "data", None) or result
            if isinstance(data, dict):
                self._last_suggested_gene_id = data.get("gene_id")
                self._start_session(data.get("gene_id"), signals, data.get("confidence", 0), False)
                return Suggestion(
                    action=data.get("action", "none"), gene_id=data.get("gene_id"),
                    gene=data.get("gene"), strategy=data.get("strategy"),
                    confidence=data.get("confidence", 0), signals=signals,
                    from_cache=False, reason=data.get("reason"),
                )
        except Exception:
            # Server unreachable — use cache even if low confidence
            local = self._cache.select_gene(signal_tags)
            self._last_suggested_gene_id = local.gene_id
            self._start_session(local.gene_id, signals, local.confidence, True)
            return Suggestion(
                action=local.action, gene_id=local.gene_id, gene=local.gene,
                strategy=local.strategy, confidence=local.confidence,
                signals=signals, from_cache=True, reason="server unreachable, using cache fallback",
            )

        return Suggestion(action="none", signals=signals, reason="no recommendation")

    def learned(
        self,
        error: str,
        outcome: str,
        summary: str,
        gene_id: Optional[str] = None,
    ) -> None:
        """Record outcome. Fire-and-forget."""
        signals = extract_signals(error=error)
        resolved = gene_id or self._last_suggested_gene_id
        if not resolved:
            return

        self._complete_session(resolved, outcome)

        with self._lock:
            self._outbox.append(_OutboxEntry(
                gene_id=resolved, signals=signals, outcome=outcome,
                summary=summary, timestamp=time.time(),
            ))

        if len(self._outbox) >= self._config.outbox_max_size:
            self._flush()

    # ─── Session tracking ─────────────────────────────────

    def _start_session(self, gene_id: Optional[str], signals: List[Dict[str, str]], confidence: float, from_cache: bool) -> None:
        if self._active_session:
            self._sessions.append(self._active_session)
        self._session_counter += 1
        self._active_session = EvolutionSession(
            id=f"ses_{self._session_counter}_{int(time.time()*1000)}",
            suggested_at=time.time(),
            suggested_gene_id=gene_id,
            signals=signals,
            confidence=confidence,
            from_cache=from_cache,
        )

    def _complete_session(self, gene_id: str, outcome: str) -> None:
        if self._active_session:
            s = self._active_session
            s.used_gene_id = gene_id
            s.adopted = gene_id == s.suggested_gene_id
            s.completed_at = time.time()
            s.outcome = outcome
            s.duration_ms = (s.completed_at - s.suggested_at) * 1000
            self._sessions.append(s)
            self._active_session = None

    @property
    def sessions(self) -> List[EvolutionSession]:
        return list(self._sessions)

    def get_metrics(self) -> SessionMetrics:
        ss = self._sessions
        total = len(ss)
        with_gene = sum(1 for s in ss if s.suggested_gene_id)
        learned_count = sum(1 for s in ss if s.completed_at)
        adopted = [s for s in ss if s.adopted and s.completed_at]
        non_adopted = [s for s in ss if not s.adopted and s.completed_at]
        durations = [s.duration_ms for s in ss if s.duration_ms is not None]
        cache_hits = sum(1 for s in ss if s.from_cache)

        return SessionMetrics(
            total_suggestions=total,
            suggestions_with_gene=with_gene,
            total_learned=learned_count,
            adopted_count=len(adopted),
            gene_utilization_rate=round(len(adopted) / with_gene, 2) if with_gene else 0,
            avg_duration_ms=round(sum(durations) / len(durations)) if durations else 0,
            adopted_success_rate=round(sum(1 for s in adopted if s.outcome == "success") / len(adopted), 2) if adopted else 0,
            non_adopted_success_rate=round(sum(1 for s in non_adopted if s.outcome == "success") / len(non_adopted), 2) if non_adopted else 0,
            cache_hit_rate=round(cache_hits / total, 2) if total else 0,
        )

    def reset_metrics(self) -> None:
        """Clear all sessions and reset counter."""
        self._sessions.clear()
        self._active_session = None
        self._session_counter = 0

    def _flush(self) -> None:
        with self._lock:
            batch = self._outbox[:]
            self._outbox.clear()

        for entry in batch:
            try:
                self._client.record(
                    gene_id=entry.gene_id,
                    signals=[s["type"] for s in entry.signals],
                    outcome=entry.outcome,
                    summary=entry.summary,
                    scope=self._config.scope,
                )
            except Exception:
                with self._lock:
                    self._outbox.append(entry)

    def _schedule_flush(self) -> None:
        if not self._started:
            return
        self._flush_timer = threading.Timer(self._config.outbox_flush_s, self._do_flush_and_reschedule)
        self._flush_timer.daemon = True
        self._flush_timer.start()

    def _do_flush_and_reschedule(self) -> None:
        self._flush()
        self._schedule_flush()
