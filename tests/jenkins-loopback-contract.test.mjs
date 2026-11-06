import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { assertLoopbackContract } from '../ops/jenkins/check-loopback-contract.mjs';

const [declaration, gatewayService, controllerDropIn] = await Promise.all([
  readFile(new URL('../ops/jenkins/config/jenkins-loopback-contract.env', import.meta.url), 'utf8'),
  readFile(new URL('../ops/jenkins/config/plane-game-webhook-gateway.service', import.meta.url), 'utf8'),
  readFile(
    new URL('../ops/jenkins/config/jenkins.service.d/plane-game-limits.conf', import.meta.url),
    'utf8',
  ),
]);

test('gateway and controller resolve to the declared loopback endpoint', () => {
  assert.equal(
    assertLoopbackContract({ declaration, gatewayService, controllerDropIn }),
    'http://127.0.0.1:18080',
  );
});

test('legacy gateway port 8080 fails the loopback contract', () => {
  const mismatch = gatewayService.replace(
    'JENKINS_URL=http://127.0.0.1:18080',
    'JENKINS_URL=http://127.0.0.1:8080',
  );
  assert.throws(
    () => assertLoopbackContract({ declaration, gatewayService: mismatch, controllerDropIn }),
    /gateway JENKINS_URL diverges/,
  );
});

test('controller port mismatch fails the loopback contract', () => {
  const mismatch = controllerDropIn.replace('JENKINS_PORT=18080', 'JENKINS_PORT=8080');
  assert.throws(
    () => assertLoopbackContract({ declaration, gatewayService, controllerDropIn: mismatch }),
    /controller JENKINS_PORT diverges/,
  );
});
