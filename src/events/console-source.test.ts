import type { BrowserContext } from '@playwright/test';
import { describe, expect, it, vi } from 'vitest';

import {
  CONSOLE_EVENTS,
  ConsoleSource,
  formatConsoleArgs,
  toConsoleLevel,
  toConsoleRecord,
} from './console-source.js';
import { REDACTED_VALUE } from './redact.js';
import { SessionEvents } from './session-events.js';
import type {
  CdpEvent,
  CdpManager,
  CdpSubscribeOptions,
} from '../platform/cdp-manager.js';
import type { ConsoleRecord } from '../tools/types/events.js';

const INFURA_KEY = '0123456789abcdef0123456789abcdef';
const SW = {
  kind: 'sw' as const,
  targetId: 'W1',
  url: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/bg.js',
};
const PAGE = {
  kind: 'page' as const,
  targetId: 'P1',
  url: `https://dapp.example/?apiKey=secret`,
};

/**
 * Builds a `Runtime.consoleAPICalled` event.
 *
 * @param type - The console call type.
 * @param args - The arguments.
 * @param options - Target and time.
 * @param options.target - The event target.
 * @param options.timestamp - The CDP timestamp, epoch ms.
 * @returns The event.
 */
function consoleEvent(
  type: string,
  args: unknown[],
  options: { target?: CdpEvent['target']; timestamp?: number } = {},
): CdpEvent {
  return {
    target: options.target ?? SW,
    method: 'Runtime.consoleAPICalled',
    params: {
      type,
      args,
      ...(options.timestamp === undefined
        ? {}
        : { timestamp: options.timestamp }),
      stackTrace: {
        callFrames: [{ url: SW.url, lineNumber: 9, columnNumber: 4 }],
      },
    },
    t: 5000,
  };
}

/**
 * Starts a console source on a fake manager.
 *
 * @returns The session events and a function that emits a CDP event.
 */
async function startSource(): Promise<{
  events: SessionEvents;
  emit: (event: CdpEvent) => void;
  options: CdpSubscribeOptions;
}> {
  let options: CdpSubscribeOptions | undefined;
  const manager = {
    subscribe: vi.fn(async (subscribeOptions: CdpSubscribeOptions) => {
      options = subscribeOptions;
      return { unsubscribe: vi.fn() };
    }),
  } as unknown as CdpManager;
  const events = new SessionEvents({} as BrowserContext, []);
  await new ConsoleSource().start(manager, events);
  const subscribed = options as CdpSubscribeOptions;
  return {
    events,
    emit: (event): void => subscribed.onEvent(event),
    options: subscribed,
  };
}

/**
 * Reads every console record.
 *
 * @param events - The session events.
 * @returns The records.
 */
function readAll(events: SessionEvents): ConsoleRecord[] {
  return events.buffer.read<ConsoleRecord>({ kind: 'console', limit: 100 })
    .records;
}

describe('toConsoleLevel', () => {
  it.each([
    ['error', 'error'],
    ['assert', 'error'],
    ['warning', 'warning'],
    ['info', 'info'],
    ['debug', 'debug'],
    ['log', 'log'],
    ['table', 'log'],
    [undefined, 'log'],
  ])('%s → %s', (type, level) => {
    expect(toConsoleLevel(type)).toBe(level);
  });
});

describe('toConsoleRecord', () => {
  it('formats console arguments, redacts and locates', () => {
    const built = toConsoleRecord(
      consoleEvent(
        'error',
        [
          {
            type: 'string',
            value: `failed https://mainnet.infura.io/v3/${INFURA_KEY}`,
          },
          { type: 'number', value: 42 },
          { type: 'number', unserializableValue: 'NaN' },
          { type: 'undefined' },
          { type: 'object', subtype: 'null', value: null },
          {
            type: 'object',
            subtype: 'error',
            description: 'Error: boom\n    at x',
          },
          {
            type: 'object',
            subtype: 'object',
            className: 'Object',
            description: 'Object',
            objectId: '{"injectedScriptId":1,"id":1}',
            preview: {
              type: 'object',
              overflow: false,
              properties: [
                { name: 'code', type: 'number', value: '4001' },
                { name: 'message', type: 'string', value: 'User rejected' },
              ],
            },
          },
          {
            type: 'object',
            subtype: 'array',
            className: 'Array',
            description: 'Array(2)',
            objectId: '{"injectedScriptId":1,"id":2}',
            preview: {
              type: 'object',
              subtype: 'array',
              description: 'Array(2)',
              overflow: false,
              properties: [
                { name: '0', type: 'number', value: '1' },
                { name: '1', type: 'number', value: '2' },
              ],
            },
          },
          {
            type: 'object',
            className: 'Object',
            description: 'Object',
            preview: {
              type: 'object',
              overflow: true,
              properties: [{ name: 'a', type: 'number', value: '1' }],
            },
          },
          { type: 'boolean', value: false },
          { type: 'object', className: 'Object', description: 'Object' },
        ],
        { timestamp: 1234.6 },
      ),
    );
    expect(built).toStrictEqual({
      timestamp: 1234.6,
      record: {
        t: 1235,
        target: { kind: 'sw', id: 'W1', url: SW.url },
        level: 'error',
        text: "failed https://mainnet.infura.io/v3/[REDACTED] 42 NaN undefined null Error: boom\n    at x {code: [REDACTED], message: 'User rejected'} [1, 2] {a: 1, …} false Object",
        location: `${SW.url}:10:5`,
      },
    });
  });

  it('redacts sensitive preview fields, including nested ones', () => {
    const built = toConsoleRecord(
      consoleEvent('error', [
        {
          type: 'object',
          className: 'Object',
          description: 'Object',
          preview: {
            type: 'object',
            overflow: false,
            properties: [
              { name: 'privateKey', type: 'string', value: '0xdeadbeef' },
              { name: 'mnemonic', type: 'string', value: 'word word word' },
              { name: 'password', type: 'string', value: 'hunter2' },
              { name: 'seedPhrase', type: 'string', value: 'a b c' },
              {
                name: 'url',
                type: 'string',
                value: 'https://rpc.example.com/?apiKey=secret',
              },
              {
                name: 'nested',
                type: 'object',
                value: 'Object',
                valuePreview: {
                  type: 'object',
                  overflow: false,
                  properties: [
                    {
                      name: 'privateKey',
                      type: 'string',
                      value: '0xcafe',
                    },
                    { name: 'ok', type: 'number', value: '1' },
                  ],
                },
              },
              { name: 'safe', type: 'number', value: '1' },
            ],
          },
        },
      ]),
    );

    expect(built?.record.text).toBe(
      `{privateKey: ${REDACTED_VALUE}, mnemonic: ${REDACTED_VALUE}, ` +
        `password: ${REDACTED_VALUE}, seedPhrase: ${REDACTED_VALUE}, ` +
        `url: 'https://rpc.example.com/?apiKey=${REDACTED_VALUE}', ` +
        `nested: {privateKey: ${REDACTED_VALUE}, ok: 1}, safe: 1}`,
    );
  });

  it('redacts a named property of an array preview and keeps its name', () => {
    const built = toConsoleRecord(
      consoleEvent('error', [
        {
          type: 'object',
          subtype: 'array',
          className: 'Array',
          description: 'Array(3)',
          preview: {
            type: 'object',
            subtype: 'array',
            description: 'Array(3)',
            overflow: false,
            properties: [
              { name: '0', type: 'string', value: 'one' },
              { name: '1', type: 'number', value: '2' },
              { name: 'privateKey', type: 'string', value: '0xdeadbeef' },
              { name: 'label', type: 'string', value: 'wallet' },
            ],
          },
        },
      ]),
    );

    expect(built?.record.text).toBe(
      `['one', 2, privateKey: ${REDACTED_VALUE}, label: 'wallet']`,
    );
  });

  it('uses the query rules for preview names and keeps the allowlist', () => {
    const build = (names: string[]) =>
      toConsoleRecord(
        consoleEvent('error', [
          {
            type: 'object',
            className: 'Object',
            description: 'Object',
            preview: {
              type: 'object',
              overflow: false,
              properties: names.map((name) => ({
                name,
                type: 'string',
                value: 'secret',
              })),
            },
          },
        ]),
      )?.record.text;

    expect(
      build(['token', 'secretKey', 'seed', 'key', 'mnemonicPhrase', 'pk']),
    ).toBe(
      `{token: ${REDACTED_VALUE}, secretKey: ${REDACTED_VALUE}, ` +
        `seed: ${REDACTED_VALUE}, key: ${REDACTED_VALUE}, ` +
        `mnemonicPhrase: ${REDACTED_VALUE}, pk: ${REDACTED_VALUE}}`,
    );
    expect(build(['publicKey', 'sortKey', 'sourceToken', 'nativeToken'])).toBe(
      "{publicKey: 'secret', sortKey: 'secret', sourceToken: 'secret', " +
        "nativeToken: 'secret'}",
    );
  });

  it('renders plain objects and proxies, and descriptions for other subtypes', () => {
    const preview = (
      subtype: string,
      description: string,
      properties: { name: string; type: string; value?: string }[] = [],
    ) => ({
      type: 'object',
      subtype,
      description,
      preview: {
        type: 'object',
        subtype,
        description,
        overflow: false,
        properties,
      },
    });
    expect(
      formatConsoleArgs([
        preview('proxy', 'Proxy', [{ name: 'a', type: 'number', value: '1' }]),
        preview('regexp', '/foo/g', [
          { name: 'lastIndex', type: 'number', value: '0' },
        ]),
        preview('date', 'Tue Nov 18 2026'),
        preview('typedarray', 'Uint8Array(2)', [
          { name: '0', type: 'number', value: '1' },
        ]),
        preview('arraybuffer', 'ArrayBuffer(8)'),
        preview('promise', 'Promise'),
        preview('error', 'Error: boom'),
        preview('weakmap', 'WeakMap'),
        preview('iterator', 'Array Iterator'),
        preview('generator', 'Generator'),
      ]),
    ).toBe(
      '{a: 1} /foo/g Tue Nov 18 2026 Uint8Array(2) ArrayBuffer(8) ' +
        'Promise Error: boom WeakMap Array Iterator Generator',
    );
  });

  it('never prints map or set entry values', () => {
    expect(
      formatConsoleArgs([
        {
          type: 'object',
          subtype: 'map',
          description: 'Map(1)',
          preview: {
            type: 'object',
            subtype: 'map',
            description: 'Map(1)',
            overflow: false,
            properties: [
              { name: 'privateKey', type: 'string', value: '0xdeadbeef' },
            ],
          },
        },
        {
          type: 'object',
          subtype: 'set',
          description: 'Set(1)',
          preview: {
            type: 'object',
            subtype: 'set',
            description: 'Set(1)',
            overflow: false,
            properties: [{ name: '0', type: 'string', value: 'secret' }],
          },
        },
      ]),
    ).toBe('Map(1) Set(1)');
  });

  it('fills format specifiers from the following arguments', () => {
    const preview = {
      type: 'object',
      className: 'Object',
      description: 'Object',
      preview: {
        type: 'object',
        overflow: false,
        properties: [
          { name: 'code', type: 'number', value: '4001' },
          { name: 'message', type: 'string', value: 'User rejected' },
        ],
      },
    };
    expect(
      formatConsoleArgs([
        { type: 'string', value: 'Failed %s with %d' },
        { type: 'string', value: 'x' },
        { type: 'number', value: 4 },
        preview,
      ]),
    ).toBe("Failed x with 4 {code: [REDACTED], message: 'User rejected'}");
    expect(
      formatConsoleArgs([
        { type: 'string', value: '%cHello %s%c!' },
        { type: 'string', value: 'color: red' },
        { type: 'string', value: 'world' },
        { type: 'string', value: 'font-weight: bold' },
      ]),
    ).toBe('Hello world!');
    expect(
      formatConsoleArgs([
        { type: 'string', value: '100%% %i %f' },
        { type: 'number', value: 3.9 },
        { type: 'string', value: '2.5' },
      ]),
    ).toBe('100% 3 2.5');
    expect(formatConsoleArgs([{ type: 'string', value: 'value %s' }])).toBe(
      'value %s',
    );
  });

  it('uses the delivery time without a CDP timestamp and redacts the target URL', () => {
    const event: CdpEvent = {
      target: PAGE,
      method: 'Runtime.consoleAPICalled',
      params: { type: 'warning' },
      t: 777,
    };
    expect(toConsoleRecord(event)).toStrictEqual({
      timestamp: undefined,
      record: {
        t: 777,
        target: {
          kind: 'page',
          id: 'P1',
          url: 'https://dapp.example/?apiKey=[REDACTED]',
        },
        level: 'warning',
        text: '',
      },
    });
  });

  it('builds an uncaught exception record', () => {
    const event: CdpEvent = {
      target: PAGE,
      method: 'Runtime.exceptionThrown',
      params: {
        timestamp: 900,
        exceptionDetails: {
          text: 'Uncaught',
          exception: {
            type: 'object',
            subtype: 'error',
            description: 'TypeError: uncaught in page',
          },
          url: 'https://dapp.example/app.js',
          lineNumber: 0,
          columnNumber: 7,
        },
      },
      t: 1000,
    };
    expect(toConsoleRecord(event)?.record).toStrictEqual({
      t: 900,
      target: {
        kind: 'page',
        id: 'P1',
        url: 'https://dapp.example/?apiKey=[REDACTED]',
      },
      level: 'error',
      text: 'Uncaught TypeError: uncaught in page',
      location: 'https://dapp.example/app.js:1:8',
      uncaught: true,
    });
  });

  it('prefers the stack frame, and does not repeat a description in the text', () => {
    const event: CdpEvent = {
      target: SW,
      method: 'Runtime.exceptionThrown',
      params: {
        exceptionDetails: {
          text: 'Uncaught (in promise) boom',
          exception: { type: 'string', value: 'boom' },
          stackTrace: {
            callFrames: [{ url: SW.url, lineNumber: 1, columnNumber: 2 }],
          },
        },
      },
      t: 50,
    };
    expect(toConsoleRecord(event)?.record).toMatchObject({
      t: 50,
      text: 'Uncaught (in promise) boom',
      location: `${SW.url}:2:3`,
    });
  });

  it('does not drop a short exception value', () => {
    const event: CdpEvent = {
      target: SW,
      method: 'Runtime.exceptionThrown',
      params: {
        exceptionDetails: {
          text: 'Uncaught (in promise)',
          exception: { type: 'string', value: 'e' },
        },
      },
      t: 50,
    };
    expect(toConsoleRecord(event)?.record.text).toBe('Uncaught (in promise) e');
  });

  it('handles an exception without details', () => {
    const event: CdpEvent = {
      target: SW,
      method: 'Runtime.exceptionThrown',
      params: {},
      t: 50,
    };
    expect(toConsoleRecord(event)?.record).toStrictEqual({
      t: 50,
      target: { kind: 'sw', id: 'W1', url: SW.url },
      level: 'error',
      text: 'Uncaught',
      uncaught: true,
    });
  });

  it('ignores other events and frames without a URL', () => {
    expect(
      toConsoleRecord({
        target: SW,
        method: 'Network.dataReceived',
        params: {},
        t: 1,
      }),
    ).toBeUndefined();
    const event: CdpEvent = {
      target: SW,
      method: 'Runtime.consoleAPICalled',
      params: { type: 'error', stackTrace: { callFrames: [{}] } },
      t: 1,
    };
    expect(toConsoleRecord(event)?.record.location).toBeUndefined();
  });
});

describe('ConsoleSource', () => {
  it('subscribes to the Runtime console events', async () => {
    const { options } = await startSource();
    expect(options.events).toStrictEqual(CONSOLE_EVENTS);
  });

  it('records only errors by default, and more levels after configure', async () => {
    const { events, emit } = await startSource();
    const now = Date.now() + 10;
    emit(
      consoleEvent('error', [{ type: 'string', value: 'e1' }], {
        timestamp: now,
      }),
    );
    emit(
      consoleEvent('warning', [{ type: 'string', value: 'w1' }], {
        timestamp: now,
      }),
    );
    emit(
      consoleEvent('assert', [{ type: 'string', value: 'a1' }], {
        timestamp: now,
      }),
    );
    expect(readAll(events).map((record) => record.text)).toStrictEqual([
      'e1',
      'a1',
    ]);

    events.config = { consoleLevels: ['error', 'warning'] };
    emit(
      consoleEvent('warning', [{ type: 'string', value: 'w2' }], {
        timestamp: now + 1,
      }),
    );
    emit(
      consoleEvent('log', [{ type: 'string', value: 'l1' }], {
        timestamp: now + 1,
      }),
    );
    expect(readAll(events).map((record) => record.text)).toStrictEqual([
      'e1',
      'a1',
      'w2',
    ]);
  });

  it('drops replays: messages older than the source and repeated messages', async () => {
    const { events, emit } = await startSource();
    const now = Date.now() + 10;
    emit(
      consoleEvent('error', [{ type: 'string', value: 'old' }], {
        timestamp: now - 60_000,
      }),
    );
    const fresh = consoleEvent('error', [{ type: 'string', value: 'new' }], {
      timestamp: now,
    });
    emit(fresh);
    emit(fresh);
    // Same text on another target is kept.
    emit(
      consoleEvent('error', [{ type: 'string', value: 'new' }], {
        timestamp: now,
        target: PAGE,
      }),
    );
    // Without a CDP timestamp there is nothing to compare: kept.
    emit(consoleEvent('error', [{ type: 'string', value: 'no-ts' }]));
    emit(consoleEvent('error', [{ type: 'string', value: 'no-ts' }]));

    expect(
      readAll(events).map((record) => `${record.target.kind}:${record.text}`),
    ).toStrictEqual(['sw:new', 'page:new', 'sw:no-ts', 'sw:no-ts']);
  });

  it('remembers filtered messages, so widening the levels does not record them again', async () => {
    const { events, emit } = await startSource();
    const now = Date.now() + 10;
    const warning = consoleEvent('warning', [{ type: 'string', value: 'w' }], {
      timestamp: now,
    });
    // Filtered out, but its replay key is remembered.
    emit(warning);
    events.config = { consoleLevels: ['error', 'warning'] };
    // The same message again is a replay: not recorded.
    emit(warning);
    emit(
      consoleEvent('warning', [{ type: 'string', value: 'w' }], {
        timestamp: now + 1,
      }),
    );
    expect(readAll(events).map((record) => record.text)).toStrictEqual(['w']);
  });

  it('forgets the oldest remembered message past its limit', async () => {
    const { events, emit } = await startSource();
    const now = Date.now() + 10;
    const first = consoleEvent('error', [{ type: 'string', value: 'm0' }], {
      timestamp: now,
    });
    emit(first);
    for (let index = 1; index <= 1000; index++) {
      emit(
        consoleEvent('error', [{ type: 'string', value: `m${index}` }], {
          timestamp: now,
        }),
      );
    }
    emit(first);
    expect(events.buffer.summary().seq).toBe(1002);
  });
});
