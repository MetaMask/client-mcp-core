import { describe, expect, it } from 'vitest';

import {
  MAX_RPC_BATCH_METHODS,
  MAX_RPC_METHOD_NAME_LENGTH,
  MAX_RPC_REQUEST_BYTES,
  parseRpcError,
  parseRpcMethods,
} from './json-rpc.js';

describe('parseRpcMethods', () => {
  it('reads a single call as a one-item array', () => {
    expect(
      parseRpcMethods('{"jsonrpc":"2.0","id":1,"method":"eth_call"}'),
    ).toStrictEqual(['eth_call']);
    expect(parseRpcMethods('  {"id":1,"method":"eth_chainId"}')).toStrictEqual([
      'eth_chainId',
    ]);
    expect(
      parseRpcMethods('{"method":"eth_blockNumber","params":[]}'),
    ).toStrictEqual(['eth_blockNumber']);
  });

  it('reads a batch in order and caps it', () => {
    expect(
      parseRpcMethods(
        JSON.stringify([
          { jsonrpc: '2.0', id: 2, method: 'eth_chainId' },
          { foo: 1 },
          { jsonrpc: '2.0', id: 3, method: 'eth_blockNumber' },
        ]),
      ),
    ).toStrictEqual(['eth_chainId', 'eth_blockNumber']);
    const big = Array.from({ length: MAX_RPC_BATCH_METHODS + 5 }, (_, id) => ({
      id,
      method: `m${id}`,
    }));
    expect(parseRpcMethods(JSON.stringify(big))).toHaveLength(
      MAX_RPC_BATCH_METHODS,
    );
  });

  it('caps a method name', () => {
    const method = `m${'x'.repeat(200)}`;
    expect(parseRpcMethods(JSON.stringify({ id: 1, method }))).toStrictEqual([
      method.slice(0, MAX_RPC_METHOD_NAME_LENGTH),
    ]);
  });

  it('returns undefined for non-JSON-RPC bodies', () => {
    expect(parseRpcMethods(undefined)).toBeUndefined();
    expect(parseRpcMethods('a=1&b=2')).toBeUndefined();
    expect(parseRpcMethods('{not json')).toBeUndefined();
    expect(parseRpcMethods('{"method":"x"}')).toBeUndefined();
    expect(parseRpcMethods('{"id":1,"method":5}')).toBeUndefined();
    expect(parseRpcMethods('[1,null,"x"]')).toBeUndefined();
    expect(
      parseRpcMethods(
        `{"id":1,"method":"eth_call","p":"${'x'.repeat(MAX_RPC_REQUEST_BYTES)}"}`,
      ),
    ).toBeUndefined();
  });
});

describe('parseRpcError', () => {
  it('reads the error of a single response', () => {
    expect(
      parseRpcError(
        '{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"execution reverted"}}',
      ),
    ).toStrictEqual({ code: -32000, message: 'execution reverted' });
  });

  it('reads the first error of a batch', () => {
    expect(
      parseRpcError(
        JSON.stringify([
          { id: 1, result: '0x1' },
          {
            id: 2,
            error: { code: 'x', message: 'see https://a.example/?key=s' },
          },
          { id: 3, error: { code: 3, message: 'second' } },
        ]),
      ),
    ).toStrictEqual({ message: 'see https://a.example/?key=[REDACTED]' });
  });

  it('cuts a long message and names a missing one', () => {
    const long = parseRpcError(
      JSON.stringify({ error: { code: 1, message: 'm'.repeat(400) } }),
    );
    expect(long?.message).toHaveLength(301);
    expect(parseRpcError('{"error":{}}')).toStrictEqual({
      message: 'unknown error',
    });
  });

  it('returns undefined without an error', () => {
    expect(parseRpcError('{"id":1,"result":"0x1"}')).toBeUndefined();
    expect(parseRpcError('[null, 1]')).toBeUndefined();
    expect(parseRpcError('not json')).toBeUndefined();
  });
});
