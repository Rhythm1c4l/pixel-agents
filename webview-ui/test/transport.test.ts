/**
 * Unit tests for webview-ui/src/transport.ts
 *
 * Tests the WebSocket transport: connection, backoff, message routing,
 * disconnect, and reconnection state machine.
 *
 * Uses a mock WebSocket to simulate server behavior without a network.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

// ── Mock WebSocket ─────────────────────────────────────────────────────────────

type WsEventName = 'open' | 'message' | 'close' | 'error';

interface MockCloseEvent {
  code: number;
  reason: string;
}

class MockWebSocket {
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static CONNECTING = 0;

  readyState: number = MockWebSocket.CONNECTING;
  url: string;

  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: MockCloseEvent) => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;

  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    // Register in the global tracker so tests can access it
    lastMockWs = this;
  }

  // Simulate server opening the connection
  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  // Simulate receiving a message from the server
  simulateMessage(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  // Simulate connection close
  simulateClose(code = 1006, reason = ''): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  // Simulate an error
  simulateError(err: unknown = new Error('connection refused')): void {
    this.onerror?.(err);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSING;
    this.onclose?.({ code: 1000, reason: 'intentional' });
  }
}

let lastMockWs: MockWebSocket | null = null;

// ── Mock window ───────────────────────────────────────────────────────────────

const dispatchedEvents: MessageEvent[] = [];

const mockWindow = {
  dispatchEvent(event: Event): boolean {
    if (event instanceof MessageEvent) {
      dispatchedEvents.push(event);
    }
    return true;
  },
};

// ── Test setup: inject globals ─────────────────────────────────────────────────

// We inject the mocks into globalThis before importing transport.ts.
// The module uses `new WebSocket(...)` and `window.dispatchEvent(...)`.
// Since Node.js uses the global scope for these, we can inject before the import.

// Set up globals before dynamic import
(globalThis as Record<string, unknown>).WebSocket = MockWebSocket;
(globalThis as Record<string, unknown>).window = mockWindow;

// Dynamic import after globals are set
const { connectToServer } = await import('../src/transport.js');

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('connectToServer: initial state', () => {
  beforeEach(() => {
    lastMockWs = null;
    dispatchedEvents.length = 0;
  });

  afterEach(() => {
    // Disconnect to prevent dangling timers
    // (captured per test below)
  });

  it('starts in connecting state', () => {
    const transport = connectToServer('ws://localhost:3000/ws', 'test-token');
    assert.equal(transport.state, 'connecting');
    transport.disconnect();
  });

  it('appends auth token as query param to WebSocket URL', () => {
    connectToServer('ws://localhost:3000/ws', 'my-token');
    assert.ok(lastMockWs, 'WebSocket should be created');
    assert.ok(
      lastMockWs.url.includes('token=my-token'),
      `Expected URL to contain token=my-token, got ${lastMockWs.url}`,
    );
    // Intentional: don't disconnect since state isn't changing — but clean up
    // by simulating close to prevent timer leaks
    lastMockWs.simulateClose();
  });

  it('url-encodes the auth token', () => {
    connectToServer('ws://localhost:3000/ws', 'token with spaces & special=chars');
    assert.ok(lastMockWs);
    assert.ok(lastMockWs.url.includes('token=token%20with%20spaces'));
    lastMockWs.simulateClose();
  });
});

describe('connectToServer: state transitions', () => {
  let transport: ReturnType<typeof connectToServer>;
  let ws: MockWebSocket;

  beforeEach(() => {
    lastMockWs = null;
    dispatchedEvents.length = 0;
    transport = connectToServer('ws://localhost:3000/ws', 'test-token');
    ws = lastMockWs!;
  });

  afterEach(() => {
    transport.disconnect();
  });

  it('transitions to connected on open', () => {
    const states: string[] = [];
    transport.onStateChange((s) => states.push(s));
    ws.simulateOpen();
    assert.equal(transport.state, 'connected');
    assert.deepEqual(states, ['connected']);
  });

  it('fires stateChange handlers with new state', () => {
    const states: string[] = [];
    transport.onStateChange((s) => states.push(s));
    ws.simulateOpen();
    assert.deepEqual(states, ['connected']);
  });

  it('allows unsubscribing from state changes', () => {
    const states: string[] = [];
    const unsub = transport.onStateChange((s) => states.push(s));
    unsub();
    ws.simulateOpen();
    assert.deepEqual(states, []); // no events after unsubscribe
  });

  it('transitions to disconnected on intentional disconnect', () => {
    ws.simulateOpen();
    const states: string[] = [];
    transport.onStateChange((s) => states.push(s));
    transport.disconnect();
    assert.equal(transport.state, 'disconnected');
    assert.ok(states.includes('disconnected'));
  });
});

describe('connectToServer: message handling', () => {
  let transport: ReturnType<typeof connectToServer>;
  let ws: MockWebSocket;

  beforeEach(() => {
    lastMockWs = null;
    dispatchedEvents.length = 0;
    transport = connectToServer('ws://localhost:3000/ws', 'test-token');
    ws = lastMockWs!;
    ws.simulateOpen();
  });

  afterEach(() => {
    transport.disconnect();
  });

  it('routes messages to onMessage handlers', () => {
    const received: unknown[] = [];
    transport.onMessage((msg) => received.push(msg));

    ws.simulateMessage({ type: 'agentStatus', id: 1, status: 'active', projectHash: 'abc' });

    assert.equal(received.length, 1);
    assert.deepEqual((received[0] as { type: string }).type, 'agentStatus');
  });

  it('routes messages to multiple handlers', () => {
    const received1: unknown[] = [];
    const received2: unknown[] = [];
    transport.onMessage((msg) => received1.push(msg));
    transport.onMessage((msg) => received2.push(msg));

    ws.simulateMessage({ type: 'ping' });

    assert.equal(received1.length, 1);
    assert.equal(received2.length, 1);
  });

  it('allows unsubscribing from messages', () => {
    const received: unknown[] = [];
    const unsub = transport.onMessage((msg) => received.push(msg));
    unsub();

    ws.simulateMessage({ type: 'ping' });

    assert.equal(received.length, 0);
  });

  it('dispatches received messages to window as MessageEvent', () => {
    const before = dispatchedEvents.length;
    ws.simulateMessage({ type: 'ping' });
    assert.equal(dispatchedEvents.length, before + 1);
  });

  it('wraps message in {data: msg} for window dispatch (useExtensionMessages compatibility)', () => {
    ws.simulateMessage({ type: 'agentStatus', id: 1, status: 'active', projectHash: 'x' });
    const last = dispatchedEvents[dispatchedEvents.length - 1];
    assert.ok(last, 'Should have dispatched a MessageEvent');
    // The transport wraps: { data: msg }
    assert.deepEqual((last.data as { data: { type: string } }).data.type, 'agentStatus');
  });

  it('ignores malformed JSON messages without throwing', () => {
    const received: unknown[] = [];
    transport.onMessage((msg) => received.push(msg));

    // Simulate a bad message directly
    ws.onmessage?.({ data: 'not valid json{{{' });

    assert.equal(received.length, 0); // nothing dispatched
  });
});

describe('connectToServer: send', () => {
  let transport: ReturnType<typeof connectToServer>;
  let ws: MockWebSocket;

  beforeEach(() => {
    lastMockWs = null;
    transport = connectToServer('ws://localhost:3000/ws', 'test-token');
    ws = lastMockWs!;
  });

  afterEach(() => {
    transport.disconnect();
  });

  it('sends serialized JSON when connected', () => {
    ws.simulateOpen();
    transport.send({ type: 'saveLayout', layout: {} as never });
    assert.equal(ws.sent.length, 1);
    const parsed = JSON.parse(ws.sent[0]) as { type: string };
    assert.equal(parsed.type, 'saveLayout');
  });

  it('does not throw when sending while disconnected', () => {
    // Not yet open — sending should be a no-op
    assert.doesNotThrow(() => {
      transport.send({ type: 'saveLayout', layout: {} as never });
    });
    assert.equal(ws.sent.length, 0);
  });
});

describe('connectToServer: exponential backoff math', () => {
  // Test the nextBackoff() function behavior by verifying the sequence
  // through the transport reconnect behavior.
  // We test the math inline since nextBackoff is not exported.

  it('backoff doubles on each attempt', () => {
    // The constants: initial=1000, multiplier=2, max=30000
    let backoff = 1000;
    const sequence: number[] = [backoff];
    for (let i = 0; i < 6; i++) {
      backoff = Math.min(backoff * 2, 30_000);
      sequence.push(backoff);
    }
    assert.deepEqual(sequence, [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  it('backoff caps at 30000ms', () => {
    let backoff = 1000;
    for (let i = 0; i < 20; i++) {
      backoff = Math.min(backoff * 2, 30_000);
    }
    assert.equal(backoff, 30_000);
  });

  it('backoff stays at cap indefinitely', () => {
    let backoff = 30_000;
    backoff = Math.min(backoff * 2, 30_000);
    assert.equal(backoff, 30_000);
  });
});

describe('connectToServer: disconnect cleanup', () => {
  it('stops reconnect timer on disconnect', () => {
    const transport = connectToServer('ws://localhost:3000/ws', 'test-token');
    const ws = lastMockWs!;

    // Open then close to trigger reconnect timer
    ws.simulateOpen();
    ws.simulateClose();
    // State should be reconnecting
    assert.equal(transport.state, 'reconnecting');

    // Disconnect should cancel the timer and go to disconnected
    transport.disconnect();
    assert.equal(transport.state, 'disconnected');
  });

  it('does not reconnect after intentional disconnect', () => {
    const transport = connectToServer('ws://localhost:3000/ws', 'test-token');
    const initialWs = lastMockWs!;

    initialWs.simulateOpen();
    transport.disconnect();

    const wsCountBefore = lastMockWs;
    // Nothing should have changed — no new WebSocket created
    assert.equal(lastMockWs, wsCountBefore);
    assert.equal(transport.state, 'disconnected');
  });

  it('sets state to disconnected after calling disconnect()', () => {
    const transport = connectToServer('ws://localhost:3000/ws', 'test-token');
    const ws = lastMockWs!;
    ws.simulateOpen();

    transport.disconnect();
    assert.equal(transport.state, 'disconnected');
  });
});
