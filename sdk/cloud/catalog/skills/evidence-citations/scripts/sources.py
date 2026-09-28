#!/usr/bin/env python3
"""Citation ledger for grounded answers and documents.

Owns the ``url -> [n]`` mapping used by the ``grounded-citations`` skill.
Ids are assigned at retrieval time and never change, so a draft's ``[3]``
always resolves to the same page.  The model only ever emits integers the
ledger handed it, which is what makes the citations verifiable.

Subcommands
-----------
  reset                            start a clean ledger
  add URL [URL ...]                register source(s), print their ids
  ingest FILE|-                    register every url found in JSON tool output
  quote ID --text T --from FILE|-  attach verbatim supporting evidence to a source
  list                             show the ledger
  render                           render a Sources block
  verify DRAFT                     check a draft's citations against the ledger

Fact-checking is evidence-backed citation: ``quote`` only accepts text that
literally appears in the fetched page text you point it at, ``verify
--evidence`` requires every cited source to carry at least one such quote, and
``render --style evidence`` prints the quotes under each source so the reader
can check the chain themselves.  Claims from model knowledge are declared with
an ``[unverified]`` marker rather than silently blended in.

Ledger path resolution (first wins):
  --ledger PATH
  $PRISMER_SCRATCH_DIR/citations.json (dispatch-isolated scratch only)
  Otherwise fail rather than share a profile-global mutable ledger.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Iterable

SCHEMA_VERSION = 1

# A citation marker in prose: [12].  Markdown links ([text](url)) and
# reference-style labels are excluded by requiring digits only and no
# following "(" or ":".
_CITE_RE = re.compile(r"\[(\d{1,4})\](?![(:])")
_SOURCES_HEADER_RE = re.compile(r"^\s*(?:#{1,6}\s*)?(?:\*\*)?sources:?(?:\*\*)?\s*$", re.IGNORECASE)
_SOURCE_LINE_RE = re.compile(r"^ {0,3}\[(\d{1,4})\][ \t]+(https?://[^\s\"'<>)\]}]+)(?:[ \t]+.*)?$")
_URL_IN_TEXT_RE = re.compile(r"https?://[^\s\"'<>)\]}]+")
_FENCE_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")
_CJK_RE = re.compile(r"[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]")
# Explicit declaration that a claim comes from model knowledge, not a source.
_UNVERIFIED_RE = re.compile(r"\[unverified\]", re.IGNORECASE)


# ---------------------------------------------------------------------------
# Ledger I/O
# ---------------------------------------------------------------------------


def resolve_ledger_path(explicit: str | None = None) -> Path:
    if explicit:
        return Path(explicit).expanduser()
    scratch = os.environ.get("PRISMER_SCRATCH_DIR", "").strip()
    if scratch and Path(scratch).is_absolute():
        return Path(scratch) / "citations.json"
    raise SystemExit("Pass --ledger with a task-specific path; no shared ledger default is allowed")


def normalize_url(url: str) -> str:
    """Canonicalize a URL for ledger identity.

    Strips the fragment and a trailing slash so ``/page``, ``/page/`` and
    ``/page#section`` are one source.  Query strings are significant and are
    kept — they usually select different content.
    """
    u = (url or "").strip()
    if "#" in u:
        u = u.split("#", 1)[0]
    stripped = u.rstrip("/")
    return stripped or u


def load_ledger(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"version": SCHEMA_VERSION, "sources": []}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        raise SystemExit(f"error: ledger at {path} is unreadable ({exc}); run `reset` to start over")
    if not isinstance(data, dict) or not isinstance(data.get("sources"), list):
        raise SystemExit(f"error: ledger at {path} has an unexpected shape; run `reset`")
    return data


def save_ledger(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".tmp{os.getpid()}")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)


class _LedgerLock:
    """Exclusive writer lock; contention times out without stealing ownership.

    Parallel subagents can share one ledger via --ledger; without a lock two
    concurrent ``add`` calls can assign the same id. A stale lock requires
    explicit recovery after confirming no writer owns it.
    """

    def __init__(self, path: Path, timeout: float = 5.0) -> None:
        self.lock_path = path.with_suffix(path.suffix + ".lock")
        self.timeout = timeout
        self.fd: int | None = None

    def __enter__(self) -> "_LedgerLock":
        self.lock_path.parent.mkdir(parents=True, exist_ok=True)
        deadline = time.monotonic() + self.timeout
        while True:
            try:
                self.fd = os.open(str(self.lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                return self
            except FileExistsError:
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"ledger is locked: {self.lock_path}")
                time.sleep(0.05)

    def __exit__(self, *_exc: object) -> None:
        if self.fd is not None:
            try:
                owned = os.fstat(self.fd)
                current = self.lock_path.stat(follow_symlinks=False)
                if (owned.st_dev, owned.st_ino) == (current.st_dev, current.st_ino):
                    self.lock_path.unlink()
            except FileNotFoundError:
                pass
            finally:
                os.close(self.fd)
                self.fd = None


# ---------------------------------------------------------------------------
# Core operations
# ---------------------------------------------------------------------------


def _by_url(sources: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {s["url"]: s for s in sources}


def add_sources(
    path: Path,
    urls: Iterable[str],
    title: str | None = None,
    accessed: str | None = None,
) -> list[dict[str, Any]]:
    """Register urls, returning their ledger entries (existing or new)."""
    urls = [u for u in (str(u).strip() for u in urls) if u]
    if not urls:
        return []
    with _LedgerLock(path):
        data = load_ledger(path)
        sources = data["sources"]
        index = _by_url(sources)
        out: list[dict[str, Any]] = []
        changed = False
        for raw in urls:
            key = normalize_url(raw)
            existing = index.get(key)
            if existing is not None:
                if title and not existing.get("title"):
                    existing["title"] = title
                    changed = True
                out.append(existing)
                continue
            entry = {
                "id": len(sources) + 1,
                "url": key,
                "title": (title or "").strip(),
                "accessed": accessed or time.strftime("%Y-%m-%d"),
            }
            sources.append(entry)
            index[key] = entry
            out.append(entry)
            changed = True
        if changed:
            save_ledger(path, data)
    return out


def urls_from_json(payload: Any) -> list[tuple[str, str]]:
    """Walk arbitrary JSON tool output collecting (url, title) pairs.

    Handles web_search (``data.web[]``), web_extract (``results[]``) and any
    other nesting, in document order, deduped.
    """
    found: list[tuple[str, str]] = []
    seen: set[str] = set()

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            url = node.get("url") or node.get("link") or node.get("source_url")
            if isinstance(url, str) and url.startswith(("http://", "https://")):
                key = normalize_url(url)
                if key not in seen:
                    seen.add(key)
                    raw_title = node.get("title") or node.get("name") or ""
                    found.append((url, raw_title if isinstance(raw_title, str) else ""))
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(payload)
    return found


# ---------------------------------------------------------------------------
# Evidence quotes (fact-checking)
# ---------------------------------------------------------------------------


def _normalize_ws(text: str) -> str:
    """Collapse all whitespace runs to single spaces for verbatim matching."""
    return " ".join((text or "").split())


# Markdown artifacts that retrieval tools inject into otherwise-identical prose.
# ``web_extract`` returns markdown, so the most citation-worthy sentences are
# exactly the ones carrying inline links and emphasis around terms:
#   "including _[ERAP1](https://…/erap1/)_, _[IL1A](…)_, have also been…"
# reads identically to the page a human sees.  Matching has to see through that
# markup, or the skill pushes the agent toward weaker evidence fragments.
_MD_LINK_RE = re.compile(r"\[([^\]]*)\]\((?:[^()\s]|\([^()]*\))*\)")
_MD_NOISE_RE = re.compile(r"[*_`~]|\\(?=[^\w\s])")


def _match_key(text: str) -> str:
    """Canonicalize text for verbatim comparison.

    Whitespace-, case-, and markdown-insensitive: inline links collapse to
    their label, emphasis/code markers and backslash escapes are dropped.  The
    stored quote keeps whatever the caller passed, so the rendered evidence
    block shows clean prose rather than extractor artifacts.
    """
    collapsed = _MD_LINK_RE.sub(r"\1", text or "")
    return _normalize_ws(_MD_NOISE_RE.sub("", collapsed)).casefold()


def quote_in_evidence(quote: str, evidence: str) -> bool:
    """True when ``quote`` appears verbatim in the fetched ``evidence`` text,
    ignoring whitespace, case, and markdown markup on either side."""
    q = _match_key(quote)
    return bool(q) and q in _match_key(evidence)


def attach_quote(path: Path, source_id: int, quote: str, evidence: str) -> dict[str, Any]:
    """Attach a verbatim quote to a ledger entry after checking it against
    the evidence text.  Raises SystemExit on unknown id or non-verbatim text —
    a quote the page does not contain is exactly the fabrication this guards
    against."""
    quote = (quote or "").strip()
    if len(_normalize_ws(quote).split()) < 3 and len(_CJK_RE.findall(quote)) < 6:
        raise SystemExit("error: quote too short — use at least 3 words or 6 CJK characters")
    if not quote_in_evidence(quote, evidence):
        raise SystemExit(
            "error: quote not found verbatim in the evidence text — "
            "copy the exact wording from the fetched page, do not paraphrase"
        )
    with _LedgerLock(path):
        data = load_ledger(path)
        entry = next((s for s in data["sources"] if s["id"] == source_id), None)
        if entry is None:
            raise SystemExit(f"error: no source [{source_id}] in the ledger")
        quotes = entry.setdefault("quotes", [])
        norm = _match_key(quote)
        if not any(_match_key(q.get("text", "")) == norm for q in quotes):
            quotes.append({"text": quote, "added": time.strftime("%Y-%m-%d")})
            save_ledger(path, data)
    return entry


def render_sources(
    sources: list[dict[str, Any]],
    style: str = "markdown",
    only: set[int] | None = None,
) -> str:
    picked = [s for s in sources if only is None or s["id"] in only]
    picked.sort(key=lambda s: s["id"])
    if not picked:
        return ""
    lines: list[str] = []
    if style == "bibtex":
        for s in picked:
            key = f"source{s['id']}"
            title = s.get("title") or s["url"]
            lines.append(
                "@misc{%s,\n  title = {%s},\n  howpublished = {\\url{%s}},\n  note = {Accessed %s}\n}"
                % (key, _bibtex_escape(title), _bibtex_escape(s["url"]), _bibtex_escape(s.get("accessed", "")))
            )
        return "\n".join(lines)
    if style == "footnotes":
        for s in picked:
            title = s.get("title")
            suffix = f" — {title}" if title else ""
            lines.append(f"[^{s['id']}]: {s['url']}{suffix}")
        return "\n".join(lines)
    header = "Sources:" if style == "plain" else "## Sources"
    lines.append(header)
    if style != "plain":
        lines.append("")
    for s in picked:
        title = s.get("title")
        suffix = f" — {title}" if title else ""
        lines.append(f"[{s['id']}] {s['url']}{suffix}")
        if style == "evidence":
            for q in s.get("quotes", []):
                lines.append(f'    > "{q.get("text", "")}"')
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------


def _bibtex_escape(value: str) -> str:
    escapes = {"\\": r"\textbackslash{}", "{": r"\{", "}": r"\}",
               "%": r"\%", "&": r"\&", "#": r"\#", "_": r"\_",
               "$": r"\$", "~": r"\textasciitilde{}", "^": r"\textasciicircum{}"}
    return "".join(escapes.get(char, char) for char in str(value).replace("\n", " "))


def _prose_lines(lines: list[str], include_indented: bool = False) -> list[tuple[int, str]]:
    result = []
    fence = ""
    for index, line in enumerate(lines):
        match = _FENCE_RE.match(line)
        if fence:
            if match and match[1][0] == fence[0] and len(match[1]) >= len(fence) and not match[2].strip():
                fence = ""
            continue
        if match:
            fence = match[1]
        elif include_indented or not line.startswith(("    ", "\t")):
            result.append((index, line))
    return result


def _sources_tail(text: str) -> tuple[int | None, dict[int, str]]:
    """Only an unambiguous terminal bibliography may be replaced."""
    lines = text.splitlines()
    headers = [i for i, line in _prose_lines(lines) if _SOURCES_HEADER_RE.match(line)]
    if len(headers) != 1:
        return None, {}
    index = headers[0]
    listed = {}
    for line in lines[index + 1:]:
        if not line.strip():
            continue
        match = _SOURCE_LINE_RE.match(line)
        if match:
            sid = int(match[1])
            if sid in listed:
                return None, {}
            listed[sid] = match[2]
        elif listed and line.startswith("    > "):
            continue
        else:
            return None, {}
    return (index, listed) if listed else (None, {})


def _split_draft(text: str) -> tuple[str, dict[int, str]]:
    index, listed = _sources_tail(text)
    lines = text.splitlines()
    return "\n".join(line for _, line in _prose_lines(lines[:index])), listed


def _strip_sources_block(text: str) -> str:
    """Return the draft with its trailing Sources block removed.

    Ambiguous, non-terminal and fenced headers are preserved verbatim.
    """
    header_idx, _ = _sources_tail(text)
    if header_idx is None:
        return text
    return "\n".join(text.splitlines()[:header_idx])


def _sentences(prose: str) -> list[str]:
    """Rough sentence split over prose lines, skipping headings and tables."""
    out: list[str] = []
    for line in prose.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or stripped.startswith("|"):
            continue
        if stripped.startswith(">"):
            stripped = stripped.lstrip("> ").strip()
        for part in re.findall(r".+?(?:[.!?。！？](?:\[\d{1,4}\]|\[unverified\])*|$)", stripped):
            part = part.strip()
            if len(part.split()) >= 4 or len(_CJK_RE.findall(part)) >= 4:
                out.append(part)
    return out


def verify_draft(
    draft_path: Path,
    sources: list[dict[str, Any]],
    strict: bool = False,
    min_coverage: float | None = None,
    require_evidence: bool = False,
) -> tuple[int, list[str], list[str]]:
    """Return (exit_code, errors, warnings)."""
    text = draft_path.read_text(encoding="utf-8")
    prose, listed = _split_draft(text)
    by_id = {s["id"]: s for s in sources}

    errors: list[str] = []
    warnings: list[str] = []
    # Containers (quotes/lists) can define document-wide Markdown references.
    # Reject numeric definitions conservatively, while ignoring fenced examples.
    definitions = "\n".join(line for _, line in _prose_lines(text.splitlines(), include_indented=True))
    if re.search(r"\[\s*\d{1,4}\s*\]\s*:", definitions):
        errors.append("numeric reference definition can redirect a citation; use plain [n] citations and Sources entries")
    if re.search(r"\[\^\w+\]|\\cite\w*\{", prose):
        errors.append("unsupported citation format: verify a numeric [n] Markdown draft before export")
    if min_coverage is not None and not 0 <= min_coverage <= 1:
        errors.append("min-coverage must be between 0 and 1")

    cited = [int(m) for m in _CITE_RE.findall(prose)]
    cited_set = set(cited)

    unknown = sorted(i for i in cited_set if i not in by_id)
    if unknown:
        errors.append(
            "citations not in the ledger (hallucinated or renumbered): "
            + ", ".join(f"[{i}]" for i in unknown)
        )

    if cited_set and not listed:
        errors.append("draft cites sources but has no `Sources:` block — run `render --cited-in`")

    missing_from_block = sorted(cited_set - set(listed)) if listed else []
    if missing_from_block:
        errors.append(
            "cited but absent from the Sources block: "
            + ", ".join(f"[{i}]" for i in missing_from_block)
        )

    for sid, url in sorted(listed.items()):
        entry = by_id.get(sid)
        if entry is None:
            errors.append(f"Sources block lists [{sid}], which is not in the ledger")
            continue
        if normalize_url(url) != entry["url"]:
            errors.append(
                f"Sources block URL for [{sid}] does not match the ledger "
                f"(block: {url} / ledger: {entry['url']}) — re-run `render`"
            )

    extra_in_block = sorted(set(listed) - cited_set)
    if extra_in_block:
        warnings.append(
            "listed in Sources but never cited inline: "
            + ", ".join(f"[{i}]" for i in extra_in_block)
        )

    registered_uncited = sorted(set(by_id) - cited_set)
    if registered_uncited:
        warnings.append(
            "registered in the ledger but not cited in this draft: "
            + ", ".join(f"[{i}]" for i in registered_uncited)
        )

    sentences = _sentences(prose)
    cited_sentences = [s for s in sentences if _CITE_RE.search(s)]
    unverified_sentences = [s for s in sentences if _UNVERIFIED_RE.search(s)]
    covered = [s for s in sentences if _CITE_RE.search(s) or _UNVERIFIED_RE.search(s)]
    coverage = (len(covered) / len(sentences)) if sentences else 0.0
    if min_coverage is not None and not sentences:
        errors.append("citation coverage cannot be measured: no prose sentences")
    if min_coverage is not None and sentences and coverage < min_coverage:
        errors.append(
            f"citation coverage {coverage:.0%} is below the required {min_coverage:.0%} "
            f"({len(covered)}/{len(sentences)} sentences cited or marked [unverified])"
        )

    if require_evidence:
        unevidenced = sorted(
            i for i in cited_set if i in by_id and not by_id[i].get("quotes")
        )
        if unevidenced:
            errors.append(
                "cited sources carry no verbatim evidence quote (run `quote` with the "
                "fetched page text): " + ", ".join(f"[{i}]" for i in unevidenced)
            )

    over_cited = [s for s in sentences if len(_CITE_RE.findall(s)) > 3]
    if over_cited:
        warnings.append(f"{len(over_cited)} sentence(s) carry more than 3 citations")

    code = 1 if errors else (1 if (strict and warnings) else 0)
    quoted = sum(1 for s in sources if s.get("quotes"))
    stats = (
        f"{len(sentences)} prose sentence(s), {len(covered)} with declared provenance "
        f"({coverage:.0%}) — {len(cited_sentences)} cited, "
        f"{len(unverified_sentences)} marked [unverified] (a sentence may be both); "
        f"{len(cited_set)} distinct source(s) cited, "
        f"{len(by_id)} in ledger ({quoted} with evidence quotes)"
    )
    warnings.insert(0, f"stats: {stats}")
    return code, errors, warnings


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _parse_only(spec: str | None) -> set[int] | None:
    if not spec:
        return None
    out: set[int] = set()
    for chunk in spec.replace(" ", "").split(","):
        if not chunk:
            continue
        if "-" in chunk:
            lo, _, hi = chunk.partition("-")
            out.update(range(int(lo), int(hi) + 1))
        else:
            out.add(int(chunk))
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="sources.py", description="Citation ledger for grounded answers and documents."
    )
    parser.add_argument("--ledger", help="ledger file path (overrides env / default)")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("reset", help="start a clean ledger")

    p_add = sub.add_parser("add", help="register source url(s), print their ids")
    p_add.add_argument("urls", nargs="+")
    p_add.add_argument("--title", help="title for the source (single-url calls)")
    p_add.add_argument("--accessed", help="access date (default: today)")
    p_add.add_argument("--json", action="store_true", help="emit JSON instead of ids")

    p_ing = sub.add_parser("ingest", help="register every url in JSON tool output")
    p_ing.add_argument("file", help="JSON file, or - for stdin")

    p_q = sub.add_parser("quote", help="attach verbatim supporting evidence to a source")
    p_q.add_argument("id", type=int, help="ledger id of the source the quote supports")
    p_q.add_argument("--text", required=True, help="the exact quote, copied from the page")
    p_q.add_argument(
        "--from",
        dest="evidence",
        required=True,
        help="file with the fetched page text (or - for stdin) the quote must appear in",
    )

    p_list = sub.add_parser("list", help="show the ledger")
    p_list.add_argument("--json", action="store_true")

    p_render = sub.add_parser("render", help="render a Sources block")
    p_render.add_argument(
        "--style", default="markdown", choices=["markdown", "plain", "footnotes", "bibtex", "evidence"]
    )
    p_render.add_argument("--only", help="ids to include, e.g. 1,3,5-7")
    p_render.add_argument("--cited-in", help="include only ids cited in this draft file")
    p_render.add_argument(
        "--replace-in",
        help="rewrite this draft's Sources block in place (implies --cited-in on it)",
    )

    p_ver = sub.add_parser("verify", help="check a draft's citations against the ledger")
    p_ver.add_argument("draft")
    p_ver.add_argument("--strict", action="store_true", help="treat warnings as failures")
    p_ver.add_argument("--min-coverage", type=float, help="required cited-sentence share, e.g. 0.5")
    p_ver.add_argument(
        "--evidence",
        action="store_true",
        help="require every cited source to carry at least one verbatim quote",
    )

    args = parser.parse_args(argv)
    path = resolve_ledger_path(args.ledger)

    if args.cmd == "reset":
        with _LedgerLock(path):
            save_ledger(path, {"version": SCHEMA_VERSION, "sources": []})
        print(f"ledger reset: {path}")
        return 0

    if args.cmd == "add":
        title = args.title if len(args.urls) == 1 else None
        entries = add_sources(path, args.urls, title=title, accessed=args.accessed)
        if args.json:
            print(json.dumps(entries, indent=2, ensure_ascii=False))
        else:
            for e in entries:
                print(f"[{e['id']}] {e['url']}")
        return 0

    if args.cmd == "ingest":
        raw = sys.stdin.read() if args.file == "-" else Path(args.file).read_text(encoding="utf-8")
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            print(f"error: input is not valid JSON ({exc})", file=sys.stderr)
            return 2
        pairs = urls_from_json(payload)
        if not pairs:
            print("no urls found in input", file=sys.stderr)
            return 1
        for url, title in pairs:
            entry = add_sources(path, [url], title=title or None)[0]
            print(f"[{entry['id']}] {entry['url']}")
        return 0

    if args.cmd == "quote":
        raw = (
            sys.stdin.read()
            if args.evidence == "-"
            else Path(args.evidence).read_text(encoding="utf-8")
        )
        entry = attach_quote(path, args.id, args.text, raw)
        print(f"[{entry['id']}] evidence attached ({len(entry.get('quotes', []))} quote(s))")
        return 0

    data = load_ledger(path)
    sources = sorted(data["sources"], key=lambda s: s["id"])

    if args.cmd == "list":
        if args.json:
            print(json.dumps(sources, indent=2, ensure_ascii=False))
        elif not sources:
            print(f"ledger is empty: {path}")
        else:
            for s in sources:
                title = f"  {s['title']}" if s.get("title") else ""
                nq = len(s.get("quotes", []))
                mark = f"  ({nq} quote{'s' if nq != 1 else ''})" if nq else ""
                print(f"[{s['id']}] {s['url']}{title}{mark}")
        return 0

    if args.cmd == "render":
        only = _parse_only(args.only)
        if args.replace_in:
            target = Path(args.replace_in)
            if args.style not in {"markdown", "plain", "evidence"}:
                parser.error("--replace-in requires a numeric Markdown Sources style; export other formats separately")
            with _LedgerLock(target):
                original = target.read_text(encoding="utf-8")
                prose, _ = _split_draft(original)
                cited = {int(m) for m in _CITE_RE.findall(prose)}
                selected = cited if only is None else (only & cited)
                current_sources = sorted(load_ledger(path)["sources"], key=lambda s: s["id"])
                block = render_sources(current_sources, style=args.style, only=selected)
                if not block:
                    print("no sources to render", file=sys.stderr)
                    return 1
                body = _strip_sources_block(original)
                if any(_SOURCES_HEADER_RE.match(line) for _, line in _prose_lines(body.splitlines())):
                    parser.error("ambiguous or non-terminal Sources section; draft left unchanged")
                temporary = None
                try:
                    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=target.parent, delete=False) as handle:
                        temporary = Path(handle.name)
                        handle.write(body.rstrip("\n") + "\n\n" + block + "\n")
                    temporary.chmod(target.stat().st_mode & 0o777)
                    os.replace(temporary, target)
                finally:
                    if temporary is not None:
                        temporary.unlink(missing_ok=True)
            print(f"Sources block rewritten in {target}")
            return 0
        if args.cited_in:
            draft = Path(args.cited_in).read_text(encoding="utf-8")
            prose, _ = _split_draft(draft)
            cited = {int(m) for m in _CITE_RE.findall(prose)}
            only = cited if only is None else (only & cited)
        block = render_sources(sources, style=args.style, only=only)
        if not block:
            print("no sources to render", file=sys.stderr)
            return 1
        print(block)
        return 0

    if args.cmd == "verify":
        draft_path = Path(args.draft)
        if not draft_path.is_file():
            print(f"error: no such draft: {draft_path}", file=sys.stderr)
            return 2
        code, errors, warnings = verify_draft(
            draft_path,
            sources,
            strict=args.strict,
            min_coverage=args.min_coverage,
            require_evidence=args.evidence,
        )
        for w in warnings:
            prefix = "info" if w.startswith("stats: ") else "warn"
            print(f"{prefix}: {w}")
        for e in errors:
            print(f"FAIL: {e}", file=sys.stderr)
        print("citations OK" if code == 0 else "verification failed")
        return code

    return 2


if __name__ == "__main__":
    sys.exit(main())
