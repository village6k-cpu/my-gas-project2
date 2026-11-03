#!/usr/bin/env python3
"""Install only inside the existing isolated Hermes installation; no restarts."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import pwd
import shlex
import tempfile

HERE = Path(__file__).resolve().parent
START = '# BEGIN VILLAGE ORCA GUARD'
END = '# END VILLAGE ORCA GUARD'


def install(root, real_cli, user_data, *, execute=False):
    root, real_cli, user_data = map(lambda p: Path(p).resolve(), (root, real_cli, user_data))
    env_file = root / 'control/root.env.json'
    env = json.loads(env_file.read_text())
    sandbox = root / 'os-home'
    binary = root / 'bin/orca'
    configured_home = Path(env.get('HOME', '/')).resolve()
    configured_paths = [Path(p).resolve() for p in env.get('PATH', '').split(os.pathsep) if p]
    if configured_home != sandbox or root / 'bin' not in configured_paths:
        raise ValueError('not the configured isolated Hermes installation')
    if not real_cli.is_file() or not os.access(real_cli, os.X_OK) or real_cli == binary.resolve() or not user_data.is_dir():
        raise ValueError('real Orca executable and existing app profile required')
    if binary.exists() and 'VILLAGE_ORCA_GUARD' not in binary.read_text():
        raise ValueError('preserve the unrelated existing launcher')
    policy = {'real_cli': str(real_cli), 'user_data_path': str(user_data), 'log_path': str(root / 'control/orca-guard/blocked-starts.ndjson')}
    block = '\n'.join([START,
        'export ORCA_USER_DATA_PATH=' + shlex.quote(str(user_data)),
        'orca () { ' + shlex.quote(str(binary)) + ' "$@"; }', END, ''])
    desired = [(binary, (HERE / 'orca_guard.py').read_bytes(), 0o700),
               (root / 'bin/orca-policy.json', (json.dumps(policy, indent=2) + '\n').encode(), 0o600)]
    for name in ['.bash_profile', '.zprofile']:
        profile = sandbox / name
        if profile.is_symlink() or not profile.resolve().is_relative_to(sandbox):
            raise ValueError('shell profile must stay inside the isolated HOME')
        text = profile.read_text() if profile.exists() else ''
        if START in text:
            if text.count(START) != 1 or text.count(END) != 1:
                raise ValueError('ambiguous existing guard block')
            before, tail = text.split(START, 1)
            _, after = tail.split(END, 1)
            text = before + block.rstrip('\n') + after
        else:
            text = text + ('\n' if text and not text.endswith('\n') else '') + block
        desired.append((profile, text.encode(), 0o600))
    changes = [(p, data, mode) for p, data, mode in desired if not p.exists() or p.read_bytes() != data]
    result = {'dryRun': not execute, 'changed': len(changes), 'paths': [str(p) for p, _, _ in changes], 'servicesRestarted': False, 'serviceEnvironmentChanged': False}
    if not execute or not changes:
        return result
    backup = root / 'control/orca-guard/backups' / datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backup.mkdir(parents=True, mode=0o700)
    manifest = []
    for number, (p, data, mode) in enumerate(changes):
        old = p.read_bytes() if p.exists() else None
        if old is not None:
            copy = backup / str(number)
            copy.write_bytes(old)
            copy.chmod(0o600)
        manifest.append({'path': str(p), 'existed': old is not None, 'backup': str(number) if old is not None else None, 'installedSha256': hashlib.sha256(data).hexdigest()})
    (backup / 'manifest.json').write_text(json.dumps(manifest, indent=2))
    (backup / 'manifest.json').chmod(0o600)
    for p, data, mode in changes:
        p.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=p.name + '.', dir=p.parent)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
        os.chmod(temporary, mode)
        os.replace(temporary, p)
    result['backup'] = str(backup)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--real-cli', default='/usr/local/bin/orca')
    parser.add_argument('--user-data', default=str(Path(pwd.getpwuid(os.getuid()).pw_dir) / 'Library/Application Support/Orca'))
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    print(json.dumps(install(args.root, args.real_cli, args.user_data, execute=args.apply)))
