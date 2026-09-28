#!/usr/bin/env python3
"""Read-only structural wiki lint; requires PyYAML, never edits user pages."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys


def lint(root):
    import yaml
    root = Path(root).resolve(strict=True)
    issues = []
    pages = {}
    required = {"title", "created", "updated", "type", "tags", "sources"}
    for file in root.rglob("*.md"):
        relative = file.relative_to(root).as_posix()
        if not file.resolve().is_relative_to(root):
            issues.append({"path": relative, "error": "symlink escapes wiki root"})
            continue
        if file.is_symlink() or relative.startswith("_archive/"):
            continue
        if relative.split("/")[0] not in {"entities", "concepts", "comparisons", "queries", "raw"}:
            continue
        text = file.read_text(encoding="utf-8")
        match = re.match(r"\A---\r?\n(.*?)\r?\n---(?:\r?\n|$)", text, re.S)
        try:
            metadata = yaml.safe_load(match[1]) if match else None
            if not isinstance(metadata, dict):
                raise ValueError("missing YAML mapping frontmatter")
        except (yaml.YAMLError, ValueError) as exc:
            issues.append({"path": relative, "error": str(exc)})
            continue
        body = text[match.end():]
        if relative.startswith("raw/"):
            if metadata.get("sha256") != hashlib.sha256(body.encode()).hexdigest():
                issues.append({"path": relative, "error": "raw body hash mismatch"})
            continue
        missing = sorted(required - metadata.keys())
        if missing:
            issues.append({"path": relative, "error": "missing fields: " + ", ".join(missing)})
        if not isinstance(metadata.get("tags"), list) or not isinstance(metadata.get("sources"), list):
            issues.append({"path": relative, "error": "tags and sources must be lists"})
        for source in metadata.get("sources", []) if isinstance(metadata.get("sources"), list) else []:
            target = (root / str(source)).resolve()
            if not target.is_relative_to(root) or not target.is_file():
                issues.append({"path": relative, "error": "missing or outside source: " + str(source)})
        pages[relative.removesuffix(".md")] = body
    by_name = {}
    for name in pages:
        by_name.setdefault(Path(name).name, []).append(name)
    inbound = {name: 0 for name in pages}
    for name, body in pages.items():
        for raw_link in re.findall(r"(?<!!)\[\[([^\]]+)\]\]", body):
            target = raw_link.split("|", 1)[0].split("#", 1)[0].removesuffix(".md")
            if not target:
                continue
            matches = [target] if target in pages else by_name.get(target, [])
            if len(matches) != 1:
                issues.append({"path": name + ".md", "error": "broken or ambiguous link: " + target})
            elif matches[0] != name:
                inbound[matches[0]] += 1
    index = root / "index.md"
    index_text = index.read_text(encoding="utf-8") if index.is_file() and index.resolve().is_relative_to(root) else ""
    index_links = {link.split("|", 1)[0].split("#", 1)[0].removesuffix(".md") for link in re.findall(r"\[\[([^\]]+)\]\]", index_text)}
    for name in pages:
        if name not in index_links and not (len(by_name[Path(name).name]) == 1 and Path(name).name in index_links):
            issues.append({"path": name + ".md", "error": "not listed in index"})
    return {"ok": not issues, "pages": len(pages), "issues": issues,
            "orphans": [name for name, count in inbound.items() if count == 0 and len(pages) > 1],
            "limits": ["No remote freshness, semantic contradiction, tag-taxonomy or factual verification"]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    try:
        result = lint(args.root)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        sys.exit(0 if result["ok"] else 1)
    except (ImportError, OSError) as exc:
        parser.exit(2, f"wiki lint unavailable: {exc}\n")
