import { describe, it, expect } from 'vitest';
import {
  isValidTargetSelection,
  isInvalidTargetSelection,
  type TargetType,
} from './type-guards.js';

describe('isValidTargetSelection', () => {
  describe('with valid target selection', () => {
    it('returns true for valid a11yRef selection', () => {
      const result = {
        valid: true,
        type: 'a11yRef' as TargetType,
        value: 'e1',
      };

      expect(isValidTargetSelection(result)).toBe(true);
    });

    it('returns true for valid testId selection', () => {
      const result = {
        valid: true,
        type: 'testId' as TargetType,
        value: 'submit-button',
      };

      expect(isValidTargetSelection(result)).toBe(true);
    });

    it('returns true for valid selector selection', () => {
      const result = {
        valid: true,
        type: 'selector' as TargetType,
        value: 'button.primary',
      };

      expect(isValidTargetSelection(result)).toBe(true);
    });

    it('returns true with additional properties', () => {
      const result = {
        valid: true,
        type: 'testId' as TargetType,
        value: 'button',
        extra: 'property',
      };

      expect(isValidTargetSelection(result)).toBe(true);
    });
  });

  describe('with invalid target selection', () => {
    it('returns false when valid is false', () => {
      const result = {
        valid: false,
        type: 'testId' as TargetType,
        value: 'button',
      };

      expect(isValidTargetSelection(result)).toBe(false);
    });

    it('returns false when missing type property', () => {
      const result = {
        valid: true,
        value: 'button',
      };

      expect(isValidTargetSelection(result)).toBe(false);
    });

    it('returns false when missing value property', () => {
      const result = {
        valid: true,
        type: 'testId' as TargetType,
      };

      expect(isValidTargetSelection(result)).toBe(false);
    });

    it('returns false when type is not a string', () => {
      const result = {
        valid: true,
        type: 123,
        value: 'button',
      };

      expect(isValidTargetSelection(result)).toBe(false);
    });

    it('returns false when value is not a string', () => {
      const result = {
        valid: true,
        type: 'testId' as TargetType,
        value: 123,
      };

      expect(isValidTargetSelection(result)).toBe(false);
    });

    it('returns false when valid property is missing', () => {
      const result = {
        type: 'testId' as TargetType,
        value: 'button',
      };

      expect(isValidTargetSelection(result)).toBe(false);
    });
  });

  describe('with non-object inputs', () => {
    it('returns false for null', () => {
      expect(isValidTargetSelection(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(isValidTargetSelection(undefined)).toBe(false);
    });

    it('returns false for string', () => {
      expect(isValidTargetSelection('valid')).toBe(false);
    });

    it('returns false for number', () => {
      expect(isValidTargetSelection(123)).toBe(false);
    });

    it('returns false for boolean', () => {
      expect(isValidTargetSelection(true)).toBe(false);
    });

    it('returns false for array', () => {
      expect(isValidTargetSelection([true, 'testId', 'button'])).toBe(false);
    });
  });

  describe('with edge cases', () => {
    it('returns true for empty string value', () => {
      const result = {
        valid: true,
        type: 'testId' as TargetType,
        value: '',
      };

      expect(isValidTargetSelection(result)).toBe(true);
    });

    it('returns true for empty string type', () => {
      const result = {
        valid: true,
        type: '',
        value: 'button',
      };

      expect(isValidTargetSelection(result)).toBe(true);
    });
  });
});

describe('isInvalidTargetSelection', () => {
  describe('with invalid target selection', () => {
    it('returns true for invalid selection with error', () => {
      const result = {
        valid: false,
        error: 'No target specified',
      };

      expect(isInvalidTargetSelection(result)).toBe(true);
    });

    it('returns true with additional properties', () => {
      const result = {
        valid: false,
        error: 'Multiple targets specified',
        extra: 'property',
      };

      expect(isInvalidTargetSelection(result)).toBe(true);
    });

    it('returns true for empty error string', () => {
      const result = {
        valid: false,
        error: '',
      };

      expect(isInvalidTargetSelection(result)).toBe(true);
    });
  });

  describe('with valid target selection', () => {
    it('returns false when valid is true', () => {
      const result = {
        valid: true,
        type: 'testId' as TargetType,
        value: 'button',
      };

      expect(isInvalidTargetSelection(result)).toBe(false);
    });

    it('returns false when missing error property', () => {
      const result = {
        valid: false,
      };

      expect(isInvalidTargetSelection(result)).toBe(false);
    });

    it('returns false when error is not a string', () => {
      const result = {
        valid: false,
        error: 123,
      };

      expect(isInvalidTargetSelection(result)).toBe(false);
    });

    it('returns false when valid property is missing', () => {
      const result = {
        error: 'No target specified',
      };

      expect(isInvalidTargetSelection(result)).toBe(false);
    });
  });

  describe('with non-object inputs', () => {
    it('returns false for null', () => {
      expect(isInvalidTargetSelection(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(isInvalidTargetSelection(undefined)).toBe(false);
    });

    it('returns false for string', () => {
      expect(isInvalidTargetSelection('invalid')).toBe(false);
    });

    it('returns false for number', () => {
      expect(isInvalidTargetSelection(0)).toBe(false);
    });

    it('returns false for boolean', () => {
      expect(isInvalidTargetSelection(false)).toBe(false);
    });

    it('returns false for array', () => {
      expect(isInvalidTargetSelection([false, 'error message'])).toBe(false);
    });
  });

  describe('with edge cases', () => {
    it('returns true for very long error message', () => {
      const result = {
        valid: false,
        error: 'a'.repeat(1000),
      };

      expect(isInvalidTargetSelection(result)).toBe(true);
    });

    it('returns true for error with special characters', () => {
      const result = {
        valid: false,
        error: 'Error: "Multiple targets" (a11yRef, testId)',
      };

      expect(isInvalidTargetSelection(result)).toBe(true);
    });
  });
});

describe('type guards mutual exclusivity', () => {
  it('valid and invalid selections are mutually exclusive', () => {
    const validResult = {
      valid: true,
      type: 'testId' as TargetType,
      value: 'button',
    };

    const invalidResult = {
      valid: false,
      error: 'No target',
    };

    expect(isValidTargetSelection(validResult)).toBe(true);
    expect(isInvalidTargetSelection(validResult)).toBe(false);

    expect(isValidTargetSelection(invalidResult)).toBe(false);
    expect(isInvalidTargetSelection(invalidResult)).toBe(true);
  });

  it('accepts objects where valid is truthy (not strictly boolean)', () => {
    const objectWithTruthyValid = {
      valid: 'maybe',
      type: 'testId',
      value: 'button',
    };

    expect(isValidTargetSelection(objectWithTruthyValid)).toBe(true);
    expect(isInvalidTargetSelection(objectWithTruthyValid)).toBe(false);
  });
});
