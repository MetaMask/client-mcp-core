import { describe, it, expect } from 'vitest';

import {
  tokenize,
  tokenizeIdentifier,
  expandWithSynonyms,
} from './tokenization.js';

describe('tokenization', () => {
  describe('tokenize', () => {
    it('returns empty array for empty string', () => {
      expect(tokenize('')).toStrictEqual([]);
    });

    it('returns empty array for null/undefined', () => {
      expect(tokenize(null as unknown as string)).toStrictEqual([]);
      expect(tokenize(undefined as unknown as string)).toStrictEqual([]);
    });

    it('converts to lowercase', () => {
      const tokens = tokenize('Hello World UPPERCASE');
      expect(tokens).toContain('hello');
      expect(tokens).toContain('world');
      expect(tokens).toContain('uppercase');
    });

    it('splits on non-alphanumeric characters', () => {
      const tokens = tokenize('click-button_send.test');
      expect(tokens).toContain('click');
      expect(tokens).toContain('button');
      expect(tokens).toContain('send');
    });

    it('filters out stopwords', () => {
      const tokens = tokenize('the user is a tester');
      expect(tokens).not.toContain('the');
      expect(tokens).not.toContain('is');
      expect(tokens).not.toContain('a');
      expect(tokens).toContain('user');
      expect(tokens).toContain('tester');
    });

    it('filters out tokens shorter than MIN_TOKEN_LENGTH', () => {
      const tokens = tokenize('a b cd ef');
      expect(tokens).not.toContain('a');
      expect(tokens).not.toContain('b');
      expect(tokens).toContain('cd');
      expect(tokens).toContain('ef');
    });

    it('removes duplicate tokens', () => {
      const tokens = tokenize('click click button button click');
      const clickCount = tokens.filter((t) => t === 'click').length;
      const buttonCount = tokens.filter((t) => t === 'button').length;
      expect(clickCount).toBe(1);
      expect(buttonCount).toBe(1);
    });

    it('handles special tool/extension stopwords', () => {
      const tokens = tokenize('mm mcp lw test flow');
      expect(tokens).not.toContain('mm');
      expect(tokens).not.toContain('mcp');
      expect(tokens).not.toContain('lw');
      expect(tokens).not.toContain('test');
      expect(tokens).not.toContain('flow');
    });
  });

  describe('tokenizeIdentifier', () => {
    it('returns empty array for empty string', () => {
      expect(tokenizeIdentifier('')).toStrictEqual([]);
    });

    it('returns empty array for null/undefined', () => {
      expect(tokenizeIdentifier(null as unknown as string)).toStrictEqual([]);
      expect(tokenizeIdentifier(undefined as unknown as string)).toStrictEqual(
        [],
      );
    });

    it('splits camelCase identifiers', () => {
      const tokens = tokenizeIdentifier('handleButtonClick');
      expect(tokens).toContain('handle');
      expect(tokens).toContain('button');
      expect(tokens).toContain('click');
    });

    it('splits PascalCase identifiers', () => {
      const tokens = tokenizeIdentifier('MetaMaskController');
      expect(tokens).toContain('meta');
      expect(tokens).toContain('mask');
      expect(tokens).toContain('controller');
    });

    it('splits consecutive uppercase letters correctly', () => {
      const tokens = tokenizeIdentifier('XMLHttpRequest');
      expect(tokens).toContain('xml');
      expect(tokens).toContain('http');
      expect(tokens).toContain('request');
    });

    it('handles snake_case', () => {
      const tokens = tokenizeIdentifier('data_testid_value');
      expect(tokens).toContain('data');
      expect(tokens).toContain('testid');
      expect(tokens).toContain('value');
    });

    it('handles kebab-case', () => {
      const tokens = tokenizeIdentifier('confirm-button-primary');
      expect(tokens).toContain('confirm');
      expect(tokens).toContain('button');
      expect(tokens).toContain('primary');
    });

    it('removes duplicates', () => {
      const tokens = tokenizeIdentifier('clickClickButton');
      const clickCount = tokens.filter((t) => t === 'click').length;
      expect(clickCount).toBe(1);
    });

    it('filters out short tokens', () => {
      const tokens = tokenizeIdentifier('aButtonForX');
      expect(tokens).not.toContain('a');
      expect(tokens).not.toContain('x');
      expect(tokens).toContain('button');
      expect(tokens).toContain('for');
    });
  });

  describe('expandWithSynonyms', () => {
    it('returns original tokens if no synonyms match', () => {
      const tokens = ['button', 'primary'];
      const expanded = expandWithSynonyms(tokens);
      expect(expanded).toContain('button');
      expect(expanded).toContain('primary');
    });

    it('expands send with transfer and pay', () => {
      const tokens = ['send'];
      const expanded = expandWithSynonyms(tokens);
      expect(expanded).toContain('send');
      expect(expanded).toContain('transfer');
      expect(expanded).toContain('pay');
    });

    it('expands approve with confirm, accept, allow', () => {
      const tokens = ['approve'];
      const expanded = expandWithSynonyms(tokens);
      expect(expanded).toContain('approve');
      expect(expanded).toContain('confirm');
      expect(expanded).toContain('accept');
      expect(expanded).toContain('allow');
    });

    it('expands reverse synonyms (synonym -> canonical)', () => {
      const tokens = ['transfer'];
      const expanded = expandWithSynonyms(tokens);
      expect(expanded).toContain('send');
      expect(expanded).toContain('transfer');
      expect(expanded).toContain('pay');
    });

    it('expands unlock with login and signin', () => {
      const tokens = ['unlock'];
      const expanded = expandWithSynonyms(tokens);
      expect(expanded).toContain('unlock');
      expect(expanded).toContain('login');
      expect(expanded).toContain('signin');
    });

    it('expands swap with exchange and trade', () => {
      const tokens = ['swap'];
      const expanded = expandWithSynonyms(tokens);
      expect(expanded).toContain('swap');
      expect(expanded).toContain('exchange');
      expect(expanded).toContain('trade');
    });

    it('expands reject with deny, cancel, decline', () => {
      const tokens = ['reject'];
      const expanded = expandWithSynonyms(tokens);
      expect(expanded).toContain('reject');
      expect(expanded).toContain('deny');
      expect(expanded).toContain('cancel');
      expect(expanded).toContain('decline');
    });

    it('preserves non-synonym tokens', () => {
      const tokens = ['button', 'send', 'primary'];
      const expanded = expandWithSynonyms(tokens);
      expect(expanded).toContain('button');
      expect(expanded).toContain('primary');
      expect(expanded).toContain('send');
      expect(expanded).toContain('transfer');
    });

    it('does not create duplicates', () => {
      const tokens = ['send', 'transfer'];
      const expanded = expandWithSynonyms(tokens);
      const sendCount = expanded.filter((t) => t === 'send').length;
      expect(sendCount).toBe(1);
    });
  });
});
