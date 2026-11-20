/**
 * Redaction for session event records (`mm logs`, `mm network`). Applied
 * before a record enters the buffer, so secrets never reach the output.
 */

import { isSensitiveBodyField, REDACTED_VALUE } from '../tools/mock-network.js';

export { REDACTED_VALUE };

export const MAX_RECORDED_URL_LENGTH = 2048;

export const MAX_RECORDED_TEXT_LENGTH = 2000;

// Query and fragment parameter names whose values are secrets, in addition to
// the mock-network body field names and the patterns below.
const SENSITIVE_QUERY_PARAMS = new Set([
  'key',
  'token',
  'auth',
  'authtoken',
  'sig',
  'signature',
  'jwt',
  'session',
  'sessionid',
  'sessiontoken',
  'projectid',
  'code',
  'passwd',
  'pwd',
  'pass',
  'bearer',
  'seed',
  'pk',
]);

// Names that end in `key` or `token` but are not secrets: a sort key, the
// source and destination tokens of a swap, a public key. They are checked
// before the suffix patterns, so a name on this list is never redacted.
const NON_SECRET_QUERY_NAMES = new Set([
  'publickey',
  'pubkey',
  'sortkey',
  'cachekey',
  'primarykey',
  'sourcetoken',
  'destinationtoken',
  'fromtoken',
  'totoken',
  'buytoken',
  'selltoken',
  'tokenaddress',
  'nativetoken',
]);

// Parameter names that carry a secret as a suffix or prefix, after
// lowercasing and removing `-` and `_`: `infuraProjectId`, `api_token`,
// `access_key`, `x-api-key`, `sig`, `signature`, `authToken`, `oauth`.
const SENSITIVE_QUERY_NAME_PATTERNS = [
  /token$/u,
  /key$/u,
  /secret$/u,
  /projectid$/u,
  // `sig`, `sign`, `signature`, and `x-amz-signature` / `x-goog-signature`
  // through the suffix rule. `signer` and `significant` are not secrets.
  /^sig(?:n|nature)?$/u,
  /signature$/u,
  // `auth`, `authToken`, `authentication`, `authorization`, but not the
  // innocent `author`, `authors` and `authority`.
  /^auth(?!or(?:s|ity)?$)/u,
  // `x-amz-credential` / `x-goog-credential`.
  /credential$/u,
  // `mnemonic`, `mnemonicPhrase`, `mnemonic_words`.
  /mnemonic/u,
];

// A JWT: three base64url parts, the first starting with `eyJ` (`{"`).
const JWT_PATTERN = /^eyJ[\w-]+\.[\w-]+\.[\w-]*$/u;

// A JWT anywhere in a text. A shorter first part is allowed than in a URL
// path, because a text can be a log line around a token.
const JWT_IN_TEXT_PATTERN = /\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*/gu;

// The credential after `Bearer`, case-insensitive, anywhere in a text. A
// value shorter than 8 token characters is prose (`the bearer of good news`),
// not a token.
const BEARER_TOKEN_IN_TEXT_PATTERN = /\b(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/giu;

// `scheme://user:password@` anywhere in a text, for schemes the URL pattern
// does not know (`ftp:`, `postgres:`, `redis:`, `mongodb+srv:`, …). The match
// is parsed as a URL so only a real userinfo is redacted, not a path that
// happens to contain `:` and `@`.
const ANY_SCHEME_URL_IN_TEXT_PATTERN =
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`)\]}*]+/giu;

// Path segments that identify an object (an account, a transaction), whose
// next segment can be a hash-like ID rather than a key.
const IDENTIFIER_PATH_WORDS = new Set([
  'account',
  'accounts',
  'address',
  'addresses',
  'tx',
  'txs',
  'transaction',
  'transactions',
]);

// Path segments that hold an API key in the next segment (`/v3/<key>`).
const RPC_KEY_PATH_WORDS = new Set(['v1', 'v2', 'v3', 'v4']);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

// A 64-character hex ID without `0x`, such as a Bitcoin transaction ID.
const HEX_ID_PATTERN = /^[0-9a-f]{64}$/iu;

// A base58 string of the length of a Bitcoin address or transaction ID.
const BASE58_ID_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u;

const URL_IN_TEXT_PATTERN = /\b(?:https?|wss?):\/\/[^\s"'<>`)\]}*]+/giu;

// Punctuation that can end a sentence right after a URL, which the URL
// pattern otherwise swallows. `)}]`, `}` and `*` are already excluded from
// the pattern, so a URL wrapped in `{`/`(`/`[` keeps its wrapper.
const TRAILING_URL_PUNCTUATION_CHARS = new Set([
  '.',
  ',',
  ';',
  ':',
  '!',
  '?',
  '}',
  '*',
]);

/**
 * Checks whether a URL segment looks like an API key: at least 24
 * characters of letters, digits, `-` or `_`, with both letters and digits.
 * Hex values with `0x` (addresses, hashes) and UUIDs are kept; JWTs are
 * always redacted, even when shorter than 24 characters.
 *
 * @param segment - A path segment or host label.
 * @returns True if the segment must be redacted.
 */
export function isSecretUrlSegment(segment: string): boolean {
  return (
    (segment.length >= 24 &&
      /^[A-Za-z0-9_-]+$/u.test(segment) &&
      /[0-9]/u.test(segment) &&
      /[A-Za-z]/u.test(segment) &&
      !/^0x[0-9a-f]+$/iu.test(segment) &&
      !UUID_PATTERN.test(segment)) ||
    JWT_PATTERN.test(segment)
  );
}

/**
 * Checks whether a query or fragment parameter holds a secret.
 *
 * @param name - The decoded parameter name.
 * @returns True if the value must be redacted.
 */
export function isSensitiveQueryParam(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[-_]/gu, '');
  if (NON_SECRET_QUERY_NAMES.has(normalized)) {
    return false;
  }
  return (
    isSensitiveBodyField(name) ||
    SENSITIVE_QUERY_PARAMS.has(normalized) ||
    SENSITIVE_QUERY_NAME_PATTERNS.some((pattern) => pattern.test(normalized))
  );
}

/**
 * Cuts a text to a maximum length and marks the cut.
 *
 * @param text - The text.
 * @param maxLength - The maximum length.
 * @returns The text, at most `maxLength` characters plus the marker.
 */
export function truncateText(
  text: string,
  maxLength = MAX_RECORDED_TEXT_LENGTH,
): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/**
 * Redacts secrets in a URL: credentials, key-like host labels and path
 * segments (for example an Infura project ID) and sensitive query values.
 * The result is cut to {@link MAX_RECORDED_URL_LENGTH} characters.
 *
 * @param rawUrl - The URL.
 * @returns The URL safe to record.
 */
export function redactUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return truncateText(rawUrl, MAX_RECORDED_URL_LENGTH);
  }
  if (url.host === '') {
    // `chrome-extension:` and other non-hierarchical URLs: nothing to redact
    // in a host; keep the path rules.
    return truncateText(
      `${url.protocol}${redactPath(url.pathname)}${redactParameters(
        url.search,
        '?',
      )}${redactParameters(url.hash, '#')}`,
      MAX_RECORDED_URL_LENGTH,
    );
  }

  const host = url.host
    .split('.')
    .map((label) => (isSecretUrlSegment(label) ? REDACTED_VALUE : label))
    .join('.');
  // `user:pass@host` carries a credential: keep the fact that there was one,
  // so a redacted URL is recognisably redacted, without the credential.
  const credentials =
    url.username !== '' || url.password !== '' ? `${REDACTED_VALUE}@` : '';
  return truncateText(
    `${url.protocol}//${credentials}${host}${redactPath(
      url.pathname,
    )}${redactParameters(url.search, '?')}${redactParameters(url.hash, '#')}`,
    MAX_RECORDED_URL_LENGTH,
  );
}

/**
 * Redacts key-like segments of a URL path. A UUID that is the whole path is
 * a credential, as in `https://eth-mainnet.blastapi.io/<uuid>`; a UUID under
 * a real path is an identifier and is kept. Segments after an identifier word
 * also keep hash-like IDs (a transaction hash, a Bitcoin address); segments
 * after an RPC version word are redacted as API keys when they are opaque.
 *
 * @param pathname - The URL path.
 * @returns The path with secret segments replaced.
 */
function redactPath(pathname: string): string {
  const segments = pathname.split('/');
  const nonEmpty = segments.filter((segment) => segment !== '');
  // The only-segment rule keeps `/v1/orders/<uuid>` and `/v2/<uuid>` as
  // identifiers while redacting a bare key path such as the Blast one.
  const onlySegment = nonEmpty.length === 1 ? nonEmpty[0] : undefined;
  let previous = '';
  return segments
    .map((segment) => {
      const afterIdentifier = IDENTIFIER_PATH_WORDS.has(previous);
      const afterRpcVersion = RPC_KEY_PATH_WORDS.has(previous);
      previous = segment.toLowerCase();
      if (segment === onlySegment && UUID_PATTERN.test(segment)) {
        return REDACTED_VALUE;
      }
      if (
        afterIdentifier &&
        (HEX_ID_PATTERN.test(segment) || BASE58_ID_PATTERN.test(segment))
      ) {
        return segment;
      }
      if (afterRpcVersion && isOpaquePathKey(segment)) {
        return REDACTED_VALUE;
      }
      return isSecretUrlSegment(segment) ? REDACTED_VALUE : segment;
    })
    .join('/');
}

/**
 * Checks whether a path segment after an RPC version word is an API key: at
 * least 28 letters, digits, `-` or `_`, not a hex value with `0x` or a UUID.
 *
 * Trade-off: the check does not require digits, because real keys can be
 * 32 random letters only (a digit-less Alchemy key would leak otherwise).
 * A long human-readable word in that position is redacted as collateral;
 * version words are followed by a key in every RPC provider URL seen, so
 * that is the safe side.
 *
 * @param segment - The path segment.
 * @returns True if the segment must be redacted.
 */
function isOpaquePathKey(segment: string): boolean {
  return (
    segment.length >= 28 &&
    /^[A-Za-z0-9_-]+$/u.test(segment) &&
    !/^0x[0-9a-f]+$/iu.test(segment) &&
    !UUID_PATTERN.test(segment)
  );
}

/**
 * Redacts the values of sensitive parameters in a query string or fragment.
 *
 * @param parameters - The query string or fragment, with its `?` or `#`, or
 * empty.
 * @param prefix - The `?` or `#` that starts the parameters.
 * @returns The parameters with secret values replaced.
 */
function redactParameters(parameters: string, prefix: '?' | '#'): string {
  if (!parameters) {
    return '';
  }
  const pairs = parameters.slice(1).split('&').map(redactPair);
  return `${prefix}${pairs.join('&')}`;
}

/**
 * Redacts one `name=value` parameter when its name is sensitive or its value
 * is a JWT. A bare part (no `=`) is redacted when it looks like a key, as in
 * `#<jwt>`.
 *
 * @param pair - The encoded parameter.
 * @returns The parameter with its value replaced, or the input.
 */
function redactPair(pair: string): string {
  const separator = pair.indexOf('=');
  if (separator < 0) {
    return isSecretUrlSegment(decodeQueryName(pair)) ? REDACTED_VALUE : pair;
  }
  const name = decodeQueryName(pair.slice(0, separator));
  const value = decodeQueryName(pair.slice(separator + 1));
  return isSensitiveQueryParam(name) || JWT_PATTERN.test(value)
    ? `${pair.slice(0, separator)}=${REDACTED_VALUE}`
    : pair;
}

/**
 * Decodes a query parameter name without throwing.
 *
 * @param name - The encoded name.
 * @returns The decoded name, or the input when it is not valid encoding.
 */
function decodeQueryName(name: string): string {
  try {
    return decodeURIComponent(name.replace(/\+/gu, ' '));
  } catch {
    return name;
  }
}

/**
 * Counts the trailing sentence punctuation of a URL match. A backward loop
 * keeps the work linear: a regex such as `[.,;:!?]+$` can retry at every
 * position of a long run of punctuation.
 *
 * @param match - The URL as matched in the text.
 * @returns The number of trailing punctuation characters.
 */
function trailingUrlPunctuationLength(match: string): number {
  let start = match.length;
  while (
    start > 0 &&
    TRAILING_URL_PUNCTUATION_CHARS.has(match.charAt(start - 1))
  ) {
    start -= 1;
  }
  return match.length - start;
}

/**
 * Redacts the credentials of a `scheme://user:password@` URL in a text for
 * the schemes the URL pattern does not know (`ftp:`, `postgres:`, …). The URL
 * is parsed, so a path that contains `:` and `@` is not mistaken for a
 * credential.
 *
 * @param text - The text.
 * @returns The text with URL credentials redacted.
 */
function redactCredentialUrlsInText(text: string): string {
  return text.replace(ANY_SCHEME_URL_IN_TEXT_PATTERN, (match) => {
    let url: URL;
    try {
      url = new URL(match);
    } catch {
      return match;
    }
    if (url.username === '' && url.password === '') {
      return match;
    }
    return `${url.protocol}//${REDACTED_VALUE}@${url.host}${url.pathname}${url.search}${url.hash}`;
  });
}

/**
 * Redacts JWTs and `Bearer` tokens anywhere in a text. Text without a match
 * is returned unchanged.
 *
 * @param text - The text.
 * @returns The text with tokens redacted.
 */
function redactTokensInText(text: string): string {
  return text
    .replace(BEARER_TOKEN_IN_TEXT_PATTERN, `$1${REDACTED_VALUE}`)
    .replace(JWT_IN_TEXT_PATTERN, REDACTED_VALUE);
}

/**
 * Redacts every URL found in a text. A URL without secrets is kept as it
 * appears, so normalizing it does not change the text. Trailing sentence
 * punctuation is not part of the URL and is put back after redacting.
 *
 * @param text - The text.
 * @returns The text with redacted URLs.
 */
export function redactUrlsInText(text: string): string {
  return text.replace(URL_IN_TEXT_PATTERN, (match) => {
    const length = trailingUrlPunctuationLength(match);
    const suffix = length === 0 ? '' : match.slice(-length);
    const url = length === 0 ? match : match.slice(0, -length);
    const redacted = redactUrl(url);
    return redacted.includes(REDACTED_VALUE) ? `${redacted}${suffix}` : match;
  });
}

/**
 * Redacts URLs and their credentials, JWTs and `Bearer` tokens in a text and
 * cuts it to {@link MAX_RECORDED_TEXT_LENGTH} characters.
 *
 * @param text - The text, for example a console message.
 * @returns The text safe to record.
 */
export function redactText(text: string): string {
  const withoutUrls = redactUrlsInText(text);
  return truncateText(
    redactTokensInText(redactCredentialUrlsInText(withoutUrls)),
  );
}
