#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidateFromDiscovery, validateCandidate } from './lib/github-candidate.mjs';
import { PublicGitHubClient, githubPolicy } from './lib/github-public-client.mjs';
import { JenkinsCredentialProvider, JenkinsPollerClient } from './lib/jenkins-poller-client.mjs';
import { SecureLedger } from './lib/secure-ledger.mjs';

function requireMode(expected) {
  const mode = process.env.CD_TRIGGER_MODE;
  if (!['disabled', 'poller', 'webhook'].includes(mode ?? '') || mode !== expected) {
    throw Object.assign(new Error(`CD trigger mode must be ${expected}`), { code: 'trigger_mode_rejected' });
  }
}

function safeCode(error) {
  return /^[a-z0-9_]{1,64}$/i.test(error?.code ?? '') ? error.code : 'poller_failed';
}

export class PrivateActionsPoller {
  constructor({ ledger, githubClient, jenkinsClient, logger = () => {} }) {
    this.ledger = ledger;
    this.githubClient = githubClient;
    this.jenkinsClient = jenkinsClient;
    this.logger = logger;
  }

  async reconcilePending() {
    const pending = Object.entries(this.ledger.getState().poller)
      .filter(([, record]) => ['post_intent', 'quarantined'].includes(record.state) &&
        record.reconcileAttempted !== true && record.evidenceHash &&
        !record.queueId && !record.buildNumber)
      .sort((left, right) => left[1].updatedAtMs - right[1].updatedAtMs);
    if (pending.length === 0) return null;
    const [triggerId, record] = pending[0];
    let recovered;
    try {
      const prepared = this.jenkinsClient.prepareAuthorization();
      const result = await this.jenkinsClient.reconcile(record.candidate, prepared);
      recovered = this.ledger.reconcilePoller(triggerId, result);
    } catch (error) {
      if (this.ledger.getState().poller[triggerId]?.reconcileAttempted !== true) {
        this.ledger.reconcilePoller(triggerId, null, safeCode(error));
      }
      this.ledger.cancelReservation(triggerId, safeCode(error));
      this.logger({ outcome: 'quarantined', code: safeCode(error), triggerId });
      throw error;
    }
    if (['failed', 'quarantined'].includes(recovered.state)) {
      this.ledger.cancelReservation(triggerId, 'jenkins_reconciled_terminal');
    }
    this.logger({ outcome: 'reconciled', code: recovered.state, triggerId });
    return { outcome: 'reconciled', state: recovered.state, triggerId };
  }

  async runOnce() {
    const recovery = await this.reconcilePending();
    if (recovery) return recovery;
    const state = this.ledger.getState();
    const discovery = await this.githubClient.get(
      `${githubPolicy.REPOSITORY_PATH}/actions/workflows/checks.yml/runs?branch=main&event=push&status=completed&per_page=100`,
      { etag: state.discovery.etag, list: true, allowNotModified: true },
    );
    if (discovery.status === 304) {
      this.logger({ outcome: 'unchanged', code: 'not_modified' });
      return { outcome: 'unchanged' };
    }
    if (!/^W\/"[^"\r\n]+"$|^"[^"\r\n]+"$/.test(discovery.etag ?? '')) {
      throw Object.assign(new Error('conditional discovery ETag missing'), { code: 'discovery_etag_missing' });
    }
    const candidate = candidateFromDiscovery(discovery.data);
    this.ledger.setDiscovery({ etag: discovery.etag, triggerId: candidate.triggerId });
    const current = this.ledger.getState();
    if (current.poller[candidate.triggerId]) {
      this.logger({ outcome: 'duplicate', code: current.poller[candidate.triggerId].state });
      return { outcome: 'duplicate', state: current.poller[candidate.triggerId].state };
    }

    this.ledger.admitCandidate(candidate.triggerId, discovery.rate.remaining);
    this.ledger.transitionPoller(candidate.triggerId, 'observed', { candidate });
    const reservedClient = this.githubClient.withReservation(candidate.triggerId);
    try {
      const initial = await validateCandidate(reservedClient, candidate);
      this.ledger.transitionPoller(candidate.triggerId, 'eligible', {
        initialEvidenceHash: initial.hash,
        approval: initial.approvals[0],
        deployment: initial.deployment,
      });
      const final = await validateCandidate(reservedClient, candidate);
      if (final.hash !== initial.hash) {
        throw Object.assign(new Error('evidence changed between validation passes'), {
          code: 'stale_evidence',
        });
      }
      const prepared = this.jenkinsClient.prepareAuthorization();
      this.ledger.transitionPoller(candidate.triggerId, 'post_intent', {
        evidenceHash: final.hash,
        approval: final.approvals[0],
        deployment: final.deployment,
      });
      let queue;
      try {
        queue = await this.jenkinsClient.enqueue(candidate, prepared);
      } catch (error) {
        this.ledger.transitionPoller(candidate.triggerId, 'quarantined', {
          errorCode: safeCode(error),
        });
        throw error;
      }
      this.ledger.transitionPoller(candidate.triggerId, 'queued', queue);
      this.logger({ outcome: 'queued', code: 'queued', triggerId: candidate.triggerId });
      return { outcome: 'queued', candidate, queue };
    } catch (error) {
      const record = this.ledger.getState().poller[candidate.triggerId];
      if (record && !['post_intent', 'queued', 'quarantined'].includes(record.state)) {
        this.ledger.transitionPoller(candidate.triggerId, 'failed', { errorCode: safeCode(error) });
      }
      if (!record || !['post_intent', 'queued', 'quarantined'].includes(record.state)) {
        this.ledger.cancelReservation(candidate.triggerId, safeCode(error));
      }
      this.logger({ outcome: 'failed', code: safeCode(error), triggerId: candidate.triggerId });
      throw error;
    }
  }
}

async function main() {
  if (process.argv[2] === '--initialize') {
    const root = process.argv[3];
    if (!root || process.argv.length !== 4) throw new Error('usage: private-actions-poller.mjs --initialize STATE_DIR');
    SecureLedger.initialize(root);
    return;
  }
  requireMode('poller');
  const root = process.env.PLANE_POLLER_STATE_DIR;
  const credential = process.env.PLANE_POLLER_JENKINS_CREDENTIAL_FILE;
  if (!root || !credential) throw new Error('poller file configuration is incomplete');
  const ledger = new SecureLedger(root);
  const poller = new PrivateActionsPoller({
    ledger,
    githubClient: new PublicGitHubClient({ ledger }),
    jenkinsClient: new JenkinsPollerClient({
      credentialProvider: new JenkinsCredentialProvider(credential),
    }),
    logger: ({ outcome, code, triggerId }) =>
      console.info(`private_poller outcome=${outcome} code=${code}${triggerId ? ` trigger_id=${triggerId}` : ''}`),
  });
  await poller.runOnce();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}

export { requireMode };
