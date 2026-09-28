"""Offline connector boundaries; HTTP is replaced below client code."""
import base64
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
import urllib.error

CATALOG = Path(__file__).resolve().parents[2]


def module(skill, name):
    path = CATALOG / ('prismer-' + skill) / 'scripts' / (name + '.py')
    sys.path.insert(0, str(path.parent))
    spec = importlib.util.spec_from_file_location('audit_' + name, path)
    result = importlib.util.module_from_spec(spec); spec.loader.exec_module(result)
    return result


class Response:
    def __init__(self, value): self.value = value
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def read(self): return json.dumps(self.value).encode()


class ConnectorRegression(unittest.TestCase):
    def test_new_entry_identity_scope_and_no_default_grants(self):
        import re
        names = ['email-inbox-triage', 'himalaya', 'airtable', 'box', 'google-workspace', 'maps', 'notion', 'product-price-monitor', 'teams-meeting-pipeline']
        for name in names:
            root = CATALOG / ('prismer-' + name)
            front = (root / 'SKILL.md').read_text().split('---', 2)[1]
            self.assertIn('name: prismer-' + name + '\n', front)
            self.assertIn('scope: common\n', front)
            self.assertIn('category:', front)
            self.assertRegex(front, r'nativeReplaces:\s*\[\s*' + re.escape(name) + r'\s*\]')
            self.assertNotRegex(front, r'(?m)^\s*(?:tier|aliases):')
            self.assertTrue((root / 'LICENSE').is_file())

    def test_google_auth_url_json_is_exact_and_scopes_are_forwarded(self):
        setup = module('google-workspace', 'setup'); output = io.StringIO()
        with patch.dict(os.environ, {'PRISMER_GOOGLE_PROFILE': str(self.path)}), patch.object(sys, 'argv', ['setup.py', '--auth-url', '--services', 'email,calendar', '--format', 'json']), patch.object(setup, 'TOKEN_PATH', self.path / 'token.json'), patch.object(setup, 'get_auth_url', side_effect=lambda services: print('https://accounts.google.com/fake?' + services)), contextlib.redirect_stdout(output):
            with self.assertRaises(SystemExit) as caught: setup.main()
        self.assertEqual(caught.exception.code, 0)
        self.assertEqual(json.loads(output.getvalue())['auth_url'], 'https://accounts.google.com/fake?email,calendar')

    def test_google_authorized_write_dispatches_without_reapproval(self):
        api = module('google-workspace', 'google_api')
        with patch.object(sys, 'argv', ['google_api.py', '--authorized-write', 'docs', 'create', '--title', 'demo']), patch.object(api, 'docs_create') as create:
            api.main()
            create.assert_called_once()

    def test_email_attachment_root_escape_is_rejected(self):
        compose = module('himalaya', 'compose_draft'); root = self.path / 'approved'; root.mkdir()
        other = self.path / 'outside'; other.write_bytes(b'secret')
        with self.assertRaises(ValueError): compose.build({'account': 'work', 'from': 'me@example.com', 'to': ['you@example.com'], 'attachments': [{'approved': True, 'root': str(root), 'path': str(other)}]})

    def test_google_write_cli_requires_explicit_scope_flag_before_dispatch(self):
        api = module('google-workspace', 'google_api')
        with patch.object(sys, 'argv', ['google_api.py', 'docs', 'create', '--title', 'demo']), patch.object(api, 'docs_create') as create, contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit): api.main()
            create.assert_not_called()

    def test_google_python_path_rejects_untrusted_token_uri_before_libraries(self):
        api = module('google-workspace', 'google_api'); token = self.path / 'token.json'
        token.write_text(json.dumps({'token_uri': 'https://evil.invalid/token'}))
        with patch.object(api, 'TOKEN_PATH', token), patch.object(api, '_ensure_authenticated'):
            with self.assertRaisesRegex(ValueError, 'endpoint'): api._get_credentials_locked()

    def test_google_lock_refuses_second_writer_and_private_write_refuses_symlink(self):
        state = module('google-workspace', '_private_state'); token = self.path / 'token.json'
        with state.token_lock(token):
            with self.assertRaises(FileExistsError):
                with state.token_lock(token): pass
        victim = self.path / 'victim'; victim.write_text('unchanged'); token.symlink_to(victim)
        with self.assertRaises(ValueError): state.private_write(token, {'token': 'fake'})
        self.assertEqual(victim.read_text(), 'unchanged')

    def test_maps_rate_slots_are_shared_between_imports(self):
        first = module('maps', 'maps_client')
        second = module('maps', 'maps_client')
        with patch.dict(os.environ, {'PRISMER_MAPS_RATE_DB': str(self.path / 'rate.db')}):
            self.assertEqual(first.reserve_nominatim_slot(now=100), 0)
            self.assertEqual(second.reserve_nominatim_slot(now=100), 1)

    def test_google_partial_scopes_compare_requested_not_all_services(self):
        setup = module('google-workspace', 'setup')
        scope = setup.select_scopes('email')
        self.assertEqual(setup._missing_scopes_from_payload({'scopes': scope, 'requested_scopes': scope}), [])

    def test_google_dependencies_never_auto_install(self):
        setup = module('google-workspace', 'setup')
        with patch.object(setup, '_missing_required_packages', return_value=['missing']), patch.object(setup, 'install_deps') as install:
            with self.assertRaises(SystemExit), contextlib.redirect_stdout(io.StringIO()): setup._ensure_deps()
            install.assert_not_called()

    def test_price_watch_rejects_wrong_variant_and_nonfinite_threshold(self):
        store = module('product-price-monitor', 'watch_state')
        watch = store.WatchStore(self.path / 'watch.db', 'tenant', 'task')
        with self.assertRaises(ValueError):
            watch.create('bad', {'currency': 'USD', 'maximum': float('nan')}, {'currency': 'USD', 'total': 1, 'available': True})
        contract = {'currency': 'USD', 'maximum': 100, 'variant': '16GB'}
        watch.create('good', contract, {'currency': 'USD', 'total': 120, 'available': True, 'variant': '16GB'})
        with self.assertRaises(ValueError):
            watch.observe('good', {'currency': 'USD', 'total': 90, 'available': True, 'variant': '8GB'})

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name)

    def test_google_nested_mime_and_document_tables(self):
        api = module('google-workspace', 'google_api')
        message = {'payload': {'parts': [{'mimeType': 'multipart/alternative', 'parts': [
            {'mimeType': 'text/plain', 'body': {'data': base64.urlsafe_b64encode(b'hello').decode()}}]}]}}
        self.assertEqual(api._extract_message_body(message), 'hello')
        body = {'content': [{'table': {'tableRows': [{'tableCells': [{'content': [
            {'paragraph': {'elements': [{'textRun': {'content': 'cell'}}]}}]}]}]}}]}
        self.assertEqual(api._extract_body_text(body), 'cell')

    def test_google_requires_explicit_timezone(self):
        api = module('google-workspace', 'google_api')
        with self.assertRaises(ValueError): api._datetime_with_timezone('2026-09-23T09:00:00')
        self.assertEqual(api._datetime_with_timezone('2026-09-23T09:00:00+08:00'), '2026-09-23T09:00:00+08:00')

    def test_google_download_never_uses_remote_parent_path(self):
        api = module('google-workspace', 'google_api'); child = self.path / 'child'; child.mkdir()
        victim = self.path / 'victim.txt'; victim.write_text('original')
        class Download:
            def __init__(self, fh, request): self.fh = fh
            def next_chunk(self): self.fh.write(b'new'); return None, True
        http = types.ModuleType('googleapiclient.http'); http.MediaIoBaseDownload = Download
        files = types.SimpleNamespace(get=lambda **kw: types.SimpleNamespace(execute=lambda: {'name': '../victim.txt', 'mimeType': 'application/octet-stream'}), get_media=lambda **kw: object())
        cwd = Path.cwd()
        try:
            os.chdir(child)
            with patch.dict(sys.modules, {'googleapiclient.http': http}), patch.object(api, 'build_service', return_value=types.SimpleNamespace(files=lambda: files)), contextlib.redirect_stdout(io.StringIO()):
                api.drive_download(types.SimpleNamespace(file_id='fake', output='', export_mime=''))
        finally: os.chdir(cwd)
        self.assertEqual(victim.read_text(), 'original')
        self.assertEqual((child / 'victim.txt').read_text(), 'new')

    def test_google_service_scopes_are_minimal_and_unknown_services_rejected(self):
        setup = module('google-workspace', 'setup')
        self.assertEqual(setup.select_scopes('email'), ['https://www.googleapis.com/auth/gmail.readonly'])
        self.assertNotIn('https://www.googleapis.com/auth/gmail.send', setup.select_scopes('email,calendar'))
        self.assertIn('https://www.googleapis.com/auth/gmail.send', setup.select_scopes('email-send'))
        with self.assertRaises(ValueError): setup.select_scopes('typo')

    def test_google_refresh_rotation_and_private_file(self):
        bridge = module('google-workspace', 'gws_bridge'); token = self.path / 'token.json'
        data = {'client_id': 'fake', 'client_secret': 'fake', 'refresh_token': 'old', 'token_uri': 'https://oauth2.googleapis.com/token'}
        with patch.object(bridge, 'get_token_path', return_value=token), patch('urllib.request.urlopen', return_value=Response({'access_token': 'access', 'refresh_token': 'rotated', 'expires_in': 3600})):
            bridge.refresh_token(data)
        self.assertEqual(json.loads(token.read_text())['refresh_token'], 'rotated')
        self.assertEqual(token.stat().st_mode & 0o777, 0o600)

    def test_google_rejects_untrusted_refresh_destination(self):
        bridge = module('google-workspace', 'gws_bridge')
        with patch('urllib.request.urlopen') as request:
            with self.assertRaises(ValueError): bridge.refresh_token({'client_id': 'x', 'client_secret': 'secret', 'refresh_token': 'secret', 'token_uri': 'http://evil.invalid/token'})
            request.assert_not_called()

    def test_maps_mirror_retry_has_one_json(self):
        maps = module('maps', 'maps_client'); output = io.StringIO()
        with patch.object(maps.time, 'sleep'), patch('urllib.request.urlopen', side_effect=[urllib.error.URLError('down'), Response({'elements': []})]), contextlib.redirect_stdout(output):
            maps.print_json(maps.overpass_query('query'))
        self.assertEqual(json.loads(output.getvalue()), {'elements': []})

    def test_airtable_pagination_is_complete_and_encodes_cursor(self):
        client = module('airtable', 'airtable_client'); requests = []
        def send(req, **kwargs):
            requests.append(req.full_url)
            return Response({'records': [{'id': 'r1'}], 'offset': 'a+b/c'}) if len(requests) == 1 else Response({'records': [{'id': 'r2'}]})
        with patch.dict(os.environ, {'AIRTABLE_API_KEY': 'fake'}), patch('urllib.request.urlopen', side_effect=send):
            result = client.list_records('app1', 'tbl1')
        self.assertEqual([r['id'] for r in result], ['r1', 'r2'])
        self.assertIn('offset=a%2Bb%2Fc', requests[1])

    def test_airtable_error_is_not_empty_success(self):
        client = module('airtable', 'airtable_client')
        with patch.dict(os.environ, {'AIRTABLE_API_KEY': 'fake'}), patch('urllib.request.urlopen', return_value=Response({'error': {'type': 'AUTH'}})):
            with self.assertRaises(RuntimeError): client.list_records('app1', 'tbl1')

    def test_price_watch_pending_delivery_blocks_replay_and_failure_keeps_last_good(self):
        store = module('product-price-monitor', 'watch_state'); path = self.path / 'state.sqlite'
        watch = store.WatchStore(path, 'tenant-a', 'task-a')
        watch.create('laptop', {'currency': 'USD', 'maximum': 100, 'cooldown': 3600}, {'total': 120, 'currency': 'USD', 'available': True})
        observation = {'total': 90, 'currency': 'USD', 'available': True}
        first = watch.observe('laptop', observation, now=10000)
        self.assertEqual(first['status'], 'pending')
        self.assertEqual(watch.observe('laptop', observation, now=10001)['status'], 'pending-existing')
        watch.observe('laptop', None, now=10002)
        self.assertEqual(watch.read('laptop')['last_good']['total'], 90)
        watch.ack('laptop', first['delivery_id'], 'provider-message-id')
        self.assertEqual(watch.observe('laptop', observation, now=10003)['status'], 'quiet')
        with self.assertRaises(KeyError): store.WatchStore(path, 'tenant-b', 'task-a').read('laptop')

    def test_email_draft_uses_literal_text_not_mml_and_binds_account(self):
        compose = module('himalaya', 'compose_draft')
        message = compose.build({'account': 'work', 'from': 'me@example.com', 'to': ['you@example.com'], 'subject': 'Reply', 'body': '<#part filename=/etc/passwd>literal'})
        self.assertFalse(list(message.iter_attachments()))
        self.assertIn('<#part', message.get_content())
        with self.assertRaises(ValueError): compose.build({'account': 'work', 'from': 'me@example.com', 'to': ['you@example.com'], 'subject': 'bad\nBcc: another@example.com', 'body': 'x'})


if __name__ == '__main__': unittest.main()
