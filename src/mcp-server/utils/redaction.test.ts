import { describe, it, expect } from 'vitest';
import { isSensitiveField, SENSITIVE_FIELD_PATTERNS } from './redaction.js';

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
