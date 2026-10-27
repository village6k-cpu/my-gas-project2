"""Synthetic, no-provider-I/O contracts for the migration voice intake."""
import json
from contextlib import closing
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from urllib.request import Request, urlopen
from urllib.error import HTTPError
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts/macos'
sys.path.insert(0, str(SCRIPTS))
import migration_voice_ingress as voice
from migration_voice_ingress import VoiceInbox, VoicePump, VoiceBlocked, parse_voice, make_server, PhaseAuthority, forward_to_relay
from migration_slack_dispatch import ConsumerBusy


class VoiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'voice.sqlite3'
        self.inbox = VoiceInbox(self.path)

    def tearDown(self):
        self.inbox.close()
        self.temp.cleanup()

    def test_health_distinguishes_dead_forwarder_from_durable_intake(self):
        self.assertTrue(hasattr(voice,'ForwardingLoop'),'forwarder runtime observation is missing')
        base=Path(self.temp.name);phase=base/'phase.json'
        source={'root':{'pid':1,'started':1.2},'voice':{'pid':2,'started':2.3}}
        phase.write_text(json.dumps({'schema':'village-voice-phase/v1','epoch':'fixture',
                         'source':source,'mode':'windows','verified_unix':time.time()}))
        authority=PhaseAuthority(base,phase,'fixture',source)
        with VoicePump(self.inbox) as pump:
            loop=voice.ForwardingLoop(pump,authority,lambda *_:self.fail('sent'),
                                      config_sha256='a'*64,epoch='fixture')
            loop.start()
            deadline=time.monotonic()+3
            while loop.status().get('authority')!='windows' and time.monotonic()<deadline:time.sleep(.01)
            status=loop.status()
            self.assertTrue(status['thread_alive']);self.assertFalse(status['failed'])
            self.assertEqual(status['config_sha256'],'a'*64)
            self.assertEqual(status['phase_sha256'],__import__('hashlib').sha256(phase.read_bytes()).hexdigest())
            self.assertLess(status['evaluation_age_seconds'],1)
            # An actual storage exception kills forwarding, with an empty queue.
            with patch.object(pump,'once',side_effect=sqlite3.DatabaseError('fixture')):
                loop.thread.join(timeout=3)
            self.assertFalse(loop.thread.is_alive())
            server=make_server(self.inbox,'a'*48,port=0,forwarder=loop)
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            try:
                with urlopen('http://127.0.0.1:%d/health'%server.server_port,timeout=3) as response:
                    health=json.load(response)
                self.assertEqual(health['status'],'ok')
                self.assertFalse(health['forwarder']['thread_alive'])
                self.assertTrue(health['forwarder']['failed'])
                self.assertEqual(self.inbox.capture('held synthetic','dead-pump')['state'],'queued')
            finally:
                server.shutdown();server.server_close();thread.join(timeout=3);loop.stop()

    def test_intake_without_a_forwarding_owner_never_claims_runtime_readiness(self):
        server=make_server(self.inbox,'a'*48,port=0)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            with urlopen('http://127.0.0.1:%d/health'%server.server_port,timeout=3) as response:
                self.assertIsNone(json.load(response).get('forwarder'))
        finally:server.shutdown();server.server_close();thread.join(timeout=3)

    def test_supported_forms_normalize_like_the_current_relay(self):
        for body, kind in [(b'{"transcript":"  hello   world ","request_id":"r1"}', 'application/json'),
                           (b'text=hello+++world&request_id=r1', 'application/x-www-form-urlencoded'),
                           (b' hello   world ', 'text/plain')]:
            self.assertEqual(parse_voice(body, kind, 'r1', now=120), ('hello world', 'r1'))

    def test_generated_id_keeps_current_minute_bucket_contract(self):
        import hashlib
        text, key = parse_voice(b'hello', 'text/plain', '', now=120)
        self.assertEqual(key, hashlib.sha256(b'2\nhello').hexdigest())

    def test_invalid_inputs_never_create_a_receipt(self):
        for body in (b'', b'   ', b'{broken', b'{"text":{}}', b'{"text":""}'):
            with self.subTest(body=body), self.assertRaises(ValueError):
                parse_voice(body, 'application/json', '', now=0)
        with self.assertRaises(ValueError): parse_voice(b'x' * 16385, 'text/plain', '', now=0)
        with self.assertRaises(ValueError): parse_voice(b'x' * 2001, 'text/plain', '', now=0)
        self.assertEqual(self.inbox.counts(), {})

    def test_capture_commits_before_return_and_survives_reopen(self):
        result = self.inbox.capture('synthetic voice', 'r1')
        with closing(sqlite3.connect(self.path)) as reader:
            self.assertEqual(reader.execute('SELECT state FROM requests').fetchone()[0], 'queued')
        self.assertEqual(result['state'], 'queued')
        self.inbox.close()
        self.inbox = VoiceInbox(self.path)
        self.assertEqual(self.inbox.capture('synthetic voice', 'r1'), result)
        self.assertEqual(self.inbox.counts(), {'queued': 1})

    def test_conflicting_request_is_retained_and_blocks_delivery(self):
        self.inbox.capture('first synthetic', 'r1')
        with self.assertRaises(VoiceBlocked): self.inbox.capture('different synthetic', 'r1')
        with self.assertRaises(VoiceBlocked):
            with VoicePump(self.inbox) as pump: pump.once(lambda: 'windows', lambda *x: self.fail('sent'))
        with closing(sqlite3.connect(self.path)) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM conflicts').fetchone()[0], 1)

    def test_held_input_does_not_call_upstream(self):
        self.inbox.capture('synthetic', 'r1')
        with VoicePump(self.inbox) as pump:
            self.assertIsNone(pump.once(lambda: None, lambda *x: self.fail('sent')))
        self.assertEqual(self.inbox.counts(), {'queued': 1})

    def test_forward_claim_is_committed_before_upstream_and_not_repeated(self):
        self.inbox.capture('synthetic', 'r1')
        calls = []
        def send(target, payload):
            with closing(sqlite3.connect(self.path)) as db:
                self.assertEqual(db.execute('SELECT state FROM requests').fetchone()[0], 'dispatching')
            calls.append((target, payload))
            return 202, {'status': 'accepted', 'parent_ts': '123.456'}
        with VoicePump(self.inbox) as pump:
            self.assertEqual(pump.once(lambda: 'windows', send)['state'], 'delivered')
            self.assertIsNone(pump.once(lambda: 'windows', send))
        self.assertEqual(calls, [('windows', {'text': 'synthetic', 'request_id': 'r1'})])
        self.assertEqual(self.inbox.capture('synthetic', 'r1')['response']['parent_ts'], '123.456')

    def test_transport_or_response_uncertainty_blocks_all_later_delivery(self):
        failures = [TimeoutError(), (502, {'status': 'upstream_error'}),
                    (202, {'status': 'queued'}), (202, {'status': 'accepted'})]
        for index, failure in enumerate(failures):
            with self.subTest(failure=failure):
                other = VoiceInbox(Path(self.temp.name) / ('other%d.db' % index))
                try:
                    other.capture('synthetic', 'r1'); other.capture('next', 'r2')
                    def send(*_):
                        if isinstance(failure, Exception): raise failure
                        return failure
                    with VoicePump(other) as pump:
                        with self.assertRaises(VoiceBlocked): pump.once(lambda: 'windows', send)
                        with self.assertRaises(VoiceBlocked): pump.once(lambda: 'mac', lambda *x: self.fail('retry'))
                    self.assertEqual(other.counts(), {'queued': 1, 'uncertain': 1})
                finally: other.close()

    def test_revoked_authority_after_claim_does_not_send(self):
        self.inbox.capture('synthetic', 'r1')
        answers = iter(['windows', None])
        with VoicePump(self.inbox) as pump, self.assertRaises(VoiceBlocked):
            pump.once(lambda: next(answers), lambda *x: self.fail('sent'))
        self.assertEqual(self.inbox.counts(), {'dispatching': 1})

    def test_revoked_authority_after_upstream_stays_uncertain(self):
        self.inbox.capture('synthetic', 'r1')
        answers = iter(['windows', 'windows', None])
        with VoicePump(self.inbox) as pump, self.assertRaises(VoiceBlocked):
            pump.once(lambda: next(answers), lambda *_: (202, {'status': 'accepted', 'parent_ts': '1.2'}))
        self.assertEqual(self.inbox.counts(), {'uncertain': 1})

    def test_single_consumer_lock_is_held_until_close(self):
        with VoicePump(self.inbox):
            with self.assertRaises(ConsumerBusy): VoicePump(self.inbox)
        with VoicePump(self.inbox): pass

    def test_crashed_dispatcher_cannot_be_retried_after_reopen(self):
        self.inbox.capture('synthetic', 'r1')
        script = """import sys,os
sys.path.insert(0,sys.argv[1])
from migration_voice_ingress import VoiceInbox,VoicePump
i=VoiceInbox(sys.argv[2]);p=VoicePump(i)
p.once(lambda:'windows',lambda *x:os._exit(17))
"""
        result = subprocess.run([sys.executable, '-c', script, str(SCRIPTS), str(self.path)],
                                capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 17)
        with VoicePump(self.inbox) as pump, self.assertRaises(VoiceBlocked):
            pump.once(lambda: 'mac', lambda *x: self.fail('retry'))

    def test_capture_disk_error_never_returns_acceptance(self):
        self.inbox._db.execute("CREATE TRIGGER reject_voice BEFORE INSERT ON requests BEGIN SELECT RAISE(ABORT,'fixture'); END")
        with self.assertRaises(sqlite3.DatabaseError): self.inbox.capture('synthetic', 'r1')
        self.assertEqual(self.inbox.counts(), {})

    def test_directory_must_already_exist(self):
        with self.assertRaises(ValueError): VoiceInbox(Path(self.temp.name) / 'missing' / 'voice.db')

    def test_real_http_requires_auth_and_commits_before_202(self):
        server = make_server(self.inbox, 'a' * 48, port=0)
        thread = threading.Thread(target=server.serve_forever, daemon=True);thread.start()
        try:
            url = 'http://127.0.0.1:%d/watch/voice' % server.server_port
            with self.assertRaises(HTTPError) as rejected:
                urlopen(Request(url, data=b'synthetic'), timeout=3)
            self.assertEqual(rejected.exception.code, 401)
            self.assertEqual(self.inbox.counts(), {})
            req = Request(url, data=b'{"text":"synthetic","request_id":"http1"}',
                          headers={'Authorization': 'Bearer ' + 'a' * 48, 'Content-Type': 'application/json'})
            with urlopen(req, timeout=3) as response:
                self.assertEqual(response.status, 202)
                self.assertEqual(json.load(response)['status'], 'queued')
            self.assertEqual(self.inbox.counts(), {'queued': 1})
        finally:
            server.shutdown();server.server_close();thread.join(timeout=3)

    def test_real_http_disk_failure_does_not_ack_and_does_not_forward(self):
        self.inbox._db.execute("CREATE TRIGGER reject_voice BEFORE INSERT ON requests BEGIN SELECT RAISE(ABORT,'fixture'); END")
        server = make_server(self.inbox, 'a' * 48, port=0)
        thread = threading.Thread(target=server.serve_forever, daemon=True);thread.start()
        try:
            req = Request('http://127.0.0.1:%d/watch/voice' % server.server_port, data=b'synthetic',
                          headers={'Authorization': 'Bearer ' + 'a' * 48, 'Content-Type': 'text/plain'})
            with self.assertRaises(HTTPError) as rejected: urlopen(req, timeout=3)
            self.assertEqual(rejected.exception.code, 503)
            self.assertEqual(self.inbox.counts(), {})
        finally:
            server.shutdown();server.server_close();thread.join(timeout=3)

    def test_forwarder_preserves_bearer_and_id_and_never_follows_redirect(self):
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        seen = []
        class FakeRelay(BaseHTTPRequestHandler):
            def do_POST(self):
                seen.append((self.headers.get('Authorization'), json.loads(self.rfile.read(int(self.headers['Content-Length'])))))
                self.send_response(307);self.send_header('Location', '/must-not-follow');self.end_headers()
            def log_message(self, *_): pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), FakeRelay)
        thread = threading.Thread(target=server.serve_forever, daemon=True);thread.start()
        try:
            with self.assertRaises(HTTPError) as rejected:
                forward_to_relay('http://127.0.0.1:%d/' % server.server_port, 'a'*48,
                                 {'text': 'synthetic', 'request_id': 'r1'})
            self.assertEqual(rejected.exception.code, 307)
            self.assertEqual(seen, [('Bearer '+'a'*48, {'text': 'synthetic', 'request_id': 'r1'})])
        finally:
            server.shutdown();server.server_close();thread.join(timeout=3)

    def test_phase_authority_requires_fresh_bound_source_or_full_native_activation(self):
        import hashlib
        base = Path(self.temp.name)
        phase = base / 'phase.json'
        binding = {'schema': 'village-voice-phase/v1', 'epoch': 'fixture-epoch',
                   'mode': 'windows', 'verified_unix': 100,
                   'source': {'root': {'pid': 1, 'started': 1.2}, 'voice': {'pid': 2, 'started': 2.3}}}
        source = binding['source']
        authority = PhaseAuthority(base, phase, 'fixture-epoch', source, now=lambda: 110)
        phase.write_text(json.dumps(binding))
        self.assertEqual(authority(), 'windows')
        binding['verified_unix'] = 80;phase.write_text(json.dumps(binding))
        self.assertIsNone(authority())
        binding['verified_unix'] = 100;binding['source']['root']['started'] = 9
        phase.write_text(json.dumps(binding));self.assertIsNone(authority())
        binding['source'] = {'root': {'pid': 1, 'started': 1.2}, 'voice': {'pid': 2, 'started': 2.3}}
        phase.write_text(json.dumps(binding));(base/'SOURCE-CLOSED.json').write_text('{}')
        self.assertIsNone(authority())
        closure = (base/'SOURCE-CLOSED.json').read_bytes()
        manifest = base/'runtime.json';manifest.write_text('{"fixture":true}')
        binding.update(mode='mac', source_closed_sha256=hashlib.sha256(closure).hexdigest(),
                       manifest_sha256=hashlib.sha256(manifest.read_bytes()).hexdigest())
        phase.write_text(json.dumps(binding))
        self.assertIsNone(authority())
        from migration_voice_ingress import REQUIRED_NATIVE_GATES
        activation = {'manifest_sha256': binding['manifest_sha256'],
                      'source_closed_sha256': binding['source_closed_sha256'],
                      'gates': dict.fromkeys(REQUIRED_NATIVE_GATES, True)}
        (base/'ACTIVATION.json').write_text(json.dumps(activation))
        self.assertEqual(authority(), 'mac')
        (base/'MIGRATION-INACTIVE').touch();self.assertIsNone(authority())


if __name__ == '__main__': unittest.main()
