"""No-network contracts for one-consumer Slack handoff admission."""
import asyncio
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from types import SimpleNamespace

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts/macos'
sys.path.insert(0, str(SCRIPTS))
from migration_socket_inbox import SocketInbox
from migration_slack_dispatch import DispatchLedger, HandoffPump, ConsumerBusy, CaptureReceiver


def event(number=1, envelope=None):
    return {'envelope_id': envelope or 'envelope-' + str(number), 'type': 'events_api',
            'payload': {'type': 'event_callback', 'team_id': 'T1', 'api_app_id': 'A1',
                        'event_id': 'Ev' + str(number),
                        'event': {'type': 'message', 'text': '합성 인계 검증'}}}


class DispatchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'inbox.sqlite3'
        self.inbox = SocketInbox(self.path, team_id='T1', app_id='A1')
        self.ledger = DispatchLedger(self.inbox)
        self.authorized = True
        self.calls = []
        async def dispatch(envelope):
            self.calls.append(envelope)
            return SimpleNamespace(status=200)
        self.dispatch = dispatch
        self.pump = HandoffPump(self.ledger, can_dispatch=lambda: self.authorized,
                                dispatch=self.dispatch)

    def tearDown(self):
        self.ledger.close()
        self.inbox.close()
        self.temp.cleanup()

    def sql(self, query):
        with closing(sqlite3.connect(self.path)) as db:
            return db.execute(query).fetchall()

    def consume(self):
        return asyncio.run(self.pump.consume_one())

    def test_closed_authority_never_claims_or_dispatches(self):
        self.inbox.record(event())
        self.authorized = False
        self.assertEqual(self.consume()['state'], 'blocked')
        self.assertEqual(self.calls, [])
        self.assertEqual(self.sql('SELECT COUNT(*) FROM handoff_dispatches')[0][0], 0)

    def test_truthy_non_boolean_authority_is_refused(self):
        self.inbox.record(event())
        self.authorized = 1
        self.assertEqual(self.consume()['state'], 'blocked')
        self.assertEqual(self.calls, [])

    def test_admission_preserves_full_payload_and_never_claims_business_completion(self):
        value = event()
        value['retry_attempt'] = 2
        self.inbox.record(value)
        got = self.consume()
        self.assertEqual(self.calls, [value])
        self.assertEqual(got['state'], 'admitted')
        self.assertFalse(got['business_outcome_verified'])
        self.assertEqual(self.consume()['state'], 'empty')

    def test_next_claim_follows_capture_order(self):
        for number in (3, 1, 2):
            self.inbox.record(event(number))
        for _ in range(3):
            self.assertEqual(self.consume()['state'], 'admitted')
        self.assertEqual([v['payload']['event_id'] for v in self.calls], ['Ev3', 'Ev1', 'Ev2'])

    def test_duplicate_delivery_after_admission_is_never_dispatched_again(self):
        self.inbox.record(event())
        self.consume()
        self.inbox.record(event(envelope='new-envelope'))
        self.assertEqual(self.consume()['state'], 'empty')
        self.assertEqual(len(self.calls), 1)

    def test_dispatch_failure_is_uncertain_and_blocks_new_work(self):
        async def fail(value):
            self.calls.append(value)
            raise RuntimeError('private error detail must not appear in status')
        self.pump.dispatch = fail
        self.inbox.record(event())
        self.inbox.record(event(2))
        got = self.consume()
        self.assertEqual(got['state'], 'uncertain')
        self.assertNotIn('private', json.dumps(got))
        self.assertEqual(self.consume()['state'], 'blocked')
        self.assertEqual(len(self.calls), 1)

    def test_non_success_sdk_response_is_not_retried(self):
        async def rejected(_):
            return SimpleNamespace(status=403)
        self.pump.dispatch = rejected
        self.inbox.record(event())
        self.assertEqual(self.consume()['state'], 'uncertain')
        self.assertEqual(self.consume()['state'], 'blocked')

    def test_interruption_after_claim_remains_held_after_reopen(self):
        self.inbox.record(event())
        claim = self.ledger.claim_next()
        self.assertIsNotNone(claim)
        self.ledger.close()
        self.ledger = DispatchLedger(self.inbox)
        self.pump = HandoffPump(self.ledger, can_dispatch=lambda: True, dispatch=self.dispatch)
        self.assertEqual(self.consume()['state'], 'blocked')
        self.assertEqual(self.calls, [])

    def test_unconfirmed_admission_stays_blocked_after_reopen(self):
        self.inbox.record(event())
        claim = self.ledger.claim_next()
        self.assertEqual(self.ledger.finish(claim, admitted=True, detail='bolt_admitted'),
                         'admission_pending')
        self.ledger.close()
        self.ledger = DispatchLedger(self.inbox)
        self.pump = HandoffPump(self.ledger, can_dispatch=lambda: True, dispatch=self.dispatch)
        self.assertEqual(self.consume()['state'], 'blocked')

    def test_second_consumer_is_refused(self):
        with self.assertRaises(ConsumerBusy):
            DispatchLedger(self.inbox)

    def test_other_process_cannot_take_the_consumer_lease(self):
        code = '''import sys
sys.path.insert(0,sys.argv[1])
from migration_socket_inbox import SocketInbox
from migration_slack_dispatch import DispatchLedger,ConsumerBusy
inbox=SocketInbox(sys.argv[2],team_id='T1',app_id='A1')
try: ledger=DispatchLedger(inbox)
except ConsumerBusy: sys.exit(43)
ledger.close();inbox.close()
'''
        def run():
            return subprocess.run([sys.executable, '-c', code, str(SCRIPTS), str(self.path)],
                                  capture_output=True, timeout=15)
        self.assertEqual(run().returncode, 43)
        self.ledger.close()
        self.assertEqual(run().returncode, 0)
        self.ledger = DispatchLedger(self.inbox)

    def test_finish_commit_failure_preserves_no_retry_fence(self):
        reader = sqlite3.connect(self.path)
        self.ledger._db.execute('PRAGMA busy_timeout=50')
        async def accepted_but_locked(value):
            self.calls.append(value)
            reader.execute('BEGIN')
            reader.execute('SELECT * FROM handoff_dispatches').fetchall()
            return SimpleNamespace(status=200)
        self.pump.dispatch = accepted_but_locked
        self.inbox.record(event())
        try:
            self.assertEqual(self.consume()['state'], 'uncertain')
        finally:
            reader.close()
        self.assertEqual(self.sql('SELECT state FROM handoff_dispatches'), [('dispatching',)])
        self.assertEqual(self.consume()['state'], 'blocked')
        self.assertEqual(len(self.calls), 1)

    def test_capture_conflict_blocks_admission(self):
        self.inbox.record(event())
        changed = event(envelope='conflict')
        changed['payload']['event']['text'] = '충돌'
        self.inbox.record(changed)
        self.assertEqual(self.consume()['state'], 'blocked')
        self.assertEqual(self.calls, [])

    def test_authority_revoked_during_dispatch_is_uncertain(self):
        async def revoke(_):
            self.authorized = False
            return SimpleNamespace(status=200)
        self.pump.dispatch = revoke
        self.inbox.record(event())
        self.assertEqual(self.consume()['state'], 'uncertain')

    def test_cancelled_dispatch_is_not_replayed(self):
        async def cancelled(_):
            raise asyncio.CancelledError()
        self.pump.dispatch = cancelled
        self.inbox.record(event())
        with self.assertRaises(asyncio.CancelledError):
            self.consume()
        self.assertEqual(self.consume()['state'], 'blocked')

    def test_cancelled_finish_keeps_a_blocking_fence_after_worker_settles(self):
        self.inbox.record(event())
        self.inbox.record(event(2))
        entered, release, settled = threading.Event(), threading.Event(), threading.Event()
        original = self.ledger.finish
        def delayed_finish(*args, **kwargs):
            entered.set()
            if not release.wait(timeout=5):
                raise RuntimeError('Test finish gate timed out')
            try:
                return original(*args, **kwargs)
            finally:
                settled.set()
        self.ledger.finish = delayed_finish
        async def exercise():
            task = asyncio.create_task(self.pump.consume_one())
            try:
                self.assertTrue(await asyncio.to_thread(entered.wait, 3))
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
            finally:
                release.set()
            self.assertTrue(await asyncio.to_thread(settled.wait, 3))
            self.assertNotEqual(self.sql('SELECT state FROM handoff_dispatches')[0][0], 'admitted')
            self.assertEqual((await self.pump.consume_one())['state'], 'blocked')
        asyncio.run(exercise())
        self.assertEqual(len(self.calls), 1)

    def test_capture_receiver_commits_before_ack_and_does_not_dispatch(self):
        receiver = CaptureReceiver(self.inbox)
        seen = []
        async def ack(envelope_id):
            self.assertEqual(self.inbox.status()['events'], 1)
            self.assertEqual(self.sql('SELECT COUNT(*) FROM handoff_dispatches')[0][0], 0)
            seen.append(envelope_id)
        asyncio.run(receiver.receive(event(), ack))
        self.assertEqual(seen, ['envelope-1'])
        self.assertEqual(self.calls, [])

    def test_unsupported_request_is_stored_and_not_acknowledged(self):
        receiver = CaptureReceiver(self.inbox)
        seen = []
        async def ack(value):
            seen.append(value)
        asyncio.run(receiver.receive({'type': 'interactive', 'envelope_id': 'click',
                                     'payload': {'type': 'block_actions'}}, ack))
        self.assertEqual(seen, [])
        self.assertEqual(self.consume()['state'], 'blocked')


class InstalledSdkTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_bolt_dispatch_preserves_the_original_listener_pipeline(self):
        from unittest.mock import patch
        from slack_bolt.async_app import AsyncApp
        from slack_bolt.authorization import AuthorizeResult
        from migration_slack_dispatch import dispatch_to_existing_bolt_app
        received = []
        done = asyncio.Event()
        async def authorize(enterprise_id, team_id, user_id):
            return AuthorizeResult(enterprise_id=None, team_id='T1', bot_user_id='B1',
                                   bot_id='B1', bot_token='xoxb-fixture')
        app = AsyncApp(authorize=authorize, ignoring_self_events_enabled=False)
        @app.event('message')
        async def handle(body):
            received.append(body)
            done.set()
        value = event()
        value['payload']['event'].update(user='U1', channel='C1', ts='1700000000.000001')
        with patch('socket.socket.connect', side_effect=AssertionError('No test network')):
            result = await dispatch_to_existing_bolt_app(app, value)
            self.assertEqual(result.status, 200)
            await asyncio.wait_for(done.wait(), timeout=2)
        self.assertEqual(received, [value['payload']])

    async def test_sdk_receiver_preserves_retry_metadata_before_ack(self):
        from slack_sdk.socket_mode.request import SocketModeRequest
        with tempfile.TemporaryDirectory() as directory:
            inbox = SocketInbox(Path(directory) / 'inbox.sqlite3', team_id='T1', app_id='A1')
            sent = []
            class Client:
                async def send_socket_mode_response(self, response):
                    self_test.assertEqual(inbox.status()['events'], 1)
                    sent.append(response.envelope_id)
            self_test = self
            value = event()
            value.update(retry_attempt=2, retry_reason='timeout', accepts_response_payload=True)
            try:
                receiver = CaptureReceiver(inbox)
                await receiver.on_socket_request(Client(), SocketModeRequest.from_dict(value))
                self.assertEqual(sent, ['envelope-1'])
                with closing(sqlite3.connect(inbox.path)) as db:
                    saved = json.loads(db.execute('SELECT raw_json FROM deliveries').fetchone()[0])
                self.assertEqual(saved, value)
            finally:
                inbox.close()


if __name__ == '__main__':
    unittest.main()
