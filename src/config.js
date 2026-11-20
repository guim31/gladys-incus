// -----------------------------------------------------------------------------
// Integration configuration: defaults (they mirror the `default` values of the
// manifest `config_schema`, see test/manifest.test.js) and normalization, so
// the rest of the code never deals with strings, blanks or `undefined`.
//
// One Incus (or LXD) server: the address of its HTTPS API, the trust token
// of `incus config trust add` (used once, then the client certificate is
// trusted), a display name, the interval of the reads and the language of
// the texts sent by the container.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';

export const LANGUAGES = ['en', 'fr', 'de', 'es'];

// The port of `core.https_address` in the Incus documentation.
export const DEFAULT_PORT = 8443;

// Refresh intervals offered in the configuration, in seconds.
export const POLL_INTERVALS = ['15', '30', '60', '120', '300'];

export const DEFAULT_CONFIG = {
  api_url: '',
  trust_token: '',
  host_name: '',
  poll_interval: '30',
  language: 'fr',
};

export const DEFAULT_HOST_NAME = 'Incus';
export const MAX_NAME_LENGTH = 40;

/**
 * Parse the API address typed by the user: a bare host or IP (`192.0.2.10`,
 * HTTPS and port 8443 added), `host:port`, or a full `https://` URL (a
 * reverse proxy, a path kept). Plain HTTP and credentials are refused: the
 * API only speaks TLS, and an address must never carry a secret.
 * @param {unknown} raw
 * @returns {string|null} `https://host[:port][/path]`, null when unusable
 */
export function parseApiUrl(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  const text = raw.trim();
  if (!text) {
    return null;
  }
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  let url;
  try {
    url = new URL(hasScheme ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !url.hostname) {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) {
    return null;
  }
  // `0.0.0.0` / `[::]` is where the server listens, not where Gladys reaches it.
  if (url.hostname === '0.0.0.0' || url.hostname === '[::]') {
    return null;
  }
  if (!url.port && (!hasScheme || url.pathname === '/')) {
    url.port = String(DEFAULT_PORT);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** Host part shown to the user (no scheme). */
export const hostOf = (url) => url.replace(/^https:\/\//, '');

/**
 * Decode a trust token of `incus config trust add` (base64 of a JSON object).
 * @returns {{ token: string, fingerprint: string, addresses: string[], id: string }|null}
 *   `id` a hash of the token, to remember it was used without keeping it
 */
export function parseTrustToken(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  const token = raw.replace(/\s+/g, '');
  if (!token) {
    return null;
  }
  let data;
  try {
    data = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (
    !data ||
    typeof data.client_name !== 'string' ||
    typeof data.secret !== 'string' ||
    !data.secret
  ) {
    return null;
  }
  const fingerprint =
    typeof data.fingerprint === 'string' && /^[0-9a-f]{64}$/i.test(data.fingerprint)
      ? data.fingerprint.toLowerCase()
      : null;
  return {
    token,
    fingerprint,
    addresses: Array.isArray(data.addresses)
      ? data.addresses.filter((entry) => typeof entry === 'string')
      : [],
    id: createHash('sha256').update(token).digest('hex').slice(0, 16),
  };
}

/**
 * @param {Record<string, unknown>} raw the configuration returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const text = (key) => (typeof source[key] === 'string' ? source[key].trim() : '');
  const pick = (key, list) => {
    const value = source[key] === undefined || source[key] === null ? '' : String(source[key]);
    return list.includes(value) ? value : DEFAULT_CONFIG[key];
  };

  const problems = [];
  const typedToken = text('trust_token');
  const token = parseTrustToken(typedToken);
  if (typedToken && !token) {
    problems.push('invalidToken');
  }
  const typedUrl = text('api_url');
  let url = parseApiUrl(typedUrl);
  if (typedUrl && !url) {
    problems.push('invalidUrl');
  }
  // No address typed: the first one the token lists.
  if (!typedUrl && token?.addresses.length) {
    url = parseApiUrl(token.addresses[0]);
  }

  return {
    url,
    token,
    name: text('host_name').slice(0, MAX_NAME_LENGTH) || DEFAULT_HOST_NAME,
    problems,
    pollIntervalMs: Number(pick('poll_interval', POLL_INTERVALS)) * 1000,
    language: LANGUAGES.includes(source.language) ? source.language : DEFAULT_CONFIG.language,
  };
}
