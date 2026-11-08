import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';
import { directPublicGitHubFetch } from '../ops/jenkins/lib/direct-public-github-http.mjs';

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
