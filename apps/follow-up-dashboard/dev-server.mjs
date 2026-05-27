import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

function loadEnvFile(path, { skip = new Set() } = {}) {
  let raw = '';
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (skip.has(key)) continue;
    if (process.env[key]) continue;
    process.env[key] = rawValue.replace(/^(['"])(.*)\1$/, '$2');
  }
}

loadEnvFile(join(rootDir, '.env'));
loadEnvFile(resolve(rootDir, '../../tools/kakao-dom-bridge/.env'), { skip: new Set(['PORT', 'HOST']) });

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg'
};

const apiHandlers = new Map([
  ['/api/follow-ups', () => import('./api/follow-ups.js')],
  ['/api/operations', () => import('./api/operations.js')]
]);

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

async function handleApi(req, res, pathname, searchParams) {
  const load = apiHandlers.get(pathname);
  if (!load) return false;
  const mod = await load();
  req.query = Object.fromEntries(searchParams.entries());
  await mod.default(req, res);
  return true;
}

function serveStatic(res, pathname) {
  const cleanPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = normalize(join(rootDir, cleanPath));
  if (!filePath.startsWith(rootDir)) {
    send(res, 403, 'forbidden', { 'content-type': 'text/plain; charset=utf-8' });
    return;
  }
  try {
    const body = readFileSync(filePath);
    send(res, 200, body, { 'content-type': mimeTypes[extname(filePath)] || 'application/octet-stream' });
  } catch {
    send(res, 404, 'not found', { 'content-type': 'text/plain; charset=utf-8' });
  }
}

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';

createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);
    if (await handleApi(req, res, url.pathname, url.searchParams)) return;
    serveStatic(res, decodeURIComponent(url.pathname));
  } catch (error) {
    send(res, 500, JSON.stringify({ error: error.message }), { 'content-type': 'application/json; charset=utf-8' });
  }
}).listen(port, host, () => {
  console.log(`follow-up dashboard dev server listening on http://${host}:${port}`);
  console.log(`api module base ${pathToFileURL(rootDir).href}`);
});
