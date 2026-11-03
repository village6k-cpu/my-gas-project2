#!/usr/bin/env python3
"""Pinned Hermes driver and short socket; leave other Cua runtimes alone."""
import json
import os
from pathlib import Path
import subprocess
import sys


def main():
    cfg = json.loads(Path(__file__).with_suffix('.json').read_text())
    binary = cfg['binary']
    args = sys.argv[1:] or ['mcp']
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
    os.execve(binary, [binary, *args], env)


if __name__ == '__main__':
    main()
