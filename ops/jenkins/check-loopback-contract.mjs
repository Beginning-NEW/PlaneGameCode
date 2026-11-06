import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const config = new URL('./config/', import.meta.url);

function uniqueValue(values, name, source) {
  assert.equal(values.length, 1, `${source} must declare ${name} exactly once`);
  assert.ok(values[0], `${source} must not declare an empty ${name}`);
  return values[0];
}

function systemdEnvironment(unit, name, source) {
  const values = unit.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    const quoted = `Environment="${name}=`;
    const plain = `Environment=${name}=`;
    if (trimmed.startsWith(quoted) && trimmed.endsWith('"')) {
      return [trimmed.slice(quoted.length, -1)];
    }
    if (trimmed.startsWith(plain)) return [trimmed.slice(plain.length)];
    return [];
  });
  return uniqueValue(values, name, source);
}

function envValue(contents, name, source) {
  const values = contents.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return [];
    const prefix = `${name}=`;
    return trimmed.startsWith(prefix) ? [trimmed.slice(prefix.length)] : [];
  });
  return uniqueValue(values, name, source);
}

export function assertLoopbackContract({ declaration, gatewayService, controllerDropIn }) {
  const expected = envValue(
    declaration,
    'JENKINS_CONTROLLER_ENDPOINT',
    'jenkins-loopback-contract.env',
  );
  const gatewayUrl = systemdEnvironment(
    gatewayService,
    'JENKINS_URL',
    'plane-game-webhook-gateway.service',
  );
  const controllerPort = systemdEnvironment(
    controllerDropIn,
    'JENKINS_PORT',
    'jenkins.service.d/plane-game-limits.conf',
  );
  const controllerHost = systemdEnvironment(
    controllerDropIn,
    'JENKINS_LISTEN_ADDRESS',
    'jenkins.service.d/plane-game-limits.conf',
  );

  const endpoint = new URL(expected);
  assert.equal(endpoint.protocol, 'http:', 'Jenkins controller endpoint must use loopback HTTP');
  assert.equal(endpoint.hostname, '127.0.0.1', 'Jenkins controller must bind IPv4 loopback');
  assert.equal(endpoint.port, '18080', 'approved Jenkins controller port is 18080');
  assert.equal(endpoint.pathname, '/', 'Jenkins controller endpoint must not add a path prefix');
  assert.equal(endpoint.search, '', 'Jenkins controller endpoint must not add a query');
  assert.equal(endpoint.hash, '', 'Jenkins controller endpoint must not add a fragment');
  assert.equal(gatewayUrl, expected, 'gateway JENKINS_URL diverges from the declared endpoint');
  assert.equal(controllerHost, endpoint.hostname, 'controller listen address diverges from the endpoint');
  assert.equal(controllerPort, endpoint.port, 'controller JENKINS_PORT diverges from the endpoint');
  assert.notEqual(controllerPort, '8080', 'legacy Jenkins port 8080 is forbidden');

  return expected;
}

async function main(paths = process.argv.slice(2)) {
  assert.ok(
    paths.length === 0 || paths.length === 3,
    'usage: check-loopback-contract.mjs [declaration gateway-service controller-drop-in]',
  );
  const [declarationPath, gatewayPath, controllerPath] = paths.length === 3
    ? paths.map((path) => pathToFileURL(path))
    : [
        new URL('jenkins-loopback-contract.env', config),
        new URL('plane-game-webhook-gateway.service', config),
        new URL('jenkins.service.d/plane-game-limits.conf', config),
      ];
  const [declaration, gatewayService, controllerDropIn] = await Promise.all([
    readFile(declarationPath, 'utf8'),
    readFile(gatewayPath, 'utf8'),
    readFile(controllerPath, 'utf8'),
  ]);
  const endpoint = assertLoopbackContract({ declaration, gatewayService, controllerDropIn });
  console.log(
    `jenkins loopback contract: endpoint=${endpoint} gateway=match controller=match legacy_8080=absent`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`jenkins loopback contract: FAIL: ${error.message}`);
    process.exitCode = 1;
  });
}
