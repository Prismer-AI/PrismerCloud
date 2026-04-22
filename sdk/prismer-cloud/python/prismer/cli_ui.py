"""
Prismer CLI UI — per §15 cli-design.md spec

This module provides consistent, beautiful CLI output across Prismer SDKs.
Design reference: docs/version190/15-cli-design.md

Level hierarchy:
- Level 1: Header (bold, section markers)
- Level 2: Primary data (plain text)
- Level 3: Secondary (dimmed, indented)
- Level 4: Action tips (cyan "Tip:"/"Next:")
- Level 5: Status indicators (✓ ✗ ● ○ ⟳ · with colors)
- Level 6: Error block (Cause/Fix format)
"""

from __future__ import annotations
import json
import os
import sys
from typing import Any, Dict, List, Optional, Callable

try:
    from rich.console import Console
    from rich.text import Text
    from rich.table import Table
    from rich.panel import Panel
    from rich.progress import Progress, SpinnerColumn, TextColumn
    from rich.prompt import Prompt, Confirm
    from rich.syntax import Syntax
    from rich.json import JSON as RichJSON
    from rich import box
except ImportError:
    # Rich is optional - fallback to plain output
    Console = None
    Text = None
    Table = None
    Panel = None
    Progress = None
    Prompt = None
    Confirm = None
    Syntax = None
    RichJSON = None
    box = None


# ============================================================================
# Constants
# ============================================================================

# Status indicators per §15
STATUS_OK = "✓"
STATUS_FAIL = "✗"
STATUS_ONLINE = "●"
STATUS_OFFLINE = "○"
STATUS_PENDING = "⟳"
STATUS_NOT_INSTALLED = "·"

# Braille spinner frames per §15
BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

# Forbidden brand voice patterns per §15
FORBIDDEN_SUBSTRINGS = ["Sorry", "Unfortunately", "Oops"]
FORBIDDEN_WORDS = ["Please"]

# Brand icon - embedded from sdk/prismer-cloud/icon
BRAND_ICON = """


          ▒▒▒▒▒▒▒▒▒▒▒▒▒▒
        ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒
      ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒
      ▒▒▒▒                 ▒▒▒▒▒
     ▒▒▒▒    ▒▒▒▒▒▒▒▒▒      ▒▒▒▒         ▓▓▓▓▓▓▓       ▓▓▓▓▓▓▓       ▓▓▓▓      ▓▓▓▓▓▓      ▓▓▓            ▓▓   ▓▓▓▓▓▓▓  ▓▓▓▓▓▓▓▓▓
    ▒▒▒   ▒▒▒▒▒▒▒▒▒▒▒    ▒▒▒       ▓▓▓▓▓▓▓▓    ▓▓▓▓▓▓▓    ▓▓▓    ▓▓▓▓▓▓▓    ▓▓▓           ▓▓   ▓▓▓▓▓▓  ▓▓▓▓▓▓▓▓▓
    ▒▒▒  ▒▒▒▒▒▒▒▒▒▒▒▒    ▒▒▒      ▓▓▓▓▓▓▓   ▓▓▓▓▓▓   ▓▓▓   ▓▓▓▓ ▓▓▓▓▓▓  ▓▓▓▓         ▓▓   ▓▓▓▓▓▓▓▓▓▓  ▓▓▓▓▓▓▓▓
   ▒▒▒   ▒▒▒        ▒▒▒    ▒▒▒      ▓▓▓▓    ▓▓▓▓  ▓▓▓      ▓▓▓   ▓▓▓▓▓   ▓▓▓     ▓▓    ▓▓▓▓        ▓▓▓   ▓▓▓           ▓▓▓     ▓▓▓
   ▒▒▒  ▒▒▒          ▒▒▒   ▒▒▒      ▓▓▓▓    ▓▓▓▓   ▓▓▓     ▓▓▓▓   ▓▓▓▓            ▓▓▓▓▓      ▓▓▓▓▓   ▓▓▓▓           ▓▓▓     ▓▓▓
  ▒▒▒   ▒▒▒     ▒▒▒▒▒▒    ▒▒▒      ▓▓▓▓▓▓▓   ▓▓▓▓▓▓▓   ▓▓▓    ▓▓▓▓▓▓    ▓▓▓▓▓▓▓   ▓▓▓▓▓▓▓▓▓▓
  ▒▒▒  ▒▒▒▒  ▒▒▒▒▒▒▒    ▒▒▒       ▓▓▓▓▓▓    ▓▓▓▓▓▓▓     ▓▓▓     ▓▓▓▓▓▓▓▒▒  ▓▓▓▓   ▓▓▓▓▓▓   ▓▓▓▓▓▓▓▓▓  ▓▓▓▓▓▓▓▓▓▓▓
 ▒▒▒   ▒▒▒  ▒▒▒▒▒▒     ▒▒▒        ▓▓▓▓▓▓       ▓▓▓▓▓▓      ▓▓▓             ▓▓  ▓▓▓ ▓▓▓ ▓▓ ▓▓   ▓▓▓▓           ▓▓▓▓▓▓▓▓
 ▒▒▒  ▒▒▒   ▒▒▒        ▒▒▒▒▒        ▓▓▓            ▓▓▓   ▓▓▓▓     ▓▓▓▓  ▓▓▓▓       ▓▓▓  ▓▓▓  ▓▓▓▓▓  ▓▓▓   ▓▓▓▓           ▓▓▓   ▓▓▓▓
 ▒▒▒  ▒▒▒   ▒▒▒        ▒▒▒▒▒        ▓▓▓            ▓▓▓   ▓▓▓▓     ▓▓▓▓  ▓▓▓       ▓▓▓  ▓▓▓  ▓▓▓▓▓▓  ▓▓▓   ▓▓▓           ▓▓▓   ▓▓▓▓
▒▒▒   ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒          ▓▓▓            ▓▓▓    ▓▓▓▓    ▓▓▓▓  ▓▓▓▓     ▓▓▓  ▓▓▓   ▓▓▓▓▓▓▓  ▓▓▓   ▓▓▓           ▓▓▓   ▓▓▓▓▓
▒▒▒   ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒            ▓▓▓            ▓▓▓     ▓▓▓▓   ▓▓▓▓   ▓▓▓▓▓▓▓    ▓▓▓    ▓▓▓▓    ▓▓▓   ▓▓▓▓▓▓  ▓▓▓    ▓▓▓▓▓     ▓▓▓
▒▒▒     ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒               ▓▓▓            ▓▓▓      ▓▓▓▓  ▓▓▓▓     ▓▓▓▓▓▓▓    ▓▓▓    ▓▓▓▓    ▓▓▓▓  ▓▓▓▓   ▓▓▓▓▓▓  ▓▓▓     ▓▓▓
  ▒▒▒▒▒      ▒▒▒▒
  ▒▒▒▒▒▒▒▒▒▒▒
    ▒▒▒▒▒▒▒▒▒▒
      ▒▒▒▒▒▒
"""

COMPACT_BANNER = ["◇ PRISMER", "  Runtime CLI"]


# ============================================================================
# Output modes
# ============================================================================

class OutputMode:
    PRETTY = "pretty"
    JSON = "json"
    QUIET = "quiet"


# ============================================================================
# UI class
# ============================================================================

class UI:
    def __init__(self, mode: str = OutputMode.PRETTY, color: Optional[bool] = None):
        self.mode = mode
        self.color_enabled = color if color is not None else self._supports_color()
        self.console = Console(force_terminal=False if not sys.stdout.isatty() else None) if Console else None
        self.width = self._get_terminal_width()

    def set_mode(self, mode: str) -> None:
        self.mode = mode

    def set_color(self, enabled: bool) -> None:
        self.color_enabled = enabled

    # ========================================================================
    # Color helpers
    # ========================================================================

    def _color(self, code: str, text: str) -> str:
        if not self.color_enabled:
            return text
        return f"\u001b[{code}m{text}\u001b[0m"

    def _ansi(self, code: int, text: str) -> str:
        if not self.color_enabled:
            return text
        return f"\u001b[{code}m{text}\u001b[0m"

    def red(self, text: str) -> str:
        return self._ansi(31, text)

    def green(self, text: str) -> str:
        return self._ansi(32, text)

    def yellow(self, text: str) -> str:
        return self._ansi(33, text)

    def cyan(self, text: str) -> str:
        return self._ansi(36, text)

    def dim(self, text: str) -> str:
        return self._ansi(2, text)

    def bold(self, text: str) -> str:
        return self._ansi(1, text)

    def _color_brand_line(self, line: str) -> str:
        out = []
        for ch in line:
            if ch == '▒':
                out.append(self.cyan(ch))
            elif ch == '▓':
                out.append(self.dim(ch))
            else:
                out.append(ch)
        return "".join(out)

    # ========================================================================
    # Write helpers
    # ========================================================================

    def _write(self, text: str) -> None:
        print(text, end="", file=sys.stdout, flush=True)

    def _write_err(self, text: str) -> None:
        print(text, end="", file=sys.stderr, flush=True)

    # ========================================================================
    # Level 1: Header
    # ========================================================================

    def header(self, text: str) -> None:
        if self.mode == OutputMode.QUIET or self.mode == OutputMode.JSON:
            return
        self._write(f"{self.bold(text)}\n")

    def banner(self, subtitle: Optional[str] = None, full: bool = False) -> None:
        if self.mode == OutputMode.QUIET or self.mode == OutputMode.JSON:
            return

        should_use_full = full or self.width >= 120

        if should_use_full:
            # Full icon
            for line in BRAND_ICON.split("\n"):
                stripped = line.strip()
                if not stripped:
                    self._write("\n")
                    continue
                clipped = stripped[:self.width - 1] if len(stripped) >= self.width else stripped
                self._write(f"{self._color_brand_line(clipped)}\n")
        else:
            # Compact banner
            self._write(f"{self.cyan('◇ PRISMER')}\n")
            self._write(f"{self.dim('  Runtime CLI')}\n")

        if subtitle:
            self._write(f"  {self.dim(subtitle)}\n")
        self.blank()

    # ========================================================================
    # Level 2: Primary data
    # ========================================================================

    def blank(self) -> None:
        if self.mode == OutputMode.QUIET or self.mode == OutputMode.JSON:
            return
        self._write("\n")

    def line(self, text: str) -> None:
        if self.mode == OutputMode.QUIET or self.mode == OutputMode.JSON:
            return
        self._write(f"{text}\n")

    def info(self, text: str) -> None:
        self.line(text)

    # ========================================================================
    # Level 3: Secondary
    # ========================================================================

    def secondary(self, text: str, indent: int = 2) -> None:
        if self.mode == OutputMode.QUIET or self.mode == OutputMode.JSON:
            return
        padding = " " * indent
        self._write(f"{padding}{self.dim(text)}\n")

    # ========================================================================
    # Level 4: Action tips
    # ========================================================================

    def tip(self, text: str) -> None:
        if self.mode == OutputMode.QUIET or self.mode == OutputMode.JSON:
            return
        self._write(f"{self.cyan('Tip:')} {text}\n")

    def next(self, text: str) -> None:
        if self.mode == OutputMode.QUIET or self.mode == OutputMode.JSON:
            return
        self._write(f"{self.cyan('Next:')} {text}\n")

    # ========================================================================
    # Level 5: Status indicators
    # ========================================================================

    def ok(self, text: str, detail: Optional[str] = None) -> None:
        if self.mode == OutputMode.QUIET or self.mode == OutputMode.JSON:
            return
        suffix = f"  {self.dim(detail)}" if detail else ""
        self._write(f"  {self.green(STATUS_OK)} {text}{suffix}\n")

    def success(self, text: str, detail: Optional[str] = None) -> None:
        self.ok(text, detail)

    def fail(self, text: str, detail: Optional[str] = None) -> None:
        if self.mode == OutputMode.QUIET or self.mode == OutputMode.JSON:
            return
        suffix = f"  {self.dim(detail)}" if detail else ""
        self._write(f"  {self.red(STATUS_FAIL)} {text}{suffix}\n")

    def online(self, text: str) -> None:
        if self.mode == OutputMode.QUIET or self.mode == OutputMode.JSON:
            return
        self._write(f"  {self.green(STATUS_ONLINE)} {text}\n")

    def offline(self, text: str) -> None:
        if self.mode == OutputMode.QUIET or self.mode == OutputMode.JSON:
            return
        self._write(f"  {self.dim(STATUS_OFFLINE)} {text}\n")

    def not_installed(self, text: str) -> None:
        if self.mode == OutputMode.QUIET or self.mode == OutputMode.JSON:
            return
        self._write(f"  {self.dim(STATUS_NOT_INSTALLED)} {self.dim(text)}\n")

    def pending(self, text: str) -> None:
        if self.mode == OutputMode.QUIET or self.mode == OutputMode.JSON:
            return
        self._write(f"  {self.yellow(STATUS_PENDING)} {text}\n")

    def warn(self, text: str, detail: Optional[str] = None) -> None:
        if self.mode == OutputMode.QUIET or self.mode == OutputMode.JSON:
            return
        suffix = f"  {self.dim(detail)}" if detail else ""
        self._write(f"  ! {text}{suffix}\n")

    # ========================================================================
    # Level 6: Error block
    # ========================================================================

    def error(self, what: str, cause: Optional[str] = None, fix: Optional[str] = None) -> None:
        if self.mode == OutputMode.JSON:
            self._write_json_error(what, cause, fix)
            return

        self._write_err(f"{self.red(STATUS_FAIL)} {what}\n")
        if cause:
            self._write_err(f"  {self.dim('Cause:')} {self.dim(cause)}\n")
        if fix:
            self._write_err(f"  {self.cyan('Fix:')} {fix}\u001b[0m\n")

    def _write_json_error(self, what: str, cause: Optional[str], fix: Optional[str]) -> None:
        err_obj = {"error": what}
        if cause:
            err_obj["cause"] = cause
        if fix:
            err_obj["fix"] = fix
        print(json.dumps(err_obj, indent=2), file=sys.stderr)

    # ========================================================================
    # Tables
    # ========================================================================

    def table(self, rows: List[Dict[str, str]], columns: List[str]) -> None:
        """Print a table with 80-char width fallback to list mode."""
        self.blank()

        # Check terminal width
        total_width = sum(len(c) for c in columns) + len(columns) * 2 + 2

        if total_width > self.width:
            # List mode fallback
            for row in rows:
                for col in columns:
                    self.secondary(f"{col}:", 2)
                    self.secondary(str(row.get(col, "")), 4)
                self.blank()
            return

        if not Console:
            # Plain text fallback
            header = "  ".join(c.upper().ljust(15) for c in columns)
            self._write(f"  {self.dim(header)}\n")
            for row in rows:
                line = "  ".join(str(row.get(c, "")).ljust(15) for c in columns)
                self._write(f"  {line}\n")
            return

        # Rich table mode
        table = Table(
            box=box.ROUNDED,
            show_header=True,
            header_style="bold cyan",
        )
        for col in columns:
            table.add_column(col, style="cyan" if col == columns[0] else None)
        for row in rows:
            table.add_row(*[str(row.get(c, "")) for c in columns])
        self.console.print(table)

    # ========================================================================
    # Spinner
    # ========================================================================

    class Spinner:
        def __init__(self, ui: "UI", message: str = "Working..."):
            self.ui = ui
            self.message = message
            self.running = False
            self.frame = 0

        def start(self) -> None:
            if self.running or self.ui.mode in (OutputMode.QUIET, OutputMode.JSON):
                return

            # Non-TTY or non-color: just show pending status
            if not self.ui.color_enabled or not sys.stdout.isatty():
                self.ui.pending(self.message)
                self.running = True
                return

            self.running = True

            # Animated braille spinner
            import threading
            import time

            self._stop_event = threading.Event()

            def _spinner():
                while not self._stop_event.is_set():
                    frame = BRAILLE_FRAMES[self.frame % len(BRAILLE_FRAMES)]
                    self.ui._write(f"\r{frame} {self.ui.yellow(self.message)}")
                    self.frame += 1
                    time.sleep(0.08)

            self._thread = threading.Thread(target=_spinner, daemon=True)
            self._thread.start()

        def update(self, message: str) -> None:
            if not self.running:
                return
            self.message = message

        def stop(self, success_message: Optional[str] = None) -> None:
            if not self.running:
                return

            self.running = False

            if hasattr(self, "_stop_event"):
                self._stop_event.set()

            if hasattr(self, "_thread"):
                self._thread.join(timeout=1.0)

            # Clear spinner line
            if sys.stdout.isatty() and self.ui.color_enabled:
                self.ui._write("\r\u001b[2K")

            if success_message:
                self.ui.ok(success_message)

    def spinner(self, message: str = "Working...") -> Spinner:
        return self.Spinner(self, message)

    # ========================================================================
    # JSON output
    # ========================================================================

    def json(self, payload: Any) -> None:
        self._write(json.dumps(payload, indent=2, default=str) + "\n")

    def result(self, pretty_func: Callable[[], None], json_payload: Any) -> None:
        if self.mode == OutputMode.PRETTY:
            pretty_func()
        else:
            self.json(json_payload)

    # ========================================================================
    # Brand voice checker
    # ========================================================================

    @staticmethod
    def check_brand_voice(text: str, field: str) -> None:
        """Check for forbidden words and substrings. Raise ValueError if found."""
        # Check for forbidden substrings
        for fs in FORBIDDEN_SUBSTRINGS:
            if fs in text:
                raise ValueError(f"Brand voice error in {field}: found forbidden substring '{fs}'")

        # Check for forbidden words (whole word match)
        for fw in FORBIDDEN_WORDS:
            import re
            if re.search(rf"\b{fw}\b", text):
                raise ValueError(f"Brand voice error in {field}: found forbidden word '{fw}'")

        # Check for trailing exclamation marks (not inside quotes)
        for line in text.split("\n"):
            stripped = line.strip()
            if not stripped:
                continue

            # Check if inside quotes
            in_double_quote = '"' in stripped
            in_single_quote = "'" in stripped
            if in_double_quote or in_single_quote:
                # Skip quoted text
                continue

            # Check for trailing exclamation
            if stripped.endswith('!') and not stripped.endswith('!!'):
                raise ValueError(f"Brand voice error in {field}: trailing exclamation mark in '{line}'")

    # ========================================================================
    # Terminal detection
    # ========================================================================

    @staticmethod
    def _supports_color() -> bool:
        return os.environ.get("NO_COLOR") is None

    def _get_terminal_width(self) -> int:
        if "COLUMNS" in os.environ:
            try:
                return int(os.environ["COLUMNS"])
            except ValueError:
                pass
        return 80


# ============================================================================
# Default UI instance
# ============================================================================

_ui: Optional[UI] = None


def get_ui() -> UI:
    global _ui
    if _ui is None:
        _ui = UI()
    return _ui


def set_ui(ui: UI) -> None:
    global _ui
    _ui = ui
