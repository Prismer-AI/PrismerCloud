#!/usr/bin/env python3
"""Read-only GitHub REST JSON with complete, same-host pagination."""
import argparse
import json
import os
import re
import sys
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('API redirect rejected; verify the canonical repository')


def check_url(url):
    parsed = urlsplit(url)
    if (parsed.scheme != 'https' or parsed.hostname != 'api.github.com' or
            parsed.username or parsed.password or parsed.port not in (None, 443) or
            parsed.fragment or any(ord(c) < 33 for c in url)):
        raise ValueError('only https://api.github.com URLs are accepted')


def fetch(url, token):
    check_url(url)
    headers = {'Accept': 'application/vnd.github+json', 'User-Agent': 'Prismer-GitHub-skill'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    with build_opener(NoRedirect()).open(Request(url, headers=headers), timeout=30) as response:
        raw = response.read(16_000_001)
        if len(raw) > 16_000_000:
            raise ValueError('API page too large')
        return json.loads(raw), response.headers.get('Link', '')


def read_all(url, token='', request=fetch):
    seen, result, key = set(), None, None
    while url:
        check_url(url)
        if url in seen or len(seen) >= 100:
            raise ValueError('pagination cycle/limit; no partial result returned')
        seen.add(url)
        data, links = request(url, token)
        if result is None:
            result = data
            if isinstance(data, dict):
                keys = [k for k in ('items', 'workflow_runs', 'workflows', 'check_runs', 'jobs', 'artifacts', 'secrets') if isinstance(data.get(k), list)]
                key = keys[0] if len(keys) == 1 else None
        elif isinstance(result, list) and isinstance(data, list):
            result.extend(data)
        elif key and isinstance(data, dict) and isinstance(data.get(key), list):
            result[key].extend(data[key])
        else:
            raise ValueError('inconsistent paginated response')
        next_links = re.findall(r'<([^>]+)>;\s*rel="next"', links)
        if len(next_links) > 1:
            raise ValueError('ambiguous next page')
        url = next_links[0] if next_links else ''
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('url')
    args = parser.parse_args()
    try:
        print(json.dumps(read_all(args.url, os.environ.get('GH_TOKEN') or os.environ.get('GITHUB_TOKEN', ''))))
    except (ValueError, OSError):
        print('GitHub read failed; no complete result available', file=sys.stderr)
        sys.exit(1)
