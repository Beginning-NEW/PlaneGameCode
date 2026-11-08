import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { connect as connectSocket } from 'node:net';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { directLoopbackFetch } from '../ops/jenkins/lib/direct-loopback-http.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const directModule = new URL('../ops/jenkins/lib/direct-loopback-http.mjs', import.meta.url).href;
const syntheticAuthorization = 'Basic ' + Buffer.from('qa-admin:qa-password').toString('base64');

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function run(command, args, env) {
  const child = spawn(command, args, { cwd: root, env, windowsHide: true });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [status] = await once(child, 'close');
  return { status, stdout, stderr };
}

function hostileProxyEnvironment(proxyUrl, extra = {}) {
  return {
    ...process.env,
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    ALL_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    all_proxy: proxyUrl,
    NO_PROXY: '',
    no_proxy: '',
    NODE_OPTIONS: '--use-env-proxy',
    NODE_USE_ENV_PROXY: '1',
    ...extra,
  };
}

test('direct loopback response preserves fetch-compatible status and JSON behavior', async (t) => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ source: 'loopback' }));
  });
  t.after(() => server.close());
  const port = await listen(server);
  const response = await directLoopbackFetch('http://127.0.0.1:' + port + '/api/json', {
    redirect: 'manual',
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.ok, true);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { source: 'loopback' });
});

test('direct loopback transport rejects non-loopback and credential-bearing URLs before I/O', () => {
  for (const url of [
    'http://example.test/api/json',
    'https://127.0.0.1:18080/api/json',
    'http://user:password@127.0.0.1:18080/api/json',
  ]) {
    assert.throws(() => directLoopbackFetch(url), { code: 'loopback_url_forbidden' });
  }
});

test('direct Node loopback transport bypasses hostile env proxy with Basic auth', {
  skip: process.platform === 'win32',
}, async (t) => {
  const targetRequests = [];
  const proxyRequests = [];
  const target = createServer((request, response) => {
    targetRequests.push({ url: request.url, authorization: request.headers.authorization });
    response.writeHead(201, { 'content-type': 'text/plain', 'x-jenkins': '2', 'x-hudson': '1' });
    response.end('target');
  });
  const proxy = createServer((request, response) => {
    proxyRequests.push({ url: request.url, authorization: request.headers.authorization });
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('proxy');
  });
  proxy.on('connect', (request, clientSocket, head) => {
    proxyRequests.push({ url: request.url, authorization: request.headers.authorization });
    const targetSocket = connectSocket(targetPort, '127.0.0.1', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) targetSocket.write(head);
      targetSocket.pipe(clientSocket);
      clientSocket.pipe(targetSocket);
    });
    targetSocket.on('error', () => clientSocket.destroy());
  });
  t.after(() => {
    target.close();
    proxy.close();
  });
  const targetPort = await listen(target);
  const proxyPort = await listen(proxy);
  const targetUrl = 'http://127.0.0.1:' + targetPort + '/queue/api/json';
  const env = hostileProxyEnvironment('http://127.0.0.1:' + proxyPort, {
    TARGET_URL: targetUrl,
    DIRECT_MODULE: directModule,
    SYNTHETIC_AUTHORIZATION: syntheticAuthorization,
  });

  const vulnerableScript = [
    'const response = await fetch(process.env.TARGET_URL, {',
    '  headers: { authorization: process.env.SYNTHETIC_AUTHORIZATION },',
    '});',
    'process.stdout.write(await response.text(), () => process.exit(0));',
  ].join('\n');
  const vulnerableControl = await run(process.execPath,
    ['--input-type=module', '--eval', vulnerableScript], env);
  assert.equal(vulnerableControl.status, 0, vulnerableControl.stderr);
  assert.equal(vulnerableControl.stdout, 'target');
  assert.equal(proxyRequests.length, 1);
  assert.equal(targetRequests.length, 1);
  assert.equal(targetRequests[0].authorization, syntheticAuthorization);

  proxyRequests.length = 0;
  targetRequests.length = 0;
  const fixedScript = [
    'const { directLoopbackFetch } = await import(process.env.DIRECT_MODULE);',
    'const response = await directLoopbackFetch(process.env.TARGET_URL, {',
    '  headers: { authorization: process.env.SYNTHETIC_AUTHORIZATION },',
    '  redirect: \'manual\',',
    '  signal: AbortSignal.timeout(5000),',
    '});',
    'process.stdout.write(await response.text(), () => process.exit(0));',
  ].join('\n');
  const fixed = await run(process.execPath, ['--input-type=module', '--eval', fixedScript], env);
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.equal(fixed.stdout, 'target');
  assert.equal(proxyRequests.length, 0);
  assert.equal(targetRequests.length, 1);
  assert.equal(targetRequests[0].authorization, syntheticAuthorization);
});

test('deployment curl loopback helper bypasses hostile proxy and preserves exact health', {
  skip: process.platform === 'win32',
}, async (t) => {
  const sha = '8'.repeat(40);
  const targetRequests = [];
  const proxyRequests = [];
  const target = createServer((request, response) => {
    targetRequests.push(request.url);
    if (request.url === '/healthz') response.end('ok');
    else if (request.url === '/version.json') response.end(JSON.stringify({ sha }));
    else if (request.url === '/') response.end('<html>plane</html>');
    else {
      response.statusCode = 404;
      response.end('missing');
    }
  });
  const proxy = createServer((request, response) => {
    proxyRequests.push(request.url);
    response.end(request.url.endsWith('/version.json') ? JSON.stringify({ sha }) : '<html>proxy</html>');
  });
  t.after(() => {
    target.close();
    proxy.close();
  });
  const targetPort = await listen(target);
  const proxyPort = await listen(proxy);
  const env = hostileProxyEnvironment('http://127.0.0.1:' + proxyPort, {
    TEST_TARGET_PORT: String(targetPort),
    TEST_SHA: sha,
    NODE_OPTIONS: '',
    NODE_USE_ENV_PROXY: '',
  });
  const result = await run('bash', ['-lc',
    'source ./deploy/common.sh; APP_PORT="$TEST_TARGET_PORT"; verify_gateway_route "$TEST_SHA"'], env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(proxyRequests.length, 0);
  assert.deepEqual(targetRequests.sort(), ['/', '/healthz', '/version.json']);
});
