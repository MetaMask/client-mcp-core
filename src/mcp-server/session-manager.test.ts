import { describe, it, expect, beforeEach } from 'vitest';

import {
  setSessionManager,
  getSessionManager,
  hasSessionManager,
} from './session-manager.js';
import type { ISessionManager } from './session-manager.js';
import { createMockSessionManager } from './test-utils/mock-factories.js';

describe('session-manager', () => {
  beforeEach(() => {
    setSessionManager(undefined as unknown as ISessionManager);
  });

  describe('setSessionManager', () => {
    it('sets the session manager instance', () => {
      const mockManager = createMockSessionManager();
      setSessionManager(mockManager);

      expect(hasSessionManager()).toBe(true);
    });

    it('replaces the existing session manager', () => {
      const mockManager1 = createMockSessionManager();
      const mockManager2 = createMockSessionManager();

      setSessionManager(mockManager1);
      setSessionManager(mockManager2);

      expect(getSessionManager()).toBe(mockManager2);
    });
  });

  describe('getSessionManager', () => {
    it('returns the session manager when set', () => {
      const mockManager = createMockSessionManager();
      setSessionManager(mockManager);

      expect(getSessionManager()).toBe(mockManager);
    });

    it('throws error when session manager is not set', () => {
      expect(() => getSessionManager()).toThrowError(
        'Session manager not initialized. Call setSessionManager() first.',
      );
    });
  });

  describe('hasSessionManager', () => {
    it('returns false when no session manager is set', () => {
      expect(hasSessionManager()).toBe(false);
    });

    it('returns true when session manager is set', () => {
      const mockManager = createMockSessionManager();
      setSessionManager(mockManager);

      expect(hasSessionManager()).toBe(true);
    });
  });

  describe('ISessionManager interface compliance', () => {
    let manager: ISessionManager;

    beforeEach(() => {
      manager = createMockSessionManager();
      setSessionManager(manager);
    });

    it('can call hasActiveSession', () => {
      const result = getSessionManager().hasActiveSession();
      expect(typeof result).toBe('boolean');
    });

    it('can call getSessionId', () => {
      const result = getSessionManager().getSessionId();
      expect(result).toBeUndefined();
    });

    it('can call launch', async () => {
      const result = await getSessionManager().launch({});
      expect(result.sessionId).toBe('test-session-123');
    });

    it('can call cleanup', async () => {
      const result = await getSessionManager().cleanup();
      expect(result).toBe(true);
    });

    it('can call screenshot', async () => {
      const result = await getSessionManager().screenshot({ name: 'test' });
      expect(result.path).toBeDefined();
    });

    it('can access capability methods', () => {
      expect(getSessionManager().getBuildCapability()).toBeUndefined();
      expect(getSessionManager().getFixtureCapability()).toBeUndefined();
      expect(getSessionManager().getChainCapability()).toBeUndefined();
      expect(
        getSessionManager().getContractSeedingCapability(),
      ).toBeUndefined();
    });
  });
});
