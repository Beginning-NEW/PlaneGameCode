import { createHash } from 'node:crypto';
import { githubPolicy } from './github-public-client.mjs';

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const INTEGER_PATTERN = /^[1-9][0-9]*$/;
const EXPECTED_WORKFLOW_ID = 407966338;
const EXPECTED_WORKFLOW_PATH = '.github/workflows/checks.yml';
const APPROVER = { login: 'Beginning-NEW', id: 183624934 };

function candidateError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function evidenceHash(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function positive(value) {
  const text = String(value ?? '');
  return INTEGER_PATTERN.test(text) ? text : null;
}

function exactCandidate(candidate) {
  const normalized = {
    sha: String(candidate?.sha ?? ''),
    runId: positive(candidate?.runId),
    runAttempt: positive(candidate?.runAttempt),
  };
  if (!SHA_PATTERN.test(normalized.sha) || !normalized.runId || !normalized.runAttempt) {
    throw candidateError('candidate_identity_invalid');
  }
  return { ...normalized, triggerId: `${normalized.sha}:${normalized.runId}:${normalized.runAttempt}` };
}

function validateRun(run, candidate) {
  if (String(run?.id ?? '') !== candidate.runId ||
      String(run?.run_attempt ?? '') !== candidate.runAttempt ||
      run?.workflow_id !== EXPECTED_WORKFLOW_ID || run?.path !== EXPECTED_WORKFLOW_PATH ||
      run?.event !== 'push' || run?.head_branch !== 'main' || run?.head_sha !== candidate.sha ||
      run?.status !== 'completed' || run?.conclusion !== 'success' ||
      run?.repository?.full_name !== githubPolicy.REPOSITORY ||
      run?.head_repository?.full_name !== githubPolicy.REPOSITORY || !positive(run?.run_number)) {
    throw candidateError('run_evidence_rejected');
  }
  const startedMs = Date.parse(run.run_started_at);
  const completedMs = Date.parse(run.updated_at);
  if (!Number.isFinite(startedMs) || !Number.isFinite(completedMs) || completedMs < startedMs) {
    throw candidateError('attempt_window_invalid');
  }
  return { startedMs, completedMs, runNumber: String(run.run_number) };
}

function approvalMarker(candidate) {
  return `plane-game-cd-approved run=${candidate.runId} attempt=${candidate.runAttempt} sha=${candidate.sha}`;
}

function withinAttempt(value, window) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms >= window.startedMs && ms <= window.completedMs ? ms : null;
}

function validateApprovals(approvals, candidate) {
  if (!Array.isArray(approvals) || approvals.length === 0 || approvals.length >= 100) {
    throw candidateError('approval_history_rejected');
  }
  const production = approvals.filter((record) => record?.environments?.some(
    (environment) => environment?.name === 'production',
  ));
  if (production.length === 0 || production.some((record) => record?.state !== 'approved')) {
    throw candidateError('approval_state_rejected');
  }
  const allowed = production.filter((record) =>
    record?.user?.login === APPROVER.login && record?.user?.id === APPROVER.id);
  if (allowed.length === 0) throw candidateError('approval_reviewer_rejected');
  const marker = approvalMarker(candidate);
  if (allowed.filter((record) => record?.comment === marker).length !== 1) {
    throw candidateError('approval_attempt_ambiguous');
  }
  return [{ reviewer: APPROVER, environment: 'production', marker }];
}

function selectDeployment(deployments, candidate, window) {
  if (!Array.isArray(deployments) || deployments.length === 0 || deployments.length >= 100) {
    throw candidateError('deployment_history_rejected');
  }
  const matches = deployments.filter((deployment) =>
    deployment?.sha === candidate.sha && deployment?.environment === 'production' &&
    positive(deployment?.id) && withinAttempt(deployment?.created_at, window) !== null);
  if (matches.length !== 1) throw candidateError('deployment_ambiguous');
  return matches[0];
}

function validateDeploymentStatus(statuses, deployment, window) {
  if (!Array.isArray(statuses) || statuses.length === 0 || statuses.length >= 100) {
    throw candidateError('deployment_status_rejected');
  }
  const latest = statuses[0];
  const url = `https://api.github.com/repos/${githubPolicy.REPOSITORY}/deployments/${deployment.id}`;
  if (latest?.state !== 'success' || statuses.some((status) =>
    status?.deployment_url !== url || withinAttempt(status?.created_at, window) === null)) {
    throw candidateError('deployment_status_rejected');
  }
  const chronological = [...statuses].reverse();
  // GitHub emits adjacent duplicate states on some runs (two `waiting` at
  // creation, two `queued` around the approval), so collapse runs of the same state.
  const states = [];
  const times = [];
  for (const status of chronological) {
    if (states.length > 0 && states[states.length - 1] === status.state) continue;
    states.push(status.state);
    times.push(withinAttempt(status.created_at, window));
  }
  if (!['waiting,in_progress,success', 'waiting,queued,in_progress,success'].includes(states.join(',')) ||
      times.some((time, index) => index > 0 && time < times[index - 1])) {
    throw candidateError('deployment_status_rejected');
  }
  return { id: String(latest.id ?? ''), state: latest.state, createdAt: latest.created_at ?? null };
}

function validateMain(reference, candidate) {
  if (reference?.ref !== 'refs/heads/main' || reference?.object?.type !== 'commit' ||
      reference?.object?.sha !== candidate.sha) {
    throw candidateError('main_moved');
  }
}

export function candidateFromDiscovery(payload) {
  const runs = payload?.workflow_runs;
  if (!Array.isArray(runs) || runs.length === 0 || runs.length >= 100) {
    throw candidateError('discovery_rejected');
  }
  const run = runs[0];
  const candidate = exactCandidate({ sha: run?.head_sha, runId: run?.id, runAttempt: run?.run_attempt });
  validateRun(run, candidate);
  return candidate;
}

export async function validateCandidate(client, rawCandidate) {
  const candidate = exactCandidate(rawCandidate);
  const base = githubPolicy.REPOSITORY_PATH;
  const runResponse = await client.get(`${base}/actions/runs/${candidate.runId}/attempts/${candidate.runAttempt}`);
  const window = validateRun(runResponse.data, candidate);
  const approvalsResponse = await client.get(
    `${base}/actions/runs/${candidate.runId}/approvals?per_page=100`, { list: true });
  const approvals = validateApprovals(approvalsResponse.data, candidate);
  const deploymentsResponse = await client.get(
    `${base}/deployments?sha=${candidate.sha}&environment=production&per_page=100`, { list: true });
  const deployment = selectDeployment(deploymentsResponse.data, candidate, window);
  const statusesResponse = await client.get(
    `${base}/deployments/${deployment.id}/statuses?per_page=100`, { list: true });
  const status = validateDeploymentStatus(statusesResponse.data, deployment, window);
  const mainResponse = await client.get(`${base}/git/ref/heads/main`);
  validateMain(mainResponse.data, candidate);

  const evidence = {
    version: 1,
    candidate,
    run: {
      workflowId: EXPECTED_WORKFLOW_ID,
      workflowPath: EXPECTED_WORKFLOW_PATH,
      runNumber: window.runNumber,
      startedAt: new Date(window.startedMs).toISOString(),
      completedAt: new Date(window.completedMs).toISOString(),
    },
    approvals,
    deployment: {
      id: String(deployment.id),
      sha: deployment.sha,
      environment: deployment.environment,
      status,
    },
    mainSha: mainResponse.data.object.sha,
  };
  return { ...evidence, hash: evidenceHash(evidence) };
}

export const candidatePolicy = {
  EXPECTED_WORKFLOW_ID,
  EXPECTED_WORKFLOW_PATH,
  APPROVER,
  approvalMarker,
  exactCandidate,
  evidenceHash,
};
