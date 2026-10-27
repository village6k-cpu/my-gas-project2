"""Durable voice handoff primitives; importing does not serve or forward traffic.

Accepted intake is independent of business completion. A single forwarding owner
commits its claim before contacting the original relay. Any interrupted or
uncertain delivery blocks subsequent forwarding, with no automatic retry/reset.
The caller must bind authority to the actual migration phase and source closure.
"""
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import sqlite3
import threading
import time
from urllib.parse import parse_qs
from urllib.request import Request, HTTPRedirectHandler, build_opener

from migration_slack_dispatch import _ConsumerLease

SCHEMA = 'village-voice-handoff/v1'
REQUIRED_NATIVE_GATES = ('backups_verified', 'model_quality_verified', 'performance_verified',
                         'coexistence_verified', 'windows_consumers_drained',
                         'final_state_reconciled', 'rollback_ready')


class VoiceBlocked(RuntimeError):
    pass


def parse_voice(body, content_type, request_id='', *, now=None):
    if not isinstance(body, bytes) or not 0 < len(body) <= 16384:
        raise ValueError('Invalid voice body length')
    text = body.decode('utf-8')
    kind = content_type.lower()
    if 'application/json' in kind:
        data = json.loads(text)
        if not isinstance(data, dict):
            raise ValueError('Voice body must be an object')
        text = next((data[k] for k in ('text', 'transcript', 'speech', 'input')
                     if data.get(k) is not None), '')
        request_id = data.get('request_id') or request_id
    elif 'application/x-www-form-urlencoded' in kind:
        data = parse_qs(text)
        text = next((data[k][0] for k in ('text', 'transcript', 'speech', 'input')
                     if data.get(k)), '')
        # The current relay reads form IDs from the HTTP header only.
    if not isinstance(text, str) or not isinstance(request_id, str):
        raise ValueError('Voice fields must be strings')
    text = re.sub(r'\s+', ' ', text).strip()
    request_id = request_id.strip()
    if not text or len(text) > 2000 or len(request_id) > 512 or '\0' in request_id:
        raise ValueError('Invalid voice fields')
    if not request_id:
        bucket = int((time.time() if now is None else now) // 60)
        request_id = hashlib.sha256(f'{bucket}\n{text}'.encode('utf-8')).hexdigest()
    return text, request_id


class VoiceInbox:
    def __init__(self, path):
        self.path = Path(path).absolute()
        self._lock = threading.Lock()
        self._db = None
        if not self.path.parent.is_dir() or self.path.is_symlink():
            raise ValueError('Private inbox directory must be provisioned')
        try:
            fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            fresh = False
        else:
            os.close(fd)
            fresh = True
        if os.name == 'posix' and self.path.stat().st_mode & 0o077:
            raise ValueError('Voice database must be private')
        db = sqlite3.connect(self.path, timeout=5, isolation_level=None,
                             check_same_thread=False)
        try:
            if not fresh and dict(db.execute('SELECT key,value FROM metadata')) != {'schema': SCHEMA}:
                raise ValueError('Voice database identity changed')
            if db.execute('PRAGMA journal_mode=DELETE').fetchone()[0] != 'delete':
                raise RuntimeError('Durable voice journal unavailable')
            db.execute('PRAGMA synchronous=EXTRA')
            db.execute('PRAGMA fullfsync=ON')
            if db.execute('PRAGMA synchronous').fetchone()[0] != 3:
                raise RuntimeError('Durable voice commit unavailable')
            if fresh:
                db.execute('BEGIN IMMEDIATE')
                db.execute('CREATE TABLE metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL)')
                db.execute('INSERT INTO metadata VALUES (?,?)', ('schema', SCHEMA))
                db.execute('''CREATE TABLE requests (
                    sequence INTEGER PRIMARY KEY, request_id TEXT UNIQUE NOT NULL,
                    text TEXT NOT NULL, state TEXT NOT NULL
                    CHECK(state IN ('queued','dispatching','delivered','uncertain')),
                    target TEXT, response TEXT, created REAL NOT NULL)''')
                db.execute('''CREATE TABLE conflicts (
                    sequence INTEGER PRIMARY KEY, request_id TEXT NOT NULL,
                    text TEXT NOT NULL, created REAL NOT NULL)''')
                db.execute('COMMIT')
                if os.name == 'posix':
                    directory = os.open(self.path.parent, os.O_RDONLY | os.O_DIRECTORY)
                    try: os.fsync(directory)
                    finally: os.close(directory)
            self._db = db
        except BaseException:
            db.close()
            raise

    def close(self):
        with self._lock:
            if self._db is not None:
                self._db.close()
                self._db = None

    def capture(self, text, request_id):
        normalized, key = parse_voice(json.dumps({'text': text, 'request_id': request_id}).encode('utf-8'),
                                      'application/json')
        with self._lock:
            db = self._db
            if db is None: raise RuntimeError('Inbox is closed')
            db.execute('BEGIN IMMEDIATE')
            try:
                old = db.execute('SELECT text,state,response FROM requests WHERE request_id=?', (key,)).fetchone()
                conflict = old is not None and old[0] != normalized
                if conflict:
                    db.execute('INSERT INTO conflicts(request_id,text,created) VALUES (?,?,?)',
                               (key, normalized, time.time()))
                elif old is None:
                    db.execute('INSERT INTO requests(request_id,text,state,created) VALUES (?,?,?,?)',
                               (key, normalized, 'queued', time.time()))
                db.execute('COMMIT')
            except BaseException:
                if db.in_transaction: db.execute('ROLLBACK')
                raise
            if conflict: raise VoiceBlocked('Request identity has conflicting content')
            result = {'request_id': key, 'state': old[1] if old else 'queued'}
            if old and old[2]: result['response'] = json.loads(old[2])
            return result

    def counts(self):
        with self._lock:
            return dict(self._db.execute('SELECT state,count(*) FROM requests GROUP BY state'))


class VoicePump:
    def __init__(self, inbox):
        self.inbox = inbox
        self._lease = _ConsumerLease(inbox.path)
        self._mutex = threading.Lock()

    def close(self):
        with self._mutex:
            self._lease.close()

    def __enter__(self): return self
    def __exit__(self, *_): self.close()

    def once(self, authority, send):
        """Forward at most once. Authority is None (held), windows, or mac.

        Successful relay admission is not proof that Hermes completed the work.
        The synchronous API deliberately contains no retry or state reset method.
        """
        with self._mutex:
            if self._lease.fd is None: raise VoiceBlocked('Forwarding owner is closed')
            target = authority()
            if target is None: return None
            if target not in ('windows', 'mac'): raise VoiceBlocked('Unknown forwarding authority')
            with self.inbox._lock:
                db = self.inbox._db
                db.execute('BEGIN IMMEDIATE')
                try:
                    if (db.execute('SELECT 1 FROM conflicts LIMIT 1').fetchone() or
                        db.execute("SELECT 1 FROM requests WHERE state IN ('dispatching','uncertain') LIMIT 1").fetchone()):
                        raise VoiceBlocked('Earlier voice delivery requires authoritative inspection')
                    row = db.execute("SELECT request_id,text FROM requests WHERE state='queued' ORDER BY sequence LIMIT 1").fetchone()
                    if row:
                        db.execute("UPDATE requests SET state='dispatching',target=? WHERE request_id=? AND state='queued'", (target, row[0]))
                    db.execute('COMMIT')
                except BaseException:
                    if db.in_transaction: db.execute('ROLLBACK')
                    raise
            if row is None: return None
            if authority() != target:
                raise VoiceBlocked('Forwarding authority revoked before send')
            try:
                code, response = send(target, {'text': row[1], 'request_id': row[0]})
                if (code != 202 or not isinstance(response, dict)
                        or response.get('status') not in ('accepted', 'duplicate')
                        or not isinstance(response.get('parent_ts'), str)
                        or not re.fullmatch(r'\d+\.\d+', response['parent_ts'])
                        or authority() != target):
                    raise VoiceBlocked('Relay acceptance was not verified')
                encoded = json.dumps(response, ensure_ascii=False, allow_nan=False)
            except BaseException:
                with self.inbox._lock:
                    db.execute("UPDATE requests SET state='uncertain' WHERE request_id=? AND state='dispatching'", (row[0],))
                raise VoiceBlocked('Voice forwarding result requires inspection') from None
            # Commit failure leaves dispatching. Neither path retries the effect.
            with self.inbox._lock:
                db.execute("UPDATE requests SET state='delivered',response=? WHERE request_id=? AND state='dispatching'",
                           (encoded, row[0]))
            return {'request_id': row[0], 'state': 'delivered', 'response': response}


class PhaseAuthority:
    """Private controller input; source lease is a bounded observation, not health.

    The Windows controller must freshly verify both exact process identities
    before renewing the lease, and stop renewing before source closure. Native
    dispatch additionally requires the final activation and closure hash binding.
    """
    def __init__(self, root, phase, epoch, source, *, manifest='runtime.json', now=time.time):
        self.root = Path(root).resolve()
        self.phase = Path(phase).resolve()
        self.manifest = (self.root / manifest).resolve()
        if not self.phase.is_relative_to(self.root) or not self.manifest.is_relative_to(self.root):
            raise ValueError('Authority paths must remain in the private installation')
        self.epoch = epoch
        self.source = json.loads(json.dumps(source))
        self.now = now

    def __call__(self):
        return self.observe()['authority']

    def observe(self):
        digest=None
        try:
            raw=self.phase.read_bytes()
            digest=hashlib.sha256(raw).hexdigest()
            data=json.loads(raw.decode('utf-8'))
            target=self._evaluate(data)
        except (OSError, ValueError, TypeError, AttributeError):
            target=None
        return {'authority':target,'phase_sha256':digest}

    def _evaluate(self,data):
        try:
            if (data.get('schema') != 'village-voice-phase/v1' or data.get('epoch') != self.epoch
                    or data.get('source') != self.source): return None
            closure = self.root / 'SOURCE-CLOSED.json'
            activation = self.root / 'ACTIVATION.json'
            if data.get('mode') == 'windows':
                verified = data.get('verified_unix')
                if (type(verified) not in (int, float) or not 0 <= self.now() - verified <= 15
                        or closure.exists() or activation.exists()): return None
                return 'windows'
            if data.get('mode') == 'mac':
                if (self.root/'MIGRATION-INACTIVE').exists(): return None
                closed_sha = hashlib.sha256(closure.read_bytes()).hexdigest()
                manifest_sha = hashlib.sha256(self.manifest.read_bytes()).hexdigest()
                proof = json.loads(activation.read_text(encoding='utf-8'))
                if (closed_sha != data.get('source_closed_sha256')
                        or closed_sha != proof.get('source_closed_sha256')
                        or manifest_sha != data.get('manifest_sha256')
                        or manifest_sha != proof.get('manifest_sha256')
                        or any(proof.get('gates', {}).get(g) is not True for g in REQUIRED_NATIVE_GATES)):
                    return None
                return 'mac'
        except (OSError, ValueError, TypeError, AttributeError):
            pass
        return None


class ForwardingLoop:
    """Process-local observation of the actual single consumer, never a lease.

    HTTP intake can remain healthy after a storage failure. Its readiness must
    therefore expose the real thread and the exact phase it last evaluated.
    """
    def __init__(self,pump,authority,send,*,config_sha256,epoch):
        self.pump,self.authority,self.send=pump,authority,send
        self.config_sha256,self.epoch=config_sha256,epoch
        self.stopping=threading.Event()
        self._lock=threading.Lock();self._last={};self._evaluated=None;self._failed=False
        self.thread=threading.Thread(target=self._run,daemon=True)

    def start(self):self.thread.start()

    def _authority(self):
        observation=self.authority.observe()
        with self._lock:
            self._last=observation;self._evaluated=time.monotonic()
        return observation['authority']

    def _run(self):
        while not self.stopping.is_set():
            try:self.pump.once(self._authority,self.send)
            except VoiceBlocked:pass  # Retain conflicts/uncertain claims; never retry them.
            except Exception:
                with self._lock:self._failed=True
                return
            self.stopping.wait(.25)

    def status(self):
        with self._lock:
            return dict(self._last,schema='village-voice-forwarder-runtime/v1',
                config_sha256=self.config_sha256,epoch=self.epoch,
                thread_alive=self.thread.is_alive() and not self.stopping.is_set(),
                failed=self._failed,evaluation_age_seconds=(
                    None if self._evaluated is None else time.monotonic()-self._evaluated))

    def stop(self):
        self.stopping.set();self.thread.join(timeout=30)


def make_server(inbox, bearer, *, port=18788, forwarder=None):
    if not isinstance(bearer, str) or len(bearer) < 43:
        raise ValueError('Strong voice bearer is required')

    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(5)

        def reply(self, status, value):
            body = json.dumps(value, separators=(',', ':')).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path.split('?', 1)[0].rstrip('/') not in ('/health', '/watch/voice/health'):
                self.reply(404, {'status': 'not_found'}); return
            self.reply(200, {'status': 'ok', 'role': 'durable_voice_intake',
                             'counts': inbox.counts(), 'business_completion_verified': False,
                             'forwarder':None if forwarder is None else forwarder.status()})

        def do_POST(self):
            if self.path.split('?', 1)[0].rstrip('/') not in ('', '/watch/voice'):
                self.reply(404, {'status': 'not_found'}); return
            supplied = self.headers.get('Authorization', '')
            scheme, sep, token = supplied.partition(' ')
            if not sep or scheme.lower() != 'bearer' or not hmac.compare_digest(token, bearer):
                self.reply(401, {'status': 'unauthorized'}); return
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 16384 or self.headers.get('Transfer-Encoding'):
                    raise ValueError('Invalid request length')
                body = self.rfile.read(length)
                if len(body) != length: raise ValueError('Incomplete request body')
                text, key = parse_voice(body, self.headers.get('Content-Type', ''),
                                        self.headers.get('X-Request-ID', ''))
                receipt = inbox.capture(text, key)
            except (ValueError, UnicodeError):
                self.reply(400, {'status': 'invalid_request'}); return
            except VoiceBlocked:
                self.reply(409, {'status': 'request_identity_conflict'}); return
            except (OSError, sqlite3.Error, RuntimeError):
                self.reply(503, {'status': 'intake_unavailable'}); return
            if receipt['state'] == 'delivered':
                self.reply(202, receipt['response'])
            else:
                self.reply(202, {'status': 'held' if receipt['state'] == 'uncertain' else 'queued',
                                 'request_id': key})

        def log_message(self, *_):
            pass  # Never log transcripts, request IDs or bearer headers.

    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.daemon_threads = True
    return server


def forward_to_relay(url, bearer, payload):
    class NoRedirect(HTTPRedirectHandler):
        def redirect_request(self, *_args, **_kwargs): return None
    body = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    req = Request(url, data=body, method='POST', headers={
        'Authorization': 'Bearer ' + bearer, 'Content-Type': 'application/json; charset=utf-8',
        'X-Request-ID': payload['request_id']})
    with build_opener(NoRedirect()).open(req, timeout=25) as response:
        raw = response.read(16385)
        if len(raw) > 16384: raise ValueError('Relay response exceeds limit')
        return response.status, json.loads(raw.decode('utf-8'))


def main():
    """Explicit native daemon entrypoint; config is pinned by its caller's hash.

    No routing or phase changes are performed here. All upstream addresses are
    fixed loopback endpoints: the verified SSH reverse tunnel, or native voice.
    """
    import argparse
    import sys
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--config-sha', required=True)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    raw = args.config.read_bytes()
    if hashlib.sha256(raw).hexdigest() != args.config_sha:
        raise ValueError('Voice intake config changed')
    config = json.loads(raw.decode('utf-8'))
    root = Path(config['root']).resolve()
    if (config.get('schema') != 'village-voice-service/v1'
            or root != Path('/Users/choijaehyeong/VillageMigration/20260930-windows/candidate')
            or not args.config.resolve().is_relative_to(root)):
        raise ValueError('Wrong isolated voice installation')
    def contained(name):
        path = Path(config[name]).resolve()
        if not path.is_relative_to(root): raise ValueError('Voice path outside installation')
        return path
    database, bearer_path, phase_path = (contained(name) for name in ('database', 'bearer_file', 'phase_file'))
    bearer = bearer_path.read_text(encoding='utf-8').strip()
    if len(bearer) < 43 or not database.parent.is_dir():
        raise ValueError('Private voice intake is not provisioned')
    authority = PhaseAuthority(root, phase_path, config['epoch'], config['source'],
                               manifest=config['runtime_manifest'])
    if args.check:
        print(json.dumps({'valid': True, 'serving': False, 'forwarding': False,
                          'authority': authority()}))
        return 0
    if sys.platform != 'darwin': raise RuntimeError('Voice handoff daemon requires macOS')
    inbox = VoiceInbox(database)
    pump = VoicePump(inbox)
    def send(target, payload):
        port = 28788 if target == 'windows' else 8788
        return forward_to_relay(f'http://127.0.0.1:{port}/watch/voice', bearer, payload)
    forwarder=ForwardingLoop(pump,authority,send,config_sha256=args.config_sha,epoch=config['epoch'])
    server=make_server(inbox,bearer,forwarder=forwarder)
    forwarder.start()
    try:
        server.serve_forever()
    finally:
        forwarder.stop()
        server.server_close()
        if not forwarder.thread.is_alive():
            pump.close();inbox.close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
