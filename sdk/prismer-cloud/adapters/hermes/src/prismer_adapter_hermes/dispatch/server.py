"""
server.py — aiohttp ``web.Application`` exposing the Mode B dispatch API.

Routes
------
    POST /dispatch  – Run a PARA task against Hermes AIAgent.
    GET  /health    – Liveness probe for the daemon.

Request / response shapes are documented in the package ``README.md``;
the Node-side adapter treats this surface as a fixed contract, so any
change here is breaking.

This module imports aiohttp lazily at construction time so the core
package never drags it in.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Callable, Dict, Optional

logger = logging.getLogger(__name__)


# Matches the version in src/prismer_adapter_hermes/__init__.py::__version__.
# Kept as a constant rather than a runtime import so ``/health`` stays cheap.
_ADAPTER_VERSION = "0.2.0"

_ERROR_PREFIX = "hermes_agent_error:"


async def _handle_health(request):  # pragma: no cover - trivial
    """GET /health — liveness probe."""
    from aiohttp import web

    return web.json_response(
        {"status": "ok", "adapter": "hermes", "version": _ADAPTER_VERSION}
    )


def _make_dispatch_handler(
    runner: Callable[..., Any],
    config_provider: Optional[Callable[[], Dict[str, Any]]] = None,
):
    """Build the /dispatch handler closed over a runner + optional config.

    The runner indirection lets tests inject a fake (synchronous or async)
    function without needing a live Hermes install. The default runner is
    ``agent_runner.run_one``, wired in ``build_app`` below.
    """
    from aiohttp import web

    async def _handle_dispatch(request):
        # -- Parse body --------------------------------------------------
        try:
            raw = await request.read()
            body = json.loads(raw.decode("utf-8")) if raw else {}
        except (ValueError, UnicodeDecodeError) as exc:
            return web.json_response(
                {
                    "ok": False,
                    "error": f"{_ERROR_PREFIX}invalid_json:{exc}",
                },
                status=400,
            )
        if not isinstance(body, dict):
            return web.json_response(
                {"ok": False, "error": f"{_ERROR_PREFIX}body_not_object"},
                status=400,
            )

        task_id = body.get("taskId")
        prompt = body.get("prompt")
        if not isinstance(task_id, str) or not task_id:
            return web.json_response(
                {"ok": False, "error": f"{_ERROR_PREFIX}missing_taskId"},
                status=400,
            )
        if not isinstance(prompt, str) or not prompt:
            return web.json_response(
                {"ok": False, "error": f"{_ERROR_PREFIX}missing_prompt"},
                status=400,
            )

        capability = body.get("capability") if isinstance(body.get("capability"), str) else None
        step_idx = body.get("stepIdx") if isinstance(body.get("stepIdx"), int) else None
        deadline_at = (
            body.get("deadlineAt") if isinstance(body.get("deadlineAt"), int) else None
        )

        # -- Invoke runner ----------------------------------------------
        cfg: Dict[str, Any] = {}
        if config_provider is not None:
            try:
                cfg = dict(config_provider() or {})
            except Exception as exc:  # pragma: no cover - defensive
                logger.warning("[hermes-adapter] config_provider raised: %s", exc)
                cfg = {}

        try:
            result = runner(
                task_id=task_id,
                capability=capability,
                prompt=prompt,
                step_idx=step_idx,
                deadline_at=deadline_at,
                config=cfg,
            )
            # Support both sync and async runners — tests often pass sync
            # mocks, while the production runner is a coroutine.
            if hasattr(result, "__await__"):
                result = await result
        except Exception as exc:
            logger.exception("[hermes-adapter] /dispatch runner raised")
            return web.json_response(
                {
                    "ok": False,
                    "error": f"{_ERROR_PREFIX}{exc.__class__.__name__}:{exc}",
                },
                status=200,  # Contract: errors still 200, surfaced via ok:False.
            )

        if not isinstance(result, dict):
            return web.json_response(
                {
                    "ok": False,
                    "error": f"{_ERROR_PREFIX}runner_returned_non_dict",
                },
                status=200,
            )

        return web.json_response(result, status=200)

    return _handle_dispatch


def build_app(
    runner: Optional[Callable[..., Any]] = None,
    config_provider: Optional[Callable[[], Dict[str, Any]]] = None,
):
    """Construct the aiohttp ``web.Application`` with /dispatch + /health.

    Parameters
    ----------
    runner:
        Callable matching ``agent_runner.run_one``'s keyword contract.
        Defaults to the production runner. Tests override this with a
        lightweight mock.
    config_provider:
        Optional zero-arg callable returning a config dict forwarded to
        the runner on every request. Used by ``__main__.main()`` to lock
        in env-derived credentials once at startup rather than re-reading
        the environment on every dispatch.
    """
    from aiohttp import web

    if runner is None:
        from .agent_runner import run_one as runner  # type: ignore[assignment]

    app = web.Application()
    app.router.add_get("/health", _handle_health)
    app.router.add_post("/dispatch", _make_dispatch_handler(runner, config_provider))
    return app


def default_config_from_env() -> Dict[str, Any]:
    """Build an ``agent_runner`` config dict from standard env vars.

    Order of precedence for each key:
        api_key   → OPENAI_API_KEY → HERMES_API_KEY
        base_url  → OPENAI_API_BASE_URL → OPENAI_BASE_URL → HERMES_BASE_URL
        model     → AGENT_DEFAULT_MODEL → HERMES_MODEL
    """
    return {
        "api_key": os.environ.get("OPENAI_API_KEY")
        or os.environ.get("HERMES_API_KEY"),
        "base_url": os.environ.get("OPENAI_API_BASE_URL")
        or os.environ.get("OPENAI_BASE_URL")
        or os.environ.get("HERMES_BASE_URL"),
        "model": os.environ.get("AGENT_DEFAULT_MODEL")
        or os.environ.get("HERMES_MODEL"),
    }
