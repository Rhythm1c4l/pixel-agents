/**
 * Unit tests for server/transcriptProcessor.ts
 *
 * Tests the bridge between SessionWatcher events and AgentTracker state.
 * Uses real JSONL samples to verify end-to-end tool event processing.
 *
 * Run with: npm run test:server
 */

import assert from 'node:assert/strict';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { AgentTracker } from '../agentTracker.ts';
import type { ProjectInfo, SessionInfo } from '../types.ts';

// ── Mock SessionScanner ───────────────────────────────────────────────────────

class MockSessionScanner extends EventEmitter {
  projects: ProjectInfo[] = [];

  addProject(project: ProjectInfo): void {
    this.projects.push(project);
    this.emit('project:discovered', project);
  }

  removeProject(project: ProjectInfo): void {
    this.projects = this.projects.filter((p) => p.hash !== project.hash);
    this.emit('project:removed', project);
  }

  getProjects(): ProjectInfo[] {
    return this.projects;
  }
}

// ── Mock SessionWatcher ───────────────────────────────────────────────────────

class MockSessionWatcher extends EventEmitter {
  readonly projectDir: string;
  readonly projectHash: string;
  started = false;
  disposed = false;

  constructor(projectDir: string, projectHash: string) {
    super();
    this.projectDir = projectDir;
    this.projectHash = projectHash;
    lastMockWatcher = this;
    allMockWatchers.push(this);
  }

  start(): void {
    this.started = true;
  }

  dispose(): void {
    this.disposed = true;
  }

  simulateSessionDiscovered(session: SessionInfo): void {
    this.emit('session:discovered', session);
  }

  simulateLine(session: SessionInfo, line: string): void {
    this.emit('session:line', session, line);
  }

  simulateNewData(session: SessionInfo): void {
    this.emit('session:newData', session);
  }
}

let lastMockWatcher: MockSessionWatcher | null = null;
const allMockWatchers: MockSessionWatcher[] = [];

// ── Inject mock into require cache synchronously ──────────────────────────────

const _require = createRequire(import.meta.url);
const sessionWatcherPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../server/sessionWatcher.js',
);

// tsx resolves .js imports to .ts files — inject both keys to ensure the mock is found
const sessionWatcherTsPath = sessionWatcherPath.replace(/\.js$/, '.ts');
const mockModule = {
  id: sessionWatcherPath,
  filename: sessionWatcherPath,
  loaded: true,
  exports: { SessionWatcher: MockSessionWatcher },
  children: [],
  paths: [],
  parent: null,
} as unknown as NodeModule;
_require.cache[sessionWatcherPath] = mockModule;
_require.cache[sessionWatcherTsPath] = { ...mockModule, id: sessionWatcherTsPath, filename: sessionWatcherTsPath } as unknown as NodeModule;

// Import TranscriptProcessor AFTER patching the cache
// Use synchronous require since we're in CJS context (tsx compiles to CJS)
const { TranscriptProcessor } = _require('../../server/transcriptProcessor.js') as {
  TranscriptProcessor: new (
    scanner: MockSessionScanner,
    tracker: AgentTracker,
  ) => {
    start(): void;
    dispose(): void;
  };
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function toolUseJsonl(toolId: string, toolName: string, input: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: toolId, name: toolName, input }] },
  });
}

function toolResultJsonl(toolUseId: string): string {
  return JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId }] },
  });
}

function turnDurationJsonl(): string {
  return JSON.stringify({ type: 'system', subtype: 'turn_duration' });
}

function makeSession(sessionId: string, projectHash: string): SessionInfo {
  return { sessionId, filePath: `/fake/${sessionId}.jsonl`, projectHash };
}

function makeProject(hash: string): ProjectInfo {
  return { hash, dir: `/fake/${hash}`, name: hash.split('-').pop() || hash };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TranscriptProcessor: agent creation', () => {
  let scanner: MockSessionScanner;
  let tracker: AgentTracker;
  let processor: ReturnType<typeof TranscriptProcessor.prototype.constructor> & {
    start(): void;
    dispose(): void;
  };

  beforeEach(() => {
    lastMockWatcher = null;
    allMockWatchers.length = 0;
    scanner = new MockSessionScanner();
    tracker = new AgentTracker();
    processor = new (TranscriptProcessor as unknown as new (
      s: MockSessionScanner,
      t: AgentTracker,
    ) => { start(): void; dispose(): void })(scanner, tracker);
    processor.start();
  });

  afterEach(() => {
    processor.dispose();
    tracker.dispose();
  });

  it('creates a SessionWatcher when a project is discovered', () => {
    scanner.addProject(makeProject('proj-alpha'));
    assert.ok(lastMockWatcher, 'Should have created a SessionWatcher');
    assert.ok(lastMockWatcher.started, 'SessionWatcher should have been started');
    assert.equal(lastMockWatcher.projectHash, 'proj-alpha');
  });

  it('creates an agent when a session is discovered', () => {
    scanner.addProject(makeProject('proj-beta'));
    const watcher = lastMockWatcher!;

    const created: Array<[number, string]> = [];
    tracker.on('agentCreated', (id: number, hash: string) => created.push([id, hash]));

    watcher.simulateSessionDiscovered(makeSession('sess-001', 'proj-beta'));

    assert.equal(created.length, 1);
    assert.equal(created[0][1], 'proj-beta');
  });

  it('does not create duplicate SessionWatcher for same project', () => {
    const project = makeProject('proj-gamma');
    scanner.addProject(project);
    // Emit again to simulate race condition — should be deduplicated by hash
    scanner.emit('project:discovered', project);

    assert.equal(allMockWatchers.length, 1);
  });

  it('handles projects already discovered before start()', () => {
    const scanner2 = new MockSessionScanner();
    scanner2.projects = [makeProject('pre-existing-proj')];
    const tracker2 = new AgentTracker();

    const processor2 = new (TranscriptProcessor as unknown as new (
      s: MockSessionScanner,
      t: AgentTracker,
    ) => { start(): void; dispose(): void })(scanner2, tracker2);

    allMockWatchers.length = 0;
    lastMockWatcher = null;

    processor2.start();

    assert.ok(lastMockWatcher, 'Should have created watcher for pre-existing project');
    assert.ok(lastMockWatcher.started);

    processor2.dispose();
    tracker2.dispose();
  });
});

describe('TranscriptProcessor: JSONL line processing', () => {
  let scanner: MockSessionScanner;
  let tracker: AgentTracker;
  let processor: { start(): void; dispose(): void };
  let watcher: MockSessionWatcher;
  let session: SessionInfo;

  beforeEach(() => {
    lastMockWatcher = null;
    allMockWatchers.length = 0;
    scanner = new MockSessionScanner();
    tracker = new AgentTracker();
    processor = new (TranscriptProcessor as unknown as new (
      s: MockSessionScanner,
      t: AgentTracker,
    ) => { start(): void; dispose(): void })(scanner, tracker);
    processor.start();

    scanner.addProject(makeProject('test-proj'));
    watcher = lastMockWatcher!;
    session = makeSession('sess-abc', 'test-proj');
    watcher.simulateSessionDiscovered(session);
  });

  afterEach(() => {
    processor.dispose();
    tracker.dispose();
  });

  it('routes JSONL lines to agent tracker', () => {
    const toolStarts: string[] = [];
    tracker.on('agentToolStart', (_id: number, toolId: string) => toolStarts.push(toolId));

    watcher.simulateLine(session, toolUseJsonl('tool_001', 'Read', { file_path: '/test.ts' }));

    assert.ok(toolStarts.includes('tool_001'));
  });

  it('processes tool done when tool_result received', async () => {
    tracker.on('agentToolStart', () => {}); // suppress
    watcher.simulateLine(session, toolUseJsonl('tool_001', 'Read', {}));

    const done: string[] = [];
    tracker.on('agentToolDone', (_id: number, toolId: string) => done.push(toolId));

    watcher.simulateLine(session, toolResultJsonl('tool_001'));

    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.ok(done.includes('tool_001'));
  });

  it('processes turn_duration to emit waiting status', () => {
    const statuses: string[] = [];
    tracker.on('agentStatus', (_id: number, status: string) => statuses.push(status));

    watcher.simulateLine(session, turnDurationJsonl());

    assert.ok(statuses.includes('waiting'));
  });

  it('calls onNewData when session:newData event fires', () => {
    const agentId = tracker.getAgentForSession('sess-abc');
    assert.ok(agentId !== undefined);
    const agent = tracker.getAgent(agentId);
    assert.ok(agent);
    agent.permissionSent = true;

    const cleared: number[] = [];
    tracker.on('agentToolPermissionClear', (id: number) => cleared.push(id));

    watcher.simulateNewData(session);

    assert.ok(cleared.includes(agentId));
    assert.ok(!agent.permissionSent);
  });

  it('ignores session:line if session not registered with tracker', () => {
    const unknownSession = makeSession('not-registered', 'test-proj');
    const toolStarts: unknown[] = [];
    tracker.on('agentToolStart', () => toolStarts.push(true));

    assert.doesNotThrow(() => {
      watcher.simulateLine(unknownSession, toolUseJsonl('tool_999', 'Read', {}));
    });
    assert.equal(toolStarts.length, 0);
  });
});

describe('TranscriptProcessor: project removal', () => {
  let scanner: MockSessionScanner;
  let tracker: AgentTracker;
  let processor: { start(): void; dispose(): void };

  beforeEach(() => {
    lastMockWatcher = null;
    allMockWatchers.length = 0;
    scanner = new MockSessionScanner();
    tracker = new AgentTracker();
    processor = new (TranscriptProcessor as unknown as new (
      s: MockSessionScanner,
      t: AgentTracker,
    ) => { start(): void; dispose(): void })(scanner, tracker);
    processor.start();
  });

  afterEach(() => {
    processor.dispose();
    tracker.dispose();
  });

  it('disposes SessionWatcher when project is removed', () => {
    const project = makeProject('removable-proj');
    scanner.addProject(project);
    const watcher = lastMockWatcher!;
    assert.ok(!watcher.disposed);

    scanner.removeProject(project);

    assert.ok(watcher.disposed);
  });

  it('removes agents when project is removed', () => {
    const project = makeProject('agents-proj');
    scanner.addProject(project);
    const watcher = lastMockWatcher!;

    watcher.simulateSessionDiscovered(makeSession('s1', 'agents-proj'));
    watcher.simulateSessionDiscovered(makeSession('s2', 'agents-proj'));

    assert.equal(tracker.getAgentsForProject('agents-proj').length, 2);

    const closed: number[] = [];
    tracker.on('agentClosed', (id: number) => closed.push(id));

    scanner.removeProject(project);

    assert.equal(closed.length, 2);
    assert.equal(tracker.getAgentsForProject('agents-proj').length, 0);
  });
});

describe('TranscriptProcessor: dispose', () => {
  it('disposes all watchers on dispose()', () => {
    lastMockWatcher = null;
    allMockWatchers.length = 0;

    const scanner = new MockSessionScanner();
    const tracker = new AgentTracker();
    const proc = new (TranscriptProcessor as unknown as new (
      s: MockSessionScanner,
      t: AgentTracker,
    ) => { start(): void; dispose(): void })(scanner, tracker);
    proc.start();

    scanner.addProject(makeProject('proj-1'));
    scanner.addProject(makeProject('proj-2'));
    scanner.addProject(makeProject('proj-3'));

    const watchersBeforeDispose = [...allMockWatchers];
    assert.equal(watchersBeforeDispose.length, 3);
    assert.ok(watchersBeforeDispose.every((w) => !w.disposed));

    proc.dispose();
    tracker.dispose();

    assert.ok(watchersBeforeDispose.every((w) => w.disposed));
  });
});

describe('TranscriptProcessor: real JSONL samples', () => {
  it('processes a complete tool lifecycle: start → done → turn_duration', async () => {
    lastMockWatcher = null;
    allMockWatchers.length = 0;

    const scanner = new MockSessionScanner();
    const tracker = new AgentTracker();
    const proc = new (TranscriptProcessor as unknown as new (
      s: MockSessionScanner,
      t: AgentTracker,
    ) => { start(): void; dispose(): void })(scanner, tracker);
    proc.start();

    scanner.addProject(makeProject('real-sample-proj'));
    const watcher = lastMockWatcher!;

    const session = makeSession('real-session', 'real-sample-proj');
    watcher.simulateSessionDiscovered(session);

    const events: string[] = [];
    tracker.on('agentStatus', (_id: number, status: string) => events.push(`status:${status}`));
    tracker.on('agentToolStart', (_id: number, toolId: string) => events.push(`toolStart:${toolId}`));
    tracker.on('agentToolDone', (_id: number, toolId: string) => events.push(`toolDone:${toolId}`));

    watcher.simulateLine(session, toolUseJsonl('tool_read_001', 'Read', { file_path: '/src/main.ts' }));
    watcher.simulateLine(session, toolResultJsonl('tool_read_001'));

    await new Promise((resolve) => setTimeout(resolve, 400));

    watcher.simulateLine(session, turnDurationJsonl());

    assert.ok(events.includes('status:active'));
    assert.ok(events.includes('toolStart:tool_read_001'));
    assert.ok(events.includes('toolDone:tool_read_001'));
    assert.ok(events.includes('status:waiting'));

    proc.dispose();
    tracker.dispose();
  });
});
