import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

const root = resolve(process.argv.includes('--dist') ? 'dist' : '.');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const port = Number(process.env.PORT || 4173);
createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ status: 'ok' })); return; }
  const path = resolve(root, `.${decodeURIComponent(pathname === '/' ? '/index.html' : pathname)}`);
  if (!path.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
  try { const body = await readFile(path); res.writeHead(200, { 'Content-Type': `${types[extname(path)] ?? 'application/octet-stream'}; charset=utf-8`, 'X-Content-Type-Options': 'nosniff' }); res.end(body); }
  catch { res.writeHead(404); res.end('Not found'); }
}).listen(port, '127.0.0.1', () => console.log(JSON.stringify({ event: 'started', port, sha: process.env.GIT_SHA || 'local' })));
