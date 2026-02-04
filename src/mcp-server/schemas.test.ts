/**
 * Unit tests for Zod schema refinement validations.
 *
 * Tests the custom refine() validations for:
 * - switchToTabInputSchema (role or url required)
 * - closeTabInputSchema (role or url required)
 * - clipboardInputSchema (text required when action is 'write')
 */

import { describe, it, expect } from 'vitest';
import {
  switchToTabInputSchema,
  closeTabInputSchema,
  clipboardInputSchema,
} from './schemas.js';

describe('switchToTabInputSchema', () => {
  describe('refine validation: role or url required', () => {
    it('passes with role only', () => {
      const input = { role: 'extension' as const };
      const result = switchToTabInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    it('passes with url only', () => {
      const input = { url: 'https://example.com' };
      const result = switchToTabInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    it('passes with both role and url', () => {
      const input = { role: 'dapp' as const, url: 'https://example.com' };
      const result = switchToTabInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    it('fails with neither role nor url', () => {
      const input = {};
      const result = switchToTabInputSchema.safeParse(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe(
          'Either role or url must be provided',
        );
      }
    });

    it('fails with empty role and no url', () => {
      const input = { role: undefined };
      const result = switchToTabInputSchema.safeParse(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe(
          'Either role or url must be provided',
        );
      }
    });

    it('fails with empty url and no role', () => {
      const input = { url: undefined };
      const result = switchToTabInputSchema.safeParse(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe(
          'Either role or url must be provided',
        );
      }
    });

    it('passes with notification role', () => {
      const input = { role: 'notification' as const };
      const result = switchToTabInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    it('passes with other role', () => {
      const input = { role: 'other' as const };
      const result = switchToTabInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    it('passes with url containing special characters', () => {
      const input = { url: 'https://app.uniswap.org/swap?chain=ethereum' };
      const result = switchToTabInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });
  });
});

describe('closeTabInputSchema', () => {
  describe('refine validation: role or url required', () => {
    it('passes with role only', () => {
      const input = { role: 'notification' as const };
      const result = closeTabInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    it('passes with url only', () => {
      const input = { url: 'https://example.com' };
      const result = closeTabInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    it('passes with both role and url', () => {
      const input = { role: 'dapp' as const, url: 'https://example.com' };
      const result = closeTabInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    it('fails with neither role nor url', () => {
      const input = {};
      const result = closeTabInputSchema.safeParse(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe(
          'Either role or url must be provided',
        );
      }
    });

    it('fails with empty role and no url', () => {
      const input = { role: undefined };
      const result = closeTabInputSchema.safeParse(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe(
          'Either role or url must be provided',
        );
      }
    });

    it('fails with empty url and no role', () => {
      const input = { url: undefined };
      const result = closeTabInputSchema.safeParse(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe(
          'Either role or url must be provided',
        );
      }
    });

    it('passes with dapp role', () => {
      const input = { role: 'dapp' as const };
      const result = closeTabInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    it('passes with other role', () => {
      const input = { role: 'other' as const };
      const result = closeTabInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    it('passes with url containing special characters', () => {
      const input = { url: 'https://app.uniswap.org/swap?chain=ethereum' };
      const result = closeTabInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });
  });
});

describe('clipboardInputSchema', () => {
  describe('refine validation: text required when action is write', () => {
    it('passes write action with text', () => {
      const input = { action: 'write' as const, text: 'hello world' };
      const result = clipboardInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    it('passes read action without text', () => {
      const input = { action: 'read' as const };
      const result = clipboardInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    it('passes read action with text (text is optional for read)', () => {
      const input = { action: 'read' as const, text: 'ignored' };
      const result = clipboardInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    it('fails write action without text', () => {
      const input = { action: 'write' as const };
      const result = clipboardInputSchema.safeParse(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe(
          "text is required when action is 'write'",
        );
      }
    });

    it('fails write action with undefined text', () => {
      const input = { action: 'write' as const, text: undefined };
      const result = clipboardInputSchema.safeParse(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe(
          "text is required when action is 'write'",
        );
      }
    });

    it('fails write action with empty string text', () => {
      const input = { action: 'write' as const, text: '' };
      const result = clipboardInputSchema.safeParse(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe(
          "text is required when action is 'write'",
        );
      }
    });

    it('passes write action with whitespace text', () => {
      const input = { action: 'write' as const, text: '   ' };
      const result = clipboardInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    it('passes write action with long text', () => {
      const longText = 'a'.repeat(10000);
      const input = { action: 'write' as const, text: longText };
      const result = clipboardInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    it('passes write action with special characters', () => {
      const input = {
        action: 'write' as const,
        text: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      };
      const result = clipboardInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    it('passes write action with newlines', () => {
      const input = { action: 'write' as const, text: 'line1\nline2\nline3' };
      const result = clipboardInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    it('passes read action without any text property', () => {
      const input = { action: 'read' as const };
      const result = clipboardInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });
  });
});
