"""
agent_runner.py — Thin bridge between the PARA ``AdapterDispatchInput``
shape and ``hermes_agent.run_agent.AIAgent``.

Design notes:
    * We import ``AIAgent`` at call time, not at module import, so the
      core ``prismer_adapter_hermes`` package stays importable even when
      ``hermes-agent`` is not installed.
    * Session id derivation: ``f"dispatch-{task_id}"``. Stable, collision-
      safe, and lets the PARA event stream group all events emitted for
      a single dispatched task.
    * ``run_conversation`` is a synchronous blocking call (it internally
      does an ``httpx`` request loop). We run it in a default executor
      via ``loop.run_in_executor`` so the aiohttp reactor stays free to
      accept health probes and parallel dispatches.
    * The return envelope matches the TS side's expectation
      ``{ok, output, artifacts, metadata, error}`` exactly — missing
      fields on the Hermes return get defaulted rather than forwarded
      as ``None``.

This module DOES NOT modify Hermes upstream. All plugin wiring is done
once at ``__main__.py`` startup against Hermes's module-level singleton
``PluginManager`` via ``register_plugin_with_hermes()``.
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


DEFAULT_MAX_ITERATIONS = int(os.environ.get("HERMES_MAX_ITERATIONS", "90"))


def _session_id_for(task_id: str) -> str:
    """Derive a PARA session id from the dispatched task id.

    Daemons only supply the task id; we embed it in the session id so PARA
    events emitted by the LLM plugin hooks can be correlated back to the
    originating dispatch. Keep deterministic so retries on the same task
    id produce the same session id.
    """
    return f"dispatch-{task_id}"


def _normalize_envelope(
    hermes_result: Dict[str, Any],
    usage: Dict[str, Any],
    model: Optional[str],
) -> Dict[str, Any]:
    """Map Hermes's ``run_conversation`` result dict → dispatch envelope.

    Hermes's result has these keys (see ``run_agent.py``):
        final_response : str | None
        messages       : list[dict]
        api_calls      : int
        completed      : bool
        failed         : bool
        error          : str | None

    We collapse that to the PARA dispatch envelope. A hard failure
    (``failed=True``) OR a missing ``final_response`` both surface as
    ``ok=False``. Usage stats and the model string land in ``metadata``
    so the daemon can route telemetry without reparsing.
    """
    if not isinstance(hermes_result, dict):
        return {
            "ok": False,
            "error": f"hermes_agent_error:unexpected_result_type:{type(hermes_result).__name__}",
        }

    failed = bool(hermes_result.get("failed"))
    final = hermes_result.get("final_response")
    error_msg = hermes_result.get("error") or ""

    metadata: Dict[str, Any] = {
        "api_calls": int(hermes_result.get("api_calls") or 0),
        "completed": bool(hermes_result.get("completed")),
    }
    if model:
        metadata["model"] = model
    # Token counters (best-effort; absent when the agent short-circuits).
    for k in ("input_tokens", "output_tokens", "total_tokens"):
        if k in usage and usage[k] is not None:
            metadata[k] = int(usage[k] or 0)

    if failed or not final:
        # Keep `ok:False` + `error` per dispatch contract; do NOT include
        # output on failure. If final carries a partial response we still
        # expose it in metadata so callers can debug.
        if final:
            metadata["partial_output"] = final
        msg = error_msg or "hermes returned no final_response"
        return {
            "ok": False,
            "error": f"hermes_agent_error:{msg}",
            "metadata": metadata,
        }

    return {
        "ok": True,
        "output": str(final),
        "artifacts": [],
        "metadata": metadata,
    }


def _build_agent(
    *,
    session_id: str,
    config: Dict[str, Any],
):
    """Create a fresh AIAgent wired with the runtime config.

    One agent per dispatch keeps sessions isolated (no cross-task state
    leakage). We pass ``persist_session=False`` when no session_db is
    configured so stray sqlite files don't accumulate under $HOME.
    """
    from run_agent import AIAgent  # type: ignore[import]

    kwargs: Dict[str, Any] = {
        "model": config.get("model") or "",
        "max_iterations": int(config.get("max_iterations") or DEFAULT_MAX_ITERATIONS),
        "quiet_mode": True,
        "verbose_logging": False,
        "session_id": session_id,
        "platform": config.get("platform") or "dispatch",
        "persist_session": False,
    }
    if config.get("api_key"):
        kwargs["api_key"] = config["api_key"]
    if config.get("base_url"):
        kwargs["base_url"] = config["base_url"]
    if config.get("enabled_toolsets"):
        kwargs["enabled_toolsets"] = list(config["enabled_toolsets"])

    return AIAgent(**kwargs)


def _run_blocking(
    *,
    session_id: str,
    prompt: str,
    config: Dict[str, Any],
    task_id: str,
) -> Dict[str, Any]:
    """Synchronous wrapper used inside the executor.

    Splitting this off from ``run_one`` makes it trivial to unit-test
    the blocking path without having to spin up an event loop.
    """
    agent = _build_agent(session_id=session_id, config=config)
    result = agent.run_conversation(
        user_message=prompt,
        conversation_history=[],
        task_id=task_id,
    )
    usage: Dict[str, Any] = {}
    for attr, key in (
        ("session_prompt_tokens", "input_tokens"),
        ("session_completion_tokens", "output_tokens"),
        ("session_total_tokens", "total_tokens"),
    ):
        if hasattr(agent, attr):
            usage[key] = getattr(agent, attr) or 0
    return {"result": result, "usage": usage}


async def run_one(
    *,
    task_id: str,
    capability: Optional[str],
    prompt: str,
    step_idx: Optional[int] = None,
    deadline_at: Optional[int] = None,
    config: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Execute a single dispatched task against a fresh Hermes ``AIAgent``.

    Args:
        task_id:     PARA task identifier. Session id will be
                     ``dispatch-{task_id}``.
        capability:  Requested capability string (currently informational).
        prompt:      User-facing prompt submitted to the model.
        step_idx:    Optional routing step index (passed through to metadata).
        deadline_at: Optional ms-since-epoch deadline (not enforced here —
                     caller is responsible for timing out the HTTP handler;
                     included so future versions can hard-cap iterations).
        config:      Runtime config: ``api_key`` / ``base_url`` / ``model``
                     / ``max_iterations`` / ``enabled_toolsets`` /
                     ``platform``. All optional; falls back to AIAgent
                     defaults when absent.

    Returns:
        Dispatch envelope: ``{ok: True, output, artifacts, metadata}`` on
        success, ``{ok: False, error, metadata?}`` on failure. Never raises.
    """
    session_id = _session_id_for(task_id)
    cfg = dict(config or {})
    model = cfg.get("model") or os.environ.get("AGENT_DEFAULT_MODEL") or ""
    cfg.setdefault("model", model)
    cfg.setdefault("api_key", os.environ.get("OPENAI_API_KEY"))
    cfg.setdefault(
        "base_url",
        os.environ.get("OPENAI_API_BASE_URL") or os.environ.get("OPENAI_BASE_URL"),
    )

    loop = asyncio.get_running_loop()
    try:
        blocking_result = await loop.run_in_executor(
            None,
            lambda: _run_blocking(
                session_id=session_id,
                prompt=prompt,
                config=cfg,
                task_id=task_id,
            ),
        )
    except Exception as exc:  # pragma: no cover - re-raised as ok:False
        logger.exception("[hermes-adapter] run_one failed for task %s", task_id)
        return {
            "ok": False,
            "error": f"hermes_agent_error:{exc.__class__.__name__}:{exc}",
            "metadata": {
                "model": model,
                "capability": capability,
                "stepIdx": step_idx,
            },
        }

    envelope = _normalize_envelope(
        blocking_result["result"], blocking_result["usage"], model=model
    )
    # Fold in dispatch-level metadata so the daemon can correlate.
    metadata = envelope.setdefault("metadata", {})
    if capability is not None:
        metadata.setdefault("capability", capability)
    if step_idx is not None:
        metadata.setdefault("stepIdx", step_idx)
    if deadline_at is not None:
        metadata.setdefault("deadlineAt", deadline_at)
    metadata.setdefault("sessionId", session_id)
    return envelope


def warn_if_missing_llm_env() -> None:
    """Stderr warning when the agent is likely to fail at first API call.

    Kept non-fatal so the server still starts — operators may want to
    bring up the HTTP surface for health checks before filling in creds.
    """
    if not (os.environ.get("OPENAI_API_KEY") or os.environ.get("HERMES_API_KEY")):
        print(
            "[hermes-adapter] warning: no OPENAI_API_KEY / HERMES_API_KEY set — "
            "dispatches will fail until credentials are provided",
            file=sys.stderr,
        )
    if not (os.environ.get("AGENT_DEFAULT_MODEL") or os.environ.get("HERMES_MODEL")):
        print(
            "[hermes-adapter] warning: no AGENT_DEFAULT_MODEL set — AIAgent "
            "will use its built-in default (may not match your provider)",
            file=sys.stderr,
        )
