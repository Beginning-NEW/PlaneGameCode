#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCandidate, candidatePolicy } from './lib/github-candidate.mjs';
import { PublicGitHubClient } from './lib/github-public-client.mjs';
import { SecureLedger } from './lib/secure-ledger.mjs';
import { requireMode } from './private-actions-poller.mjs';

const JENKINS_JOB_URL = 'http://127.0.0.1:18080/job/plane-game/job/main-cd/';
const NON_QUARANTINING_REJECTIONS = new Set(['tuple_not_queued', 'jenkins_build_identity_mismatch']);

function revalidationError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function currentBuildIdentity(environment) {
  const buildNumber = environment.BUILD_NUMBER;
  const jobUrl = environment.JOB_URL;
  if (!/^[1-9][0-9]*$/.test(buildNumber ?? '') || jobUrl !== JENKINS_JOB_URL) {
    throw revalidationError('jenkins_build_identity_invalid');
  }
  return { buildNumber, buildUrl: `${jobUrl}${buildNumber}/` };
}

export function admitJenkinsBuild(record, environment = process.env) {
  if (!['queued', 'building'].includes(record?.state)) {
    throw revalidationError('tuple_not_queued');
  }
  const identity = currentBuildIdentity(environment);
  if (record.state === 'queued') return { transition: true, identity };
  if (record.buildNumber !== identity.buildNumber || record.buildUrl !== identity.buildUrl) {
    throw revalidationError('jenkins_build_identity_mismatch');
  }
  return { transition: false, identity };
}

export function shouldQuarantineRevalidationFailure(code, recordState) {
  if (NON_QUARANTINING_REJECTIONS.has(code)) return false;
  if (code === 'jenkins_build_identity_invalid' && recordState === 'building') return false;
  return true;
}

export function recordRevalidationFailure(ledger, triggerId, error) {
  const record = ledger.getState().poller[triggerId];
  if (!shouldQuarantineRevalidationFailure(error?.code, record?.state)) return { quarantined: false };
  if (record && !['failed', 'quarantined', 'succeeded'].includes(record.state)) {
    ledger.transitionPoller(triggerId, 'quarantined', {
      errorCode: /^[a-z0-9_]{1,64}$/i.test(error?.code ?? '') ? error.code : 'jenkins_revalidation_failed',
    });
  }
  ledger.cancelReservation(triggerId, error?.code ?? 'jenkins_revalidation_failed');
  return { quarantined: true };
}

export async function revalidateJenkinsCandidate({ ledger, candidate, client,
  environment = process.env, validate = validateCandidate }) {
  const record = ledger.getState().poller[candidate.triggerId];
  const admission = admitJenkinsBuild(record, environment);
  if (admission.transition) {
    ledger.transitionPoller(candidate.triggerId, 'building', admission.identity);
  }
  return validate(client, candidate);
}

async function main() {
  requireMode('poller');
  if (process.argv.length !== 6) {
    throw new Error('usage: jenkins-revalidate.mjs STATE_DIR SHA RUN_ID RUN_ATTEMPT');
  }
  const [root, sha, runId, runAttempt] = process.argv.slice(2);
  const candidate = candidatePolicy.exactCandidate({ sha, runId, runAttempt });
  const ledger = new SecureLedger(root);
  try {
    const evidence = await revalidateJenkinsCandidate({
      ledger,
      candidate,
      client: new PublicGitHubClient({ ledger, reservationId: candidate.triggerId }),
    });
    process.stdout.write([
      evidence.run.runNumber,
      evidence.hash,
      evidence.approvals[0].reviewer.login,
      String(evidence.approvals[0].reviewer.id),
      evidence.approvals[0].marker,
      evidence.deployment.id,
    ].join('\t') + '\n');
  } catch (error) {
    recordRevalidationFailure(ledger, candidate.triggerId, error);
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
