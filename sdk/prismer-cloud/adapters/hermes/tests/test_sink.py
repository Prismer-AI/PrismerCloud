"""
test_sink.py — Tests for the default JSONL sink.
"""

import json
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import prismer_adapter_hermes.sink as sink_module
from prismer_adapter_hermes.sink import default_jsonl_sink


def _redirect_sink_to(tmp: Path):
    """Context helper: swap out the _events_file resolver for a tmp path."""
    events_file = tmp / ".prismer" / "para" / "events.jsonl"
    return patch.object(
        sink_module, "_events_file", lambda: events_file
    ), events_file


class TestDefaultJsonlSink:
    def test_creates_directory_if_missing(self):
        tmp = Path(tempfile.mkdtemp())
        ctx, events_file = _redirect_sink_to(tmp)
        with ctx:
            default_jsonl_sink({"type": "agent.state", "status": "idle"})
        assert events_file.parent.exists()

    def test_writes_single_jsonl_line(self):
        tmp = Path(tempfile.mkdtemp())
        ctx, events_file = _redirect_sink_to(tmp)
        with ctx:
            default_jsonl_sink({"type": "agent.state", "status": "idle"})
        lines = events_file.read_text(encoding="utf-8").strip().splitlines()
        assert len(lines) == 1
        obj = json.loads(lines[0])
        assert obj["type"] == "agent.state"
        assert "_ts" in obj

    def test_appends_multiple_events(self):
        tmp = Path(tempfile.mkdtemp())
        ctx, events_file = _redirect_sink_to(tmp)
        with ctx:
            default_jsonl_sink({"type": "agent.state", "status": "idle"})
            default_jsonl_sink({"type": "agent.state", "status": "thinking"})
        lines = events_file.read_text(encoding="utf-8").strip().splitlines()
        assert len(lines) == 2

    def test_catches_oserror_gracefully(self, capsys):
        """Sink must not raise on OSError (e.g. read-only filesystem)."""
        readonly = Path("/nonexistent/readonly/path")
        with patch.object(
            sink_module, "_events_file", lambda: readonly / "events.jsonl"
        ):
            default_jsonl_sink({"type": "agent.state", "status": "idle"})
        assert "sink write error" in capsys.readouterr().err

    def test_stdout_env_flag(self, capsys, monkeypatch):
        """PRISMER_PARA_STDOUT=1 should print event to stdout."""
        monkeypatch.setenv("PRISMER_PARA_STDOUT", "1")
        tmp = Path(tempfile.mkdtemp())
        ctx, _ = _redirect_sink_to(tmp)
        with ctx:
            default_jsonl_sink({"type": "agent.state", "status": "tool"})
        assert "agent.state" in capsys.readouterr().out

    def test_concurrent_large_writes_do_not_interleave(self):
        """Regression guard for P1-7: 4KB+ tool.pre args under thread fan-out
        must produce well-formed JSONL. Each line must be parseable JSON."""
        import threading

        tmp = Path(tempfile.mkdtemp())
        ctx, events_file = _redirect_sink_to(tmp)
        # Build events large enough to exceed PIPE_BUF (~4KB) — simulates
        # Hermes `execute_code` script args or large delegate_task contexts.
        big_arg = "x" * 8192  # 8 KB payload per event

        def writer(tid):
            for i in range(50):
                default_jsonl_sink({
                    "type": "agent.state",
                    "status": "thinking",
                    # status is the only required field; overload via metadata
                    # which wire validator happily accepts.
                })
                # Also write a larger shape via the raw sink (bypasses the
                # typed event schema so we can stress O_APPEND directly).
                default_jsonl_sink({
                    "type": "agent.tool.pre",
                    "callId": f"c_{tid}_{i}",
                    "tool": "execute_code",
                    "args": {"script": big_arg},
                })

        with ctx:
            threads = [threading.Thread(target=writer, args=(t,)) for t in range(4)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()

        # Every line must parse. If any interleaves, json.loads raises.
        raw = events_file.read_text(encoding="utf-8")
        lines = [ln for ln in raw.splitlines() if ln.strip()]
        assert len(lines) == 4 * 50 * 2, f"expected 400 lines, got {len(lines)}"
        for ln in lines:
            json.loads(ln)  # will raise on corruption
