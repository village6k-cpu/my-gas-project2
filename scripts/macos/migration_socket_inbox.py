"""Offline durable storage primitive for the migration's Slack ingress handoff.

This module does not connect to Slack, run a gateway, or execute/replay work.
Only recognized event callbacks may be ACKed, after a SQLite EXTRA commit.
Unknown inputs and identity/content conflicts are retained for inspection and
never ACKed here. Interactive requests require their own timely response design;
storing them does not make their expiring trigger IDs safe to replay.

Callers must durably provision a protected local directory in advance, not a
network share. Missing directories are rejected. This is one handoff building
block, not authority to drain/stop the current business consumer.
"""
import asyncio
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import threading
from datetime import datetime, timezone

MAX_ENVELOPE_BYTES = 2 * 1024 * 1024
SCHEMA = 'village-slack-handoff-inbox/v1'
ID = re.compile(r'[A-Za-z0-9_-]{1,200}\Z')


def _identifier(value):
    return isinstance(value, str) and ID.fullmatch(value) is not None


def _canonical(value):
    def validate(item):
        if isinstance(item, dict):
            if not all(isinstance(key, str) for key in item):
                raise ValueError('Envelope contains non-JSON keys')
            for child in item.values():
                validate(child)
        elif isinstance(item, list):
            for child in item:
                validate(child)
        elif item is not None and type(item) not in (str, int, float, bool):
            raise ValueError('Envelope contains non-JSON data')
    validate(value)
    return json.dumps(value, ensure_ascii=False, allow_nan=False,
                      sort_keys=True, separators=(',', ':'))


def _sha(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


@dataclass(frozen=True)
class CaptureReceipt:
    event_key: str
    delivery_sha256: str
    envelope_id: str | None
    sequence: int
    disposition: str
    ack_allowed: bool


class SocketInbox:
    def __init__(self, path, *, team_id, app_id):
        if not _identifier(team_id) or not _identifier(app_id):
            raise ValueError('Invalid inbox identity')
        self.path = Path(path).absolute()
        self.team_id, self.app_id = team_id, app_id
        self._lock = threading.Lock()
        self._db = None
        # Do not silently create a directory tree whose own parent entries have
        # not been durably provisioned. The caller owns that preparation step.
        if not self.path.parent.is_dir():
            raise ValueError('Inbox directory must be provisioned before use')
        if self.path.is_symlink():
            raise ValueError('Inbox database must not be a symlink')
        try:
            fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            fresh = False
        else:
            os.close(fd)
            fresh = True
        if os.name == 'posix' and (self.path.stat().st_mode & 0o077):
            raise ValueError('Inbox database must be private')
        db = sqlite3.connect(self.path, timeout=5, isolation_level=None,
                             check_same_thread=False)
        expected = {'schema': SCHEMA, 'team_id': team_id, 'app_id': app_id}
        try:
            if not fresh:
                try:
                    actual = dict(db.execute('SELECT key, value FROM metadata'))
                except sqlite3.DatabaseError:
                    raise ValueError('Unrecognized inbox database') from None
                if actual != expected:
                    raise ValueError('Inbox identity or schema changed')
            # EXTRA also syncs the directory after journal unlink; fullfsync
            # requests the stronger macOS storage flush where available.
            if db.execute('PRAGMA journal_mode=DELETE').fetchone()[0] != 'delete':
                raise RuntimeError('Inbox journal mode unavailable')
            db.execute('PRAGMA synchronous=EXTRA')
            db.execute('PRAGMA fullfsync=ON')
            db.execute('PRAGMA foreign_keys=ON')
            if db.execute('PRAGMA synchronous').fetchone()[0] != 3:
                raise RuntimeError('Durable inbox commit unavailable')
            if fresh:
                db.execute('BEGIN IMMEDIATE')
                db.execute('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
                db.executemany('INSERT INTO metadata VALUES (?,?)', expected.items())
                db.execute('''CREATE TABLE events (
                    sequence INTEGER PRIMARY KEY, event_key TEXT UNIQUE NOT NULL,
                    payload_sha256 TEXT NOT NULL, state TEXT NOT NULL,
                    reason TEXT NOT NULL, received_at TEXT NOT NULL)''')
                db.execute('''CREATE TABLE deliveries (
                    delivery_sha256 TEXT PRIMARY KEY, event_key TEXT NOT NULL
                    REFERENCES events(event_key), envelope_id TEXT,
                    payload_sha256 TEXT NOT NULL, raw_json TEXT NOT NULL,
                    received_at TEXT NOT NULL)''')
                db.execute('CREATE TABLE envelopes (envelope_id TEXT PRIMARY KEY, event_key TEXT NOT NULL)')
                db.execute('COMMIT')
                if os.name == 'posix':
                    directory_fd = os.open(self.path.parent, os.O_RDONLY | os.O_DIRECTORY)
                    try:
                        os.fsync(directory_fd)
                    finally:
                        os.close(directory_fd)
            self._db = db
        except BaseException:
            db.close()
            raise

    def close(self):
        with self._lock:
            if self._db is not None:
                self._db.close()
                self._db = None

    def record(self, envelope):
        if not isinstance(envelope, dict):
            raise ValueError('Envelope must be a JSON object')
        raw = _canonical(envelope)
        if len(raw.encode('utf-8')) > MAX_ENVELOPE_BYTES:
            raise ValueError('Envelope exceeds inbox size limit')
        # All routing and ACK decisions must describe the committed snapshot,
        # even if a caller changes its original mutable object concurrently.
        envelope = json.loads(raw)
        delivery_sha = _sha(raw)
        payload = envelope.get('payload')
        payload_sha = _sha(_canonical(payload))
        envelope_id = envelope.get('envelope_id')
        reason = ''
        if not _identifier(envelope_id):
            reason = 'missing_envelope_identity'
        elif (envelope.get('type') != 'events_api' or not isinstance(payload, dict)
              or payload.get('type') != 'event_callback'):
            reason = 'unsupported_request'
        elif payload.get('team_id') != self.team_id or payload.get('api_app_id') != self.app_id:
            reason = 'identity_mismatch'
        elif not _identifier(payload.get('event_id')) or not isinstance(payload.get('event'), dict):
            reason = 'missing_event_identity'
        event_key = ('held:' + delivery_sha if reason else
                     'event:' + self.team_id + ':' + payload['event_id'])
        received_at = datetime.now(timezone.utc).isoformat()
        with self._lock:
            db = self._db
            if db is None:
                raise RuntimeError('Inbox is closed')
            db.execute('BEGIN IMMEDIATE')
            try:
                prior = db.execute('SELECT payload_sha256 FROM events WHERE event_key=?',
                                   (event_key,)).fetchone()
                db.execute('''INSERT OR IGNORE INTO events
                    (event_key,payload_sha256,state,reason,received_at) VALUES (?,?,?,?,?)''',
                           (event_key, payload_sha, 'held' if reason else 'captured', reason, received_at))
                db.execute('''INSERT OR IGNORE INTO deliveries VALUES (?,?,?,?,?,?)''',
                           (delivery_sha, event_key, envelope_id if isinstance(envelope_id, str) else None,
                            payload_sha, raw, received_at))
                if prior and prior[0] != payload_sha:
                    db.execute("UPDATE events SET state='held',reason='payload_conflict' WHERE event_key=?",
                               (event_key,))
                if _identifier(envelope_id):
                    old = db.execute('SELECT event_key FROM envelopes WHERE envelope_id=?',
                                     (envelope_id,)).fetchone()
                    if old and old[0] != event_key:
                        db.execute("UPDATE events SET state='held',reason='envelope_conflict' WHERE event_key IN (?,?)",
                                   (old[0], event_key))
                    db.execute('INSERT OR IGNORE INTO envelopes VALUES (?,?)', (envelope_id, event_key))
                sequence, state = db.execute('SELECT sequence,state FROM events WHERE event_key=?',
                                             (event_key,)).fetchone()
                db.execute('COMMIT')
            except BaseException:
                if db.in_transaction:
                    db.execute('ROLLBACK')
                raise
        return CaptureReceipt(event_key, delivery_sha, envelope_id if _identifier(envelope_id) else None, sequence,
                              'held' if state == 'held' else ('duplicate' if prior else 'captured'),
                              state == 'captured')

    def status(self):
        with self._lock:
            if self._db is None:
                raise RuntimeError('Inbox is closed')
            events, deliveries, held = self._db.execute('''SELECT
                (SELECT COUNT(*) FROM events), (SELECT COUNT(*) FROM deliveries),
                (SELECT COUNT(*) FROM events WHERE state='held')''').fetchone()
        return {'events': events, 'deliveries': deliveries, 'held': held}


async def persist_then_ack(inbox, envelope, ack):
    # Storage is off the event loop; awaiting it preserves commit-before-ACK.
    receipt = await asyncio.to_thread(inbox.record, envelope)
    if receipt.ack_allowed:
        await ack(receipt.envelope_id)
    return receipt
