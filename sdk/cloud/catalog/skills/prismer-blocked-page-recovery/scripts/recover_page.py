#!/usr/bin/env python3
"""Find candidates for authorized public pages from third-party copies.

Ladder (cheapest first):
  1. Wayback Machine "available" API  -> dated snapshot   (provenance: snapshot)
  2. archive.today domain rotation    -> dated snapshot   (provenance: snapshot)
  3. Jina Reader (JINA_API_KEY only)  -> live re-render   (provenance: live)

Heuristics reject obvious interstitials and redirects, but cannot establish
content identity. Every result remains an unverified candidate until reviewed.

Stdlib only. Usage:
    python3 recover_page.py URL [--json] [--out FILE] [--timeout N]

Exit codes: 0 candidate found (NOT verified), 1 no candidate, 2 bad invocation.
"""
from __future__ import annotations

import argparse
import contextvars
import ipaddress
import json
import os
import re
import sys
import socket
import time
import urllib.error
import urllib.parse
import urllib.request

USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)

ARCHIVE_TODAY_HOSTS = ["archive.ph", "archive.md", "archive.li", "archive.is"]

# Titles that mean "this is not the page you asked for".
INTERSTITIAL_TITLES = (
    "just a moment",
    "redirecting",
    "google search",
    "attention required",
    "access denied",
    "are you a robot",
    "one more step",
)

# Below these floors a body is a stub or an error page, not content.
MIN_BODY_BYTES = {"wayback": 3072, "archive_today": 3072, "jina": 512}

REDIRECT_STUB_RE = re.compile(
    r'http-equiv=["\']?refresh|window\.location|location\.replace', re.IGNORECASE
)
TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)
MAX_BYTES = 4 * 1024 * 1024
DEADLINE = contextvars.ContextVar('recovery_deadline', default=None)
SERVICE_HOSTS = {'archive.org', 'web.archive.org', 'r.jina.ai', *ARCHIVE_TODAY_HOSTS}


def validate_target(url, resolve=True):
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme not in ('http', 'https') or not parsed.hostname or
            parsed.username or parsed.password or parsed.query or parsed.fragment or
            any(ord(c) < 33 or ord(c) == 127 for c in url) or
            parsed.port not in (None, 80, 443)):
        raise ValueError('only public URLs without credentials, query or fragments are accepted')
    host = parsed.hostname
    if host == 'localhost' or host.endswith(('.localhost', '.local', '.internal')) or '.' not in host:
        raise ValueError('private hostname')
    try:
        if not ipaddress.ip_address(host).is_global:
            raise ValueError('private address')
    except ValueError as exc:
        if str(exc) == 'private address':
            raise
    if resolve:
        addresses = socket.getaddrinfo(host, parsed.port or 443, type=socket.SOCK_STREAM)
        if not addresses or any(not ipaddress.ip_address(item[4][0]).is_global for item in addresses):
            raise ValueError('non-public DNS destination')


class ServiceRedirect(urllib.request.HTTPRedirectHandler):
    max_redirections = 3

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        old = urllib.parse.urlsplit(req.full_url)
        new = urllib.parse.urlsplit(newurl)
        if (new.scheme != 'https' or new.hostname not in SERVICE_HOSTS or
                new.username or new.password or new.port not in (None, 443) or
                (req.has_header('Authorization') and new.hostname != old.hostname)):
            raise ValueError('unsafe service redirect')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _request(url, timeout, headers=None):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or parsed.hostname not in SERVICE_HOSTS or parsed.username or parsed.password or parsed.port not in (None, 443):
        return 0, b'', url
    deadline = DEADLINE.get() or time.monotonic() + timeout
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        return 0, b'', url
    request = urllib.request.Request(url, headers={'User-Agent': USER_AGENT, **(headers or {})})
    # No ambient proxy forwarding; destinations and redirects remain service-bound.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), ServiceRedirect())
    try:
        with opener.open(request, timeout=min(timeout, remaining)) as response:
            body = bytearray()
            while len(body) <= MAX_BYTES:
                if time.monotonic() >= deadline:
                    return 0, b'', response.geturl()
                chunk = response.read1(min(65536, MAX_BYTES + 1 - len(body)))
                if not chunk:
                    return response.status, bytes(body), response.geturl()
                body.extend(chunk)
            return 0, b'', response.geturl()
    except (urllib.error.URLError, OSError, ValueError):
        return 0, b'', url


def _fetch(
    url: str,
    timeout: int,
    headers: dict | None = None,
    retries_on_429: int = 2,
) -> tuple[int, bytes]:
    status, body, _ = _request(url, timeout, headers)
    return status, body


def _fetch_follow(url: str, timeout: int) -> tuple[int, bytes, str]:
    """Like _fetch but also returns the final URL after redirects."""
    return _request(url, timeout)


def _page_title(body: bytes) -> str:
    m = TITLE_RE.search(body[:65536].decode("utf-8", "replace"))
    return re.sub(r"\s+", " ", m.group(1)).strip().lower() if m else ""


def validate(body: bytes, route: str, target_url: str) -> str | None:
    """Return a rejection reason, or None if the body looks like real content."""
    floor = MIN_BODY_BYTES.get(route, 3072)
    if len(body) < floor:
        return f"body_too_small:{len(body)}<{floor}"
    text = body.decode('utf-8', 'replace')
    headings = ' '.join(re.findall(r'^#{1,6}\s+(.+)$', text, re.MULTILINE))
    title = _page_title(body) + ' ' + headings.lower()
    for marker in INTERSTITIAL_TITLES:
        if marker in title:
            return f"interstitial_title:{marker!r}"
    # Redirect stub: small-ish page whose only job is bouncing back to the
    # original (blocked) host — the classic AMP-cache failure mode.
    if REDIRECT_STUB_RE.search(text):
        return 'redirect_content_requires_manual_review'
    return None


def try_wayback(url: str, timeout: int) -> dict | None:
    snap_url = None
    snap_ts = None
    discovery = "https://archive.org/wayback/available?url=" + urllib.parse.quote(url, safe="")
    status, raw = _fetch(discovery, timeout)
    if status == 200:
        try:
            closest = json.loads(raw).get("archived_snapshots", {}).get("closest", {})
        except (json.JSONDecodeError, AttributeError):
            closest = {}
        if isinstance(closest, dict) and closest.get("available") and isinstance(closest.get("url"), str):
            snap_url = closest["url"].replace(
                "http://web.archive.org", "https://web.archive.org"
            )
            snap_ts = closest.get("timestamp")
    if snap_url is None:
        # Discovery API is rate-limited far more aggressively than snapshot
        # serving. Fall back to the redirect form: /web/2/<url> bounces to
        # the newest snapshot if one exists (404 page otherwise).
        snap_url = "https://web.archive.org/web/2/" + url
    status, body, final_url = _fetch_follow(snap_url, timeout)
    if status != 200 or validate(body, "wayback", url):
        return None
    m = re.search(r"/web/(\d{14})(?:[a-z_]+)?/", final_url)
    snap_ts = m.group(1) if m else None
    if not snap_ts or urllib.parse.urlsplit(final_url).hostname != 'web.archive.org':
        return None
    return {
        "route": "wayback",
        "provenance": "snapshot",
        "snapshot_timestamp": snap_ts,
        "source_url": final_url,
        "body": body,
    }


def try_archive_today(url: str, timeout: int) -> dict | None:
    for host in ARCHIVE_TODAY_HOSTS:
        fetch_url = f"https://{host}/newest/{url}"
        status, body, final_url = _fetch_follow(fetch_url, timeout)
        if status != 200:
            continue
        if validate(body, "archive_today", url):
            continue  # 429 bodies and interstitials land here
        if '/newest/' in final_url or urllib.parse.urlsplit(final_url).hostname not in ARCHIVE_TODAY_HOSTS:
            continue
        stamp = re.search(r'/(\d{14})(?:/|$)', urllib.parse.urlsplit(final_url).path)
        return {
            "route": f"archive_today:{host}",
            "provenance": "snapshot" if stamp else "snapshot-undated",
            "snapshot_timestamp": stamp.group(1) if stamp else None,
            "source_url": final_url,
            "body": body,
        }
    return None


def try_jina(url: str, timeout: int) -> dict | None:
    key = os.environ.get("JINA_API_KEY")
    if not key:
        return None
    status, body = _fetch(
        "https://r.jina.ai/" + url, timeout, headers={"Authorization": f"Bearer {key}"}
    )
    if status != 200 or validate(body, "jina", url):
        return None
    return {
        "route": "jina_reader",
        "provenance": "live",
        "snapshot_timestamp": None,
        "source_url": "https://r.jina.ai/" + url,
        "body": body,
    }


ROUTES = (try_wayback, try_archive_today, try_jina)


def recover(url: str, timeout: int = 25) -> dict | None:
    validate_target(url)
    if not 1 <= timeout <= 120:
        raise ValueError('timeout must be 1..120 seconds')
    token = DEADLINE.set(time.monotonic() + timeout)
    try:
        for route_fn in ROUTES:
            if time.monotonic() >= DEADLINE.get():
                break
            try:
                result = route_fn(url, timeout)
            except (ValueError, TypeError, OSError):
                continue
            if result:
                result.update(status='candidate', verified=False)
                return result
        return None
    finally:
        DEADLINE.reset(token)


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Recover a blocked / paywalled / WAF'd page from third-party copies."
    )
    ap.add_argument("url")
    ap.add_argument("--json", action="store_true", help="print metadata as JSON")
    ap.add_argument("--out", help="write recovered body to this file")
    ap.add_argument("--timeout", type=int, default=25)
    args = ap.parse_args()

    if not args.url.startswith(("http://", "https://")):
        print("error: URL must start with http:// or https://", file=sys.stderr)
        return 2

    try:
        result = recover(args.url, args.timeout)
    except (ValueError, OSError) as exc:
        print('error: ' + str(exc), file=sys.stderr)
        return 2
    if not result:
        msg = {"recovered": False, "url": args.url,
               "hint": "No archive copy found. Try the API-first pivot or the browser tool."}
        print(json.dumps(msg, indent=2) if args.json else msg["hint"], file=sys.stderr)
        return 1

    body = result.pop("body")
    result.update({"recovered": False, "url": args.url, "body_bytes": len(body),
                   "requires_identity_review": True})
    if args.out:
        with open(args.out, "xb") as fh:
            fh.write(body)
        result["saved_to"] = args.out

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        for k, v in result.items():
            print(f"{k}: {v}")
        if not args.out:
            print("\n--- body (first 2000 chars) ---")
            print(body[:2000].decode("utf-8", "replace"))
    if result["provenance"] == "snapshot":
        print(
            "\nNOTE: this is an ARCHIVED SNAPSHOT, not the live page. "
            "Cite it with its timestamp.",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
