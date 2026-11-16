import { describe, expect, it } from 'vitest';

import { describeOutcome, formatRequestLogLine } from './request-log.js';

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
