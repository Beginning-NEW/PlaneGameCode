const API_ORIGIN = 'https://api.github.com';
const REPOSITORY = 'Beginning-NEW/PlaneGameCode';
const REPOSITORY_PATH = '/repos/Beginning-NEW/PlaneGameCode';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_BACKOFF_MS = 60 * 60 * 1000;

function clientError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function integerHeader(headers, name) {
  const raw = headers.get(name);
  if (!/^(0|[1-9][0-9]*)$/.test(raw ?? '')) throw clientError('rate_headers_missing');
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw clientError('rate_headers_invalid');
  return value;
}

function parseRetryAfter(value, nowMs) {
  if (value == null) return null;
  if (/^[0-9]+$/.test(value)) return nowMs + Number(value) * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > nowMs ? parsed : null;
}

function assertAllowedUrl(value) {
  const url = new URL(value, API_ORIGIN);
  if (url.origin !== API_ORIGIN || url.username || url.password || url.hash) {
    throw clientError('github_url_forbidden');
  }
  const patterns = [
    new RegExp(`^${REPOSITORY_PATH}/actions/workflows/checks[.]yml/runs$`),
    new RegExp(`^${REPOSITORY_PATH}/actions/runs/[1-9][0-9]*/attempts/[1-9][0-9]*$`),
    new RegExp(`^${REPOSITORY_PATH}/actions/runs/[1-9][0-9]*/approvals$`),
    new RegExp(`^${REPOSITORY_PATH}/deployments$`),
    new RegExp(`^${REPOSITORY_PATH}/deployments/[1-9][0-9]*/statuses$`),
    new RegExp(`^${REPOSITORY_PATH}/git/ref/heads/main$`),
  ];
  if (!patterns.some((pattern) => pattern.test(url.pathname))) {
    throw clientError('github_path_forbidden');
  }
  let queryAllowed = false;
  if (url.pathname.endsWith('/actions/workflows/checks.yml/runs')) {
    queryAllowed = url.search === '?branch=main&event=push&status=completed&per_page=100';
  } else if (url.pathname.endsWith('/approvals') || url.pathname.endsWith('/statuses')) {
    queryAllowed = url.search === '?per_page=100';
  } else if (url.pathname === `${REPOSITORY_PATH}/deployments`) {
    queryAllowed = /^[0-9a-f]{40}$/.test(url.searchParams.get('sha') ?? '') &&
      url.searchParams.get('environment') === 'production' &&
      url.searchParams.get('per_page') === '100' &&
      [...url.searchParams.keys()].sort().join(',') === 'environment,per_page,sha';
  } else {
    queryAllowed = url.search === '';
  }
  if (!queryAllowed) throw clientError('github_query_forbidden');

  return url;
}

async function boundedBody(response) {
  const declared = response.headers.get('content-length');
  if (declared && (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    throw clientError('github_response_too_large');
  }
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) throw clientError('github_response_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function decodeJson(buffer) {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw clientError('github_json_malformed');
  }
}

export class PublicGitHubClient {
  constructor({ ledger, reservationId = null, fetchImpl = fetch, now = () => Date.now() }) {
    this.ledger = ledger;
    this.reservationId = reservationId;
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  withReservation(reservationId) {
    return new PublicGitHubClient({
      ledger: this.ledger,
      reservationId,
      fetchImpl: this.fetchImpl,
      now: this.now,
    });
  }

  async get(path, { etag = null, list = false, allowNotModified = false } = {}) {
    const url = assertAllowedUrl(path);
    this.ledger.recordRequest(this.reservationId);
    const headers = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'PlaneGame-private-poller/1',
    };
    if (etag) headers['if-none-match'] = etag;
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      this.ledger.defer(this.now() + DEFAULT_BACKOFF_MS, 'github_transport_failure');
      throw clientError('github_transport_failure', error?.message);
    }
    const nowMs = this.now();
    const retryAfter = parseRetryAfter(response.headers.get('retry-after'), nowMs);
    let rate;
    try {
      const limit = integerHeader(response.headers, 'x-ratelimit-limit');
      const remaining = integerHeader(response.headers, 'x-ratelimit-remaining');
      const resetSeconds = integerHeader(response.headers, 'x-ratelimit-reset');
      rate = { limit, remaining, resetMs: resetSeconds * 1000 };
      this.ledger.observeRate(rate);
    } catch (error) {
      this.ledger.defer(retryAfter ?? nowMs + DEFAULT_BACKOFF_MS, error.code ?? 'rate_headers_invalid');
      throw error;
    }
    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      this.ledger.defer(retryAfter ?? rate.resetMs, 'github_redirect_rejected');
      throw clientError('github_redirect_rejected');
    }
    if (response.status === 403 || response.status === 429) {
      this.ledger.defer(retryAfter ?? rate.resetMs, 'github_rate_limited');
      throw clientError('github_rate_limited');
    }
    if (response.status === 304) {
      if (!allowNotModified) throw clientError('github_not_modified_unexpected');
      return { status: 304, rate, etag: response.headers.get('etag'), data: null };
    }
    if (response.status !== 200) {
      throw clientError('github_http_rejected', `GitHub returned ${response.status}`);
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!/^application\/json(?:;|$)/i.test(contentType) &&
        !/^application\/vnd[.]github(?:\+json)?(?:;|$)/i.test(contentType)) {
      throw clientError('github_content_type_rejected');
    }
    if (list && response.headers.has('link')) throw clientError('github_pagination_rejected');
    const data = decodeJson(await boundedBody(response));
    if (list && Array.isArray(data) && data.length >= 100) throw clientError('github_truncation_rejected');
    return { status: 200, rate, etag: response.headers.get('etag'), data };
  }
}

export const githubPolicy = {
  API_ORIGIN,
  REPOSITORY,
  REPOSITORY_PATH,
  MAX_RESPONSE_BYTES,
};
