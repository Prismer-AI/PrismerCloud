"""
sink.py — Default JSONL sink for PARA events.

Appends events to ~/.prismer/para/events.jsonl (one JSON object per line).
Mirror of the TS adapters' sink behavior: atomic enough for log appends,
catches OSError gracefully.
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

# fcntl is POSIX-only. Hermes itself targets Linux+macOS (see the code-exec
# docs: "Windows falls back to sequential tool calls"), but we still degrade
# gracefully so importing the adapter on Windows does not crash.
try:
    import fcntl as _fcntl  # type: ignore[import]
except ImportError:
    _fcntl = None

def _para_dir() -> Path:
    """Resolve ~/.prismer/para at call time.

    HOME may change between module import and actual write (e.g. tests using
    monkeypatch, or a daemon swapping identity), so we re-read it on every
    write rather than caching at module load.
    """
    return Path.home() / ".prismer" / "para"


def _events_file() -> Path:
    return _para_dir() / "events.jsonl"


# Kept for backwards compat; callers should prefer the helpers above.
PARA_DIR = _para_dir()
EVENTS_FILE = _events_file()


def _ts() -> int:
    """Return current timestamp as integer milliseconds since epoch.

    MUST match CC + OpenClaw adapters which use Date.now() (int ms) so events
    from all three adapters appended to the same events.jsonl sort correctly.
    """
    return int(time.time() * 1000)


# 50 MB cap — rotate to events.jsonl.1 when exceeded.
MAX_EVENTS_FILE_SIZE = 50 * 1024 * 1024


def _rotate_if_needed(path: Path) -> None:
    try:
        if path.exists() and path.stat().st_size >= MAX_EVENTS_FILE_SIZE:
            rotated = path.with_suffix(path.suffix + ".1")
            # Overwrite prior rotation — single rollover is enough for this version.
            os.replace(path, rotated)
    except OSError:
        pass  # non-fatal


def default_jsonl_sink(evt: dict) -> None:
    """Append a PARA event as a single JSONL line to ~/.prismer/para/events.jsonl.

    Concurrency model:
      1. ``O_APPEND`` positions the write at EOF on each ``os.write`` call.
      2. The kernel guarantees atomicity only for writes ≤ PIPE_BUF
         (~4096 B). Hermes ``execute_code`` / ``patch`` tool args can
         exceed that when serialized into ``agent.tool.pre`` events.
      3. To protect against interleaved writes from multiple processes
         (daemon sidecar, other adapter instances) or threads, we take a
         process-scoped advisory lock (``fcntl.flock LOCK_EX``) around the
         single ``os.write``. On non-POSIX platforms the lock step is a
         no-op — in that environment you must either (a) keep args small
         or (b) serialize writes externally.

    If the write fails (no disk space, permissions, etc.) we log to stderr
    and return — the caller never sees the exception.
    """
    events_file = _events_file()
    try:
        events_file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        _rotate_if_needed(events_file)
        line = json.dumps({**evt, "_ts": _ts()}, separators=(",", ":")) + "\n"
        fd = os.open(
            str(events_file),
            os.O_WRONLY | os.O_APPEND | os.O_CREAT,
            0o600,
        )
        try:
            if _fcntl is not None:
                _fcntl.flock(fd, _fcntl.LOCK_EX)
            try:
                os.write(fd, line.encode("utf-8"))
            finally:
                if _fcntl is not None:
                    # File close would release the lock anyway, but unlock
                    # first so a partial failure in close() doesn't leave
                    # the lock held longer than necessary.
                    try:
                        _fcntl.flock(fd, _fcntl.LOCK_UN)
                    except OSError:
                        pass
        finally:
            os.close(fd)
    except OSError as exc:
        print(
            f"[hermes-adapter] sink write error ({events_file}): {exc}",
            file=sys.stderr,
        )

    if os.environ.get("PRISMER_PARA_STDOUT") == "1":
        try:
            line_no_ts = json.dumps(evt, separators=(",", ":"))
            print(line_no_ts)
        except Exception:
            pass
