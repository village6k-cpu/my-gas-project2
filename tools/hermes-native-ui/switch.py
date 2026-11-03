#!/usr/bin/env python3
"""Plan/apply a backed-up, reversible tool switch in the isolated installation."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import yaml

HERE = Path(__file__).resolve().parent


def sha(data):
    return hashlib.sha256(data).hexdigest()


def browser_patch(text):
    if '# VILLAGE_BORROWED_CDP' in text:
        return text
    anchor = '    # Auto-start recording if configured and this is first navigation\n'
    assert text.count(anchor) == 1, 'browser navigation source changed'
    text = text.replace(anchor, '''    # VILLAGE_BORROWED_CDP: each task owns a new tab, never a customer tab.
    if is_first_nav and session_info.get("features", {}).get("cdp_override"):
        created = _run_browser_command(nav_session_key, "tab", ["new"], timeout=30)
        if not created.get("success"):
            return json.dumps({"success": False, "error": "Could not create an owned browser tab"})

''' + anchor)
    anchor = '        else:\n            try:\n                _run_browser_command(task_id, "close", [], timeout=10)'
    assert text.count(anchor) == 1, 'browser cleanup source changed'
    return text.replace(anchor, '''        elif session_info.get("features", {}).get("cdp_override"):
            # Borrowed Chrome belongs to the watcher/user. Disconnect the client only.
            pass
''' + anchor, 1)


def plan(root, binary):
    root, binary = Path(root).resolve(), Path(binary).resolve()
    assert binary.is_relative_to(root / 'tools') and binary.is_file()
    manifest_path = root / 'control/runtime.json'
    activation_path = root / 'ACTIVATION.json'
    manifest = json.loads(manifest_path.read_text())
    activation = json.loads(activation_path.read_text())
    assert activation['manifest_sha256'] == sha(manifest_path.read_bytes()), 'runtime manifest drift'
    desired = {}
    driver = root / 'control/hermes-ui-driver.py'
    desired[driver] = (HERE / 'driver.py').read_bytes()
    desired[driver.with_suffix('.json')] = (json.dumps({'binary': str(binary), 'socket': '/tmp/village-hermes-ui.sock'}, indent=2) + '\n').encode()
    canonical = (root / 'hermes-root/profiles/kakaoworker/skills/computer-use/SKILL.md').read_text()
    assert 'Hermes drives' in canonical and 'cua-driver' in canonical
    desired[root / 'hermes-root/skills/computer-use/SKILL.md'] = canonical.encode()
    moves = []
    for skill in ['orca-cli', 'orchestration']:
        path = root / 'hermes-root/skills' / skill
        if path.exists():
            moves.append(path)
    for name, home, code in [('root', 'hermes-root', 'hermes-root-code'), ('worker', 'hermes-root/profiles/kakaoworker', 'hermes-worker-code')]:
        entry = manifest['services'][name]
        envpath = Path(entry['env_file'])
        assert sha(envpath.read_bytes()) == entry['env_sha256'], 'service environment drift'
        env = json.loads(envpath.read_text())
        env['HERMES_CUA_DRIVER_CMD'] = str(driver)
        env['CUA_DRIVER_COMMAND'] = str(driver)
        desired[envpath] = (json.dumps(env, indent=2) + '\n').encode()
        cfgpath = root / home / 'config.yaml'
        assert sha(cfgpath.read_bytes()) == entry['runtime_file_sha256'][str(cfgpath)], 'service configuration drift'
        cfg = yaml.safe_load(cfgpath.read_text())
        cfg['agent']['disabled_toolsets'] = [t for t in cfg['agent'].get('disabled_toolsets', []) if t != 'computer_use']
        cfg.setdefault('browser', {}).update({'cloud_provider': 'local', 'cdp_url': 'http://127.0.0.1:19223'})
        for platform, tools in cfg.get('platform_toolsets', {}).items():
            if platform in {'cli', 'slack', 'kakao_village', 'webhook'}:
                for tool in ['browser', 'computer_use']:
                    if tool not in tools:
                        tools.append(tool)
        desired[cfgpath] = yaml.safe_dump(cfg, allow_unicode=True, sort_keys=False).encode()
        source = root / code / 'tools/browser_tool.py'
        desired[source] = browser_patch(source.read_text()).encode()
        entry['env_sha256'] = sha(desired[envpath])
        for p in [cfgpath, source, driver, driver.with_suffix('.json')]:
            entry['runtime_file_sha256'][str(p)] = sha(desired[p])
    desired[manifest_path] = (json.dumps(manifest, indent=2) + '\n').encode()
    activation['manifest_sha256'] = sha(desired[manifest_path])
    activation['ui_tools_revision'] = 'hermes-native-ui-v1'
    desired[activation_path] = (json.dumps(activation, indent=2) + '\n').encode()
    return {p: data for p, data in desired.items() if not p.exists() or p.read_bytes() != data}, moves


def apply(root, binary, execute=False):
    root = Path(root).resolve()
    changes, moves = plan(root, binary)
    result = {'dryRun': not execute, 'changed': len(changes), 'paths': list(map(str, changes)), 'archivedSkills': list(map(str, moves)), 'servicesRestarted': False}
    if not execute or not (changes or moves):
        return result
    for rel in ['hermes-root', 'hermes-root/profiles/kakaoworker']:
        state = json.loads((root / rel / 'gateway_state.json').read_text())
        assert state.get('active_agents') == 0, 'wait for active Hermes work to finish'
    backup = root / 'control/ui-tools-backups' / datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backup.mkdir(parents=True, mode=0o700)
    receipt = []
    for n, (p, data) in enumerate(changes.items()):
        existed = p.exists()
        mode = p.stat().st_mode & 0o777 if existed else 0o600
        if p.name == 'hermes-ui-driver.py':
            mode = 0o700
        if existed:
            shutil.copy2(p, backup / str(n)); (backup / str(n)).chmod(0o600)
        receipt.append({'path': str(p), 'backup': str(n) if existed else None, 'mode': mode, 'installedSha256': sha(data)})
    (backup / 'manifest.json').write_text(json.dumps(receipt, indent=2)); (backup / 'manifest.json').chmod(0o600)
    for row, (p, data) in zip(receipt, changes.items()):
        fd, temporary = tempfile.mkstemp(prefix=p.name, dir=p.parent)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
        os.chmod(temporary, row['mode']); os.replace(temporary, p)
    for p in moves:
        shutil.move(str(p), str(backup / p.name))
    result['backup'] = str(backup)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--binary', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    print(json.dumps(apply(args.root, args.binary, args.apply)))
