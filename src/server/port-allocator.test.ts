import { describe, it, expect } from 'vitest';

import { allocatePort } from './port-allocator.js';

describe('allocatePort', () => {
  it('returns a valid port number', async () => {
    const { port, server } = await allocatePort();
    try {
      expect(port).toBeGreaterThan(0);
      expect(port).toBeLessThan(65536);
    } finally {
      server.close();
    }
  });

  it('returns different ports on concurrent calls', async () => {
    const [a, b] = await Promise.all([allocatePort(), allocatePort()]);
    try {
      expect(a.port).not.toBe(b.port);
    } finally {
      a.server.close();
      b.server.close();
    }
  });

  it('returns a server that is already listening', async () => {
    const { server } = await allocatePort();
    try {
      expect(server.listening).toBe(true);
    } finally {
      server.close();
    }
  });

  it('binds to 127.0.0.1', async () => {
    const { server } = await allocatePort();
    try {
      const address = server.address();
      expect(address).not.toBeNull();
      expect(typeof address).toBe('object');
      if (typeof address === 'object' && address !== null) {
        expect(address.address).toBe('127.0.0.1');
      }
    } finally {
      server.close();
    }
  });
});
