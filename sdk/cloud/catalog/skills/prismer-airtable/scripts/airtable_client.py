"""Bounded Airtable JSON requests. Failed/partial pagination never returns success."""
import argparse
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request


def request_json(path, method='GET', payload=None, params=None):
    token = os.environ.get('AIRTABLE_API_KEY')
    if not token:
        raise ValueError('AIRTABLE_API_KEY PAT is required')
    if not path.startswith('/') or '://' in path or '..' in path.split('/'):
        raise ValueError('API path must stay within Airtable v0')
    url = 'https://api.airtable.com/v0' + path
    if params: url += '?' + urllib.parse.urlencode(params, doseq=True)
    req = urllib.request.Request(url, method=method,
        data=None if payload is None else json.dumps(payload).encode(),
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=30) as response:
                value = json.loads(response.read())
            if not isinstance(value, dict) or value.get('error'):
                raise RuntimeError('Airtable returned an error/non-object response; result incomplete')
            return value
        except urllib.error.HTTPError as exc:
            # A mutation timeout/5xx may have committed: never blindly replay it.
            if method == 'GET' and exc.code in (429, 502, 503, 504) and attempt < 3:
                time.sleep(min(30, 2 ** attempt))
                continue
            raise RuntimeError(f'Airtable HTTP {exc.code}; verify write state before retry') from None
    raise RuntimeError('Airtable request exhausted retries')


def list_records(base, table, params=None):
    path = '/' + urllib.parse.quote(base, safe='') + '/' + urllib.parse.quote(table, safe='')
    params = dict(params or {}); params['pageSize'] = 100
    records, seen = [], set()
    for _ in range(10000):
        page = request_json(path, params=params)
        if not isinstance(page.get('records'), list):
            raise RuntimeError('Missing records; partial results withheld')
        records.extend(page['records'])
        offset = page.get('offset')
        if not offset: return records
        if not isinstance(offset, str) or offset in seen:
            raise RuntimeError('Invalid/repeated pagination cursor; partial results withheld')
        seen.add(offset); params['offset'] = offset
    raise RuntimeError('Pagination limit exceeded; partial results withheld')


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('path', help='API path e.g. /appID/tblID or /meta/bases')
    p.add_argument('--method', choices=['GET', 'POST', 'PATCH', 'DELETE'], default='GET')
    p.add_argument('--json-file'); p.add_argument('--params', default='{}')
    p.add_argument('--all-records', action='store_true')
    p.add_argument('--authorized-write', action='store_true', help='Only after user authorization; not an authorization grant')
    args = p.parse_args()
    if args.method != 'GET' and not args.authorized_write:
        p.error('writes require explicit authorized scope and --authorized-write')
    payload = None
    if args.json_file:
        with open(args.json_file, encoding='utf-8') as stream: payload = json.load(stream)
    if args.all_records:
        pieces = args.path.strip('/').split('/')
        if len(pieces) != 2 or args.method != 'GET': p.error('--all-records requires GET /base/table')
        result = {'records': list_records(*pieces, params=json.loads(args.params)), 'complete': True}
    else: result = request_json(args.path, args.method, payload, json.loads(args.params))
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__': main()
