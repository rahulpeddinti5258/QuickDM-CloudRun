import hashlib
import hmac
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]

class WebhookTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('quickdm_test', ROOT / 'app.py')
        self.app = importlib.util.module_from_spec(spec)
        with patch('dotenv.load_dotenv'), patch.dict(os.environ, {}, clear=True):
            spec.loader.exec_module(self.app)
        self.app.META_APP_SECRET = 'test-secret'
        self.app.VERIFY_TOKEN = 'test-verify'
        self.app.ACCESS_TOKEN = 'test-token'
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.app.DB_PATH = str(Path(self.tmp.name) / 'test.db')
        self.app.init_db()
        self.h = object.__new__(self.app.QuickDMHandler)
        self.h.path = '/webhook'
        self.h.wfile = io.BytesIO()
        self.h.send_error = Mock()
        self.h.send_response = Mock()
        self.h.end_headers = Mock()
        self.event = {'object': 'instagram', 'entry': [{'id': self.app.IG_USER_ID,
            'changes': [{'field': 'comments', 'value': {'id': 'comment-1', 'from': {'id': 'person'}}}]}]}

    def post(self, event=None, signature=True):
        body = json.dumps(self.event if event is None else event).encode()
        self.h.rfile = io.BytesIO(body)
        self.h.headers = {'Content-Length': str(len(body))}
        if signature:
            self.h.headers['X-Hub-Signature-256'] = 'sha256=' + hmac.new(b'test-secret', body, hashlib.sha256).hexdigest()
        self.h.do_POST()

    def test_unsigned_never_sends(self):
        with patch.object(self.app.requests, 'post') as send:
            self.post(signature=False)
            send.assert_not_called()
        self.assertEqual(self.h.send_error.call_args.args[0], 403)

    def test_invalid_json_shape_never_sends(self):
        with patch.object(self.app.requests, 'post') as send:
            self.post([])
            send.assert_not_called()
        self.assertEqual(self.h.send_error.call_args.args[0], 400)

    def test_signed_duplicate_keeps_dm_and_public_once(self):
        with patch.object(self.app.requests, 'post', return_value=Mock(ok=True, status_code=200)) as send:
            self.post()
            self.post()
            self.assertEqual(send.call_count, 2)
            self.assertEqual(send.call_args_list[0].kwargs['json']['recipient'], {'comment_id': 'comment-1'})
            self.assertEqual(send.call_args_list[1].kwargs['json']['message'], 'Check your DMs! 📩❤️')

    def test_self_comment_ignored(self):
        self.event['entry'][0]['changes'][0]['value']['from']['id'] = self.app.IG_USER_ID
        self.assertEqual(self.app.parse_comments(self.event), [])

    def test_wrong_account_ignored(self):
        self.event['entry'][0]['id'] = 'other'
        self.assertEqual(self.app.parse_comments(self.event), [])

    def test_entire_batch_validated_before_sends(self):
        self.event['entry'][0]['changes'].append({'field': 'comments', 'value': []})
        with patch.object(self.app.requests, 'post') as send:
            self.post()
            send.assert_not_called()
        self.assertEqual(self.h.send_error.call_args.args[0], 400)

    def test_missing_token_is_not_acknowledged(self):
        self.app.ACCESS_TOKEN = ''
        self.post()
        self.assertEqual(self.h.send_error.call_args.args[0], 503)
        self.h.send_response.assert_not_called()

    def test_get_challenge(self):
        self.h.path = '/webhook?hub.mode=subscribe&hub.verify_token=test-verify&hub.challenge=123'
        self.h.do_GET()
        self.assertEqual(self.h.wfile.getvalue(), b'123')

    def test_empty_challenge_rejected(self):
        self.h.path = '/webhook?hub.mode=subscribe&hub.verify_token=test-verify'
        self.h.do_GET()
        self.assertEqual(self.h.send_error.call_args.args[0], 400)

    def test_missing_configuration_fails_before_binding(self):
        self.app.ACCESS_TOKEN = ''
        with patch.object(self.app, 'HTTPServer') as server, self.assertRaises(SystemExit):
            self.app.main()
        server.assert_not_called()

    def test_large_request_rejected_before_read(self):
        self.h.headers = {'Content-Length': str(self.app.MAX_BODY_BYTES + 1)}
        self.h.rfile = Mock()
        self.h.do_POST()
        self.h.rfile.read.assert_not_called()
        self.assertEqual(self.h.send_error.call_args.args[0], 413)

if __name__ == '__main__':
    unittest.main()
