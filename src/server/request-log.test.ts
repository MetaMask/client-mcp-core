import { describe, expect, it } from 'vitest';

import {
  describeOutcome,
  describeTarget,
  encodeLogValue,
  formatRequestLogLine,
  MAX_LOGGED_VALUE_LENGTH,
} from './request-log.js';

describe('describeOutcome', () => {
  it('reports a successful tool call', () => {
    expect(describeOutcome({ ok: true, result: { clicked: true } })).toBe(
      ' ok=true',
    );
  });

  it('reports a failed tool call with its code', () => {
    expect(
      describeOutcome({
        ok: false,
        error: { code: 'MM_CLICK_TIMEOUT', message: 'Click timed out' },
      }),
    ).toBe(' ok=false code=MM_CLICK_TIMEOUT');
  });

  it('reports a failure without a code', () => {
    expect(describeOutcome({ ok: false })).toBe(' ok=false');
  });

  it.each([
    ['free text', 'wrong password hunter2'],
    ['a newline', 'MM_X\n[INFO] POST /tool/fake 200'],
    ['a lowercase code', 'mm_click_timeout'],
    ['a very long code', `MM_${'A'.repeat(100)}`],
    ['a number', 42],
  ])('leaves out a code that is %s', (_name, code) => {
    expect(describeOutcome({ ok: false, error: { code } })).toBe(' ok=false');
  });

  it('leaves out an invalid code of a failed batch step', () => {
    expect(
      describeOutcome({
        ok: true,
        result: {
          steps: [{ ok: false, error: { code: 'seed phrase here' } }],
          summary: { total: 1, failed: 1 },
        },
      }),
    ).toBe(' ok=true failed=1/1');
  });

  it('reports the failed steps of a batch and the first failure code', () => {
    expect(
      describeOutcome({
        ok: true,
        result: {
          steps: [
            { tool: 'click', ok: true },
            {
              tool: 'wait_for',
              ok: false,
              error: { code: 'MM_WAIT_TIMEOUT' },
            },
            { tool: 'click', ok: false, error: { code: 'MM_CLICK_FAILED' } },
          ],
          summary: { ok: false, total: 3, failed: 2 },
        },
      }),
    ).toBe(' ok=true failed=2/3 code=MM_WAIT_TIMEOUT');
  });

  it('reports a batch whose steps all passed as ok', () => {
    expect(
      describeOutcome({
        ok: true,
        result: {
          steps: [{ tool: 'click', ok: true }],
          summary: { ok: true, total: 1, failed: 0 },
        },
      }),
    ).toBe(' ok=true');
  });

  it.each([
    ['a body without ok', { status: 'ok', nonce: 'abc' }],
    ['no body', undefined],
    ['a string body', 'ok'],
  ])('adds nothing for %s', (_name, body) => {
    expect(describeOutcome(body)).toBe('');
  });
});

describe('describeTarget', () => {
  it.each([
    ['a testId', { testId: 'confirm-btn' }, ' testid=confirm-btn'],
    ['an a11y ref', { a11yRef: 'f1e3' }, ' ref=f1e3'],
    [
      'a selector',
      { selector: '[data-testid="x"] button' },
      ' selector=[data-testid="x"]%20button',
    ],
    ['a screen', { screen: 'home' }, ' screen=home'],
    ['a tab role', { role: 'notification' }, ' role=notification'],
    [
      'a CDP method',
      { method: 'Runtime.evaluate' },
      ' method=Runtime.evaluate',
    ],
    ['a device button', { button: 'back' }, ' button=back'],
    ['a swipe direction', { direction: 'up' }, ' direction=up'],
  ])('logs %s', (_name, input, expected) => {
    expect(describeTarget(input, { ok: true })).toBe(expected);
  });

  it('logs the screen and the URL of a navigate call', () => {
    expect(
      describeTarget(
        { screen: 'url', url: 'https://app.uniswap.org/swap?chain=base' },
        { ok: true },
      ),
    ).toBe(' screen=url url=https://app.uniswap.org/swap?chain=base');
  });

  it('redacts secrets in a URL', () => {
    const line = describeTarget(
      {
        screen: 'url',
        url: 'https://mainnet.infura.io/v3/0123456789abcdef0123456789abcdef?apiKey=s3cret',
      },
      { ok: true },
    );
    expect(line).not.toContain('0123456789abcdef0123456789abcdef');
    expect(line).not.toContain('s3cret');
    expect(line).toContain(' url=https://mainnet.infura.io/v3/');
  });

  it.each([
    ['typed text', { testId: 'password', text: 'hunter2 hunter2' }],
    ['clipboard text', { action: 'write', text: 'seed words here' }],
    [
      'CDP params',
      {
        method: 'Runtime.evaluate',
        params: { expression: 'localStorage.secret' },
      },
    ],
    ['launch secrets', { srp: 'seed words here', password: 'hunter2' }],
  ])('never logs %s', (_name, input) => {
    const line = describeTarget(input, { ok: true });
    expect(line).not.toMatch(/hunter2|seed words|localStorage/u);
  });

  it('logs the file name of a screenshot', () => {
    expect(
      describeTarget(
        { name: 'SET-RC-001-theme-dark' },
        {
          ok: true,
          result: {
            path: '/repo/test-artifacts/screenshots/SET-RC-001-theme-dark-1795767101324.png',
          },
        },
      ),
    ).toBe(' file=SET-RC-001-theme-dark-1795767101324.png');
  });

  it('logs the file name of a describe_screen screenshot', () => {
    expect(
      describeTarget(
        { includeScreenshot: true },
        {
          ok: true,
          result: { screenshot: { path: '/repo/shots/describe-screen-1.png' } },
        },
      ),
    ).toBe(' file=describe-screen-1.png');
  });

  it('logs no file for a failed screenshot', () => {
    expect(
      describeTarget(
        { name: 'x' },
        { ok: false, error: { code: 'MM_SCREENSHOT_FAILED' } },
      ),
    ).toBe('');
  });

  it('logs the tools of a run_steps batch, not their args', () => {
    const line = describeTarget(
      {
        steps: [
          { tool: 'click', args: { testId: 'confirm-btn' } },
          { tool: 'type', args: { testId: 'password', text: 'hunter2' } },
          { tool: 'wait_for', args: { selector: 'text=Done' } },
        ],
      },
      { ok: true },
    );
    expect(line).toBe(' steps=click,type,wait_for');
  });

  it.each([
    ['a tool name with spaces', [{ tool: 'click now' }]],
    ['a tool name with a newline', [{ tool: 'click\n[INFO] x' }]],
    ['an uppercase tool name', [{ tool: 'Click' }]],
    ['a step that is not an object', ['click', null]],
    ['a step without a tool', [{ args: {} }]],
  ])('leaves out %s', (_name, steps) => {
    expect(describeTarget({ steps }, { ok: true })).toBe('');
  });

  it('keeps the valid tools of a batch with an invalid one', () => {
    expect(
      describeTarget(
        {
          steps: [
            { tool: 'click' },
            { tool: 'Bad Tool' },
            { tool: 'screenshot' },
          ],
        },
        { ok: true },
      ),
    ).toBe(' steps=click,screenshot');
  });

  it('adds nothing for an empty batch', () => {
    expect(describeTarget({ steps: [] }, { ok: true })).toBe('');
  });

  it.each([
    ['no body', undefined],
    ['an empty body', {}],
    ['an empty testId', { testId: '' }],
    ['a non-string target', { testId: 42 }],
    ['a string body', 'confirm'],
  ])('adds nothing for %s', (_name, input) => {
    expect(describeTarget(input, undefined)).toBe('');
  });
});

describe('encodeLogValue', () => {
  it('keeps a value without spaces as it is', () => {
    expect(encodeLogValue('text=Create a new wallet')).toBe(
      'text=Create%20a%20new%20wallet',
    );
  });

  it('cannot start a new log line', () => {
    const value = encodeLogValue('x\n[INFO] POST /tool/fake 200 ok=true 1ms');
    expect(value).not.toMatch(/\s/u);
    expect(decodeURIComponent(value)).toBe(
      'x\n[INFO] POST /tool/fake 200 ok=true 1ms',
    );
  });

  it('encodes % so the value decodes back', () => {
    expect(decodeURIComponent(encodeLogValue('100% done'))).toBe('100% done');
  });

  it('cuts a long value', () => {
    const value = encodeLogValue('a'.repeat(500));
    expect(value).toHaveLength(MAX_LOGGED_VALUE_LENGTH + 1);
    expect(value.endsWith('…')).toBe(true);
  });
});

describe('formatRequestLogLine', () => {
  it('puts the outcome between the status and the duration', () => {
    expect(
      formatRequestLogLine(
        { method: 'POST', path: '/tool/click', status: 200 },
        { ok: false, error: { code: 'MM_CLICK_TIMEOUT' } },
        15080,
      ),
    ).toBe(
      '[INFO] POST /tool/click 200 ok=false code=MM_CLICK_TIMEOUT 15080ms',
    );
  });

  it('puts the target after the outcome', () => {
    expect(
      formatRequestLogLine(
        {
          method: 'POST',
          path: '/tool/click',
          status: 200,
          input: { testId: 'confirm-btn', timeoutMs: 15000 },
        },
        { ok: false, error: { code: 'MM_CLICK_TIMEOUT' } },
        15080,
      ),
    ).toBe(
      '[INFO] POST /tool/click 200 ok=false code=MM_CLICK_TIMEOUT testid=confirm-btn 15080ms',
    );
  });

  it('puts the batch tools after the failed-step count', () => {
    expect(
      formatRequestLogLine(
        {
          method: 'POST',
          path: '/tool/run_steps',
          status: 200,
          input: { steps: [{ tool: 'click' }, { tool: 'wait_for' }] },
        },
        {
          ok: true,
          result: {
            steps: [
              { tool: 'click', ok: true },
              {
                tool: 'wait_for',
                ok: false,
                error: { code: 'MM_WAIT_TIMEOUT' },
              },
            ],
            summary: { total: 2, failed: 1 },
          },
        },
        900,
      ),
    ).toBe(
      '[INFO] POST /tool/run_steps 200 ok=true failed=1/2 code=MM_WAIT_TIMEOUT steps=click,wait_for 900ms',
    );
  });

  it('keeps the old format for responses without an outcome', () => {
    expect(
      formatRequestLogLine(
        { method: 'GET', path: '/health', status: 200 },
        { status: 'ok' },
        2,
      ),
    ).toBe('[INFO] GET /health 200 2ms');
  });
});
