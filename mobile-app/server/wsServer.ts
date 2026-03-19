/**
 * WebSocket server — handles upgrade requests, manages client connections,
 * and bridges agent tracker events to connected clients.
 *
 * Uses Node.js built-in crypto for WebSocket handshake (RFC 6455).
 * No external ws library dependency.
 */

import * as crypto from 'crypto';
import * as http from 'http';
import type { Duplex } from 'stream';

import type { AgentTracker, ServerAgentState } from './agentTracker.js';
import type { LayoutWatcher } from './layoutManager.js';
import { readLayout } from './layoutManager.js';
import { getProjectName } from './projectMapper.js';
import type { SessionScanner } from './sessionScanner.js';
import type { ServerToClientMessage, ClientToServerMessage } from '../shared/protocol.js';

const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 30_000;
const MAX_PAYLOAD_SIZE = 1_048_576; // 1 MB
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB57C8A2AE';

// ── WebSocket frame helpers (RFC 6455) ────────────────────────

function encodeFrame(data: string): Buffer {
  const payload = Buffer.from(data, 'utf-8');
  const len = payload.length;

  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + text opcode
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  return Buffer.concat([header, payload]);
}

function decodeMaskedPayload(data: Buffer, maskKey: Buffer, length: number): string {
  const unmasked = Buffer.alloc(length);
  for (let i = 0; i < length; i++) {
    unmasked[i] = data[i] ^ maskKey[i % 4];
  }
  return unmasked.toString('utf-8');
}

// ── Client connection ─────────────────────────────────────────

interface WsClient {
  socket: Duplex;
  projectHash: string | null;
  lastPong: number;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
}

// ── Message validation ────────────────────────────────────────

const VALID_CLIENT_TYPES = new Set([
  'selectProject', 'webviewReady', 'saveLayout',
  'saveAgentSeats', 'focusAgent', 'setSoundEnabled',
]);

function isValidClientMessage(msg: unknown): msg is ClientToServerMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'type' in msg &&
    typeof (msg as Record<string, unknown>).type === 'string' &&
    VALID_CLIENT_TYPES.has((msg as Record<string, unknown>).type as string)
  );
}

// ── WebSocket server ──────────────────────────────────────────

export class WsServer {
  private clients = new Set<WsClient>();
  private tracker: AgentTracker;
  private scanner: SessionScanner;
  private validateToken: (token: string) => boolean;

  constructor(
    tracker: AgentTracker,
    scanner: SessionScanner,
    validateToken: (token: string) => boolean,
  ) {
    this.tracker = tracker;
    this.scanner = scanner;
    this.validateToken = validateToken;

    // Subscribe to agent tracker events and broadcast to clients
    this.setupTrackerListeners();
  }

  /** Attach to an HTTP server to handle WebSocket upgrades. */
  attach(server: http.Server): void {
    server.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket as Duplex, head);
    });
  }

  private handleUpgrade(req: http.IncomingMessage, socket: Duplex, _head: Buffer): void {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    // Only handle /ws path
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    // Validate auth token
    const token = url.searchParams.get('token');
    if (!token || !this.validateToken(token)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    // WebSocket handshake
    const wsKey = req.headers['sec-websocket-key'];
    if (!wsKey) {
      socket.destroy();
      return;
    }

    const acceptKey = crypto
      .createHash('sha1')
      .update(wsKey + WS_GUID)
      .digest('base64');

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
      '\r\n',
    );

    const client: WsClient = {
      socket,
      projectHash: null,
      lastPong: Date.now(),
      heartbeatTimer: null,
    };

    this.clients.add(client);

    // Start heartbeat
    client.heartbeatTimer = setInterval(() => {
      if (Date.now() - client.lastPong > HEARTBEAT_TIMEOUT_MS) {
        this.removeClient(client);
        return;
      }
      // Send ping frame
      const pingFrame = Buffer.alloc(2);
      pingFrame[0] = 0x89; // FIN + ping opcode
      pingFrame[1] = 0;
      socket.write(pingFrame);
    }, HEARTBEAT_INTERVAL_MS);

    // Handle incoming data
    let buffer = Buffer.alloc(0);

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      while (buffer.length >= 2) {
        const secondByte = buffer[1];
        const isMasked = (secondByte & 0x80) !== 0;
        let payloadLen = secondByte & 0x7f;
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

        if (payloadLen > MAX_PAYLOAD_SIZE) {
          this.removeClient(client);
          return;
        }

        const maskLen = isMasked ? 4 : 0;
        const totalLen = headerLen + maskLen + payloadLen;
        if (buffer.length < totalLen) break;

        const opcode = buffer[0] & 0x0f;

        if (opcode === 0x08) {
          // Close frame
          this.removeClient(client);
          return;
        }

        if (opcode === 0x0a) {
          // Pong
          client.lastPong = Date.now();
        } else if (opcode === 0x09) {
          // Ping — respond with pong
          const pongFrame = Buffer.alloc(2);
          pongFrame[0] = 0x8a; // FIN + pong opcode
          pongFrame[1] = 0;
          socket.write(pongFrame);
        } else if (opcode === 0x01) {
          // Text frame
          const maskKey = isMasked
            ? buffer.subarray(headerLen, headerLen + maskLen)
            : Buffer.alloc(4);
          const payloadData = buffer.subarray(headerLen + maskLen, totalLen);
          const text = isMasked
            ? decodeMaskedPayload(payloadData, maskKey, payloadLen)
            : payloadData.toString('utf-8');

          this.handleMessage(client, text);
        }

        buffer = buffer.subarray(totalLen);
      }
    });

    socket.on('close', () => this.removeClient(client));
    socket.on('error', () => this.removeClient(client));

    // Send project list on connect
    this.sendProjectList(client);
  }

  private sendToClient(client: WsClient, msg: ServerToClientMessage): void {
    try {
      client.socket.write(encodeFrame(JSON.stringify(msg)));
    } catch {
      this.removeClient(client);
    }
  }

  private broadcast(msg: ServerToClientMessage, projectHash?: string): void {
    for (const client of this.clients) {
      if (projectHash && client.projectHash !== projectHash) continue;
      this.sendToClient(client, msg);
    }
  }

  private handleMessage(client: WsClient, text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (!isValidClientMessage(parsed)) return;
    const msg = parsed;

    switch (msg.type) {
      case 'selectProject':
        client.projectHash = msg.projectHash;
        this.sendFullState(client, msg.projectHash);
        break;

      case 'webviewReady':
        if (client.projectHash) {
          this.sendFullState(client, client.projectHash);
        }
        break;

      case 'saveLayout':
        // Layout saves are handled by the CLI entry point
        break;

      case 'saveAgentSeats':
        // Update agent seats in tracker
        for (const [idStr, seat] of Object.entries(msg.seats)) {
          const agentId = Number(idStr);
          const agent = this.tracker.getAgent(agentId);
          if (agent) {
            agent.palette = seat.palette;
            agent.hueShift = seat.hueShift;
            agent.seatId = seat.seatId;
          }
        }
        break;

      case 'focusAgent':
        // Not applicable on server — no terminals to focus
        break;

      case 'setSoundEnabled':
        // Sound is client-side only
        break;
    }
  }

  private sendProjectList(client: WsClient): void {
    const projects = this.scanner.getProjects().map((p) => ({
      hash: p.hash,
      name: getProjectName(p.hash),
      agentCount: this.tracker.getAgentsForProject(p.hash).length,
    }));

    this.sendToClient(client, { type: 'projectList', projects });
  }

  private sendFullState(client: WsClient, projectHash: string): void {
    const agents = this.tracker.getAgentsForProject(projectHash);
    const agentIds = agents.map((a) => a.id);
    const agentMeta: Record<number, { palette?: number; hueShift?: number; seatId?: string }> = {};
    const folderNames: Record<number, string> = {};
    const agentStatuses: Record<number, 'active' | 'waiting'> = {};
    const agentTools: Record<number, Array<{ toolId: string; status: string; done: boolean }>> = {};

    for (const agent of agents) {
      agentMeta[agent.id] = {
        palette: agent.palette,
        hueShift: agent.hueShift,
        seatId: agent.seatId ?? undefined,
      };
      if (agent.isWaiting) {
        agentStatuses[agent.id] = 'waiting';
      }
      if (agent.activeToolIds.size > 0) {
        agentTools[agent.id] = Array.from(agent.activeToolIds).map((toolId) => ({
          toolId,
          status: agent.activeToolStatuses.get(toolId) || '',
          done: false,
        }));
      }
    }

    const layout = readLayout() || {};

    this.sendToClient(client, {
      type: 'fullState',
      projectHash,
      agents: agentIds,
      agentMeta,
      folderNames,
      agentStatuses,
      agentTools,
      layout,
    });
  }

  private setupTrackerListeners(): void {
    this.tracker.on('agentCreated', (agentId: number, projectHash: string) => {
      this.broadcast({ type: 'agentCreated', id: agentId, projectHash }, projectHash);
    });

    this.tracker.on('agentClosed', (agentId: number, projectHash: string) => {
      this.broadcast({ type: 'agentClosed', id: agentId, projectHash }, projectHash);
    });

    this.tracker.on('agentStatus', (agentId: number, status: 'active' | 'waiting') => {
      const agent = this.tracker.getAgent(agentId);
      if (!agent) return;
      this.broadcast(
        { type: 'agentStatus', id: agentId, status, projectHash: agent.projectHash },
        agent.projectHash,
      );
    });

    this.tracker.on('agentToolStart', (agentId: number, toolId: string, status: string) => {
      const agent = this.tracker.getAgent(agentId);
      if (!agent) return;
      this.broadcast(
        { type: 'agentToolStart', id: agentId, toolId, status, projectHash: agent.projectHash },
        agent.projectHash,
      );
    });

    this.tracker.on('agentToolDone', (agentId: number, toolId: string) => {
      const agent = this.tracker.getAgent(agentId);
      if (!agent) return;
      this.broadcast(
        { type: 'agentToolDone', id: agentId, toolId, projectHash: agent.projectHash },
        agent.projectHash,
      );
    });

    this.tracker.on('agentToolsClear', (agentId: number) => {
      const agent = this.tracker.getAgent(agentId);
      if (!agent) return;
      this.broadcast(
        { type: 'agentToolsClear', id: agentId, projectHash: agent.projectHash },
        agent.projectHash,
      );
    });

    this.tracker.on('agentToolPermission', (agentId: number) => {
      const agent = this.tracker.getAgent(agentId);
      if (!agent) return;
      this.broadcast(
        { type: 'agentToolPermission', id: agentId, projectHash: agent.projectHash },
        agent.projectHash,
      );
    });

    this.tracker.on('agentToolPermissionClear', (agentId: number) => {
      const agent = this.tracker.getAgent(agentId);
      if (!agent) return;
      this.broadcast(
        { type: 'agentToolPermissionClear', id: agentId, projectHash: agent.projectHash },
        agent.projectHash,
      );
    });

    this.tracker.on('subagentToolStart', (agentId: number, parentToolId: string, toolId: string, status: string) => {
      const agent = this.tracker.getAgent(agentId);
      if (!agent) return;
      this.broadcast(
        { type: 'subagentToolStart', id: agentId, parentToolId, toolId, status, projectHash: agent.projectHash },
        agent.projectHash,
      );
    });

    this.tracker.on('subagentToolDone', (agentId: number, parentToolId: string, toolId: string) => {
      const agent = this.tracker.getAgent(agentId);
      if (!agent) return;
      this.broadcast(
        { type: 'subagentToolDone', id: agentId, parentToolId, toolId, projectHash: agent.projectHash },
        agent.projectHash,
      );
    });

    this.tracker.on('subagentClear', (agentId: number, parentToolId: string) => {
      const agent = this.tracker.getAgent(agentId);
      if (!agent) return;
      this.broadcast(
        { type: 'subagentClear', id: agentId, parentToolId, projectHash: agent.projectHash },
        agent.projectHash,
      );
    });

    this.tracker.on('subagentToolPermission', (agentId: number, parentToolId: string) => {
      const agent = this.tracker.getAgent(agentId);
      if (!agent) return;
      this.broadcast(
        { type: 'subagentToolPermission', id: agentId, parentToolId, projectHash: agent.projectHash },
        agent.projectHash,
      );
    });
  }

  private removeClient(client: WsClient): void {
    if (!this.clients.has(client)) return;
    this.clients.delete(client);
    if (client.heartbeatTimer) {
      clearInterval(client.heartbeatTimer);
      client.heartbeatTimer = null;
    }
    try {
      client.socket.destroy();
    } catch {
      /* ignore */
    }
  }

  /** Clean up all connections. */
  dispose(): void {
    for (const client of this.clients) {
      this.removeClient(client);
    }
  }
}
