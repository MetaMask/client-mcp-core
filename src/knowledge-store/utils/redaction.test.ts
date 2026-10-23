import { describe, it, expect } from 'vitest';

import {
  isSensitiveField,
  redactRecordedSecrets,
  SENSITIVE_FIELD_PATTERNS,
} from './redaction.js';
import type { StepRecord } from '../../tools/types/step-record.js';

describe('isSensitiveField', () => {
  describe('password patterns', () => {
    it('detects password field', () => {
      expect(isSensitiveField('password')).toBe(true);
    });

    it('detects PASSWORD field (case insensitive)', () => {
      expect(isSensitiveField('PASSWORD')).toBe(true);
    });

    it('detects userPassword field', () => {
      expect(isSensitiveField('userPassword')).toBe(true);
    });

    it('detects password_hash field', () => {
      expect(isSensitiveField('password_hash')).toBe(true);
    });
  });

  describe('seed phrase patterns', () => {
    it('detects seed field', () => {
      expect(isSensitiveField('seed')).toBe(true);
    });

    it('detects seedPhrase field', () => {
      expect(isSensitiveField('seedPhrase')).toBe(true);
    });

    it('detects srp field', () => {
      expect(isSensitiveField('srp')).toBe(true);
    });

    it('detects phrase field', () => {
      expect(isSensitiveField('phrase')).toBe(true);
    });

    it('detects mnemonic field', () => {
      expect(isSensitiveField('mnemonic')).toBe(true);
    });

    it('detects recovery_phrase field', () => {
      expect(isSensitiveField('recovery_phrase')).toBe(true);
    });
  });

  describe('key patterns', () => {
    it('detects privateKey field', () => {
      expect(isSensitiveField('privateKey')).toBe(true);
    });

    it('detects private_key field', () => {
      expect(isSensitiveField('private_key')).toBe(true);
    });

    it('detects private-key field', () => {
      expect(isSensitiveField('private-key')).toBe(true);
    });

    it('detects apiKey field', () => {
      expect(isSensitiveField('apiKey')).toBe(true);
    });

    it('detects api_key field', () => {
      expect(isSensitiveField('api_key')).toBe(true);
    });

    it('detects api-key field', () => {
      expect(isSensitiveField('api-key')).toBe(true);
    });
  });

  describe('secret patterns', () => {
    it('detects secret field', () => {
      expect(isSensitiveField('secret')).toBe(true);
    });

    it('detects clientSecret field', () => {
      expect(isSensitiveField('clientSecret')).toBe(true);
    });

    it('detects shared_secret field', () => {
      expect(isSensitiveField('shared_secret')).toBe(true);
    });
  });

  describe('non-sensitive fields', () => {
    it('returns false for username', () => {
      expect(isSensitiveField('username')).toBe(false);
    });

    it('returns false for email', () => {
      expect(isSensitiveField('email')).toBe(false);
    });

    it('returns false for name', () => {
      expect(isSensitiveField('name')).toBe(false);
    });

    it('returns false for address', () => {
      expect(isSensitiveField('address')).toBe(false);
    });

    it('returns false for id', () => {
      expect(isSensitiveField('id')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(isSensitiveField('')).toBe(false);
    });

    it('returns false for random text', () => {
      expect(isSensitiveField('randomFieldName')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('handles mixed case variations', () => {
      expect(isSensitiveField('PaSsWoRd')).toBe(true);
      expect(isSensitiveField('SeeD')).toBe(true);
      expect(isSensitiveField('PrivateKey')).toBe(true);
    });

    it('detects patterns within longer field names', () => {
      expect(isSensitiveField('user_password_hash')).toBe(true);
      expect(isSensitiveField('backup_seed_phrase')).toBe(true);
      expect(isSensitiveField('wallet_private_key')).toBe(true);
    });

    it('handles underscores and hyphens in field names', () => {
      expect(isSensitiveField('private_key')).toBe(true);
      expect(isSensitiveField('private-key')).toBe(true);
      expect(isSensitiveField('api_key')).toBe(true);
      expect(isSensitiveField('api-key')).toBe(true);
    });
  });
});

describe('SENSITIVE_FIELD_PATTERNS', () => {
  it('is an array of regex patterns', () => {
    expect(Array.isArray(SENSITIVE_FIELD_PATTERNS)).toBe(true);
    expect(SENSITIVE_FIELD_PATTERNS.length).toBeGreaterThan(0);
  });

  it('contains only RegExp objects', () => {
    SENSITIVE_FIELD_PATTERNS.forEach((pattern) => {
      expect(pattern).toBeInstanceOf(RegExp);
    });
  });

  it('has patterns for all sensitive field types', () => {
    const patternStrings = SENSITIVE_FIELD_PATTERNS.map((p) => p.source);

    expect(patternStrings.some((s) => s.includes('password'))).toBe(true);
    expect(patternStrings.some((s) => s.includes('seed'))).toBe(true);
    expect(patternStrings.some((s) => s.includes('private'))).toBe(true);
    expect(patternStrings.some((s) => s.includes('secret'))).toBe(true);
  });
});

// A minimal typed record for pure matching/scoping tests; no HTTP or filesystem.
function stepRecord(): StepRecord {
  return {
    schemaVersion: 1,
    timestamp: '2026-10-13T12:00:00.000Z',
    sessionId: 'mm-session-2026',
    context: 'prod',
    environment: { platform: 'darwin', nodeVersion: 'v24.13.1' },
    tool: {
      name: 'cdp',
      input: { method: 'Input.dispatchKeyEvent', params: '[REDACTED]' },
    },
    labels: ['error-recovery'],
    outcome: { ok: false, error: { code: 'MM_CDP_FAILED' } },
    observation: {
      state: {
        isLoaded: true,
        isUnlocked: false,
        currentScreen: 'onboarding',
        currentUrl: 'chrome-extension://test/home.html',
        extensionId: 'test',
        accountAddress: null,
        networkName: null,
        chainId: 2,
        balance: '20 tokens',
      },
      testIds: [{ testId: 'go-2', tag: 'span', text: 'go 2', visible: true }],
      a11y: {
        nodes: [
          {
            ref: 'e2',
            role: 'button',
            name: 'Continue onboarding 2',
            path: ['dialog'],
            testId: 'onboarding-2',
            textContent: 'Continue 2',
          },
        ],
      },
    },
  };
}

describe('redactRecordedSecrets', () => {
  it.each(['2', 'o'])(
    'preserves metadata and short substrings while redacting exact %s echoes',
    (secret) => {
      const record = stepRecord();
      record.outcome.error = { code: secret, message: secret };
      record.tool.target = { selector: secret, testId: `prefix ${secret}` };
      record.observation.state.networkName = secret;
      record.observation.testIds.push({
        testId: 'exact',
        tag: 'span',
        text: secret,
        visible: true,
      });
      record.observation.a11y.nodes.push({
        ref: 'e3',
        role: 'textbox',
        name: secret,
        path: [],
      });
      const result = redactRecordedSecrets(record, [{ text: secret }]);

      expect(result.timestamp).toBe(record.timestamp);
      expect(new Date(result.timestamp).toISOString()).toBe(record.timestamp);
      expect(result).toMatchObject({
        schemaVersion: 1,
        sessionId: record.sessionId,
        context: 'prod',
        environment: record.environment,
        labels: record.labels,
        tool: { name: 'cdp' },
      });
      expect(result.outcome.error).toMatchObject({
        code: secret,
        message: '[REDACTED]',
      });
      expect(result.tool.target).toStrictEqual({
        selector: '[REDACTED]',
        testId: `prefix ${secret}`,
      });
      expect(result.observation.state).toStrictEqual({
        ...record.observation.state,
        networkName: '[REDACTED]',
      });
      expect(result.observation.testIds).toStrictEqual([
        record.observation.testIds[0],
        { ...record.observation.testIds[1], text: '[REDACTED]' },
      ]);
      expect(result.observation.a11y.nodes).toMatchObject([
        record.observation.a11y.nodes[0],
        { ...record.observation.a11y.nodes[1], name: '[REDACTED]' },
      ]);
    },
  );

  it.each([7, 8])(
    'chooses whole-value versus substring matching from raw length %s, before escaping',
    (length) => {
      const secret = '"'.repeat(length);
      const escaped = JSON.stringify(secret).slice(1, -1);
      const record = stepRecord();
      record.outcome.error = {
        code: 'EXAMPLE',
        details: {
          raw: secret,
          escaped,
          embedded: `prefix ${secret}`,
          embeddedEscaped: `prefix ${escaped}`,
        },
      };
      const result = redactRecordedSecrets(record, [secret]);

      expect(result.outcome.error?.details).toStrictEqual({
        raw: '[REDACTED]',
        escaped: '[REDACTED]',
        embedded: length === 7 ? `prefix ${secret}` : 'prefix [REDACTED]',
        embeddedEscaped:
          length === 7 ? `prefix ${escaped}` : 'prefix [REDACTED]',
      });
    },
  );

  it('scrubs every targeted free-text category, retaining structural metadata and the supplied record', () => {
    const secret = 'synthetic-"password"\\path\n';
    const echo = `echo ${secret}; ${JSON.stringify(secret)}`;
    const redactedEcho = 'echo [REDACTED]; "[REDACTED]"';
    const record = stepRecord();
    record.tool.target = { selector: echo, testId: echo, a11yRef: echo };
    record.outcome.error = {
      code: 'MM_CDP_FAILED',
      message: echo,
      details: { nested: [{ [secret]: echo }] },
    };
    record.artifacts = { screenshot: { path: echo, width: 2, height: 3 } };
    const { observation } = record;
    observation.state = {
      ...observation.state,
      currentUrl: echo,
      currentScreen: echo,
      extensionId: echo,
      accountAddress: echo,
      networkName: echo,
      balance: echo,
    };
    observation.state.activeTab = {
      role: 'notification',
      url: echo,
      title: echo,
    };
    observation.testIds = [
      { testId: echo, tag: 'element', text: echo, visible: true },
    ];
    observation.a11y = {
      nodes: [
        {
          ref: 'e2',
          role: 'button',
          name: echo,
          path: [echo],
          testId: echo,
          textContent: echo,
        },
      ],
      diff: { added: [echo], removed: [echo], unchanged: 2 },
    };
    const original = structuredClone(record);
    // Intentional exact matches prove structural metadata survives redaction.
    const structuralStrings = [
      'cdp',
      'prod',
      'button',
      'element',
      'e2',
      'type',
      'a11yHint',
      'testId',
      'notification',
      'EXAMPLE',
      'MM_CDP_FAILED',
      'error-recovery',
      record.sessionId,
      record.timestamp,
      'v24.13.1',
    ];
    const result = redactRecordedSecrets(record, [
      { nested: [secret, ...structuralStrings] },
    ]);
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(JSON.stringify(secret).slice(1, -1));
    expect(serialized).not.toContain(
      JSON.stringify(JSON.stringify(secret).slice(1, -1)).slice(1, -1),
    );
    expect(result.outcome.error?.details).toStrictEqual({
      nested: [{ '[REDACTED]': redactedEcho }],
    });
    expect(result).toMatchObject({
      timestamp: record.timestamp,
      sessionId: record.sessionId,
      context: 'prod',
      environment: record.environment,
      labels: record.labels,
      tool: { name: 'cdp', target: { selector: redactedEcho } },
      outcome: { error: { code: 'MM_CDP_FAILED', message: redactedEcho } },
      artifacts: { screenshot: { path: redactedEcho, width: 2, height: 3 } },
    });
    expect(result.observation).toMatchObject({
      state: {
        networkName: redactedEcho,
        activeTab: {
          role: 'notification',
          url: redactedEcho,
          title: redactedEcho,
        },
      },
      testIds: [{ tag: 'element', text: redactedEcho }],
      a11y: {
        nodes: [{ ref: 'e2', role: 'button', name: redactedEcho }],
        diff: { added: [redactedEcho], removed: [redactedEcho], unchanged: 2 },
      },
    });
    expect(record).toStrictEqual(original);
  });

  it('preserves existing markers and is idempotent', () => {
    const record = stepRecord();
    record.outcome.error = { message: '[REDACTED] and REDACTED' };
    const result = redactRecordedSecrets(record, ['REDACTED']);

    expect(result.outcome.error?.message).toBe('[REDACTED] and [REDACTED]');
    expect(redactRecordedSecrets(result, ['REDACTED'])).toStrictEqual(result);
  });

  it('preserves the record when no nonempty strings were redacted', () => {
    const record = stepRecord();
    expect(redactRecordedSecrets(record, [])).toStrictEqual(record);
    expect(
      redactRecordedSecrets(record, ['', 2, null, { nested: [false] }]),
    ).toStrictEqual(record);
  });
});
