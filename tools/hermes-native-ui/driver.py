#!/usr/bin/env python3
"""Pinned Hermes driver and short socket; leave other Cua runtimes alone."""
import json
import fcntl
import os
from pathlib import Path
import socket
import subprocess
import sys
import time


def socket_ready(path):
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(0.25)
        try:
            connection.connect(path)
            return True
        except OSError:
            return False


def ensure_daemon(binary, path, env):
    # LaunchServices' app-name lookup can pick an unrelated installed version.
    # Start the exact signed bundle instead, keeping its existing TCC identity.
    if socket_ready(path):
        return
    with open(path + '.launch.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if socket_ready(path):
            return
        bundle = Path(binary).parents[2]
        if bundle.suffix != '.app' or not bundle.is_dir():
            raise RuntimeError('Pinned native driver must be inside its signed app bundle')
        subprocess.run(['/usr/bin/open', '-n', '-g', str(bundle), '--args', 'serve',
                        '--socket', path, '--permission-mode', 'standard'],
                       env=env, check=True, timeout=10, stdout=subprocess.DEVNULL)
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            if socket_ready(path):
                return
            time.sleep(0.15)
        raise RuntimeError('Pinned Cua daemon did not start; no fallback app was launched')


def main():
    cfg = json.loads(Path(__file__).with_suffix('.json').read_text())
    binary = cfg['binary']
    args = sys.argv[1:] or ['mcp']
    if args[0] in {'update', 'check-update'}:
        print(json.dumps({'error': 'driver_version_pinned_for_verified_Hermes_protocol',
                          'message': 'A newer driver requires native capture/input compatibility verification before switching.'}))
        return 69 if args[0] == 'update' else 0
    if args[:2] == ['permissions', 'status']:
        args = ['call', 'check_permissions', '{"prompt":false}']
    if args[0] == 'manifest':
        p = subprocess.run([binary, 'manifest'], capture_output=True, text=True, check=True)
        manifest = json.loads(p.stdout)
        manifest['mcp_invocation'] = {'command': str(Path(__file__).resolve()),
                                      'args': ['mcp', '--socket', cfg['socket']]}
        print(json.dumps(manifest))
        return
    if args[0] in {'mcp', 'call', 'serve', 'status', 'stop', 'config', 'recording'} and '--socket' not in args:
        args += ['--socket', cfg['socket']]
    env = dict(os.environ)
    env['CUA_DRIVER_RS_TELEMETRY_ENABLED'] = '0'
    if args[0] in {'mcp', 'call'} and '--embedded' not in args:
        path = args[args.index('--socket') + 1]
        ensure_daemon(binary, path, env)
    os.execve(binary, [binary, *args], env)


if __name__ == '__main__':
    sys.exit(main())
