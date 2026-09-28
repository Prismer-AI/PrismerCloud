#!/usr/bin/env python3
"""Bounded, version-preserving arXiv Atom search (stdlib only)."""
import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

NS = {"a": "http://www.w3.org/2005/Atom"}
ID = re.compile(r"(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?/\d{7})(?:v[1-9]\d*)?\Z")
SORTS = {"relevance": "relevance", "date": "submittedDate", "updated": "lastUpdatedDate"}


def parse_feed(data):
    root = ET.fromstring(data)
    if root.tag != "{" + NS["a"] + "}feed":
        raise ValueError("response is not an Atom feed")
    papers = []
    for entry in root.findall("a:entry", NS):
        def field(name, default="unknown"):
            return " ".join((entry.findtext("a:" + name, default, NS) or default).split())
        raw_id = field("id", "")
        if "/api/errors" in raw_id:
            raise ValueError("arXiv API error: " + field("summary"))
        parsed = urllib.parse.urlsplit(raw_id)
        if parsed.hostname not in {"arxiv.org", "www.arxiv.org", "export.arxiv.org"} or not parsed.path.startswith("/abs/"):
            raise ValueError("entry has an invalid arXiv identifier")
        paper_id = parsed.path.removeprefix("/abs/")
        if not ID.fullmatch(paper_id):
            raise ValueError("entry has an invalid arXiv identifier")
        papers.append({
            "id": paper_id, "title": field("title"),
            "published": field("published"), "updated": field("updated"),
            "authors": [a.findtext("a:name", "unknown", NS) for a in entry.findall("a:author", NS)],
            "categories": [c.get("term", "") for c in entry.findall("a:category", NS)],
            "abstract": field("summary", ""),
            "abs_url": "https://arxiv.org/abs/" + paper_id,
            "pdf_url": "https://arxiv.org/pdf/" + paper_id,
        })
    return papers


def search(query=None, author=None, category=None, ids=None, max_results=5, sort="relevance", start=0, as_json=False):
    if not isinstance(max_results, int) or not 1 <= max_results <= 100:
        raise ValueError("max_results must be between 1 and 100")
    if not isinstance(start, int) or start < 0 or sort not in SORTS:
        raise ValueError("invalid start or sort")
    params = {"max_results": max_results, "start": start, "sortBy": SORTS[sort], "sortOrder": "descending"}
    if ids:
        values = [value.strip() for value in ids.split(",")]
        if len(values) > 100 or not all(ID.fullmatch(value) for value in values):
            raise ValueError("invalid arXiv id list")
        params["id_list"] = ",".join(values)
    else:
        parts = [prefix + ":" + value for prefix, value in [("all", query), ("au", author), ("cat", category)] if value]
        if not parts:
            raise ValueError("provide a query, --author, --category, or --id")
        params["search_query"] = " AND ".join(parts)
    url = "https://export.arxiv.org/api/query?" + urllib.parse.urlencode(params)
    request = urllib.request.Request(url, headers={"User-Agent": "PrismerResearch/1.0"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                data = response.read(8 * 1024 * 1024 + 1)
            if len(data) > 8 * 1024 * 1024:
                raise ValueError("arXiv response exceeds 8 MiB")
            break
        except urllib.error.HTTPError as exc:
            if attempt == 2 or exc.code not in {429, 500, 502, 503, 504}:
                raise
            time.sleep(3 * (attempt + 1))
    papers = parse_feed(data)
    if as_json:
        print(json.dumps({"papers": papers, "start": start, "count": len(papers)}, ensure_ascii=False))
    elif not papers:
        print("No results found.")
    else:
        for index, paper in enumerate(papers, start=1):
            print(f"{index}. {paper['title']}\n   ID: {paper['id']} | Published: {paper['published']} | Updated: {paper['updated']}")
            print("   Authors: " + ", ".join(paper["authors"]))
            print("   Categories: " + ", ".join(paper["categories"]))
            print("   Abstract: " + paper["abstract"])
            print(f"   Links: {paper['abs_url']} | {paper['pdf_url']}\n")
    return papers


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("query", nargs="?")
    parser.add_argument("--author")
    parser.add_argument("--category")
    parser.add_argument("--id", dest="ids")
    parser.add_argument("--max", type=int, default=5, dest="max_results")
    parser.add_argument("--start", type=int, default=0)
    parser.add_argument("--sort", choices=SORTS, default="relevance")
    parser.add_argument("--json", action="store_true", dest="as_json")
    args = parser.parse_args()
    try:
        search(**vars(args))
    except (ValueError, ET.ParseError, OSError) as exc:
        print(f"arxiv search failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
