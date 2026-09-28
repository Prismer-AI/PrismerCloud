#!/usr/bin/env python3
"""Strict remote parser. Never reads accounts or prints tokens."""
import re
import sys
from urllib.parse import urlsplit


def parse_remote(remote, host='github.com'):
    if any(ord(c) < 33 or ord(c) == 127 for c in remote):
        return ''
    if remote.startswith('git@') and ':' in remote:
        remote = 'ssh://' + remote.replace(':', '/', 1)
    try:
        url = urlsplit(remote)
        if url.scheme not in ('https', 'ssh') or url.hostname != host or url.query or url.fragment:
            return ''
        if url.password or (url.username and not (url.scheme == 'ssh' and url.username == 'git')):
            return ''
        if url.port not in (None, 443 if url.scheme == 'https' else 22):
            return ''
    except ValueError:
        return ''
    path = url.path.removeprefix('/').removesuffix('.git')
    return path if re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_.-]+', path) and path.split('/')[1] not in ('.', '..') else ''


if __name__ == '__main__':
    print(parse_remote(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else 'github.com'))
