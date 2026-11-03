#!/usr/bin/env python3
"""VILLAGE_ORCA_GUARD: correct the app profile; respect a user-closed app."""
import datetime
import json
import os
from pathlib import Path
import sys


def operation(args):
    value_flags = {'--environment', '--pairing-code', '--host'}
    i = 0
    while i < len(args):
        arg = args[i]
        if arg in value_flags:
            i += 2
        elif arg.startswith('-'):
            i += 1
        else:
            return arg
    return ''


def main(args=None):
    args = list(sys.argv[1:] if args is None else args)
    policy_file = Path(__file__).with_name('orca-policy.json')
    if args[:1] == ['--policy-file']:
        policy_file, args = Path(args[1]), args[2:]
    policy = json.loads(policy_file.read_text())
    cli = Path(policy['real_cli'])
    data = Path(policy['user_data_path'])
    if not cli.is_absolute() or not cli.is_file() or cli.resolve() == Path(__file__).resolve() or not data.is_absolute():
        raise ValueError('invalid local Orca policy')
    command = operation(args)
    if command in {'open', 'serve'}:
        receipt = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'operation': command, 'reason': 'automatic_start_blocked'}
        try:
            log = Path(policy['log_path'])
            log.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            with os.fdopen(fd, 'a') as stream:
                stream.write(json.dumps(receipt) + '\n')
        except OSError:
            pass  # Missing diagnostics must never turn a blocked launch into a launch.
        print(json.dumps({'ok': False, 'error': {'code': 'orca_automatic_start_blocked', 'message': 'Hermes must not automatically launch or reopen Orca. Use an API or browser route. If native UI access is essential, report the blocker and let the user open Orca. Do not retry open or change HOME.'}}))
        return 69
    env = dict(os.environ)
    # Keep the isolated HOME and all existing credentials/session bindings intact.
    env['ORCA_USER_DATA_PATH'] = str(data)
    os.execve(str(cli), [str(cli), *args], env)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, IndexError) as error:
        print(json.dumps({'ok': False, 'error': {'code': 'orca_guard_configuration_error', 'message': str(error)}}))
        sys.exit(78)
