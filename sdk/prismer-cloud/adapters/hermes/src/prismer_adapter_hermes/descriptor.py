"""
descriptor.py — Builds and caches the AgentDescriptor for this Hermes adapter.

The descriptor is the L1 Discovery payload that identifies the agent to the
Prismer PARA runtime.  It is cached to disk atomically so restarts return a
stable ID.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Optional

def _para_dir() -> Path:
    """Resolve ~/.prismer/para at call time (not module-import time)."""
    return Path.home() / ".prismer" / "para"


def _descriptor_cache() -> Path:
    return _para_dir() / "hermes-agent-descriptor.json"


# Kept for backwards compat; callers should use the helpers above.
PARA_DIR = _para_dir()
DESCRIPTOR_CACHE = _descriptor_cache()


def _stable_adapter_id(workspace: str, adapter: str = "hermes") -> str:
    """Derive a stable adapter ID per PARA spec §4.3.

    Format: `<adapter>-<16-hex hash>` matching the TS CC and OpenClaw adapters.
    The hash covers adapter + workspace + hostname so distinct adapters on the
    same workspace produce distinct IDs (as expected), while the workspace+host
    part is identical across adapters for daemon-side correlation.
    """
    import socket
    raw = f"{adapter}:{workspace}:{socket.gethostname()}"
    hash16 = hashlib.sha256(raw.encode()).hexdigest()[:16]
    return f"{adapter}-{hash16}"


def _hermes_version() -> str:
    """Return Hermes package version string, or 'unknown' if not installed."""
    try:
        import importlib.metadata
        return importlib.metadata.version("hermes-agent")
    except Exception:
        pass
    try:
        import hermes  # type: ignore[import]
        return str(getattr(hermes, "__version__", "unknown"))
    except Exception:
        return "unknown"


def build_agent_descriptor(workspace: Optional[str] = None) -> dict:
    """Build the AgentDescriptor dict and cache it atomically.

    Args:
        workspace: Absolute path to the agent's working directory.
                   Defaults to os.getcwd().

    Returns:
        dict with keys: id, adapter, version, tiersSupported,
        capabilityTags, workspace.
    """
    ws = workspace or os.getcwd()
    descriptor = {
        "id": _stable_adapter_id(ws),
        "adapter": "hermes",
        "version": _hermes_version(),
        # L4 claimed because pre_llm_call supports cache-safe inject (P11 Pattern).
        "tiersSupported": [1, 2, 3, 4],
        "capabilityTags": ["code", "llm", "cache-safe-inject"],
        "workspace": ws,
    }

    # Atomic cache write: write to tmp file then rename.
    para_dir = _para_dir()
    cache_path = _descriptor_cache()
    try:
        para_dir.mkdir(parents=True, exist_ok=True)
        data = json.dumps(descriptor, indent=2)
        fd, tmp_path = tempfile.mkstemp(dir=para_dir, suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(data)
            os.replace(tmp_path, cache_path)
        except Exception:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise
    except OSError as exc:
        print(
            f"[hermes-adapter] descriptor cache write error: {exc}",
            file=sys.stderr,
        )

    return descriptor


def load_cached_descriptor() -> Optional[dict]:
    """Load previously cached descriptor from disk, or None if not present."""
    try:
        with open(_descriptor_cache(), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None
