import type { ClientToServerMessage, ServerToClientMessage } from '../shared/protocol.js';

// ── Reconnection backoff ───────────────────────────────────────────────────────

const BACKOFF_INITIAL_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const BACKOFF_MULTIPLIER = 2;

function nextBackoff(current: number): number {
  return Math.min(current * BACKOFF_MULTIPLIER, BACKOFF_MAX_MS);
}

// ── Transport state ───────────────────────────────────────────────────────────

export type TransportState = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

export interface Transport {
  send(msg: ClientToServerMessage): void;
  onMessage(handler: (msg: ServerToClientMessage) => void): () => void;
  onStateChange(handler: (state: TransportState) => void): () => void;
  disconnect(): void;
  readonly state: TransportState;
}

// ── connectToServer ───────────────────────────────────────────────────────────

/**
 * Create a WebSocket transport that connects to the given URL with an auth token.
 *
 * On connect: server sends `fullState` which initialises the office.
 * On disconnect: exponential backoff reconnection (1s → 2s → 4s → … → 30s cap).
 * Messages are dispatched as `window.dispatchEvent(new MessageEvent('message', { data }))` so
 * the existing `useExtensionMessages` hook can receive them unmodified in PWA mode.
 *
 * @param url      WebSocket URL, e.g. ws://192.168.1.5:3000/ws
 * @param authToken Auth token received from the /pair endpoint
 */
export function connectToServer(url: string, authToken: string): Transport {
  let ws: WebSocket | null = null;
  let currentState: TransportState = 'connecting';
  let intentionalDisconnect = false;
  let backoffMs = BACKOFF_INITIAL_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const messageHandlers = new Set<(msg: ServerToClientMessage) => void>();
  const stateHandlers = new Set<(state: TransportState) => void>();

  function setState(s: TransportState): void {
    currentState = s;
    for (const h of stateHandlers) h(s);
  }

  function connect(): void {
    if (intentionalDisconnect) return;

    // Append auth token as query param
    const connectUrl = `${url}?token=${encodeURIComponent(authToken)}`;

    try {
      ws = new WebSocket(connectUrl);
    } catch (err) {
      console.error('[transport] Failed to create WebSocket:', err);
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      backoffMs = BACKOFF_INITIAL_MS; // reset backoff on successful connect
      setState('connected');
    };

    ws.onmessage = (event) => {
      let msg: ServerToClientMessage;
      try {
        msg = JSON.parse(event.data as string) as ServerToClientMessage;
      } catch {
        console.warn('[transport] Failed to parse message:', event.data);
        return;
      }

      // Dispatch to all registered onMessage handlers
      for (const h of messageHandlers) h(msg);

      // Also dispatch as a window MessageEvent so useExtensionMessages can
      // receive messages without modification in PWA mode.
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { data: msg },
        }),
      );
    };

    ws.onclose = (event) => {
      ws = null;
      if (intentionalDisconnect) {
        setState('disconnected');
        return;
      }
      console.warn(`[transport] WebSocket closed (code=${event.code}), reconnecting…`);
      setState('reconnecting');
      scheduleReconnect();
    };

    ws.onerror = (err) => {
      console.error('[transport] WebSocket error:', err);
      // onclose will fire after onerror, which handles reconnect
    };
  }

  function scheduleReconnect(): void {
    if (intentionalDisconnect) return;
    if (reconnectTimer !== null) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, backoffMs);
    backoffMs = nextBackoff(backoffMs);
  }

  // Initial connection
  connect();

  return {
    get state() {
      return currentState;
    },

    send(msg: ClientToServerMessage): void {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      } else {
        console.warn('[transport] Cannot send: WebSocket not open', msg.type);
      }
    },

    onMessage(handler: (msg: ServerToClientMessage) => void): () => void {
      messageHandlers.add(handler);
      return () => messageHandlers.delete(handler);
    },

    onStateChange(handler: (state: TransportState) => void): () => void {
      stateHandlers.add(handler);
      return () => stateHandlers.delete(handler);
    },

    disconnect(): void {
      intentionalDisconnect = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws) {
        ws.close();
        ws = null;
      }
      setState('disconnected');
    },
  };
}
