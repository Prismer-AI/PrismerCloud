"""
Prismer CLI UI Components (Rich-based)

Provides:
- Icon display with colorization
- Status messages (success/error/warn/info)
- Tables
- Progress spinners
- QR code display
- Interactive prompts
- Key-value pair display
- Code and JSON rendering
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

from rich.console import Console
from rich.table import Table
from rich.panel import Panel
from rich.progress import Progress, SpinnerColumn, TextColumn, BarColumn, TaskProgressColumn
from rich.prompt import Prompt, Confirm
from rich.syntax import Syntax
from rich.json import JSON as RichJSON
from rich.text import Text
from rich import box

# Global Console instance — graceful degradation for non-TTY
console = Console(force_terminal=False if not sys.stdout.isatty() else None)


# ============================================================================
# Banner / Icon
# ============================================================================

def display_banner() -> None:
    """Display the Prismer ASCII art banner with colors.

    Reads the icon file relative to this package, colorizes block characters:
    - ▒ (icon shapes) → bright_cyan
    - ▓ (text "PRISMER") → dim white
    """
    # icon is packaged inside prismer/ (same directory as this file)
    icon_path = Path(__file__).resolve().parent / "icon"
    if not icon_path.exists():
        # Fallback: source tree layout (prismer-cloud/icon)
        icon_path = Path(__file__).resolve().parent.parent.parent / "icon"
    if not icon_path.exists():
        # Last resort: plain text banner
        console.print("[bold cyan]PRISMER[/bold cyan] Cloud SDK", highlight=False)
        console.print()
        return

    icon_content = icon_path.read_text(encoding="utf-8")
    term_width = console.width or 80
    lines = icon_content.split("\n")
    for line in lines:
        # Strip trailing whitespace to prevent terminal wrapping
        stripped = line.rstrip()
        if not stripped:
            console.print()
            continue
        # Truncate to terminal width
        if len(stripped) > term_width - 1:
            stripped = stripped[: term_width - 1]
        text = Text(stripped)
        # Find where ▓ text starts to split icon vs text regions
        text_start = stripped.find("\u2593")  # ▓
        if text_start == -1:
            text_start = len(stripped)
        for i, char in enumerate(stripped):
            if char.isspace():
                continue
            elif i < text_start:
                # Icon region (▒ characters) → bright cyan
                text.stylize("bright_cyan", i, i + 1)
            else:
                # Text region (▓ characters + label) → dim white
                text.stylize("dim white", i, i + 1)
        console.print(text)
    console.print()  # trailing blank line


# ============================================================================
# Status messages
# ============================================================================

def success(msg: str) -> None:
    """Print a green success message with check mark."""
    console.print(f"[bold green]\u2713[/bold green] {msg}")


def error(msg: str, details: Optional[str] = None) -> None:
    """Print a red error message with X mark."""
    console.print(f"[bold red]\u2717[/bold red] {msg}")
    if details:
        console.print(f"  [dim]{details}[/dim]")


def warn(msg: str) -> None:
    """Print a yellow warning message."""
    console.print(f"[bold yellow]\u26a0[/bold yellow]  {msg}")


def info(msg: str) -> None:
    """Print a blue info message."""
    console.print(f"[bold blue]\u2139[/bold blue]  {msg}")


# ============================================================================
# Tables
# ============================================================================

def print_table(
    headers: List[str],
    rows: List[List[str]],
    title: Optional[str] = None,
) -> None:
    """Print a Rich table with rounded borders and cyan headers.

    Args:
        headers: Column header labels.
        rows: List of row data (each row is a list of strings).
        title: Optional table title.
    """
    table = Table(
        title=title,
        box=box.ROUNDED,
        show_header=True,
        header_style="bold cyan",
    )
    for header in headers:
        table.add_column(header)
    for row in rows:
        table.add_row(*row)
    console.print(table)


# ============================================================================
# Panel
# ============================================================================

def print_panel(
    content: str,
    title: Optional[str] = None,
    border_style: str = "blue",
) -> None:
    """Print content inside a Rich panel.

    Args:
        content: Panel body text (supports Rich markup).
        title: Optional panel title.
        border_style: Border color/style.
    """
    panel = Panel(
        content,
        title=title,
        border_style=border_style,
        box=box.ROUNDED,
        padding=(1, 2),
    )
    console.print(panel)


# ============================================================================
# Key-value display
# ============================================================================

def key_value(pairs: Dict[str, str]) -> None:
    """Display key-value pairs in aligned format.

    Keys are right-aligned and styled bold cyan, values are plain.

    Args:
        pairs: Dictionary of key-value pairs to display.
    """
    if not pairs:
        return
    max_key_len = max(len(k) for k in pairs)
    for k, v in pairs.items():
        padded_key = k.rjust(max_key_len)
        console.print(f"  [bold cyan]{padded_key}[/bold cyan]  {v}")


# ============================================================================
# Code and JSON
# ============================================================================

def print_code(
    code: str,
    language: str = "python",
    line_numbers: bool = True,
) -> None:
    """Print syntax-highlighted code.

    Args:
        code: Source code string.
        language: Language for syntax highlighting.
        line_numbers: Whether to show line numbers.
    """
    syntax = Syntax(
        code,
        language,
        theme="monokai",
        line_numbers=line_numbers,
        word_wrap=True,
    )
    console.print(syntax)


def print_json(data: Any) -> None:
    """Print pretty-formatted JSON.

    Args:
        data: A dict/list or JSON string to render.
    """
    if isinstance(data, str):
        try:
            data = json.loads(data)
        except json.JSONDecodeError:
            console.print("[yellow]Invalid JSON string[/yellow]")
            return
    json_obj = RichJSON(json.dumps(data, indent=2, default=str))
    console.print(json_obj)


# ============================================================================
# QR Code
# ============================================================================

def render_qr(data: str) -> None:
    """Render a QR code in the terminal.

    Uses the ``qrcode`` package (optional dependency) with ASCII art output.
    If ``qrcode`` is not installed, falls back to displaying the data as text.

    Args:
        data: The string/URL to encode as a QR code.
    """
    try:
        import qrcode  # type: ignore[import-untyped]

        qr = qrcode.QRCode(
            version=1,
            error_correction=qrcode.constants.ERROR_CORRECT_L,
            box_size=1,
            border=1,
        )
        qr.add_data(data)
        qr.make(fit=True)
        # print_ascii writes to stdout by default
        qr.print_ascii(invert=True)
    except ImportError:
        print_panel(
            f"[bold]{data}[/bold]\n\n"
            "[dim]Install qrcode for QR rendering: pip install prismer[qr][/dim]",
            title="Scan this URL",
        )


# ============================================================================
# Spinner (context manager)
# ============================================================================

class Spinner:
    """Context manager that shows a spinner while work is in progress.

    Usage::

        with Spinner("Connecting..."):
            do_slow_thing()
    """

    def __init__(self, message: str = "Working...") -> None:
        self.message = message
        self._progress: Optional[Progress] = None
        self._task_id: Optional[int] = None

    def __enter__(self) -> "Spinner":
        self._progress = Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            console=console,
            transient=True,
        )
        self._progress.start()
        self._task_id = self._progress.add_task(self.message, total=None)
        return self

    def update(self, message: str) -> None:
        """Update the spinner message while it is active."""
        if self._progress is not None and self._task_id is not None:
            self._progress.update(self._task_id, description=message)

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        if self._progress is not None:
            self._progress.stop()


# ============================================================================
# Progress bar (context manager)
# ============================================================================

class ProgressBar:
    """Context manager that shows a progress bar for multi-step tasks.

    Usage::

        with ProgressBar(total=10, description="Processing") as pb:
            for i in range(10):
                do_step(i)
                pb.advance()
    """

    def __init__(self, total: int, description: str = "Processing") -> None:
        self.total = total
        self.description = description
        self._progress: Optional[Progress] = None
        self._task_id: Optional[int] = None

    def __enter__(self) -> "ProgressBar":
        self._progress = Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            TaskProgressColumn(),
            console=console,
        )
        self._progress.start()
        self._task_id = self._progress.add_task(self.description, total=self.total)
        return self

    def advance(self, step: int = 1, message: Optional[str] = None) -> None:
        """Advance the progress bar.

        Args:
            step: Number of steps to advance.
            message: Optional new description.
        """
        if self._progress is not None and self._task_id is not None:
            kwargs: Dict[str, Any] = {"advance": step}
            if message:
                kwargs["description"] = message
            self._progress.update(self._task_id, **kwargs)

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        if self._progress is not None:
            self._progress.stop()


# ============================================================================
# Separator
# ============================================================================

def print_separator(char: str = "\u2500", style: str = "dim") -> None:
    """Print a horizontal separator line.

    Args:
        char: Character to repeat across the terminal width.
        style: Rich style for the line.
    """
    width = console.width
    console.print(f"[{style}]{char * width}[/{style}]")


# ============================================================================
# Interactive prompts
# ============================================================================

def ask(
    question: str,
    default: Optional[str] = None,
    choices: Optional[List[str]] = None,
) -> str:
    """Ask the user for input.

    Args:
        question: The question to display.
        default: Default value if the user just presses Enter.
        choices: If provided, show numbered choices.

    Returns:
        The user's answer.
    """
    if choices:
        console.print(f"[bold blue]{question}[/bold blue]")
        for i, choice in enumerate(choices, 1):
            console.print(f"  {i}. {choice}")
        while True:
            try:
                response = Prompt.ask(
                    "Enter choice number",
                    default=str(default) if default else None,
                )
                idx = int(response) - 1
                if 0 <= idx < len(choices):
                    return choices[idx]
                console.print("[red]Invalid choice, please try again[/red]")
            except ValueError:
                console.print("[red]Please enter a valid number[/red]")
    return Prompt.ask(question, default=default)


def confirm(question: str, default: bool = False) -> bool:
    """Ask the user for yes/no confirmation.

    Args:
        question: The question to display.
        default: Default value if the user just presses Enter.

    Returns:
        True if confirmed, False otherwise.
    """
    return Confirm.ask(question, default=default)
