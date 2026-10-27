"""Offline handoff storage contracts; no Slack credentials or connections."""
import asyncio
from contextlib import closing
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

PATH = Path(__file__).resolve().parents[1] / 'scripts/macos/migration_socket_inbox.py'
SPEC = importlib.util.spec_from_file_location('migration_socket_inbox', PATH)
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def event(envelope='envelope-1', event_id='Ev1'):
    return {'envelope_id': envelope, 'type': 'events_api',
            'payload': {'type': 'event_callback', 'team_id': 'T1', 'api_app_id': 'A1',
                        'event_id': event_id, 'event': {'type': 'message', 'text': '보관 검증'}}}


class InboxTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'handoff' / 'inbox.sqlite3'
        self.path.parent.mkdir(mode=0o700)
        self.inbox = MODULE.SocketInbox(self.path, team_id='T1', app_id='A1')

    def tearDown(self):
        self.inbox.close()
        self.temp.cleanup()

    def raw(self, query):
        with closing(sqlite3.connect(self.path)) as db:
            return db.execute(query).fetchall()

    def test_receipt_survives_close_and_reopen(self):
        result = self.inbox.record(event())
        self.assertTrue(result.ack_allowed)
        self.inbox.close()
        self.inbox = MODULE.SocketInbox(self.path, team_id='T1', app_id='A1')
        self.assertEqual(self.inbox.status(), {'events': 1, 'deliveries': 1, 'held': 0})
        saved = self.raw('SELECT raw_json FROM deliveries')[0][0]
        self.assertEqual(json.loads(saved), event())

    def test_missing_directory_is_refused_without_creating_it(self):
        missing = Path(self.temp.name) / 'not-provisioned' / 'nested' / 'inbox.sqlite3'
        opened = None
        try:
            with self.assertRaises(ValueError):
                opened = MODULE.SocketInbox(missing, team_id='T1', app_id='A1')
        finally:
            if opened is not None:
                opened.close()
        self.assertFalse(missing.parent.parent.exists())

    def test_ack_observes_committed_data_from_independent_connection(self):
        async def ack(envelope_id):
            self.assertEqual(envelope_id, 'envelope-1')
            self.assertEqual(len(self.raw('SELECT raw_json FROM deliveries')), 1)
        result = asyncio.run(MODULE.persist_then_ack(self.inbox, event(), ack))
        self.assertTrue(result.ack_allowed)

    def test_ack_identity_comes_from_the_saved_receipt(self):
        value = event()
        parent = self
        class MutatingCaller:
            def record(self, supplied):
                receipt = parent.inbox.record(supplied)
                supplied['envelope_id'] = 'not-saved'
                return receipt
        seen = []
        async def ack(envelope_id):
            seen.append(envelope_id)
        asyncio.run(MODULE.persist_then_ack(MutatingCaller(), value, ack))
        self.assertEqual(seen, ['envelope-1'])

    def test_process_exit_after_commit_does_not_lose_the_event(self):
        self.inbox.close()
        code = '''import importlib.util,json,os,sys
spec=importlib.util.spec_from_file_location('crash_inbox',sys.argv[1])
module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
inbox=module.SocketInbox(sys.argv[2],team_id='T1',app_id='A1')
inbox.record(json.loads(sys.argv[3]));os._exit(23)
'''
        result = subprocess.run([sys.executable, '-c', code, str(PATH), str(self.path),
                                 json.dumps(event())], capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 23, result.stderr.decode(errors='replace'))
        self.inbox = MODULE.SocketInbox(self.path, team_id='T1', app_id='A1')
        self.assertEqual(self.inbox.status(), {'events': 1, 'deliveries': 1, 'held': 0})
        self.assertEqual(self.inbox.record(event(envelope='retry-after-crash')).disposition, 'duplicate')

    def test_independent_connections_serialize_duplicate_deliveries(self):
        other = MODULE.SocketInbox(self.path, team_id='T1', app_id='A1')
        try:
            def capture(number):
                target = self.inbox if number % 2 else other
                return target.record(event(envelope='concurrent-' + str(number)))
            with ThreadPoolExecutor(max_workers=4) as pool:
                results = list(pool.map(capture, range(20)))
            self.assertTrue(all(result.ack_allowed for result in results))
            self.assertEqual(sum(result.disposition == 'captured' for result in results), 1)
            self.assertEqual(self.inbox.status(), {'events': 1, 'deliveries': 20, 'held': 0})
        finally:
            other.close()

    def test_lost_ack_and_retry_preserve_one_event_and_both_deliveries(self):
        async def lost(_):
            raise ConnectionError('simulated lost ACK')
        with self.assertRaises(ConnectionError):
            asyncio.run(MODULE.persist_then_ack(self.inbox, event(), lost))
        result = self.inbox.record(event(envelope='envelope-2'))
        self.assertTrue(result.ack_allowed)
        self.assertEqual(result.disposition, 'duplicate')
        self.assertEqual(self.inbox.status(), {'events': 1, 'deliveries': 2, 'held': 0})

    def test_same_delivery_is_idempotent(self):
        self.inbox.record(event())
        self.inbox.record(event())
        self.assertEqual(self.inbox.status()['deliveries'], 1)

    def test_changed_payload_holds_original_and_keeps_both_payloads(self):
        self.inbox.record(event())
        changed = event(envelope='envelope-2')
        changed['payload']['event']['text'] = '다른 내용'
        self.assertFalse(self.inbox.record(changed).ack_allowed)
        self.assertFalse(self.inbox.record(event(envelope='envelope-3')).ack_allowed)
        self.assertEqual(self.inbox.status(), {'events': 1, 'deliveries': 3, 'held': 1})
        self.assertEqual(len(self.raw('SELECT DISTINCT payload_sha256 FROM deliveries')), 2)

    def test_reused_envelope_for_another_event_holds_both(self):
        self.inbox.record(event())
        self.assertFalse(self.inbox.record(event(event_id='Ev2')).ack_allowed)
        self.assertEqual(self.inbox.status()['held'], 2)

    def test_wrong_team_or_app_is_preserved_without_ack(self):
        for field in ('team_id', 'api_app_id'):
            changed = event(envelope='wrong-' + field)
            changed['payload'][field] = 'OTHER'
            self.assertFalse(self.inbox.record(changed).ack_allowed)
        self.assertEqual(self.inbox.status(), {'events': 2, 'deliveries': 2, 'held': 2})

    def test_unsupported_interaction_is_preserved_without_ack(self):
        called = []
        async def ack(value):
            called.append(value)
        value = {'envelope_id': 'interactive-1', 'type': 'interactive',
                 'payload': {'team': {'id': 'T1'}, 'trigger_id': 'expires-soon'}}
        result = asyncio.run(MODULE.persist_then_ack(self.inbox, value, ack))
        self.assertFalse(result.ack_allowed)
        self.assertEqual(called, [])
        self.assertEqual(json.loads(self.raw('SELECT raw_json FROM deliveries')[0][0]), value)

    def test_missing_event_identity_is_held(self):
        value = event()
        del value['payload']['event_id']
        self.assertFalse(self.inbox.record(value).ack_allowed)

    def test_store_error_does_not_ack(self):
        called = []
        async def ack(value):
            called.append(value)
        with closing(sqlite3.connect(self.path)) as db:
            db.execute("CREATE TRIGGER deny_delivery BEFORE INSERT ON deliveries BEGIN SELECT RAISE(ABORT, 'disk test'); END")
            db.commit()
        with self.assertRaises(sqlite3.DatabaseError):
            asyncio.run(MODULE.persist_then_ack(self.inbox, event(), ack))
        self.assertEqual(called, [])
        self.assertEqual(self.inbox.status(), {'events': 0, 'deliveries': 0, 'held': 0})

    def test_existing_database_rejects_different_identity_without_modification(self):
        self.inbox.record(event())
        before = self.raw('SELECT * FROM metadata')
        with self.assertRaises(ValueError):
            MODULE.SocketInbox(self.path, team_id='T2', app_id='A1')
        self.assertEqual(before, self.raw('SELECT * FROM metadata'))

    def test_non_json_and_oversized_input_do_not_ack(self):
        bad = event()
        bad['payload']['event']['bad'] = float('nan')
        with self.assertRaises(ValueError):
            self.inbox.record(bad)
        huge = event()
        huge['payload']['event']['text'] = 'x' * (MODULE.MAX_ENVELOPE_BYTES + 1)
        with self.assertRaises(ValueError):
            self.inbox.record(huge)
        self.assertEqual(self.inbox.status()['events'], 0)

    def test_no_business_dispatch_or_recovery_api_is_exposed(self):
        self.assertFalse(hasattr(self.inbox, 'dispatch'))
        self.assertFalse(hasattr(self.inbox, 'replay'))
        self.assertFalse(hasattr(self.inbox, 'resume'))


if __name__ == '__main__':
    unittest.main()
