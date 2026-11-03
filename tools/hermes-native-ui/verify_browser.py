"""Live MCP acceptance test: disposable local forms, two clients, no customer input."""
import argparse
import asyncio
import base64
import contextlib
import http.server
import json
from pathlib import Path
import shutil
import tempfile
import threading
import urllib.request

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


def targets(endpoint):
    rows = json.load(urllib.request.urlopen(endpoint + '/json/list', timeout=5))
    return {x['id']: x['url'] for x in rows if x.get('type') == 'page'}


async def verify(root, output):
    endpoint = 'http://127.0.0.1:19223'
    before = targets(endpoint)
    saved = {}

    class Form(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            page = '''<!doctype html><html lang="ko"><meta charset="utf-8"><title>Hermes 전환 검증</title>
<body style="font:24px sans-serif;padding:40px"><h1>Hermes Chrome 연결 검증</h1>
<label for="value">검증 값</label><input id="value"><button id="save">저장</button><p id="result"></p>
<script>document.querySelector('#save').onclick=async()=>{let value=document.querySelector('#value').value;
await fetch(location.pathname,{method:'POST',body:JSON.stringify({value})});document.querySelector('#result').textContent='저장 값: '+value}</script>'''
            self.send_response(200); self.send_header('Content-Type', 'text/html; charset=utf-8'); self.end_headers()
            self.wfile.write(page.encode())

        def do_POST(self):
            saved[self.path] = json.loads(self.rfile.read(int(self.headers['Content-Length'])))['value']
            self.send_response(200); self.end_headers(); self.wfile.write(b'ok')

    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Form)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    url = f'http://127.0.0.1:{httpd.server_port}'
    with tempfile.TemporaryDirectory() as directory:
        stage = Path(directory)
        shutil.copy2(Path(__file__).with_name('browser.mjs'), stage / 'hermes-browser.mjs')
        (stage / 'hermes-browser.json').write_text(json.dumps({'endpoint': endpoint, 'modules': str(root/'tools/hermes-browser-mcp/node_modules')}))
        node = root / 'tools/node-24.18.0/node-v24.18.0-darwin-arm64/bin/node'
        parameters = StdioServerParameters(command=str(node), args=[str(stage/'hermes-browser.mjs')], env={'HOME': str(root/'os-home'), 'PATH': '/usr/bin:/bin'})

        async def call(client, **args):
            response = await client.call_tool('browser', args)
            text = next(c.text for c in response.content if c.type == 'text')
            return json.loads(text), response

        async with contextlib.AsyncExitStack() as stack:
            clients = []
            for _ in range(2):
                read, write = await stack.enter_async_context(stdio_client(parameters))
                client = await stack.enter_async_context(ClientSession(read, write))
                await client.initialize(); clients.append(client)
            first, second = clients
            a, _ = await call(first, action='open', url=url+'/a')
            b, _ = await call(second, action='open', url=url+'/b')
            assert a.get('handle') and b.get('handle') and a['handle'] != b['handle'], (a, b)
            foreign, response = await call(second, action='observe', handle=a['handle'])
            assert response.isError and 'Unknown' in foreign['error']
            # Another tab becomes current in the same Chrome; A must stay bound to A.
            c, _ = await call(second, action='open', url=url+'/c')
            for client, handle, value in [(first, a['handle'], 'Hermes Chrome 연결 검증 완료'), (second, b['handle'], '별도 작업 B')]:
                result, response = await call(client, action='fill', handle=handle, role='textbox', name='검증 값', text=value)
                assert not response.isError and value in result['snapshot'], result
                result, response = await call(client, action='click', handle=handle, role='button', name='저장')
                assert not response.isError and value in result['snapshot'], result
            assert saved == {'/a': 'Hermes Chrome 연결 검증 완료', '/b': '별도 작업 B'}, saved
            _, screenshot = await call(first, action='screenshot', handle=a['handle'])
            image = next(c for c in screenshot.content if c.type == 'image')
            output.mkdir(parents=True, exist_ok=True)
            (output/'browser-proof.png').write_bytes(base64.b64decode(image.data))
            for client, handle in [(first, a['handle']), (second, b['handle']), (second, c['handle'])]:
                result, response = await call(client, action='close', handle=handle)
                assert not response.isError and result.get('closed'), result
            closed, response = await call(first, action='fill', handle=a['handle'], role='textbox', name='검증 값', text='must not appear')
            assert response.isError and 'Unknown' in closed['error']
        httpd.shutdown()
        after = targets(endpoint)
        assert all(after.get(k) == value for k, value in before.items()), 'Existing customer tabs changed'
        report = {'twoClientsIsolated': True, 'tabSwitchDidNotRetarget': True, 'crossClientHandleRejected': True,
                  'closedHandleRejected': True, 'savedValuesVerified': True, 'existingTabsPreserved': len(before)}
        (output/'browser-verification.json').write_text(json.dumps(report, indent=2))
        print(json.dumps(report))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    asyncio.run(verify(args.root.resolve(), args.output.resolve()))
