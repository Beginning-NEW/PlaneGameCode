import { request } from 'node:http';

function loopbackError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function responseHeaders(source) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(source)) {
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    } else if (value !== undefined) {
      headers.append(name, String(value));
    }
  }
  return headers;
}

async function readText(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

export function directLoopbackFetch(input, options = {}) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw loopbackError('loopback_url_forbidden');
  }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' ||
      url.username || url.password || url.hash) {
    throw loopbackError('loopback_url_forbidden');
  }
  if (options.redirect !== undefined && options.redirect !== 'manual') {
    throw loopbackError('loopback_redirect_mode_forbidden');
  }
  if (options.body !== undefined && options.body !== null) {
    throw loopbackError('loopback_request_body_forbidden');
  }

  return new Promise((resolve, reject) => {
    const requestHandle = request(url, {
      method: options.method ?? 'GET',
      headers: options.headers,
      signal: options.signal,
      agent: false,
    }, (response) => {
      const headers = responseHeaders(response.headers);
      resolve({
        status: response.statusCode ?? 0,
        ok: response.statusCode >= 200 && response.statusCode < 300,
        url: url.href,
        headers,
        body: response,
        text: () => readText(response),
        json: async () => JSON.parse(await readText(response)),
      });
    });
    requestHandle.on('error', reject);
    requestHandle.end();
  });
}
