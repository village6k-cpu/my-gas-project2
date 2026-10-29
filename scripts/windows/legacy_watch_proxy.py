"""Keep only the legacy Watch loopback SSH forwarder available after logon.

Never starts, stops, or retries a business service or voice request. Existing
verified SSH owners are adopted; unknown listeners and reused PIDs fail closed.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
from urllib.request import urlopen


def same_owner(expected, actual):
    try:
        return (expected['pid'] == actual['pid']
                and abs(expected['started'] - actual['started']) < .001
                and os.path.normcase(expected['exe']) == os.path.normcase(actual['exe'])
                and expected['argv'] == actual['argv'])
    except (KeyError, TypeError):
        return False


class OwnerUnknown(RuntimeError):
    pass


def next_action(listeners, owned_pid, *, ownership_uncertain=False):
    if listeners:
        return ('observe' if owned_pid is not None
                and all(pid == owned_pid and ip == '127.0.0.1' for pid, ip in listeners)
                else 'blocked_unknown_listener')
    if owned_pid is not None:
        return 'wait_for_owned_tunnel'
    return 'blocked_unknown_owner' if ownership_uncertain else 'start_forwarder'


def mac_ready(health):
    f = health.get('forwarder') or {}
    age = f.get('evaluation_age_seconds')
    return (health.get('role') == 'durable_voice_intake' and f.get('authority') == 'mac'
            and f.get('thread_alive') is True and f.get('failed') is False
            and type(age) in (int, float) and 0 <= age <= 5)


def snapshot(psutil, pid):
    try:
        p = psutil.Process(pid)
        return {'pid': p.pid, 'started': p.create_time(), 'exe': p.exe(), 'argv': p.cmdline()}
    except psutil.NoSuchProcess:
        return None
    except (psutil.Error, OSError):
        raise OwnerUnknown('Known SSH identity could not be inspected') from None


def write_json(path, value):
    pending = path.with_suffix('.tmp')
    with pending.open('w', encoding='utf-8') as f:
        json.dump(value, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(pending, path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--config-sha', required=True)
    parser.add_argument('--once', action='store_true', help='Read-only observation; never starts SSH')
    args = parser.parse_args()
    if os.name != 'nt':
        raise RuntimeError('Windows required')
    import ctypes
    from ctypes import wintypes
    import psutil
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateMutexW.argtypes = (wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR)
    kernel.CreateMutexW.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
    handle = kernel.CreateMutexW(None, False, 'Local\\VillageLegacyWatchProxy20261029')
    if not handle:
        raise OSError('Cannot acquire forwarder guard mutex')
    if ctypes.get_last_error() == 183:
        kernel.CloseHandle(handle)
        return 0
    try:
        raw = args.config.read_bytes()
        if hashlib.sha256(raw).hexdigest() != args.config_sha:
            raise ValueError('Forwarder config changed')
        config = json.loads(raw)
        if config.get('schema') != 'village-legacy-watch-proxy/v1':
            raise ValueError('Unsupported forwarder config')
        if hashlib.sha256(Path(config['source_commit_file']).read_bytes()).hexdigest() != config['source_commit_sha256']:
            raise ValueError('Source commit proof changed')
        argv = config['ssh_argv']
        expected = ['-N', '-L', '127.0.0.1:18788:127.0.0.1:18788', 'choijaehyeong@100.103.83.1']
        if argv[-4:] != expected or '-R' in argv or '-D' in argv or '-W' in argv:
            raise ValueError('Only the pinned local voice forward is allowed')
        directory = args.config.parent
        state_file = directory / 'OWNER.json'
        allowed_argv = (argv, config['initial_owner']['argv'])
        while True:
            if (directory / 'STOP').exists():
                return 0
            candidates = [config['initial_owner']]
            if state_file.exists():
                candidates.append(json.loads(state_file.read_text(encoding='utf-8')))
            owner = None
            ownership_uncertain = False
            for candidate in candidates:
                try:
                    actual = snapshot(psutil, candidate['pid'])
                except OwnerUnknown:
                    ownership_uncertain = True
                    continue
                if actual and candidate['argv'] in allowed_argv and same_owner(candidate, actual):
                    owner = actual
                    break
            listeners = [(r.pid, r.laddr.ip) for r in psutil.net_connections(kind='tcp')
                         if r.status == psutil.CONN_LISTEN and r.laddr.port == 18788]
            action = next_action(listeners, None if owner is None else owner['pid'],
                                 ownership_uncertain=ownership_uncertain)
            if action == 'start_forwarder' and not args.once:
                process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                           stderr=subprocess.DEVNULL,
                                           creationflags=subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP)
                owner = snapshot(psutil, process.pid)
                if owner is None:
                    raise RuntimeError('New SSH owner could not be captured')
                write_json(state_file, owner)
                action = 'forwarder_started'
            health = {}
            if action in ('observe', 'forwarder_started', 'wait_for_owned_tunnel'):
                try:
                    with urlopen('http://127.0.0.1:18788/health', timeout=5) as response:
                        health = json.load(response)
                except (OSError, ValueError):
                    pass
            report = {'at': time.time(), 'guard_pid': os.getpid(), 'action': action,
                      'tunnel_pid': None if owner is None else owner['pid'],
                      'mac_authority_observed': mac_ready(health),
                      'business_consumers_started': False, 'processes_killed': 0,
                      'voice_requests_submitted': 0, 'read_only': args.once}
            write_json(directory / 'HEALTH.json', report)
            if args.once:
                print(json.dumps(report))
                return 0
            time.sleep(15)
    finally:
        kernel.CloseHandle(handle)


if __name__ == '__main__':
    raise SystemExit(main())
