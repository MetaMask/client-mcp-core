import { describe, expect, it } from 'vitest';

import {
  isSecretUrlSegment,
  isSensitiveQueryParam,
  MAX_RECORDED_TEXT_LENGTH,
  MAX_RECORDED_URL_LENGTH,
  REDACTED_VALUE,
  redactText,
  redactUrl,
  redactUrlsInText,
  truncateText,
} from './redact.js';

const INFURA_KEY = '0123456789abcdef0123456789abcdef';
const ADDRESS = '0x5aeda56215b167893e80b4fe645ba6d5bab767de';
const TX_HASH =
  '0x9fc76417374aa880d4449a1f7f31ec597f00b1f6f3dd2d66f4c9c6c445836d8b';
const UUID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

describe('redactUrl', () => {
  it.each([
    [
      'Infura key in the path',
      `https://mainnet.infura.io/v3/${INFURA_KEY}`,
      `https://mainnet.infura.io/v3/${REDACTED_VALUE}`,
    ],
    [
      'key in a host label',
      `https://${INFURA_KEY}.rpc.example.com/`,
      `https://${REDACTED_VALUE}.rpc.example.com/`,
    ],
    [
      'apiKey query value',
      'https://api.example.com/v1/x?apiKey=supersecret&chainId=1',
      `https://api.example.com/v1/x?apiKey=${REDACTED_VALUE}&chainId=1`,
    ],
    [
      'snake and dash query names',
      'https://a.example/?api_key=1&x-api-key=2&project-id=3&token=4&sig=5&jwt=6&session=7&key=8',
      `https://a.example/?api_key=${REDACTED_VALUE}&x-api-key=${REDACTED_VALUE}&project-id=${REDACTED_VALUE}&token=${REDACTED_VALUE}&sig=${REDACTED_VALUE}&jwt=${REDACTED_VALUE}&session=${REDACTED_VALUE}&key=${REDACTED_VALUE}`,
    ],
    [
      'encoded query name',
      'https://a.example/?api%5Fkey=1&%E0%A4%A=2',
      `https://a.example/?api%5Fkey=${REDACTED_VALUE}&%E0%A4%A=2`,
    ],
    [
      'credentials',
      'https://user:pass@rpc.example.com/path',
      `https://${REDACTED_VALUE}@rpc.example.com/path`,
    ],
    [
      'username only credential',
      'https://user@rpc.example.com/path',
      `https://${REDACTED_VALUE}@rpc.example.com/path`,
    ],
    [
      'AWS signed URL',
      'https://bucket.s3.amazonaws.com/x?X-Amz-Signature=abc&X-Amz-Credential=akid%2Fdate',
      `https://bucket.s3.amazonaws.com/x?X-Amz-Signature=${REDACTED_VALUE}&X-Amz-Credential=${REDACTED_VALUE}`,
    ],
    [
      'GCS signed URL',
      'https://storage.example.com/x?X-Goog-Signature=abc&X-Goog-Credential=akid',
      `https://storage.example.com/x?X-Goog-Signature=${REDACTED_VALUE}&X-Goog-Credential=${REDACTED_VALUE}`,
    ],
    [
      'bare JWT fragment',
      'https://x.io/p#eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.sig',
      `https://x.io/p#${REDACTED_VALUE}`,
    ],
    [
      'JWT value under a non-sensitive name',
      'https://x.io/p?data=eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.sig',
      `https://x.io/p?data=${REDACTED_VALUE}`,
    ],
    [
      'hex key value under a harmless name',
      'https://x.io/?data=0123456789abcdef0123456789abcdef',
      `https://x.io/?data=${REDACTED_VALUE}`,
    ],
    [
      'digitless key value under a harmless fragment name',
      'https://x.io/#state=AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEf',
      `https://x.io/#state=${REDACTED_VALUE}`,
    ],
    [
      '0x address kept',
      `https://api.example.com/accounts/${ADDRESS}/balances`,
      `https://api.example.com/accounts/${ADDRESS}/balances`,
    ],
    [
      'tx hash kept',
      `https://api.example.com/tx/${TX_HASH}`,
      `https://api.example.com/tx/${TX_HASH}`,
    ],
    [
      'UUID kept',
      `https://api.example.com/quotes/${UUID}`,
      `https://api.example.com/quotes/${UUID}`,
    ],
    [
      'UUID after a version word kept',
      `https://api.example.com/v2/${UUID}`,
      `https://api.example.com/v2/${UUID}`,
    ],
    [
      'UUID under an orders path kept',
      `https://api.example.com/v1/orders/${UUID}`,
      `https://api.example.com/v1/orders/${UUID}`,
    ],
    [
      'UUID as the only path segment redacted (Blast gateway key)',
      `https://eth-mainnet.blastapi.io/${UUID}`,
      `https://eth-mainnet.blastapi.io/${REDACTED_VALUE}`,
    ],
    [
      'fragment tokens',
      'https://x.io/cb#access_token=ya29.a0AfH6&id_token=eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.sig',
      `https://x.io/cb#access_token=${REDACTED_VALUE}&id_token=${REDACTED_VALUE}`,
    ],
    [
      'JWT in the path',
      'https://x.io/verify/eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.sig',
      `https://x.io/verify/${REDACTED_VALUE}`,
    ],
    [
      'project ID and token query names',
      'https://rpc.example.com/?infuraProjectId=1&api_token=2&access_key=3&code=4&keyword=5&chainId=6',
      `https://rpc.example.com/?infuraProjectId=${REDACTED_VALUE}&api_token=${REDACTED_VALUE}&access_key=${REDACTED_VALUE}&code=${REDACTED_VALUE}&keyword=5&chainId=6`,
    ],
    [
      'Alchemy key after a version word',
      'https://eth-mainnet.g.alchemy.com/v2/AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEf',
      `https://eth-mainnet.g.alchemy.com/v2/${REDACTED_VALUE}`,
    ],
    [
      'Bitcoin transaction ID after an identifier word kept',
      'https://api.example.com/tx/9fc76417374aa880d4449a1f7f31ec597f00b1f6f3dd2d66f4c9c6c445836d8b',
      'https://api.example.com/tx/9fc76417374aa880d4449a1f7f31ec597f00b1f6f3dd2d66f4c9c6c445836d8b',
    ],
    [
      'Bitcoin address after an identifier word kept',
      'https://api.example.com/accounts/1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
      'https://api.example.com/accounts/1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
    ],
    [
      'hash and flag query kept',
      'https://a.example/p?flag&x=1#frag',
      'https://a.example/p?flag&x=1#frag',
    ],
    [
      'chrome-extension URL',
      `chrome-extension://abcdefghijklmnopabcdefghijklmnop/home.html?token=1`,
      `chrome-extension://abcdefghijklmnopabcdefghijklmnop/home.html?token=${REDACTED_VALUE}`,
    ],
    [
      'URL without a host',
      `data:text/plain,${INFURA_KEY}`,
      `data:text/plain,${INFURA_KEY}`,
    ],
  ])('%s', (_name, input, expected) => {
    expect(redactUrl(input)).toBe(expected);
  });

  it('keeps an unparsable URL, cut to the URL limit', () => {
    expect(redactUrl('not a url')).toBe('not a url');
    const long = 'x'.repeat(MAX_RECORDED_URL_LENGTH + 10);
    expect(redactUrl(long)).toBe(`${'x'.repeat(MAX_RECORDED_URL_LENGTH)}…`);
  });

  it('cuts a long URL', () => {
    const url = `https://a.example/${'a/'.repeat(MAX_RECORDED_URL_LENGTH)}`;
    expect(redactUrl(url)).toHaveLength(MAX_RECORDED_URL_LENGTH + 1);
  });
});

describe('isSecretUrlSegment', () => {
  it.each([
    [INFURA_KEY, true],
    ['abcdefghijklmnopqrstuvwxyz', false],
    ['123456789012345678901234', false],
    ['short1a', false],
    [ADDRESS, false],
    [UUID, false],
    ['has.dot.abcdef0123456789abcdef', false],
  ])('%s → %s', (segment, expected) => {
    expect(isSecretUrlSegment(segment)).toBe(expected);
  });
});

describe('isSensitiveQueryParam', () => {
  it('matches body field names and query names, ignoring case, - and _', () => {
    expect(isSensitiveQueryParam('writeKey')).toBe(true);
    expect(isSensitiveQueryParam('ACCESS_TOKEN')).toBe(true);
    expect(isSensitiveQueryParam('projectId')).toBe(true);
    expect(isSensitiveQueryParam('chainId')).toBe(false);
    expect(isSensitiveQueryParam('token_symbol')).toBe(false);
  });

  it('matches signed-URL credential names', () => {
    for (const name of [
      'X-Amz-Signature',
      'X-Amz-Credential',
      'X-Goog-Signature',
      'X-Goog-Credential',
    ]) {
      expect(isSensitiveQueryParam(name)).toBe(true);
    }
  });

  it('matches short secret names', () => {
    for (const name of [
      'passwd',
      'pwd',
      'pass',
      'bearer',
      'seed',
      'pk',
      'mnemonicPhrase',
    ]) {
      expect(isSensitiveQueryParam(name)).toBe(true);
    }
    expect(isSensitiveQueryParam('password')).toBe(true);
    expect(isSensitiveQueryParam('PASSWD')).toBe(true);
  });

  it('keeps non-secret names that end in key or token', () => {
    for (const name of [
      'publicKey',
      'pubKey',
      'sortKey',
      'cacheKey',
      'primaryKey',
      'sourceToken',
      'destinationToken',
      'fromToken',
      'toToken',
      'buyToken',
      'sellToken',
      'tokenAddress',
      'nativeToken',
    ]) {
      expect(isSensitiveQueryParam(name)).toBe(false);
    }
  });

  it('does not match innocent prefix lookalikes', () => {
    for (const name of [
      'author',
      'authors',
      'authority',
      'signer',
      'significant',
    ]) {
      expect(isSensitiveQueryParam(name)).toBe(false);
    }
    expect(isSensitiveQueryParam('authorization')).toBe(true);
    expect(isSensitiveQueryParam('signature')).toBe(true);
  });
});

describe('redactUrlsInText / redactText', () => {
  it('redacts URLs inside text', () => {
    expect(
      redactUrlsInText(
        `fetch failed: https://mainnet.infura.io/v3/${INFURA_KEY} (status 401)`,
      ),
    ).toBe(
      `fetch failed: https://mainnet.infura.io/v3/${REDACTED_VALUE} (status 401)`,
    );
    expect(redactUrlsInText('wss://x.example/?token=abc"')).toBe(
      `wss://x.example/?token=${REDACTED_VALUE}"`,
    );
  });

  it('keeps a URL without secrets as written', () => {
    expect(redactUrlsInText('see https://A.Example')).toBe(
      'see https://A.Example',
    );
    expect(redactUrlsInText('see https://a.example/p')).toBe(
      'see https://a.example/p',
    );
  });

  it('redacts credentials in a URL inside text', () => {
    expect(
      redactUrlsInText('basic https://user:s3cret@rpc.example.com/ end'),
    ).toBe(`basic https://${REDACTED_VALUE}@rpc.example.com/ end`);
  });

  it('redacts a URL followed by sentence punctuation and keeps the punctuation', () => {
    const infura = `https://mainnet.infura.io/v3/${INFURA_KEY}`;
    expect(redactUrlsInText(`Failed to fetch ${infura}.`)).toBe(
      `Failed to fetch https://mainnet.infura.io/v3/${REDACTED_VALUE}.`,
    );
    expect(redactUrlsInText(`fetch ${infura}, retrying`)).toBe(
      `fetch https://mainnet.infura.io/v3/${REDACTED_VALUE}, retrying`,
    );
    expect(redactUrlsInText(`fetch ${infura}: 401`)).toBe(
      `fetch https://mainnet.infura.io/v3/${REDACTED_VALUE}: 401`,
    );
    expect(redactUrlsInText(`[${infura}]`)).toBe(
      `[https://mainnet.infura.io/v3/${REDACTED_VALUE}]`,
    );
    expect(redactUrlsInText(`url=${infura};`)).toBe(
      `url=https://mainnet.infura.io/v3/${REDACTED_VALUE};`,
    );
    expect(
      redactUrlsInText('https://h.io/v2/AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEf.'),
    ).toBe(`https://h.io/v2/${REDACTED_VALUE}.`);
    expect(redactUrlsInText(`(${infura})`)).toBe(
      `(https://mainnet.infura.io/v3/${REDACTED_VALUE})`,
    );
  });

  it('redacts JWTs and Bearer tokens anywhere in a text', () => {
    const jwt = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.sig';
    expect(redactText(`Authorization: Bearer ${jwt}`)).toBe(
      `Authorization: Bearer ${REDACTED_VALUE}`,
    );
    expect(redactText(`token=${jwt} in text`)).toBe(
      `token=${REDACTED_VALUE} in text`,
    );
    expect(redactText(`payload ${jwt} end`)).toBe(
      `payload ${REDACTED_VALUE} end`,
    );
    expect(redactText('Bearer abc123def456')).toBe(`Bearer ${REDACTED_VALUE}`);
    expect(redactText('bearer abc123def456')).toBe(`bearer ${REDACTED_VALUE}`);
  });

  it('redacts credentials in non-HTTP URLs inside text', () => {
    expect(
      redactText('connect ftp://user:s3cret@files.example.com/x now'),
    ).toBe(`connect ftp://${REDACTED_VALUE}@files.example.com/x now`);
    expect(redactText('postgres://admin:hunter2@db.example.com:5432/app')).toBe(
      `postgres://${REDACTED_VALUE}@db.example.com:5432/app`,
    );
    expect(
      redactText(
        'mongodb+srv://user:pass@cluster.example.net/db?retryWrites=true',
      ),
    ).toBe(
      `mongodb+srv://${REDACTED_VALUE}@cluster.example.net/db?retryWrites=true`,
    );
  });

  it('keeps a path that contains a colon and an at sign', () => {
    expect(redactText('see https://x.io/a:b@c')).toBe('see https://x.io/a:b@c');
  });

  it('leaves text without secrets byte-identical', () => {
    const text = 'plain {"a":1} — “quotes” and https://example.com/a:b@c';
    expect(redactText(text)).toBe(text);
  });

  it('keeps a closing brace or star after a URL', () => {
    const url = `https://x.io/p?token=${INFURA_KEY}`;
    expect(redactUrlsInText(`{url: ${url}}, next`)).toBe(
      `{url: https://x.io/p?token=${REDACTED_VALUE}}, next`,
    );
    expect(redactUrlsInText(`${url}*`)).toBe(
      `https://x.io/p?token=${REDACTED_VALUE}*`,
    );
  });

  it('redacts a long run of punctuation in linear time', () => {
    // A regex-based trailing-punctuation check took seconds on this input.
    const text = `https://x.io/${'.'.repeat(100_000)}x`;
    const started = performance.now();
    expect(redactText(text)).toBe(
      `${text.slice(0, MAX_RECORDED_TEXT_LENGTH)}…`,
    );
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('cuts long text', () => {
    const text = 'e'.repeat(MAX_RECORDED_TEXT_LENGTH + 5);
    expect(redactText(text)).toBe(`${'e'.repeat(MAX_RECORDED_TEXT_LENGTH)}…`);
    expect(truncateText('abc', 2)).toBe('ab…');
    expect(truncateText('abc')).toBe('abc');
  });
});
