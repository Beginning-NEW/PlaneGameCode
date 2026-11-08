import { request } from 'node:https';

function directError(code) {
  return Object.assign(new Error(code), { code });
}

export function directPublicGitHubFetch(input, options = {}, requestImpl = request) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw directError('github_url_forbidden');
  }
  if (url.origin !== 'https://api.github.com' || url.username || url.password || url.hash) {
    throw directError('github_url_forbidden');
  }
  if (options.redirect !== 'manual' || options.body !== undefined && options.body !== null) {
    throw directError('github_request_forbidden');
  }

  return new Promise((resolve, reject) => {
    const handle = requestImpl(url, {
      method: options.method ?? 'GET',
      headers: options.headers,
      signal: options.signal,
      agent: false,
      rejectUnauthorized: true,
    }, (response) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) {
          for (const entry of value) headers.append(name, entry);
        } else if (value !== undefined) {
          headers.append(name, String(value));
        }
      }
      resolve({
        status: response.statusCode ?? 0,
        headers,
        body: response,
      });
    });
    handle.on('error', reject);
    handle.end();
  });
}
