import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { assertPlaneDemoContract } from '../ops/nginx/check-plane-demo-contract.mjs';

const template = await readFile(
  new URL('../ops/nginx/plane-demo.conf.template', import.meta.url),
  'utf8',
);

test('plane-demo routes only the exact POST webhook path to the admission gateway', () => {
  assert.equal(
    assertPlaneDemoContract(template),
    'webhook=http://127.0.0.1:9080 app=http://127.0.0.1:18081 jenkins=not-exposed',
  );
});

test('plane-demo rejects a prefix webhook route that could capture sibling paths', () => {
  const prefixRoute = template.replace(
    'location = /github/workflow-run {',
    'location /github/workflow-run {',
  );
  assert.throws(() => assertPlaneDemoContract(prefixRoute), /missing Nginx block/);
});

test('plane-demo rejects any Nginx path to the Jenkins controller port', () => {
  const jenkinsProxy = template.replace(
    'proxy_pass http://127.0.0.1:18081;',
    'proxy_pass http://127.0.0.1:18080;',
  );
  assert.throws(() => assertPlaneDemoContract(jenkinsProxy), /127[.]0[.]0[.]1:18081/);

  const publicJenkinsListener = template.replace('listen 80;', 'listen 18080;');
  assert.throws(() => assertPlaneDemoContract(publicJenkinsListener), /dedicated HTTP\/TLS vhost/);
});
