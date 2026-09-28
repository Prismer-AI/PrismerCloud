"""CLI ownership contract for the Python Cloud SDK package."""

import sys
import importlib
from pathlib import Path

import pytest

from prismer import cli as cli_module


daemon_module = importlib.import_module("prismer.daemon")


def test_pyproject_exposes_canonical_and_legacy_bins() -> None:
    pyproject = (Path(__file__).parents[1] / "pyproject.toml").read_text(encoding="utf-8")
    version = (Path(__file__).parents[4] / "VERSION").read_text(encoding="utf-8").strip()
    major, minor, _patch = (int(part) for part in version.split("."))
    assert 'prismer-py = "prismer.cli:main"' in pyproject
    assert 'prismer = "prismer.cli:legacy_main"' in pyproject
    assert f'"prismer-aip>={version},<{major}.{minor + 1}.0"' in pyproject


def test_legacy_prismer_daemon_fails_closed(monkeypatch, capsys) -> None:
    monkeypatch.setattr(sys, "argv", ["prismer", "daemon", "status"])

    with pytest.raises(SystemExit) as exc:
        cli_module.legacy_main()

    assert exc.value.code == 2
    captured = capsys.readouterr()
    assert "Deprecated Python SDK bin 'prismer'" in captured.err
    assert "AMBIGUOUS_PRISMER_BIN" in captured.err
    assert captured.out == ""


def test_legacy_non_daemon_warns_on_stderr_only(monkeypatch, capsys) -> None:
    calls = []
    monkeypatch.setattr(sys, "argv", ["prismer", "status", "--json"])
    monkeypatch.setattr(cli_module, "_run", lambda prog_name: calls.append(prog_name))

    cli_module.legacy_main()

    captured = capsys.readouterr()
    assert calls == ["prismer"]
    assert "Deprecated Python SDK bin 'prismer'" in captured.err
    assert captured.out == ""


def test_canonical_prismer_py_has_no_legacy_warning(monkeypatch, capsys) -> None:
    calls = []
    monkeypatch.setattr(cli_module, "_run", lambda prog_name: calls.append(prog_name))

    cli_module.main()

    captured = capsys.readouterr()
    assert calls == ["prismer-py"]
    assert captured.err == ""
    assert captured.out == ""


def test_help_names_python_daemon_scope() -> None:
    from click.testing import CliRunner

    result = CliRunner().invoke(cli_module.cli, ["daemon", "--help"])
    assert result.exit_code == 0
    assert "not the Runtime agent host" in result.output


def test_legacy_evolution_outbox_is_explicitly_deprecated(monkeypatch, tmp_path) -> None:
    cache_dir = tmp_path / "cache"
    monkeypatch.setattr(daemon_module, "CACHE_DIR", cache_dir)
    monkeypatch.setattr(daemon_module, "OUTBOX_PATH", cache_dir / "outbox.json")

    with pytest.warns(DeprecationWarning, match="@prismer/runtime"):
        daemon_module.append_to_outbox({"geneId": "legacy-2x"})

    assert daemon_module.OUTBOX_PATH.exists()
