import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const profile = new URL('../ops/jenkins/controller-stage-b/', import.meta.url);
const [helper, javaSource, docs] = await Promise.all([
  readFile(new URL('generate-admin-bootstrap.sh', profile), 'utf8'),
  readFile(new URL('GenerateAdminBootstrap.java', profile), 'utf8'),
  readFile(new URL('README.md', profile), 'utf8'),
]);

test('bootstrap generator needs no host htpasswd or network and uses the exact approved image', () => {
  assert.doesNotMatch(helper, /htpasswd/);
  assert.match(helper, /image_id=.*image_id_file/);
  assert.match(helper, /jenkins-controller-stage-b/);
  assert.match(helper, /jcl-over-slf4j\|slf4j-api\|slf4j-jdk14/);
  assert.match(helper, /--network none/);
  assert.match(helper, /--read-only/);
  assert.match(helper, /--cap-drop ALL/);
  assert.match(helper, /--security-opt no-new-privileges:true/);
  assert.match(helper, /--user 0:0/);
  assert.match(docs, /does not require host `htpasswd`, Python, a package install, or network access/);
});

test('bootstrap password is read only from a hidden interactive console and the hash is never printed', () => {
  assert.match(javaSource, /System[.]console\(\)/);
  assert.match(javaSource, /readPassword\("New plane-admin password: "\)/);
  assert.match(javaSource, /readPassword\("Confirm plane-admin password: "\)/);
  assert.match(javaSource, /Arrays[.]fill\(first, '\\0'\)/);
  assert.match(javaSource, /Arrays[.]fill\(second, '\\0'\)/);
  assert.doesNotMatch(javaSource, /System[.]out|println\(.*encoded|printf\(.*encoded/);
  assert.doesNotMatch(helper, /export\s+[^\n]*(?:PASSWORD|SECRET)|--env|-e\s+[^\n]*(?:PASSWORD|SECRET)/i);
  assert.match(helper, /secret value not displayed/);
});

test('bootstrap output is an atomic owner-only Jenkins bcrypt file', () => {
  assert.match(javaSource, /PosixFilePermissions[.]fromString\("rw-------"\)/);
  assert.match(javaSource, /StandardCopyOption[.]ATOMIC_MOVE/);
  assert.match(javaSource, /"#jbcrypt:" \+ encoded/);
  assert.match(helper, /stat -c '%u'/);
  assert.match(helper, /stat -c '%a'/);
  assert.match(helper, /generated bootstrap mode must be 0600/);
  assert.match(helper, /\^#jbcrypt:\\\$2a/);
});

test('runbook defines first-boot, removal, restart, rotation, and replay target evidence', () => {
  assert.match(docs, /Required target bootstrap drill/);
  assert.match(docs, /exit `78`/);
  assert.match(docs, /no `[.]stage-b-ready`/);
  assert.match(docs, /remove exactly `admin-bootstrap-bcrypt`/);
  assert.match(docs, /rotated password/);
  assert.match(docs, /deliberately retaining that same file/);
  assert.match(docs, /Never attach container logs from a password-entry session/);
});
