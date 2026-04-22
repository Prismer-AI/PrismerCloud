"""
prismer_adapter_hermes.dispatch — Mode B dispatch server.

Standalone HTTP server that exposes ``/dispatch`` (POST) so a Prismer daemon
can route PARA tasks to a Hermes ``AIAgent`` running under our own aiohttp
process. This subpackage is intentionally lazy — importing
``prismer_adapter_hermes`` never reaches aiohttp or hermes-agent, so the
0.1.x core surface stays dependency-free.

See ``server.build_app()`` / ``agent_runner.run_one()`` for the entry points
and ``__main__.main`` for the CLI (``prismer-hermes-serve``).
"""

from __future__ import annotations

__all__ = ["build_app", "run_one"]


def build_app(*args, **kwargs):  # pragma: no cover - thin re-export
    """Lazy wrapper around ``server.build_app`` to keep aiohttp optional."""
    from .server import build_app as _build_app

    return _build_app(*args, **kwargs)


def run_one(*args, **kwargs):  # pragma: no cover - thin re-export
    """Lazy wrapper around ``agent_runner.run_one`` to keep deps optional."""
    from .agent_runner import run_one as _run_one

    return _run_one(*args, **kwargs)
