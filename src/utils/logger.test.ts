/* eslint-disable n/no-process-env */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('debugWarn', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    vi.resetModules();
  });

  describe('when DEBUG is true', () => {
    it('logs warning with context and error message', async () => {
      process.env.DEBUG = 'true';
      vi.resetModules();
      const { debugWarn } = await import('./logger.js');

      debugWarn('test.context', new Error('test error'));

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[Server:test.context] test error'),
      );
    });

    it('extracts error message from Error objects', async () => {
      process.env.DEBUG = 'true';
      vi.resetModules();
      const { debugWarn } = await import('./logger.js');

      const error = new Error('specific error message');
      debugWarn('context', error);

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('specific error message'),
      );
    });

    it('handles string error messages', async () => {
      process.env.DEBUG = 'true';
      vi.resetModules();
      const { debugWarn } = await import('./logger.js');

      debugWarn('context', 'string error');

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('string error'),
      );
    });

    it('handles unknown error types', async () => {
      process.env.DEBUG = 'true';
      vi.resetModules();
      const { debugWarn } = await import('./logger.js');

      debugWarn('context', { some: 'object' });

      expect(consoleWarnSpy).toHaveBeenCalled();
    });
  });

  describe('when DEBUG is false or unset', () => {
    it('does not log anything', async () => {
      delete process.env.DEBUG;
      vi.resetModules();
      const { debugWarn } = await import('./logger.js');

      debugWarn('context', new Error('test error'));

      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });

    it('does not log when DEBUG is empty string', async () => {
      process.env.DEBUG = '';
      vi.resetModules();
      const { debugWarn } = await import('./logger.js');

      debugWarn('context', new Error('test error'));

      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });
  });
});
