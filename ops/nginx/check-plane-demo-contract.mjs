import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function withoutComments(source) {
  return source.replace(/#[^\n]*/g, '');
}

function blocks(source, header) {
  const matches = [];
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf(header, cursor);
    if (start === -1) break;
    const open = source.indexOf('{', start + header.length);
    assert.notEqual(open, -1, `missing opening brace for: ${header}`);

    let depth = 0;
    for (let index = open; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1;
      if (source[index] === '}') depth -= 1;
      if (depth === 0) {
        matches.push(source.slice(open + 1, index));
        cursor = index + 1;
        break;
      }
    }
    assert.equal(depth, 0, `missing closing brace for: ${header}`);
  }
  return matches;
}

function block(source, header) {
  const matches = blocks(source, header);
  assert.notEqual(matches.length, 0, `missing Nginx block: ${header}`);
  return matches[0];
}

function values(source, directive) {
  return [...source.matchAll(new RegExp(`\\b${directive}\\s+([^;]+);`, 'g'))]
    .map((match) => match[1].trim());
}

export function assertPlaneDemoContract(template) {
  const source = withoutComments(template);
  const servers = blocks(source, 'server');
  const listens = values(source, 'listen');
  const upstreams = values(source, 'proxy_pass');

  assert.equal(servers.length, 2, 'only the dedicated HTTP and TLS vhosts may exist');
  assert.deepEqual(listens, ['80', '443 ssl'], 'only the dedicated HTTP/TLS vhost may listen');
  assert.deepEqual(values(servers[0], 'listen'), ['80']);
  assert.doesNotMatch(servers[0], /github\/workflow-run/);
  assert.deepEqual(values(servers[1], 'listen'), ['443 ssl']);

  const webhook = block(servers[1], 'location = /github/workflow-run');
  const application = block(servers[1], 'location /');
  assert.equal(
    (source.match(/location\s+=\s+\/github\/workflow-run\s*\{/g) ?? []).length,
    1,
    'the exact webhook location must occur once',
  );
  assert.match(webhook, /limit_except\s+POST\s*\{\s*deny\s+all;/s);
  assert.deepEqual(values(webhook, 'proxy_pass'), ['http://127.0.0.1:9080']);
  for (const header of [
    'X-GitHub-Delivery $http_x_github_delivery',
    'X-GitHub-Event $http_x_github_event',
    'X-Hub-Signature-256 $http_x_hub_signature_256',
  ]) {
    assert.ok(values(webhook, 'proxy_set_header').includes(header), `missing preserved header: ${header}`);
  }

  assert.deepEqual(values(application, 'proxy_pass'), ['http://127.0.0.1:18081']);
  assert.deepEqual(
    upstreams.sort(),
    ['http://127.0.0.1:18081', 'http://127.0.0.1:9080'].sort(),
    'Nginx may proxy only to the app and admission gateway loopback endpoints',
  );
  assert.doesNotMatch(source, /(?:listen|proxy_pass)[^;]*18080/);
  assert.doesNotMatch(source, /__PLANE_LOOPBACK_PORT__/);

  return 'webhook=http://127.0.0.1:9080 app=http://127.0.0.1:18081 jenkins=not-exposed';
}

async function main() {
  const templateUrl = new URL('plane-demo.conf.template', import.meta.url);
  const result = assertPlaneDemoContract(await readFile(templateUrl, 'utf8'));
  console.log(`plane-demo nginx contract: ${result}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
