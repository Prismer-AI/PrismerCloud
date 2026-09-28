#!/usr/bin/env python3
"""Bounded Tenor search/download; credential stays out of command arguments."""
import argparse
import json
import os
from pathlib import Path
import struct
import sys
from urllib.parse import urlencode, urlparse
from urllib.request import Request, build_opener, HTTPRedirectHandler

MAX_GIF = 20 * 1024 * 1024


def validate_media_url(url):
    parsed = urlparse(url)
    if parsed.scheme != 'https' or parsed.hostname not in ('media.tenor.com', 'c.tenor.com') or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise ValueError('Untrusted media URL')
    return url


def validate_gif(data):
    if len(data) < 14 or data[:6] not in (b'GIF87a', b'GIF89a') or data[-1:] != b';':
        raise ValueError('Invalid GIF payload')
    width, height = struct.unpack('<HH', data[6:10])
    if not width or not height or width * height > 40_000_000:
        raise ValueError('GIF dimensions exceed limit')
    return data


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('Redirects are not accepted')


def fetch(url, limit, mime):
    # Do not include exception URLs in errors: search URLs contain the API key.
    try:
        with build_opener(NoRedirect()).open(Request(url, headers={'Accept': mime}), timeout=20) as response:
            if response.status != 200 or response.headers.get_content_type() != mime:
                raise ValueError('Unexpected HTTP response or MIME')
            payload = response.read(limit + 1)
            if len(payload) > limit:
                raise ValueError('Response exceeds size limit')
            return payload
    except Exception:
        raise ValueError('Tenor request failed (HTTP, MIME, timeout or size limit); credential redacted') from None


def search(query, limit=5):
    key = os.environ.get('TENOR_API_KEY')
    if not key:
        raise ValueError('TENOR_API_KEY is required')
    if not query.strip() or len(query) > 1000 or not 1 <= limit <= 50:
        raise ValueError('Invalid query or limit')
    params = urlencode({'q': query, 'limit': limit, 'key': key, 'media_filter': 'gif,tinygif', 'contentfilter': 'high'})
    data = json.loads(fetch('https://tenor.googleapis.com/v2/search?' + params, 2 * 1024 * 1024, 'application/json'))
    if not isinstance(data, dict) or not isinstance(data.get('results'), list):
        raise ValueError('Malformed Tenor result')
    return data['results']


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('query')
    parser.add_argument('--limit', type=int, default=5)
    parser.add_argument('--output', help='Download first GIF to a new task-owned file')
    args = parser.parse_args()
    try:
        results = search(args.query, args.limit)
        if args.output:
            if not results:
                raise ValueError('No results; no file written')
            url = validate_media_url(results[0]['media_formats']['gif']['url'])
            payload = validate_gif(fetch(url, MAX_GIF, 'image/gif'))
            with Path(args.output).open('xb') as target:
                target.write(payload)
        print(json.dumps(results, ensure_ascii=False))
    except Exception:
        print('GIF search/download failed; check configuration, response and new output path. No credentials logged.', file=sys.stderr)
        sys.exit(1)
