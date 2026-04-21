import * as net from 'node:net';

/**
 * Allocates an available port by binding to port 0.
 * Returns both the port number AND the bound server to avoid port-grab race conditions.
 * The caller is responsible for passing the server to Express or closing it.
 *
 * @returns The allocated port and bound server.
 */
export async function allocatePort(): Promise<{
  port: number;
  server: net.Server;
}> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to get server address'));
        return;
      }
      resolve({ port: address.port, server });
    });
    server.on('error', reject);
  });
}
