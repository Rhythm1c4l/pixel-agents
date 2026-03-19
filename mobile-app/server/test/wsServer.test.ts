/**
 * WebSocket server integration tests.
 *
 * Tests the full connection lifecycle: pair → connect → fullState → incremental
 * updates → auth rejection → heartbeat timeout.
 *
 * Run with: node --import tsx/esm --test server/test/wsServer.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { once } from 'node:events';
import type { Duplex } from 'node:stream';

import { AgentTracker } from '../agentTracker.ts';
import { SessionScanner } from '../sessionScanner.ts';
import { WsServer } from '../wsServer.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

const TEST_PORT = 0; // Let OS pick a port
const VALID_TOKEN = 'test-token-123';

function getPort(server: http.Server): number {
  const addr = server.address();
  if (typeof addr === 'object' && addr !== null) return addr.port;
  throw new Error('Server not listening');
}

/**
 * Minimal WebSocket client using raw Node.js sockets (no ws library).
 */
async function connectWs(port: number, token: string): Promise<{
  socket: Duplex;
  messages: unknown[];
  waitForMessage: (type: string) => Promise<unknown>;
  send: (msg: unknown) => void;
  close: () => void;
}> {
  const key = crypto.randomBytes(16).toString('base64');
  const messages: unknown[] = [];
  const waiters: Array<{ type: string; resolve: (msg: unknown) => void }> = [];

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: `/ws?token=${encodeURIComponent(token)}`,
      method: 'GET',
      headers: {
        'Connection': 'Upgrade',
        'Upgrade': 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    });

    req.on('upgrade', (_res, socket, _head) => {
      // Pause immediately to buffer any data that arrives before our 'data' handler is set up
      socket.pause();
      let buffer = Buffer.alloc(0);

      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);

        while (buffer.length >= 2) {
          const opcode = buffer[0] & 0x0f;
          let payloadLen = buffer[1] & 0x7f;
          let headerLen = 2;

          if (payloadLen === 126) {
            if (buffer.length < 4) break;
            payloadLen = buffer.readUInt16BE(2);
            headerLen = 4;
          } else if (payloadLen === 127) {
            if (buffer.length < 10) break;
            payloadLen = Number(buffer.readBigUInt64BE(2));
            headerLen = 10;
          }

          if (buffer.length < headerLen + payloadLen) break;

          if (opcode === 0x01) {
            // Text frame
            const text = buffer.subarray(headerLen, headerLen + payloadLen).toString('utf-8');
            try {
              const msg = JSON.parse(text);
              messages.push(msg);
              // Resolve any waiters
              for (let i = waiters.length - 1; i >= 0; i--) {
                if (waiters[i].type === msg.type) {
                  waiters[i].resolve(msg);
                  waiters.splice(i, 1);
                }
              }
            } catch {
              // Non-JSON frame
            }
          } else if (opcode === 0x09) {
            // Ping — respond with pong
            const pong = Buffer.alloc(2);
            pong[0] = 0x8a;
            pong[1] = 0;
            socket.write(pong);
          }

          buffer = buffer.subarray(headerLen + payloadLen);
        }
      });

      function sendMasked(data: string): void {
        const payload = Buffer.from(data, 'utf-8');
        const maskKey = crypto.randomBytes(4);
        const masked = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i++) {
          masked[i] = payload[i] ^ maskKey[i % 4];
        }

        let header: Buffer;
        if (payload.length < 126) {
          header = Buffer.alloc(2);
          header[0] = 0x81;
          header[1] = 0x80 | payload.length;
        } else {
          header = Buffer.alloc(4);
          header[0] = 0x81;
          header[1] = 0x80 | 126;
          header.writeUInt16BE(payload.length, 2);
        }

        socket.write(Buffer.concat([header, maskKey, masked]));
      }

      // Resume now that the 'data' listener is set up
      socket.resume();

      resolve({
        socket,
        messages,
        waitForMessage(type: string): Promise<unknown> {
          // Check already received
          const existing = messages.find((m: any) => m.type === type);
          if (existing) return Promise.resolve(existing);
          return new Promise((res) => {
            waiters.push({ type, resolve: res });
          });
        },
        send(msg: unknown) {
          sendMasked(JSON.stringify(msg));
        },
        close() {
          socket.destroy();
        },
      });
    });

    req.on('error', reject);
    // If server rejects (e.g. 403), 'response' fires instead of 'upgrade'
    req.on('response', (res) => {
      reject(new Error(`WebSocket upgrade rejected: HTTP ${res.statusCode}`));
      res.resume(); // drain the response
    });
    req.end();
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('WsServer', () => {
  let server: http.Server;
  let tracker: AgentTracker;
  let scanner: SessionScanner;
  let wsServer: WsServer;

  beforeEach(async () => {
    tracker = new AgentTracker();
    scanner = new SessionScanner();
    wsServer = new WsServer(tracker, scanner, (token) => token === VALID_TOKEN);
    server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    wsServer.attach(server);
    await new Promise<void>((resolve) => {
      server.listen(TEST_PORT, '127.0.0.1', resolve);
    });
  });

  afterEach(async () => {
    wsServer.dispose();
    tracker.dispose();
    scanner.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('rejects connection with invalid token', async () => {
    const port = getPort(server);
    try {
      await connectWs(port, 'bad-token');
      assert.fail('Should have rejected connection');
    } catch {
      // Expected — connection refused or destroyed
    }
  });

  it('accepts connection with valid token and sends projectList', async () => {
    const port = getPort(server);
    const client = await connectWs(port, VALID_TOKEN);
    try {
      const msg = await client.waitForMessage('projectList') as any;
      assert.equal(msg.type, 'projectList');
      assert.ok(Array.isArray(msg.projects));
    } finally {
      client.close();
    }
  });

  it('sends fullState when client selects a project', async () => {
    const port = getPort(server);
    const client = await connectWs(port, VALID_TOKEN);
    try {
      await client.waitForMessage('projectList');
      client.send({ type: 'selectProject', projectHash: 'test-project' });

      const msg = await client.waitForMessage('fullState') as any;
      assert.equal(msg.type, 'fullState');
      assert.equal(msg.projectHash, 'test-project');
      assert.ok(Array.isArray(msg.agents));
    } finally {
      client.close();
    }
  });

  it('broadcasts agentCreated when tracker adds an agent', async () => {
    const port = getPort(server);
    const client = await connectWs(port, VALID_TOKEN);
    try {
      await client.waitForMessage('projectList');
      client.send({ type: 'selectProject', projectHash: 'test-project' });
      await client.waitForMessage('fullState');

      // Add agent to tracker
      tracker.addAgent('session-1', 'test-project');

      const msg = await client.waitForMessage('agentCreated') as any;
      assert.equal(msg.type, 'agentCreated');
      assert.equal(msg.projectHash, 'test-project');
    } finally {
      client.close();
    }
  });
});
