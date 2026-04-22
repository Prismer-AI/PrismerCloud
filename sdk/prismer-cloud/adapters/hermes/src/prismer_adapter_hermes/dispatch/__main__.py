"""
__main__.py — CLI entrypoint for ``prismer-hermes-serve``.

Boots the Mode B dispatch server and wires our PARA plugin into the
Hermes plugin singleton BEFORE the first dispatch runs, so every
``AIAgent.run_conversation`` call automatically emits PARA events
through our own JSONL sink. We register by hand (bypassing Hermes's
``plugins.enabled`` config gate) — this is intentional, matching the
"standalone process, no Hermes fork" design decision for v0.2.0.

Usage:
    prismer-hermes-serve --port 8765 --host 127.0.0.1
    OPENAI_API_KEY=… OPENAI_API_BASE_URL=… AGENT_DEFAULT_MODEL=… \
        prismer-hermes-serve

Idempotent: if the caller already wired the plugin (e.g. by importing
``prismer_adapter_hermes.register`` into a host process), we detect the
existing registration and skip re-registration.
"""

from __future__ import annotations

import argparse
import logging
import os
import signal
import sys
from typing import Optional


logger = logging.getLogger("prismer_adapter_hermes.dispatch")


def _configure_logging() -> None:
    level = os.environ.get("PRISMER_LOG_LEVEL", "INFO").upper()
    logging.basicConfig(
        level=level,
        format="%(asctime)s [hermes-dispatch] %(levelname)s %(message)s",
    )


def _register_plugin_with_hermes() -> Optional[object]:
    """Wire the PARA adapter into Hermes's module-level plugin manager.

    Hermes's ``invoke_hook`` reads from a singleton ``PluginManager``
    owned by ``hermes_cli.plugins``. We grab that manager, mark it as
    "already discovered" so it doesn't later wipe our callbacks from a
    ``plugins.enabled`` config check, then call our own ``register()``
    with a synthesised ``PluginContext``. On failure we log and continue
    — the dispatch surface is still useful for health checks and unit
    tests even without plugin wiring.
    """
    try:
        from hermes_cli.plugins import (
            PluginContext,
            PluginManifest,
            get_plugin_manager,
        )
    except Exception as exc:  # pragma: no cover - hermes missing
        print(
            f"[hermes-adapter] hermes plugin API unavailable: {exc} — "
            "dispatch will still run but PARA events will NOT be emitted",
            file=sys.stderr,
        )
        return None

    try:
        from prismer_adapter_hermes import __version__ as pkg_version
        from prismer_adapter_hermes.register import register as prismer_register
    except Exception as exc:  # pragma: no cover - package broken
        print(
            f"[hermes-adapter] adapter import failed: {exc}",
            file=sys.stderr,
        )
        return None

    manager = get_plugin_manager()

    # If we're re-invoked (e.g. in tests that call main() multiple times)
    # and our plugin is already wired, do nothing. Detection: check for a
    # well-known hook entry whose __qualname__ is on HermesParaAdapter.
    already = False
    try:
        for hook_name, callbacks in manager._hooks.items():  # type: ignore[attr-defined]
            for cb in callbacks or []:
                qn = getattr(cb, "__qualname__", "") or ""
                if qn.startswith("HermesParaAdapter."):
                    already = True
                    break
            if already:
                break
    except Exception:
        already = False

    if already:
        logger.info("plugin already registered with Hermes — skipping")
        return None

    manifest = PluginManifest(
        name="prismer-adapter-hermes",
        version=pkg_version,
        source="user",
    )
    ctx = PluginContext(manifest, manager)
    adapter = prismer_register(ctx)
    # Mark discovered so Hermes's opt-in allow-list gate doesn't later try
    # to reload plugins in a way that could overwrite us.
    try:
        manager._discovered = True  # type: ignore[attr-defined]
    except Exception:
        pass
    logger.info(
        "registered prismer-adapter-hermes v%s with hermes PluginManager",
        pkg_version,
    )
    return adapter


def _parse_args(argv) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="prismer-hermes-serve",
        description=(
            "Mode B dispatch server for Prismer Hermes adapter. POST "
            "/dispatch to /dispatch routes a PARA task to a Hermes "
            "AIAgent."
        ),
    )
    p.add_argument(
        "--host",
        default=os.environ.get("PRISMER_DISPATCH_HOST", "127.0.0.1"),
        help="Interface to bind (default: 127.0.0.1)",
    )
    p.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("PRISMER_DISPATCH_PORT", "8765")),
        help="TCP port to listen on (default: 8765)",
    )
    return p.parse_args(argv)


def main(argv=None) -> int:
    """CLI entry. Returns process exit code."""
    _configure_logging()
    args = _parse_args(argv if argv is not None else sys.argv[1:])

    try:
        from aiohttp import web  # noqa: F401 — fail early with a clean msg
    except Exception as exc:
        print(
            f"[hermes-adapter] aiohttp not installed ({exc}). Install the "
            "dispatch extra: pip install 'prismer-adapter-hermes[dispatch]'",
            file=sys.stderr,
        )
        return 2

    # Register BEFORE aiohttp.web.run_app so any background warmup hits
    # the plugin.
    _register_plugin_with_hermes()

    from .agent_runner import warn_if_missing_llm_env
    from .server import build_app, default_config_from_env

    warn_if_missing_llm_env()

    # Capture env-derived defaults once; the handler reuses this snapshot
    # so late env mutations don't cause per-request variance.
    snapshot = default_config_from_env()

    app = build_app(config_provider=lambda: snapshot)

    print(
        f"[hermes-adapter] dispatch server listening on "
        f"http://{args.host}:{args.port} (model={snapshot.get('model')})",
        file=sys.stderr,
    )

    # Graceful SIGTERM/SIGINT handling is handled by aiohttp.web.run_app.
    from aiohttp import web

    def _on_shutdown(_app):
        logger.info("shutdown requested; draining outstanding dispatches")

    app.on_shutdown.append(_on_shutdown)

    try:
        web.run_app(app, host=args.host, port=args.port, print=None)
    except (KeyboardInterrupt, SystemExit):
        pass
    except OSError as exc:
        print(
            f"[hermes-adapter] failed to bind {args.host}:{args.port}: {exc}",
            file=sys.stderr,
        )
        return 3

    # Best-effort signal cleanup when we're embedded somewhere else.
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, signal.SIG_DFL)
        except (ValueError, OSError):
            pass

    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
