import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { directPublicGitHubFetch } from '../ops/jenkins/lib/direct-public-github-http.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const clientModule = new URL('../ops/jenkins/lib/github-public-client.mjs', import.meta.url).href;

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function runBounded(command, args, env, timeoutMs = 5000) {
  const child = spawn(command, args, { cwd: root, env, windowsHide: true });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const timeout = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  const [status, signal] = await once(child, 'close');
  clearTimeout(timeout);
  return { status, signal, stdout, stderr };
}

test('public GitHub transport uses a direct TLS socket and preserves response metadata', async () => {
  const seen = [];
  const requestImpl = (url, options, onResponse) => {
    seen.push({ url: url.href, options });
    const handle = new EventEmitter();
    handle.end = () => queueMicrotask(() => {
      const response = Object.assign(Readable.from(['{"ok":true}']), {
        statusCode: 200,
        headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '60' },
      });
      onResponse(response);
    });
    return handle;
  };
  const response = await directPublicGitHubFetch(
    'https://api.github.com/repos/Beginning-NEW/PlaneGameCode/git/ref/heads/main',
    { method: 'GET', redirect: 'manual', headers: { accept: 'application/vnd.github+json' } },
    requestImpl,
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://api.github.com/repos/Beginning-NEW/PlaneGameCode/git/ref/heads/main');
  assert.equal(seen[0].options.agent, false);
  assert.equal(seen[0].options.rejectUnauthorized, true);
  assert.equal(seen[0].options.method, 'GET');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-ratelimit-remaining'), '60');
  let body = '';
  for await (const chunk of response.body) body += chunk.toString('utf8');
  assert.equal(body, '{"ok":true}');
});

test('public GitHub transport rejects other origins and redirect mode before I/O', () => {
  for (const url of [
    'http://api.github.com/repos/Beginning-NEW/PlaneGameCode',
    'https://ghcr.io/token',
    'https://user:password@api.github.com/repos/Beginning-NEW/PlaneGameCode',
  ]) {
    assert.throws(() => directPublicGitHubFetch(url, { redirect: 'manual' }), {
      code: 'github_url_forbidden',
    });
  }
  assert.throws(() => directPublicGitHubFetch('https://api.github.com/', { redirect: 'follow' }), {
    code: 'github_request_forbidden',
  });
});

test('PublicGitHubClient production default ignores hostile Node proxy inheritance', {
  skip: process.platform === 'win32',
}, async (t) => {
  const proxyRequests = [];
  const proxy = createServer((request, response) => {
    proxyRequests.push(`${request.method} ${request.url}`);
    response.writeHead(502, { 'content-type': 'application/json' });
    response.end('{"forged":true}');
  });
  proxy.on('connect', (request, socket) => {
    proxyRequests.push(`CONNECT ${request.url}`);
    socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
  });
  t.after(() => proxy.close());
  const proxyPort = await listen(proxy);

  const scratch = await mkdtemp(join(tmpdir(), 'plane-direct-github-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const preload = join(scratch, 'direct-https-probe.cjs');
  await writeFile(preload, String.raw`
const { EventEmitter } = require('node:events');
const https = require('node:https');
const { syncBuiltinESMExports } = require('node:module');
const { Readable } = require('node:stream');
const body = JSON.stringify({ object: { sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } });
https.request = (url, options, onResponse) => {
  if (url.href !== 'https://api.github.com/repos/Beginning-NEW/PlaneGameCode/git/ref/heads/main') {
    throw new Error('unexpected direct URL: ' + url.href);
  }
  if (options.agent !== false || options.rejectUnauthorized !== true || options.method !== 'GET') {
    throw new Error('direct TLS policy was not enforced');
  }
  const handle = new EventEmitter();
  handle.end = () => queueMicrotask(() => {
    const response = Object.assign(Readable.from([Buffer.from(body)]), {
      statusCode: 200,
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
        'x-ratelimit-limit': '60',
        'x-ratelimit-remaining': '59',
        'x-ratelimit-reset': '2000000000',
      },
    });
    onResponse(response);
  });
  return handle;
};
syncBuiltinESMExports();
`);

  const script = String.raw`
const { PublicGitHubClient } = await import(process.env.CLIENT_MODULE);
const ledger = {
  recordRequest() {},
  observeRate() {},
  defer(_until, reason) { throw new Error('unexpected defer: ' + reason); },
};
const client = new PublicGitHubClient({ ledger });
const result = await client.get('/repos/Beginning-NEW/PlaneGameCode/git/ref/heads/main');
process.stdout.write(result.data.object.sha, () => process.exit(0));
`;
  const proxyUrl = `http://127.0.0.1:${proxyPort}`;
  const result = await runBounded(process.execPath, ['--input-type=module', '--eval', script], {
    ...process.env,
    CLIENT_MODULE: clientModule,
    NODE_OPTIONS: `--require=${preload} --use-env-proxy`,
    NODE_USE_ENV_PROXY: '1',
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    ALL_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    all_proxy: proxyUrl,
    NO_PROXY: '',
    no_proxy: '',
  });
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'a'.repeat(40));
  assert.deepEqual(proxyRequests, []);
});
