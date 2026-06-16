/* eslint-disable vitest/prefer-lowercase-title, vitest/expect-expect */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hermesCdpTool, IDENTITY_PROBE_EXPR } from './hermes-cdp.js';
import { createMockSessionManager } from './test-utils/mock-factories.js';
import { ErrorCodes } from './types/errors.js';
import type { ToolContext, ToolResponse } from '../types/http.js';

const DEFAULT_INPUT = {
  method: 'Runtime.evaluate',
  params: { expression: '1+1', returnByValue: true },
  timeoutMs: 30_000,
};

type MockContextOptions = {
  platform?: 'ios' | 'browser' | undefined;
  appId?: string | undefined;
  metroPort?: number | undefined;
  pinnedDeviceId?: string | undefined;
};

type CdpRequest = {
  id: number;
  method: string;
  params?: unknown;
};

type MockResponse = Record<string, unknown> | string | undefined;

class MockWebSocket extends EventTarget {
  static readonly connecting = 0;

  static readonly openState = 1;

  static readonly closing = 2;

  static readonly closed = 3;

  static instances: MockWebSocket[] = [];

  static autoOpen = true;

  static openSynchronously = false;

  static responseFactory: ((request: CdpRequest) => MockResponse) | undefined;

  readonly url: string;

  readyState = MockWebSocket.connecting;

  sentMessages: string[] = [];

  constructor(url: string) {
    super();
    this.url = url;
    MockWebSocket.instances.push(this);

    if (MockWebSocket.openSynchronously) {
      this.open();
    } else if (MockWebSocket.autoOpen) {
      queueMicrotask(() => this.open());
    }
  }

  send(message: string): void {
    this.sentMessages.push(message);
    const request = JSON.parse(message) as CdpRequest;
    const response = MockWebSocket.responseFactory?.(request);
    if (response !== undefined) {
      const payload =
        typeof response === 'string' ? response : JSON.stringify(response);
      queueMicrotask(() => this.message(payload));
    }
  }

  close(): void {
    if (this.readyState === MockWebSocket.closed) {
      return;
    }
    this.readyState = MockWebSocket.closed;
    this.dispatchEvent(new Event('close'));
  }

  open(): void {
    this.readyState = MockWebSocket.openState;
    this.dispatchEvent(new Event('open'));
  }

  message(data: string): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}

Object.defineProperties(MockWebSocket, {
  CONNECTING: { value: MockWebSocket.connecting },
  OPEN: { value: MockWebSocket.openState },
  CLOSING: { value: MockWebSocket.closing },
  CLOSED: { value: MockWebSocket.closed },
});

let fetchMock: ReturnType<typeof vi.fn>;

function createMockContext(options: MockContextOptions = {}): ToolContext & {
  setPinnedHermesDeviceId: ReturnType<typeof vi.fn>;
} {
  const {
    platform = 'ios',
    metroPort,
    pinnedDeviceId: initialPinnedDeviceId,
  } = options;
  const appId = Object.hasOwn(options, 'appId')
    ? options.appId
    : 'io.metamask.MetaMask';
  let pinnedDeviceId = initialPinnedDeviceId;
  const setPinnedHermesDeviceId = vi.fn((id: string) => {
    pinnedDeviceId = id;
  });

  const context = {
    sessionManager: createMockSessionManager({ hasActive: true }),
    get page() {
      return {};
    },
    get refMap() {
      return new Map<string, string>();
    },
    workflowContext: {},
    knowledgeStore: {},
    toolRegistry: new Map(),
    platformDriver: platform
      ? {
          getPlatform: vi.fn().mockReturnValue(platform),
          getAppId: vi.fn().mockReturnValue(appId),
          getMetroPort: vi.fn().mockReturnValue(metroPort),
          getPinnedHermesDeviceId: vi.fn(() => pinnedDeviceId),
          setPinnedHermesDeviceId,
        }
      : undefined,
    setPinnedHermesDeviceId,
  };

  return context as ToolContext & {
    setPinnedHermesDeviceId: ReturnType<typeof vi.fn>;
  };
}

function target(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'device-page-1',
    title: 'io.metamask.MetaMask (iPhone 15)',
    description: 'MetaMask Hermes VM',
    appId: 'io.metamask.MetaMask',
    webSocketDebuggerUrl:
      'ws://localhost:8081/inspector/debug?device=device-1&page=1',
    reactNative: {
      logicalDeviceId: 'logical-device-1',
      capabilities: { nativePageReloads: true },
    },
    ...overrides,
  };
}

function mockDiscovery(targets: Record<string, unknown>[]): void {
  fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: vi.fn().mockResolvedValue(targets),
  });
  vi.stubGlobal('fetch', fetchMock);
}

function defaultResponseFactory(request: CdpRequest): Record<string, unknown> {
  if (request.id === 1) {
    return {
      id: request.id,
      result: {
        result: {
          type: 'string',
          value:
            '{"isHermes":true,"ossVersion":"0.19.0","debuggerEnabled":true}',
        },
      },
    };
  }
  return { id: request.id, result: { result: { type: 'number', value: 2 } } };
}

function socketAt(index: number): MockWebSocket {
  const socket = MockWebSocket.instances[index];
  if (!socket) {
    throw new Error(`Missing MockWebSocket instance ${index}`);
  }
  return socket;
}

function sentMessage(socket: MockWebSocket, index: number): CdpRequest {
  const raw = socket.sentMessages[index];
  if (!raw) {
    throw new Error(`Missing sent message ${index}`);
  }
  return JSON.parse(raw) as CdpRequest;
}

function expectError(
  response: ToolResponse,
  code: string,
): asserts response is { ok: false; error: { code: string; message: string } } {
  expect(response.ok).toBe(false);
  if (!response.ok) {
    expect(response.error.code).toBe(code);
  }
}

describe('hermesCdpTool', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    MockWebSocket.autoOpen = true;
    MockWebSocket.openSynchronously = false;
    MockWebSocket.responseFactory = defaultResponseFactory;
    vi.stubGlobal('WebSocket', MockWebSocket);
    mockDiscovery([target()]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('T1 strict appId match — only matching target selected', async () => {
    mockDiscovery([
      target({
        id: 'evil',
        appId: 'io.other.app',
        webSocketDebuggerUrl: 'ws://localhost:8081/inspector/debug?evil',
      }),
      target({
        id: 'good',
        webSocketDebuggerUrl: 'ws://localhost:8081/inspector/debug?good',
      }),
    ]);

    const result = await hermesCdpTool(DEFAULT_INPUT, createMockContext());

    expect(result.ok).toBe(true);
    expect(socketAt(0).url).toBe('ws://localhost:8081/inspector/debug?good');
  });

  it('T2 rejects spoofed title with mismatched appId', async () => {
    mockDiscovery([
      target({ title: 'metamask copycat', appId: 'io.evil.app' }),
    ]);

    const result = await hermesCdpTool(DEFAULT_INPUT, createMockContext());

    expectError(result, ErrorCodes.MM_HERMES_TARGET_NOT_FOUND);
    expect(result.error.message).toContain('Saw appIds: ["io.evil.app"]');
  });

  it('T3 rejects synthetic legacy page', async () => {
    mockDiscovery([
      target({ title: 'React Native Experimental (Improved Chrome Reloads)' }),
    ]);

    const result = await hermesCdpTool(DEFAULT_INPUT, createMockContext());

    expectError(result, ErrorCodes.MM_HERMES_TARGET_NOT_FOUND);
  });

  it('T4 rejects mismatched device pin', async () => {
    mockDiscovery([target({ reactNative: { logicalDeviceId: 'pin-B' } })]);

    const result = await hermesCdpTool(
      DEFAULT_INPUT,
      createMockContext({ pinnedDeviceId: 'pin-A' }),
    );

    expectError(result, ErrorCodes.MM_HERMES_TARGET_NOT_FOUND);
  });

  it('T5 multi-device candidates without pin → MM_HERMES_TARGET_NOT_VERIFIED', async () => {
    mockDiscovery([
      target({
        id: 'first',
        webSocketDebuggerUrl: 'ws://localhost:8081/inspector/debug?first',
        reactNative: {
          logicalDeviceId: 'logical-device-1',
          capabilities: { nativePageReloads: true },
        },
      }),
      target({
        id: 'second',
        webSocketDebuggerUrl: 'ws://localhost:8081/inspector/debug?second',
        reactNative: {
          logicalDeviceId: 'logical-device-2',
          capabilities: { nativePageReloads: true },
        },
      }),
    ]);

    const result = await hermesCdpTool(DEFAULT_INPUT, createMockContext());

    expectError(result, ErrorCodes.MM_HERMES_TARGET_NOT_VERIFIED);
    expect(result.error.message).toContain('logical-device-1');
    expect(result.error.message).toContain('logical-device-2');
    expect(result.error.message).toContain('first');
    expect(result.error.message).toContain('second');
  });

  it('T6 identity probe happy path', async () => {
    const result = await hermesCdpTool(DEFAULT_INPUT, createMockContext());

    expect(result.ok).toBe(true);
    expect(sentMessage(socketAt(0), 0)).toMatchObject({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression: IDENTITY_PROBE_EXPR, returnByValue: true },
    });
    expect(sentMessage(socketAt(0), 1)).toMatchObject({
      id: 2,
      method: 'Runtime.evaluate',
    });
  });

  it('T7 probe returns isHermes:false → MM_HERMES_TARGET_NOT_VERIFIED', async () => {
    MockWebSocket.responseFactory = (request) =>
      request.id === 1
        ? {
            id: request.id,
            result: { result: { value: '{"isHermes":false}' } },
          }
        : defaultResponseFactory(request);

    const result = await hermesCdpTool(DEFAULT_INPUT, createMockContext());

    expectError(result, ErrorCodes.MM_HERMES_TARGET_NOT_VERIFIED);
  });

  it('T8 probe expression throws inside Hermes → MM_HERMES_TARGET_NOT_VERIFIED', async () => {
    MockWebSocket.responseFactory = (request) =>
      request.id === 1
        ? {
            id: request.id,
            result: {
              result: { value: '{"error":"ReferenceError: foo"}' },
            },
          }
        : defaultResponseFactory(request);

    const result = await hermesCdpTool(DEFAULT_INPUT, createMockContext());

    expectError(result, ErrorCodes.MM_HERMES_TARGET_NOT_VERIFIED);
  });

  it('T9 rejects wss:// URLs → MM_HERMES_UNSAFE_TARGET', async () => {
    mockDiscovery([
      target({ webSocketDebuggerUrl: 'wss://evil.com/inspector/debug' }),
    ]);

    const result = await hermesCdpTool(DEFAULT_INPUT, createMockContext());

    expectError(result, ErrorCodes.MM_HERMES_UNSAFE_TARGET);
    expect(result.error.message).toContain("Unexpected protocol 'wss:'");
  });

  it('T10 rejects port mismatch → MM_HERMES_UNSAFE_TARGET', async () => {
    mockDiscovery([target({ webSocketDebuggerUrl: 'ws://localhost:9999/x' })]);

    const result = await hermesCdpTool(DEFAULT_INPUT, createMockContext());

    expectError(result, ErrorCodes.MM_HERMES_UNSAFE_TARGET);
    expect(result.error.message).toContain(
      'Port mismatch: target=9999 expected=8081',
    );
  });

  it('T11 pins device on first successful call', async () => {
    const context = createMockContext();

    const result = await hermesCdpTool(DEFAULT_INPUT, context);

    expect(result.ok).toBe(true);
    expect(context.setPinnedHermesDeviceId).toHaveBeenCalledExactlyOnceWith(
      'logical-device-1',
    );
  });

  it('T12 pin persists — second call filters by pin', async () => {
    const context = createMockContext();
    await hermesCdpTool(DEFAULT_INPUT, context);
    mockDiscovery([
      target({
        id: 'different-pin',
        webSocketDebuggerUrl: 'ws://localhost:8081/inspector/debug?different',
        reactNative: {
          logicalDeviceId: 'logical-device-2',
          capabilities: { nativePageReloads: true },
        },
      }),
      target({
        id: 'same-pin',
        webSocketDebuggerUrl: 'ws://localhost:8081/inspector/debug?same',
      }),
    ]);

    const result = await hermesCdpTool(DEFAULT_INPUT, context);

    expect(result.ok).toBe(true);
    expect(socketAt(1).url).toBe('ws://localhost:8081/inspector/debug?same');
  });

  it('T13 metroPort priority — input > session > 8081 (input wins)', async () => {
    mockDiscovery([
      target({ webSocketDebuggerUrl: 'ws://localhost:8082/inspector/debug' }),
    ]);

    const result = await hermesCdpTool(
      { ...DEFAULT_INPUT, metroPort: 8082 },
      createMockContext({ metroPort: 8083 }),
    );

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8082/json',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('T13 metroPort priority — input > session > 8081 (session wins)', async () => {
    mockDiscovery([
      target({ webSocketDebuggerUrl: 'ws://localhost:8083/inspector/debug' }),
    ]);

    const result = await hermesCdpTool(
      DEFAULT_INPUT,
      createMockContext({ metroPort: 8083 }),
    );

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8083/json',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('T13 metroPort priority — input > session > 8081 (default wins)', async () => {
    const result = await hermesCdpTool(DEFAULT_INPUT, createMockContext());

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8081/json',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('T14 per-WebSocket monotonic IDs — probe=1, user=2; second call restarts at 1', async () => {
    const context = createMockContext();

    await hermesCdpTool(DEFAULT_INPUT, context);
    await hermesCdpTool(DEFAULT_INPUT, context);

    expect(sentMessage(socketAt(0), 0).id).toBe(1);
    expect(sentMessage(socketAt(0), 1).id).toBe(2);
    expect(sentMessage(socketAt(1), 0).id).toBe(1);
    expect(sentMessage(socketAt(1), 1).id).toBe(2);
  });

  it('T15 empty target list returns target-not-found with diagnostic', async () => {
    mockDiscovery([]);

    const result = await hermesCdpTool(DEFAULT_INPUT, createMockContext());

    expectError(result, ErrorCodes.MM_HERMES_TARGET_NOT_FOUND);
    expect(result.error.message).toContain('Saw appIds: []');
  });

  it('T16 driver.getAppId() returns undefined → MM_HERMES_TARGET_NOT_VERIFIED', async () => {
    const result = await hermesCdpTool(
      DEFAULT_INPUT,
      createMockContext({ appId: undefined }),
    );

    expectError(result, ErrorCodes.MM_HERMES_TARGET_NOT_VERIFIED);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('T17 bundle ID variants — strict suffix match rejects base appId', async () => {
    const result = await hermesCdpTool(
      DEFAULT_INPUT,
      createMockContext({ appId: 'io.metamask.MetaMask.dev' }),
    );

    expectError(result, ErrorCodes.MM_HERMES_TARGET_NOT_FOUND);
  });

  it('T17 bundle ID variants — strict suffix match accepts .dev appId', async () => {
    mockDiscovery([
      target({
        appId: 'io.metamask.MetaMask.dev',
        title: 'io.metamask.MetaMask.dev (iPhone)',
      }),
    ]);

    const result = await hermesCdpTool(
      DEFAULT_INPUT,
      createMockContext({ appId: 'io.metamask.MetaMask.dev' }),
    );

    expect(result.ok).toBe(true);
  });

  it('T17 bundle ID variants — strict suffix match accepts .qa appId', async () => {
    mockDiscovery([
      target({
        appId: 'io.metamask.MetaMask.qa',
        title: 'io.metamask.MetaMask.qa (iPhone)',
      }),
    ]);

    const result = await hermesCdpTool(
      DEFAULT_INPUT,
      createMockContext({ appId: 'io.metamask.MetaMask.qa' }),
    );

    expect(result.ok).toBe(true);
  });

  it('T18 malformed webSocketDebuggerUrl → MM_HERMES_UNSAFE_TARGET', async () => {
    mockDiscovery([target({ webSocketDebuggerUrl: 'not a valid url' })]);

    const result = await hermesCdpTool(DEFAULT_INPUT, createMockContext());

    expectError(result, ErrorCodes.MM_HERMES_UNSAFE_TARGET);
    expect(result.error.message).toContain('not a valid URL');
  });

  it('T19 probe returns CDP-level error (response.error) → MM_HERMES_TARGET_NOT_VERIFIED', async () => {
    MockWebSocket.responseFactory = (request) =>
      request.id === 1
        ? {
            id: request.id,
            error: { message: 'Method not found', code: -32601 },
          }
        : defaultResponseFactory(request);

    const result = await hermesCdpTool(DEFAULT_INPUT, createMockContext());

    expectError(result, ErrorCodes.MM_HERMES_TARGET_NOT_VERIFIED);
    expect(result.error.message).toContain('Method not found');
  });

  it('T20 probe returns result.subtype === error → MM_HERMES_TARGET_NOT_VERIFIED', async () => {
    MockWebSocket.responseFactory = (request) =>
      request.id === 1
        ? {
            id: request.id,
            result: { result: { subtype: 'error', value: 'EvalError' } },
          }
        : defaultResponseFactory(request);

    const result = await hermesCdpTool(DEFAULT_INPUT, createMockContext());

    expectError(result, ErrorCodes.MM_HERMES_TARGET_NOT_VERIFIED);
  });

  it('T21 probe returns non-JSON value → MM_HERMES_TARGET_NOT_VERIFIED', async () => {
    MockWebSocket.responseFactory = (request) =>
      request.id === 1
        ? { id: request.id, result: { result: { value: '[object Object]' } } }
        : defaultResponseFactory(request);

    const result = await hermesCdpTool(DEFAULT_INPUT, createMockContext());

    expectError(result, ErrorCodes.MM_HERMES_TARGET_NOT_VERIFIED);
    expect(result.error.message).toContain('non-JSON');
  });

  it('T22 probe times out → MM_HERMES_TARGET_NOT_VERIFIED', async () => {
    vi.useFakeTimers();
    MockWebSocket.responseFactory = (request) =>
      request.id === 1 ? undefined : defaultResponseFactory(request);

    const resultPromise = hermesCdpTool(
      { ...DEFAULT_INPUT, timeoutMs: 1_000 },
      createMockContext(),
    );

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await resultPromise;

    expectError(result, ErrorCodes.MM_HERMES_TARGET_NOT_VERIFIED);
    expect(result.error.message).toContain('timed out');
  });

  it('T23 WS closes after probe success but before user method → MM_HERMES_CONNECTION_FAILED', async () => {
    MockWebSocket.responseFactory = (request) => {
      if (request.id === 2) {
        queueMicrotask(() => socketAt(0).close());
        return undefined;
      }
      return defaultResponseFactory(request);
    };

    const result = await hermesCdpTool(DEFAULT_INPUT, createMockContext());

    expectError(result, ErrorCodes.MM_HERMES_CONNECTION_FAILED);
  });

  it('T24 same-device duplicate pages → last-in-array tiebreak (RN convention)', async () => {
    mockDiscovery([
      target({ id: 'page-1' }),
      target({
        id: 'page-2',
        webSocketDebuggerUrl: 'ws://localhost:8081/inspector/debug?page=2',
      }),
    ]);

    const result = await hermesCdpTool(DEFAULT_INPUT, createMockContext());

    expect(result.ok).toBe(true);
    expect(socketAt(0).url).toBe('ws://localhost:8081/inspector/debug?page=2');
  });

  it('T25 finally block closes WebSocket even on user method failure', async () => {
    MockWebSocket.responseFactory = (request) =>
      request.id === 2 ? '{' : defaultResponseFactory(request);

    const result = await hermesCdpTool(DEFAULT_INPUT, createMockContext());

    expectError(result, ErrorCodes.MM_HERMES_CONNECTION_FAILED);
    expect(socketAt(0).readyState).toBe(MockWebSocket.closed);
  });

  it('T26 probe response missing result.value → MM_HERMES_TARGET_NOT_VERIFIED (no value field)', async () => {
    MockWebSocket.responseFactory = (request) =>
      request.id === 1
        ? { id: request.id, result: { result: {} } }
        : defaultResponseFactory(request);

    const result = await hermesCdpTool(DEFAULT_INPUT, createMockContext());

    expectError(result, ErrorCodes.MM_HERMES_TARGET_NOT_VERIFIED);
    expect(result.error.message).toContain('missing result.value');
  });

  it('T26 probe response missing result.value → MM_HERMES_TARGET_NOT_VERIFIED (undefined value)', async () => {
    MockWebSocket.responseFactory = (request) =>
      request.id === 1
        ? { id: request.id, result: { result: { value: undefined } } }
        : defaultResponseFactory(request);

    const result = await hermesCdpTool(DEFAULT_INPUT, createMockContext());

    expectError(result, ErrorCodes.MM_HERMES_TARGET_NOT_VERIFIED);
    expect(result.error.message).toContain('missing result.value');
  });

  it('T26 probe response missing result.value → MM_HERMES_TARGET_NOT_VERIFIED (null value)', async () => {
    MockWebSocket.responseFactory = (request) =>
      request.id === 1
        ? { id: request.id, result: { result: { value: null } } }
        : defaultResponseFactory(request);

    const result = await hermesCdpTool(DEFAULT_INPUT, createMockContext());

    expectError(result, ErrorCodes.MM_HERMES_TARGET_NOT_VERIFIED);
    expect(result.error.message).toContain('missing result.value');
  });

  it('blocks unsafe Hermes CDP methods before network IO', async () => {
    const result = await hermesCdpTool(
      { ...DEFAULT_INPUT, method: 'Runtime.terminateExecution' },
      createMockContext(),
    );

    expectError(result, ErrorCodes.MM_HERMES_CDP_BLOCKED);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects non-iOS sessions before network IO', async () => {
    const result = await hermesCdpTool(
      DEFAULT_INPUT,
      createMockContext({ platform: 'browser' }),
    );

    expectError(result, ErrorCodes.MM_TOOL_NOT_SUPPORTED_ON_PLATFORM);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back from /json to /json/list during target discovery', async () => {
    fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue([target()]),
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await hermesCdpTool(DEFAULT_INPUT, createMockContext());

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://localhost:8081/json/list',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('returns CDP failure when user method returns response.error', async () => {
    MockWebSocket.responseFactory = (request) =>
      request.id === 2
        ? {
            id: request.id,
            error: { message: 'Method not found', code: -32601 },
          }
        : defaultResponseFactory(request);

    const result = await hermesCdpTool(
      { ...DEFAULT_INPUT, method: 'Missing.method' },
      createMockContext(),
    );

    expectError(result, ErrorCodes.MM_HERMES_CDP_FAILED);
    expect(result.error.message).toContain('Method not found');
  });

  it('covers Metro discovery failure classification', async () => {
    fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await hermesCdpTool(DEFAULT_INPUT, createMockContext());

    expectError(result, ErrorCodes.MM_HERMES_CONNECTION_FAILED);
    expect(result.error.message).toContain('ECONNREFUSED');
  });

  it('covers non-array Metro discovery payload fallback failure', async () => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ not: 'an array' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await hermesCdpTool(DEFAULT_INPUT, createMockContext());

    expectError(result, ErrorCodes.MM_HERMES_CONNECTION_FAILED);
    expect(result.error.message).toContain('non-array');
  });

  it('filters malformed discovery entries while preserving valid targets', async () => {
    mockDiscovery([
      null,
      'not an object',
      { appId: 123, webSocketDebuggerUrl: 'ws://localhost:8081/bad' },
      target(),
    ]);

    const result = await hermesCdpTool(DEFAULT_INPUT, createMockContext());

    expect(result.ok).toBe(true);
    expect(socketAt(0).url).toBe(
      'ws://localhost:8081/inspector/debug?device=device-1&page=1',
    );
  });

  it('prefers nativePageReloads targets before applying last-target tiebreak', async () => {
    mockDiscovery([
      target({
        id: 'modern',
        webSocketDebuggerUrl: 'ws://localhost:8081/modern',
      }),
      target({
        id: 'legacy-real',
        webSocketDebuggerUrl: 'ws://localhost:8081/legacy-real',
        reactNative: {
          logicalDeviceId: 'logical-device-2',
          capabilities: { nativePageReloads: false },
        },
      }),
    ]);

    const result = await hermesCdpTool(DEFAULT_INPUT, createMockContext());

    expect(result.ok).toBe(true);
    expect(socketAt(0).url).toBe('ws://localhost:8081/modern');
  });

  it('rejects multiple candidates across different devices even without nativePageReloads', async () => {
    mockDiscovery([
      target({
        id: 'older',
        webSocketDebuggerUrl: 'ws://localhost:8081/older',
        reactNative: { logicalDeviceId: 'logical-device-1', capabilities: {} },
      }),
      target({
        id: 'newer',
        webSocketDebuggerUrl: 'ws://localhost:8081/newer',
        reactNative: { logicalDeviceId: 'logical-device-2', capabilities: {} },
      }),
    ]);

    const result = await hermesCdpTool(DEFAULT_INPUT, createMockContext());

    expectError(result, ErrorCodes.MM_HERMES_TARGET_NOT_VERIFIED);
    expect(result.error.message).toContain('logical-device-1');
    expect(result.error.message).toContain('logical-device-2');
  });

  it('rejects unexpected WebSocket hostnames', async () => {
    mockDiscovery([target({ webSocketDebuggerUrl: 'ws://evil.com:8081/x' })]);

    const result = await hermesCdpTool(DEFAULT_INPUT, createMockContext());

    expectError(result, ErrorCodes.MM_HERMES_UNSAFE_TARGET);
    expect(result.error.message).toContain("Unexpected hostname 'evil.com'");
  });

  it('returns connection failure when global WebSocket is unavailable', async () => {
    vi.stubGlobal('WebSocket', undefined);

    const result = await hermesCdpTool(DEFAULT_INPUT, createMockContext());

    expectError(result, ErrorCodes.MM_HERMES_CONNECTION_FAILED);
    expect(result.error.message).toContain('Global WebSocket is unavailable');
  });

  it('rejects targets missing reactNative.logicalDeviceId after successful probe', async () => {
    mockDiscovery([
      target({ reactNative: { capabilities: { nativePageReloads: true } } }),
    ]);

    const result = await hermesCdpTool(DEFAULT_INPUT, createMockContext());

    expectError(result, ErrorCodes.MM_HERMES_TARGET_NOT_VERIFIED);
    expect(result.error.message).toContain('logicalDeviceId');
  });

  it('returns connection failure when the probe socket closes before response', async () => {
    MockWebSocket.responseFactory = (request) => {
      if (request.id === 1) {
        queueMicrotask(() => socketAt(0).close());
        return undefined;
      }
      return defaultResponseFactory(request);
    };

    const result = await hermesCdpTool(DEFAULT_INPUT, createMockContext());

    expectError(result, ErrorCodes.MM_HERMES_CONNECTION_FAILED);
  });

  it('covers probe response missing outer result object', async () => {
    MockWebSocket.responseFactory = (request) =>
      request.id === 1
        ? { id: request.id, result: null }
        : defaultResponseFactory(request);

    const result = await hermesCdpTool(DEFAULT_INPUT, createMockContext());

    expectError(result, ErrorCodes.MM_HERMES_TARGET_NOT_VERIFIED);
    expect(result.error.message).toContain('missing result.value');
  });

  it('covers probe response missing nested result object', async () => {
    MockWebSocket.responseFactory = (request) =>
      request.id === 1
        ? { id: request.id, result: { result: null } }
        : defaultResponseFactory(request);

    const result = await hermesCdpTool(DEFAULT_INPUT, createMockContext());

    expectError(result, ErrorCodes.MM_HERMES_TARGET_NOT_VERIFIED);
    expect(result.error.message).toContain('missing result.value');
  });

  it('accepts object-valued probe payload when it verifies Hermes', async () => {
    MockWebSocket.responseFactory = (request) =>
      request.id === 1
        ? { id: request.id, result: { result: { value: { isHermes: true } } } }
        : defaultResponseFactory(request);

    const result = await hermesCdpTool(DEFAULT_INPUT, createMockContext());

    expect(result.ok).toBe(true);
  });

  it('covers WebSocket already-open path', async () => {
    MockWebSocket.openSynchronously = true;

    const result = await hermesCdpTool(DEFAULT_INPUT, createMockContext());

    expect(result.ok).toBe(true);
  });

  it('returns connection failure when WebSocket open times out', async () => {
    vi.useFakeTimers();
    MockWebSocket.autoOpen = false;

    const resultPromise = hermesCdpTool(
      { ...DEFAULT_INPUT, timeoutMs: 1_000 },
      createMockContext(),
    );

    await vi.advanceTimersByTimeAsync(1_000);
    const result = await resultPromise;

    expectError(result, ErrorCodes.MM_HERMES_CONNECTION_FAILED);
    expect(result.error.message).toContain('connection timed out');
  });

  it('returns connection failure when WebSocket emits error before user response', async () => {
    MockWebSocket.responseFactory = (request) => {
      if (request.id === 2) {
        queueMicrotask(() => socketAt(0).dispatchEvent(new Event('error')));
        return undefined;
      }
      return defaultResponseFactory(request);
    };

    const result = await hermesCdpTool(DEFAULT_INPUT, createMockContext());

    expectError(result, ErrorCodes.MM_HERMES_CONNECTION_FAILED);
    expect(result.error.message).toContain('WebSocket message error');
  });

  it('returns connection failure for non-text WebSocket frames', async () => {
    MockWebSocket.responseFactory = (request) => {
      if (request.id === 2) {
        queueMicrotask(() =>
          socketAt(0).dispatchEvent(
            new MessageEvent('message', { data: { id: 2 } }),
          ),
        );
        return undefined;
      }
      return defaultResponseFactory(request);
    };

    const result = await hermesCdpTool(DEFAULT_INPUT, createMockContext());

    expectError(result, ErrorCodes.MM_HERMES_CONNECTION_FAILED);
    expect(result.error.message).toContain('non-text');
  });

  it('includes CDP error data in formatted user-method failures', async () => {
    MockWebSocket.responseFactory = (request) =>
      request.id === 2
        ? {
            id: request.id,
            error: {
              message: 'Bad params',
              code: -32602,
              data: { reason: 'invalid' },
            },
          }
        : defaultResponseFactory(request);

    const result = await hermesCdpTool(DEFAULT_INPUT, createMockContext());

    expectError(result, ErrorCodes.MM_HERMES_CDP_FAILED);
    expect(result.error.message).toContain('{"reason":"invalid"}');
  });

  it('rejects missing platform driver before network IO', async () => {
    const context = {
      sessionManager: createMockSessionManager({ hasActive: true }),
      get page() {
        return {};
      },
      get refMap() {
        return new Map<string, string>();
      },
      workflowContext: {},
      knowledgeStore: {},
      toolRegistry: new Map(),
    } as ToolContext;

    const result = await hermesCdpTool(DEFAULT_INPUT, context);

    expectError(result, ErrorCodes.MM_TOOL_NOT_SUPPORTED_ON_PLATFORM);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects iOS platform drivers without getAppId support', async () => {
    const context = {
      sessionManager: createMockSessionManager({ hasActive: true }),
      get page() {
        return {};
      },
      get refMap() {
        return new Map<string, string>();
      },
      workflowContext: {},
      knowledgeStore: {},
      toolRegistry: new Map(),
      platformDriver: { getPlatform: vi.fn().mockReturnValue('ios') },
    } as ToolContext;

    const result = await hermesCdpTool(DEFAULT_INPUT, context);

    expectError(result, ErrorCodes.MM_HERMES_TARGET_NOT_VERIFIED);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('supports drivers without optional pin and Metro-port methods', async () => {
    const context = {
      sessionManager: createMockSessionManager({ hasActive: true }),
      get page() {
        return {};
      },
      get refMap() {
        return new Map<string, string>();
      },
      workflowContext: {},
      knowledgeStore: {},
      toolRegistry: new Map(),
      platformDriver: {
        getPlatform: vi.fn().mockReturnValue('ios'),
        getAppId: vi.fn().mockReturnValue('io.metamask.MetaMask'),
      },
    } as ToolContext;

    const result = await hermesCdpTool(DEFAULT_INPUT, context);

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8081/json',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('ignores unrelated CDP response ids while waiting for user method', async () => {
    MockWebSocket.responseFactory = (request) => {
      if (request.id === 2) {
        queueMicrotask(() =>
          socketAt(0).message(JSON.stringify({ id: 999, result: {} })),
        );
      }
      return defaultResponseFactory(request);
    };

    const result = await hermesCdpTool(DEFAULT_INPUT, createMockContext());

    expect(result.ok).toBe(true);
  });

  it('ignores primitive CDP frames while waiting for the matching response', async () => {
    MockWebSocket.responseFactory = (request) => {
      if (request.id === 2) {
        queueMicrotask(() => socketAt(0).message('1'));
      }
      return defaultResponseFactory(request);
    };

    const result = await hermesCdpTool(DEFAULT_INPUT, createMockContext());

    expect(result.ok).toBe(true);
  });

  it('ignores CDP frames without numeric ids while waiting for the matching response', async () => {
    MockWebSocket.responseFactory = (request) => {
      if (request.id === 2) {
        queueMicrotask(() =>
          socketAt(0).message(JSON.stringify({ result: { ignored: true } })),
        );
      }
      return defaultResponseFactory(request);
    };

    const result = await hermesCdpTool(DEFAULT_INPUT, createMockContext());

    expect(result.ok).toBe(true);
  });

  it('accepts same-device duplicate pages even when ids are omitted', async () => {
    mockDiscovery([target({ id: undefined }), target({ id: undefined })]);

    const result = await hermesCdpTool(DEFAULT_INPUT, createMockContext());

    expect(result.ok).toBe(true);
    expect(socketAt(0).url).toBe(
      'ws://localhost:8081/inspector/debug?device=device-1&page=1',
    );
  });

  it('rejects WebSocket URLs without an explicit Metro port', async () => {
    mockDiscovery([
      target({ webSocketDebuggerUrl: 'ws://localhost/inspector' }),
    ]);

    const result = await hermesCdpTool(DEFAULT_INPUT, createMockContext());

    expectError(result, ErrorCodes.MM_HERMES_UNSAFE_TARGET);
    expect(result.error.message).toContain('Port mismatch');
  });

  it('rejects candidates where one is missing logicalDeviceId', async () => {
    mockDiscovery([
      target({
        id: 'has-device',
        webSocketDebuggerUrl: 'ws://localhost:8081/has-device',
        reactNative: {
          logicalDeviceId: 'logical-device-1',
          capabilities: { nativePageReloads: true },
        },
      }),
      target({
        id: 'no-device',
        webSocketDebuggerUrl: 'ws://localhost:8081/no-device',
        reactNative: { capabilities: { nativePageReloads: true } },
      }),
    ]);

    const result = await hermesCdpTool(DEFAULT_INPUT, createMockContext());

    expectError(result, ErrorCodes.MM_HERMES_TARGET_NOT_VERIFIED);
    expect(result.error.message).toContain('<missing>');
  });

  it('selects the most recent page when pin + multiple pages on the same device', async () => {
    const context = createMockContext({ pinnedDeviceId: 'logical-device-1' });
    mockDiscovery([
      target({
        id: 'stale-page',
        webSocketDebuggerUrl: 'ws://localhost:8081/inspector/debug?stale',
      }),
      target({
        id: 'fresh-page',
        webSocketDebuggerUrl: 'ws://localhost:8081/inspector/debug?fresh',
      }),
    ]);

    const result = await hermesCdpTool(DEFAULT_INPUT, context);

    expect(result.ok).toBe(true);
    expect(socketAt(0).url).toBe('ws://localhost:8081/inspector/debug?fresh');
  });

  it('rejects multi-device candidates even when one matches a non-existent pin', async () => {
    const context = createMockContext({ pinnedDeviceId: 'logical-device-3' });
    mockDiscovery([
      target({
        id: 'first',
        reactNative: {
          logicalDeviceId: 'logical-device-1',
          capabilities: { nativePageReloads: true },
        },
      }),
      target({
        id: 'second',
        webSocketDebuggerUrl: 'ws://localhost:8081/inspector/debug?second',
        reactNative: {
          logicalDeviceId: 'logical-device-2',
          capabilities: { nativePageReloads: true },
        },
      }),
    ]);

    const result = await hermesCdpTool(DEFAULT_INPUT, context);

    // After pin filter no candidates remain → MM_HERMES_TARGET_NOT_FOUND
    // (pin disambiguation works correctly; this confirms pin filter precedence).
    expectError(result, ErrorCodes.MM_HERMES_TARGET_NOT_FOUND);
  });
});
