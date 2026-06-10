"""Unit tests for ``prismer hermes install-memory-provider`` (T3).

Covers 10 cases — the original 9 from the T3-C spec plus one regression
guard added during T3 review:

    1. install writes __init__.py with expected content
    2. install is idempotent — second run overwrites without error
    3. --uninstall removes the directory (when only installer files present)
    4. --uninstall is graceful when the directory does not exist
    5. --dry-run does not write but prints expected output
    6. $HERMES_HOME env var override is respected
    7. generated __init__.py contains the substring "MemoryProvider"
       (so Hermes' cheap text scan in _is_memory_provider_dir picks it up)
    8. generated __init__.py contains "register_memory_provider"
       (so the alternative discovery path picks it up)
    9. importing the generated __init__.py does not raise — and
       ``register_memory_provider()`` returns a fresh provider INSTANCE
       (matches the ``register(ctx)`` pattern; not the bare class)
   10. --uninstall preserves user-authored files in the plugin directory
       (regression guard for the original ``shutil.rmtree`` footgun)

These tests are pure offline — no daemon, no network, no API key. The
conftest fixtures live in ``tests/conftest.py`` and are not requested
here, so PRISMER_API_KEY_TEST is not exercised by this file.
"""

from __future__ import annotations

import importlib
import importlib.util
import os
import sys
import uuid
from pathlib import Path

import pytest
from click.testing import CliRunner

from prismer import _hermes_plugin_template as tpl
from prismer.cli import cli


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _invoke_install(runner: CliRunner, *args: str, env: dict | None = None):
    """Run ``prismer hermes install-memory-provider`` with the given args."""
    return runner.invoke(
        cli,
        ["hermes", "install-memory-provider", *args],
        env=env or {},
        catch_exceptions=False,
    )


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_install_writes_init_file_with_expected_content(tmp_path: Path):
    """Case 1: install writes __init__.py with expected content."""
    runner = CliRunner()
    result = _invoke_install(
        runner, "--hermes-home", str(tmp_path),
    )
    assert result.exit_code == 0, result.output

    init_file = tmp_path / "plugins" / tpl.PLUGIN_NAME / "__init__.py"
    assert init_file.exists()

    content = init_file.read_text(encoding="utf-8")
    # Spot-check substrings that prove this is our shim, not some leftover.
    assert "Auto-generated Hermes memory plugin shim for Prismer" in content
    assert "from prismer.hermes_memory_provider import" in content
    assert "PrismerDaemonMemoryProvider" in content
    assert "def register(ctx)" in content
    assert "def register_memory_provider()" in content


def test_install_is_idempotent(tmp_path: Path):
    """Case 2: re-running install overwrites without error."""
    runner = CliRunner()
    first = _invoke_install(runner, "--hermes-home", str(tmp_path))
    assert first.exit_code == 0, first.output

    init_file = tpl.plugin_init_file(tmp_path)
    # Mutate the file so we can prove it gets rewritten verbatim
    init_file.write_text("# manually corrupted\n", encoding="utf-8")
    assert init_file.read_text(encoding="utf-8") == "# manually corrupted\n"

    second = _invoke_install(runner, "--hermes-home", str(tmp_path))
    assert second.exit_code == 0, second.output
    # Restored to template
    assert init_file.read_text(encoding="utf-8") == tpl.render_template()


def test_uninstall_removes_directory(tmp_path: Path):
    """Case 3: --uninstall removes the plugin directory."""
    runner = CliRunner()
    _invoke_install(runner, "--hermes-home", str(tmp_path))
    pdir = tpl.plugin_dir(tmp_path)
    assert pdir.exists()

    result = _invoke_install(runner, "--hermes-home", str(tmp_path), "--uninstall")
    assert result.exit_code == 0, result.output
    assert not pdir.exists()
    assert "Removed" in result.output


def test_uninstall_is_graceful_when_absent(tmp_path: Path):
    """Case 4: --uninstall on a missing directory does not fail."""
    runner = CliRunner()
    pdir = tpl.plugin_dir(tmp_path)
    assert not pdir.exists()

    result = _invoke_install(runner, "--hermes-home", str(tmp_path), "--uninstall")
    assert result.exit_code == 0, result.output
    assert "Nothing to remove" in result.output or "does not exist" in result.output


def test_dry_run_does_not_write_but_prints(tmp_path: Path):
    """Case 5: --dry-run prints what would be installed without writing."""
    runner = CliRunner()
    result = _invoke_install(runner, "--hermes-home", str(tmp_path), "--dry-run")
    assert result.exit_code == 0, result.output

    pdir = tpl.plugin_dir(tmp_path)
    init_file = tpl.plugin_init_file(tmp_path)
    assert not pdir.exists(), "dry-run must not create the directory"
    assert not init_file.exists(), "dry-run must not write the init file"

    # Output should contain the rendered template
    assert "PrismerDaemonMemoryProvider" in result.output
    assert "Would create directory" in result.output or "[dry-run]" in result.output


def test_hermes_home_env_var_override(tmp_path: Path):
    """Case 6: $HERMES_HOME env var override is honored."""
    runner = CliRunner()
    # Use --hermes-home env override path. CliRunner.invoke with env= sets
    # process env for the duration of the command. We deliberately do NOT
    # pass --hermes-home so the resolver picks up HERMES_HOME from env.
    result = _invoke_install(
        runner,
        env={"HERMES_HOME": str(tmp_path)},
    )
    assert result.exit_code == 0, result.output

    init_file = tmp_path / "plugins" / tpl.PLUGIN_NAME / "__init__.py"
    assert init_file.exists(), (
        f"HERMES_HOME env var not respected: expected {init_file} to exist"
    )


def test_generated_init_contains_memoryprovider_substring(tmp_path: Path):
    """Case 7: generated __init__.py contains 'MemoryProvider'.

    Hermes' ``_is_memory_provider_dir`` does a cheap text scan for either
    ``register_memory_provider`` or ``MemoryProvider``. We must satisfy
    at least one (we satisfy both) so the directory is accepted.
    """
    runner = CliRunner()
    _invoke_install(runner, "--hermes-home", str(tmp_path))
    init_file = tpl.plugin_init_file(tmp_path)
    content = init_file.read_text(encoding="utf-8")
    assert "MemoryProvider" in content


def test_generated_init_contains_register_memory_provider_substring(tmp_path: Path):
    """Case 8: generated __init__.py contains 'register_memory_provider'.

    The bare-symbol discovery path (some loaders look for the exact
    ``register_memory_provider`` symbol) requires this substring.
    """
    runner = CliRunner()
    _invoke_install(runner, "--hermes-home", str(tmp_path))
    init_file = tpl.plugin_init_file(tmp_path)
    content = init_file.read_text(encoding="utf-8")
    assert "register_memory_provider" in content


def test_generated_init_imports_cleanly(tmp_path: Path):
    """Case 9: importing the generated __init__.py does not raise.

    Verifies that ``from prismer.hermes_memory_provider import ...``
    resolves in the test venv. We import the file at its tmp_path
    location via ``importlib.util.spec_from_file_location`` to avoid
    polluting ``sys.modules`` with a name that could collide with the
    real installed plugin path.
    """
    runner = CliRunner()
    _invoke_install(runner, "--hermes-home", str(tmp_path))
    init_file = tpl.plugin_init_file(tmp_path)

    # Use a unique synthetic module name so we don't conflict with prior
    # imports or the real "_hermes_user_memory.prismer-daemon" namespace
    # Hermes itself uses.
    module_name = f"_test_hermes_plugin_{uuid.uuid4().hex}"
    spec = importlib.util.spec_from_file_location(module_name, str(init_file))
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    try:
        spec.loader.exec_module(module)
        # The two discovery handles must be present and callable / class-like
        assert callable(module.register)
        assert callable(module.register_memory_provider)
        assert isinstance(module.MemoryProvider, type)
        # The free-function variant returns a fresh provider INSTANCE,
        # mirroring the ``register(ctx)`` pattern's
        # ``ctx.register_memory_provider(PrismerDaemonMemoryProvider())``.
        # It is NOT the bare class — callers should not have to construct.
        provider = module.register_memory_provider()
        assert isinstance(provider, module.MemoryProvider)
        # Each call returns a fresh instance (matches register(ctx) semantics)
        assert module.register_memory_provider() is not provider
    finally:
        sys.modules.pop(module_name, None)


def test_uninstall_preserves_user_files(tmp_path: Path):
    """Case 10: --uninstall preserves files the user/3rd-party dropped in.

    Pre-condition: the plugin directory contains both the installer's
    ``__init__.py`` AND a user file (e.g. a ``notes.md`` someone left
    there, or a ``__init__.py.bak`` backup from a manual edit). After
    uninstall:

        - ``__init__.py`` MUST be gone (the installer's file is removed).
        - The user file MUST survive (``shutil.rmtree`` would have
          deleted it — that's the footgun this test guards against).
        - The plugin directory MUST survive (because it's not empty).
        - The CLI MUST exit 0 and emit a warning listing the survivors.
    """
    runner = CliRunner()
    # 1. Install (creates plugins/prismer-daemon/__init__.py)
    install_result = _invoke_install(runner, "--hermes-home", str(tmp_path))
    assert install_result.exit_code == 0, install_result.output

    pdir = tpl.plugin_dir(tmp_path)
    init_file = pdir / "__init__.py"
    assert init_file.exists()

    # 2. User drops a file into the plugin directory (the scenario we
    #    must handle: ``rmtree`` would silently destroy this).
    user_file = pdir / "notes.md"
    user_file.write_text("# my plugin tweaks — keep me\n", encoding="utf-8")

    # 3. Uninstall
    result = _invoke_install(runner, "--hermes-home", str(tmp_path), "--uninstall")
    assert result.exit_code == 0, result.output

    # 4. Verify the surgical-removal contract
    assert not init_file.exists(), "installer __init__.py should be removed"
    assert user_file.exists(), "user-authored notes.md MUST survive uninstall"
    assert pdir.exists(), "plugin dir kept because it still has user files"
    assert user_file.read_text(encoding="utf-8") == "# my plugin tweaks — keep me\n"

    # 5. CLI surfaced the situation to the user
    assert "notes.md" in result.output
    # Some hint that the dir was kept, not silently nuked
    assert "Kept" in result.output or "remain" in result.output
