"""One-consumer admission journal for the inactive Slack handoff preparation.

No connection is opened here. Capture ACKs only after durable inbox storage.
Admission invokes the original Bolt dispatcher once, under caller-verified live
authority. A Bolt 200 means admitted, never verified business completion. Any
interrupted/uncertain claim blocks subsequent admission; there is no auto-retry,
receipt reset or recovery shortcut. Source closure, interactive deadlines and
authoritative business reconciliation remain separate mandatory gates.
"""
import asyncio
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import threading
from uuid import uuid4

from migration_socket_inbox import _canonical, persist_then_ack


class ConsumerBusy(RuntimeError):
    pass


class AdmissionBlocked(RuntimeError):
    pass


class _ConsumerLease:
    def __init__(self, database):
        path = Path(str(database) + '.consumer.lock')
        if path.is_symlink():
            raise ValueError('Consumer lock must not be a symlink')
        try:
            created = os.open(path, os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
        except FileExistsError:
            pass
        else:
            try:
                os.write(created, b'0')
                os.fsync(created)
            finally:
                os.close(created)
        self.fd = os.open(path, os.O_RDWR)
        try:
            if os.name == 'nt':
                import msvcrt
                os.lseek(self.fd, 0, os.SEEK_SET)
                msvcrt.locking(self.fd, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(self.fd)
            self.fd = None
            raise ConsumerBusy('Inbox already has an admission owner') from None

    def close(self):
        if self.fd is None:
            return
        if os.name == 'nt':
            import msvcrt
            os.lseek(self.fd, 0, os.SEEK_SET)
            msvcrt.locking(self.fd, msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(self.fd, fcntl.LOCK_UN)
        os.close(self.fd)
        self.fd = None


@dataclass(frozen=True)
class AdmissionClaim:
    event_key: str
    claim_id: str
    envelope: dict


class DispatchLedger:
    def __init__(self, inbox):
        self._mutex = threading.Lock()
        self._lease = _ConsumerLease(inbox.path)
        self._db = None
        self._owner = str(uuid4())
        try:
            db = sqlite3.connect(inbox.path, timeout=5, isolation_level=None,
                                 check_same_thread=False)
            self._db = db
            expected = {'schema': 'village-slack-handoff-inbox/v1',
                        'team_id': inbox.team_id, 'app_id': inbox.app_id}
            if dict(db.execute('SELECT key,value FROM metadata')) != expected:
                raise ValueError('Inbox identity or schema changed')
            if db.execute('PRAGMA journal_mode=DELETE').fetchone()[0] != 'delete':
                raise RuntimeError('Durable admission journal unavailable')
            db.execute('PRAGMA synchronous=EXTRA')
            db.execute('PRAGMA fullfsync=ON')
            db.execute('PRAGMA foreign_keys=ON')
            if db.execute('PRAGMA synchronous').fetchone()[0] != 3:
                raise RuntimeError('Durable admission commit unavailable')
            db.execute('''CREATE TABLE IF NOT EXISTS handoff_dispatches (
                event_key TEXT PRIMARY KEY REFERENCES events(event_key),
                claim_id TEXT UNIQUE NOT NULL, owner TEXT NOT NULL,
                state TEXT NOT NULL CHECK(state IN ('dispatching','admission_pending','admitted','uncertain')),
                delivery_sha256 TEXT NOT NULL, detail TEXT NOT NULL)''')
            columns = [row[1] for row in db.execute('PRAGMA table_info(handoff_dispatches)')]
            if columns != ['event_key', 'claim_id', 'owner', 'state', 'delivery_sha256', 'detail']:
                raise ValueError('Admission journal schema changed')
            sql = db.execute("SELECT sql FROM sqlite_master WHERE name='handoff_dispatches'").fetchone()[0]
            if "'admission_pending'" not in sql:
                raise ValueError('Admission journal lacks the confirmation fence')
        except BaseException:
            self.close()
            raise

    def close(self):
        with self._mutex:
            if self._db is not None:
                self._db.close()
                self._db = None
            self._lease.close()

    def claim_next(self):
        with self._mutex:
            db = self._db
            if db is None:
                raise AdmissionBlocked('Admission owner is closed')
            db.execute('BEGIN IMMEDIATE')
            try:
                if db.execute("SELECT 1 FROM handoff_dispatches WHERE state IN ('dispatching','admission_pending','uncertain') LIMIT 1").fetchone():
                    raise AdmissionBlocked('Prior admission outcome is uncertain')
                if db.execute("SELECT 1 FROM events WHERE state='held' LIMIT 1").fetchone():
                    raise AdmissionBlocked('Inbox contains held input')
                row = db.execute('''SELECT e.event_key,e.payload_sha256 FROM events e
                    WHERE e.state='captured' AND NOT EXISTS
                    (SELECT 1 FROM handoff_dispatches d WHERE d.event_key=e.event_key)
                    ORDER BY e.sequence LIMIT 1''').fetchone()
                if row is None:
                    db.execute('COMMIT')
                    return None
                key, payload_sha = row
                delivery = db.execute('''SELECT delivery_sha256,raw_json FROM deliveries
                    WHERE event_key=? AND payload_sha256=? ORDER BY received_at,delivery_sha256 LIMIT 1''',
                                      (key, payload_sha)).fetchone()
                if delivery is None or hashlib.sha256(delivery[1].encode()).hexdigest() != delivery[0]:
                    raise AdmissionBlocked('Captured delivery integrity failed')
                envelope = json.loads(delivery[1])
                if hashlib.sha256(_canonical(envelope.get('payload')).encode()).hexdigest() != payload_sha:
                    raise AdmissionBlocked('Captured payload integrity failed')
                claim_id = str(uuid4())
                db.execute('INSERT INTO handoff_dispatches VALUES (?,?,?,?,?,?)',
                           (key, claim_id, self._owner, 'dispatching', delivery[0], ''))
                db.execute('COMMIT')
                return AdmissionClaim(key, claim_id, envelope)
            except BaseException:
                if db.in_transaction:
                    db.execute('ROLLBACK')
                raise

    def finish(self, claim, *, admitted, detail):
        with self._mutex:
            db = self._db
            if db is None:
                raise AdmissionBlocked('Admission owner is closed')
            db.execute('BEGIN IMMEDIATE')
            try:
                row = db.execute('''SELECT d.state,e.state FROM handoff_dispatches d
                    JOIN events e USING(event_key) WHERE d.event_key=? AND d.claim_id=? AND d.owner=?''',
                                 (claim.event_key, claim.claim_id, self._owner)).fetchone()
                if row is None or row[0] != 'dispatching':
                    raise AdmissionBlocked('Admission claim changed')
                state = 'admission_pending' if admitted is True and row[1] == 'captured' else 'uncertain'
                db.execute('UPDATE handoff_dispatches SET state=?,detail=? WHERE claim_id=?',
                           (state, detail, claim.claim_id))
                db.execute('COMMIT')
                return state
            except BaseException:
                if db.in_transaction:
                    db.execute('ROLLBACK')
                raise

    def confirm(self, claim):
        """Short final commit with no async cancellation point before return.

        Worker threads may finish after cancellation. They can write only the
        blocking admission_pending state; only the surviving caller confirms.
        """
        with self._mutex:
            db = self._db
            if db is None:
                raise AdmissionBlocked('Admission owner is closed')
            db.execute('BEGIN IMMEDIATE')
            try:
                row = db.execute('''SELECT d.state,e.state FROM handoff_dispatches d
                    JOIN events e USING(event_key) WHERE d.event_key=? AND d.claim_id=? AND d.owner=?''',
                                 (claim.event_key, claim.claim_id, self._owner)).fetchone()
                if row is None or row[0] != 'admission_pending':
                    raise AdmissionBlocked('Admission confirmation changed')
                state = 'admitted' if row[1] == 'captured' else 'uncertain'
                db.execute('UPDATE handoff_dispatches SET state=? WHERE claim_id=?',
                           (state, claim.claim_id))
                db.execute('COMMIT')
                return state
            except BaseException:
                if db.in_transaction:
                    db.execute('ROLLBACK')
                raise


class CaptureReceiver:
    """Storage adapter only. Unsupported types stay held without an ACK."""
    def __init__(self, inbox):
        self.inbox = inbox

    async def receive(self, envelope, ack):
        return await persist_then_ack(self.inbox, envelope, ack)

    async def on_socket_request(self, client, request):
        from slack_sdk.socket_mode.response import SocketModeResponse
        # SDK to_dict() omits retry metadata and response-payload capability.
        envelope = request.to_dict()
        envelope['accepts_response_payload'] = request.accepts_response_payload
        for field in ('retry_attempt', 'retry_reason'):
            value = getattr(request, field, None)
            if value is not None:
                envelope[field] = value
        async def ack(envelope_id):
            await client.send_socket_mode_response(SocketModeResponse(envelope_id=envelope_id))
        return await self.receive(envelope, ack)


class HandoffPump:
    """Caller supplies fresh source-closure/activation authority for EACH claim.

    The callback is a trusted orchestration boundary, not an input from Slack.
    This class never creates that authority or treats a port/health 200 as proof.
    """
    def __init__(self, ledger, *, can_dispatch, dispatch):
        self.ledger, self.can_dispatch, self.dispatch = ledger, can_dispatch, dispatch
        self._lock = asyncio.Lock()

    def _authorized(self):
        try:
            return self.can_dispatch() is True
        except Exception:
            return False

    async def _finish(self, claim, admitted, detail):
        try:
            return await asyncio.to_thread(self.ledger.finish, claim, admitted=admitted, detail=detail)
        except Exception:
            # The already committed dispatching claim remains a no-retry fence.
            return 'uncertain'

    async def consume_one(self):
        async with self._lock:
            if not self._authorized():
                return {'state': 'blocked', 'reason': 'authority_unavailable'}
            try:
                claim = await asyncio.to_thread(self.ledger.claim_next)
            except AdmissionBlocked:
                return {'state': 'blocked', 'reason': 'held_or_uncertain_input'}
            if claim is None:
                return {'state': 'empty'}
            if not self._authorized():
                await self._finish(claim, False, 'authority_revoked_before_dispatch')
                return {'state': 'uncertain', 'reason': 'authority_revoked'}
            try:
                response = await self.dispatch(claim.envelope)
            except BaseException as error:
                await self._finish(claim, False, 'dispatch_exception')
                if isinstance(error, (asyncio.CancelledError, KeyboardInterrupt, SystemExit)):
                    raise
                return {'state': 'uncertain', 'reason': 'dispatch_exception',
                        'error_type': type(error).__name__}
            accepted = getattr(response, 'status', None) == 200 and self._authorized()
            state = await self._finish(claim, accepted, 'bolt_admitted' if accepted else 'admission_not_verified')
            if state == 'admission_pending':
                # No await from this last authority check through confirmation
                # and return. Cancellation at the worker await leaves pending.
                if not self._authorized():
                    return {'state': 'uncertain', 'reason': 'authority_revoked'}
                try:
                    state = self.ledger.confirm(claim)
                except Exception:
                    state = 'uncertain'
            return {'state': state, 'event_key': claim.event_key, 'business_outcome_verified': False}


async def dispatch_to_existing_bolt_app(app, envelope):
    """Use the installed original Bolt pipeline, without a second network ACK."""
    from slack_sdk.socket_mode.request import SocketModeRequest
    from slack_bolt.adapter.socket_mode.async_internals import run_async_bolt_app
    request = SocketModeRequest.from_dict(envelope)
    if request is None:
        raise ValueError('Malformed captured socket request')
    return await run_async_bolt_app(app, request)
