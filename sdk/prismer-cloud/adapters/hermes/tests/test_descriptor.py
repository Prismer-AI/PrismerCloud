"""
test_descriptor.py — Tests for build_agent_descriptor().
"""

import json
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import prismer_adapter_hermes.descriptor as desc_module
from prismer_adapter_hermes.descriptor import (
    build_agent_descriptor,
    load_cached_descriptor,
)


def _redirect_to(tmp: Path):
    """Swap the para-dir / cache-file resolvers to a temp location."""
    para_dir = tmp / ".prismer" / "para"
    cache_file = para_dir / "hermes-agent-descriptor.json"
    return (
        patch.object(desc_module, "_para_dir", lambda: para_dir),
        patch.object(desc_module, "_descriptor_cache", lambda: cache_file),
        cache_file,
    )


class TestBuildAgentDescriptor:
    def test_returns_expected_shape(self):
        tmp = Path(tempfile.mkdtemp())
        p1, p2, _ = _redirect_to(tmp)
        with p1, p2:
            d = build_agent_descriptor(workspace="/tmp/test-ws")
        assert "id" in d
        assert d["adapter"] == "hermes"
        assert isinstance(d["tiersSupported"], list)
        assert 4 in d["tiersSupported"]
        assert "cache-safe-inject" in d["capabilityTags"]
        assert d["workspace"] == "/tmp/test-ws"

    def test_id_is_stable_for_same_workspace(self):
        tmp = Path(tempfile.mkdtemp())
        p1, p2, _ = _redirect_to(tmp)
        with p1, p2:
            d1 = build_agent_descriptor(workspace="/ws-fixed")
            d2 = build_agent_descriptor(workspace="/ws-fixed")
        assert d1["id"] == d2["id"]

    def test_cache_file_written_atomically(self):
        tmp = Path(tempfile.mkdtemp())
        p1, p2, cache_file = _redirect_to(tmp)
        with p1, p2:
            build_agent_descriptor(workspace="/ws")
        assert cache_file.exists()
        loaded = json.loads(cache_file.read_text(encoding="utf-8"))
        assert loaded["adapter"] == "hermes"

    def test_uses_cwd_when_workspace_none(self):
        tmp = Path(tempfile.mkdtemp())
        p1, p2, _ = _redirect_to(tmp)
        with p1, p2:
            d = build_agent_descriptor()
        assert d["workspace"] == os.getcwd()

    def test_handles_missing_hermes_package_gracefully(self):
        """If hermes is not installed, version should be 'unknown' — no crash."""
        tmp = Path(tempfile.mkdtemp())
        p1, p2, _ = _redirect_to(tmp)
        with patch("importlib.metadata.version", side_effect=Exception("nope")):
            with p1, p2:
                d = build_agent_descriptor("/ws")
        assert d["version"] == "unknown"

    def test_cache_oserror_does_not_raise(self):
        """Even if the cache write fails, the descriptor dict is returned."""
        readonly = Path("/nonexistent/readonly/path")
        with patch.object(desc_module, "_para_dir", lambda: readonly), \
             patch.object(
                 desc_module, "_descriptor_cache",
                 lambda: readonly / "hermes-agent-descriptor.json",
             ):
            d = build_agent_descriptor("/ws")
        assert d["adapter"] == "hermes"


class TestLoadCachedDescriptor:
    def test_returns_none_when_file_missing(self):
        with patch.object(
            desc_module, "_descriptor_cache",
            lambda: Path("/nonexistent/path.json"),
        ):
            result = load_cached_descriptor()
        assert result is None

    def test_returns_dict_when_file_exists(self):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
            json.dump({"adapter": "hermes"}, f)
            tmp_path = Path(f.name)
        try:
            with patch.object(
                desc_module, "_descriptor_cache", lambda: tmp_path
            ):
                result = load_cached_descriptor()
            assert result is not None
            assert result["adapter"] == "hermes"
        finally:
            os.unlink(tmp_path)
