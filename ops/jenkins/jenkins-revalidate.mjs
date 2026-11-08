#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCandidate, candidatePolicy } from './lib/github-candidate.mjs';
import { PublicGitHubClient } from './lib/github-public-client.mjs';
import { SecureLedger } from './lib/secure-ledger.mjs';
import { requireMode } from './private-actions-poller.mjs';

async function main() {
  requireMode('poller');
  if (process.argv.length !== 6) {
    throw new Error('usage: jenkins-revalidate.mjs STATE_DIR SHA RUN_ID RUN_ATTEMPT');
  }
  const [root, sha, runId, runAttempt] = process.argv.slice(2);
  const candidate = candidatePolicy.exactCandidate({ sha, runId, runAttempt });
  const ledger = new SecureLedger(root);
  try {
    const record = ledger.getState().poller[candidate.triggerId];
    if (record?.state !== 'queued') throw Object.assign(new Error('tuple is not queued'), { code: 'tuple_not_queued' });
    ledger.transitionPoller(candidate.triggerId, 'building');
    const evidence = await validateCandidate(
      new PublicGitHubClient({ ledger, reservationId: candidate.triggerId }), candidate);
    process.stdout.write([
      evidence.run.runNumber,
      evidence.hash,
      evidence.approvals[0].reviewer.login,
      String(evidence.approvals[0].reviewer.id),
      evidence.approvals[0].submittedAt,
      evidence.deployment.id,
    ].join('\t') + '\n');
  } catch (error) {
    const record = ledger.getState().poller[candidate.triggerId];
    if (record && !['failed', 'quarantined', 'succeeded'].includes(record.state)) {
      ledger.transitionPoller(candidate.triggerId, 'quarantined', {
        errorCode: /^[a-z0-9_]{1,64}$/i.test(error?.code ?? '') ? error.code : 'jenkins_revalidation_failed',
      });
    }
    ledger.cancelReservation(candidate.triggerId, error?.code ?? 'jenkins_revalidation_failed');
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
