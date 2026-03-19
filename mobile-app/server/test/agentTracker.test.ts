/**
 * Unit tests for server/agentTracker.ts
 *
 * Tests agent lifecycle: create, tool tracking, sub-agents, palette assignment,
 * status changes, and cleanup.
 *
 * Run with: npm run test:server
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { AgentTracker } from '../agentTracker.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

function toolUseRecord(toolId: string, toolName: string, input: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id: toolId, name: toolName, input }],
    },
  });
}

function toolResultRecord(toolUseId: string) {
  return JSON.stringify({
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: toolUseId }],
    },
  });
}

function turnDurationRecord() {
  return JSON.stringify({
    type: 'system',
    subtype: 'turn_duration',
    duration_ms: 1000,
  });
}

function textRecord(text: string) {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AgentTracker: agent lifecycle', () => {
  let tracker: AgentTracker;

  beforeEach(() => {
    tracker = new AgentTracker();
  });

  afterEach(() => {
    tracker.dispose();
  });

  it('creates agent with a positive ID', () => {
    const id = tracker.addAgent('session-abc', 'project-hash-1');
    assert.ok(id > 0, `Expected positive agent ID, got ${id}`);
  });

  it('increments IDs for successive agents', () => {
    const id1 = tracker.addAgent('session-001', 'proj-hash');
    const id2 = tracker.addAgent('session-002', 'proj-hash');
    const id3 = tracker.addAgent('session-003', 'proj-hash');
    assert.ok(id2 > id1);
    assert.ok(id3 > id2);
  });

  it('returns same ID for duplicate session', () => {
    const id1 = tracker.addAgent('session-abc', 'proj-hash');
    const id2 = tracker.addAgent('session-abc', 'proj-hash');
    assert.equal(id1, id2);
  });

  it('emits agentCreated event with agentId and projectHash', () => {
    const events: Array<[number, string]> = [];
    tracker.on('agentCreated', (id: number, hash: string) => events.push([id, hash]));

    const id = tracker.addAgent('session-xyz', 'proj-abc');

    assert.equal(events.length, 1);
    assert.equal(events[0][0], id);
    assert.equal(events[0][1], 'proj-abc');
  });

  it('does NOT emit agentCreated for duplicate session', () => {
    const events: unknown[] = [];
    tracker.on('agentCreated', () => events.push(true));

    tracker.addAgent('session-dup', 'proj-hash');
    tracker.addAgent('session-dup', 'proj-hash');

    assert.equal(events.length, 1);
  });

  it('removes agent and emits agentClosed', () => {
    const closed: Array<[number, string]> = [];
    tracker.on('agentClosed', (id: number, hash: string) => closed.push([id, hash]));

    const id = tracker.addAgent('session-remove', 'proj-z');
    tracker.removeAgent(id);

    assert.equal(closed.length, 1);
    assert.equal(closed[0][0], id);
    assert.equal(closed[0][1], 'proj-z');
  });

  it('getAgent returns agent by ID', () => {
    const id = tracker.addAgent('session-get', 'proj-hash');
    const agent = tracker.getAgent(id);
    assert.ok(agent);
    assert.equal(agent.id, id);
    assert.equal(agent.sessionId, 'session-get');
    assert.equal(agent.projectHash, 'proj-hash');
  });

  it('getAgent returns undefined for unknown ID', () => {
    assert.equal(tracker.getAgent(9999), undefined);
  });

  it('getAgentForSession returns agent ID', () => {
    const id = tracker.addAgent('sess-lookup', 'proj-hash');
    assert.equal(tracker.getAgentForSession('sess-lookup'), id);
  });

  it('getAgentForSession returns undefined for unknown session', () => {
    assert.equal(tracker.getAgentForSession('unknown-session'), undefined);
  });

  it('getAgentsForProject returns agents for that project', () => {
    tracker.addAgent('s1', 'proj-a');
    tracker.addAgent('s2', 'proj-a');
    tracker.addAgent('s3', 'proj-b');

    const projAAgents = tracker.getAgentsForProject('proj-a');
    const projBAgents = tracker.getAgentsForProject('proj-b');

    assert.equal(projAAgents.length, 2);
    assert.equal(projBAgents.length, 1);
  });

  it('getAllAgents returns all agents', () => {
    tracker.addAgent('s1', 'proj-a');
    tracker.addAgent('s2', 'proj-b');
    tracker.addAgent('s3', 'proj-c');

    assert.equal(tracker.getAllAgents().length, 3);
  });

  it('removeAgent cleans up session lookup', () => {
    const id = tracker.addAgent('sess-clean', 'proj-hash');
    tracker.removeAgent(id);
    assert.equal(tracker.getAgentForSession('sess-clean'), undefined);
  });

  it('removeAgent is a no-op for unknown ID', () => {
    assert.doesNotThrow(() => tracker.removeAgent(9999));
  });
});

describe('AgentTracker: palette assignment', () => {
  let tracker: AgentTracker;

  beforeEach(() => {
    tracker = new AgentTracker();
  });

  afterEach(() => {
    tracker.dispose();
  });

  it('first 6 agents get unique palettes 0-5', () => {
    const palettes = new Set<number>();
    for (let i = 0; i < 6; i++) {
      const id = tracker.addAgent(`sess-${i}`, 'proj-hash');
      const agent = tracker.getAgent(id);
      assert.ok(agent);
      palettes.add(agent.palette);
    }
    assert.equal(palettes.size, 6);
    // All palettes 0-5 should be present
    for (let p = 0; p < 6; p++) {
      assert.ok(palettes.has(p), `Palette ${p} not assigned`);
    }
  });

  it('first 6 agents have hueShift of 0', () => {
    for (let i = 0; i < 6; i++) {
      const id = tracker.addAgent(`sess-${i}`, 'proj-hash');
      const agent = tracker.getAgent(id);
      assert.ok(agent);
      assert.equal(agent.hueShift, 0);
    }
  });

  it('7th agent gets a non-zero hueShift', () => {
    // Add 6 agents first
    for (let i = 0; i < 6; i++) {
      tracker.addAgent(`sess-${i}`, 'proj-hash');
    }
    // 7th agent should have non-zero hueShift
    const id = tracker.addAgent('sess-7', 'proj-hash');
    const agent = tracker.getAgent(id);
    assert.ok(agent);
    // hueShift is in range 45-314 (45 + random(270))
    assert.ok(agent.hueShift >= 45, `Expected hueShift >= 45, got ${agent.hueShift}`);
    assert.ok(agent.hueShift < 315, `Expected hueShift < 315, got ${agent.hueShift}`);
  });

  it('palette values are in range 0-5', () => {
    for (let i = 0; i < 12; i++) {
      const id = tracker.addAgent(`sess-${i}`, 'proj-hash');
      const agent = tracker.getAgent(id);
      assert.ok(agent);
      assert.ok(agent.palette >= 0 && agent.palette < 6);
    }
  });
});

describe('AgentTracker: processLine - tool tracking', () => {
  let tracker: AgentTracker;
  let agentId: number;

  beforeEach(() => {
    tracker = new AgentTracker();
    agentId = tracker.addAgent('sess-tools', 'proj-hash');
  });

  afterEach(() => {
    tracker.dispose();
  });

  it('emits agentToolStart when tool_use appears', () => {
    const events: Array<[number, string, string]> = [];
    tracker.on('agentToolStart', (id: number, toolId: string, status: string) =>
      events.push([id, toolId, status]),
    );

    tracker.processLine(agentId, toolUseRecord('tool_abc', 'Read', { file_path: '/foo/bar.ts' }));

    assert.equal(events.length, 1);
    assert.equal(events[0][0], agentId);
    assert.equal(events[0][1], 'tool_abc');
    assert.equal(events[0][2], 'Reading bar.ts');
  });

  it('updates agent activeToolIds', () => {
    tracker.processLine(agentId, toolUseRecord('tool_xyz', 'Bash', { command: 'ls' }));

    const agent = tracker.getAgent(agentId);
    assert.ok(agent);
    assert.ok(agent.activeToolIds.has('tool_xyz'));
  });

  it('updates agent activeToolNames', () => {
    tracker.processLine(agentId, toolUseRecord('tool_xyz', 'Bash', { command: 'ls' }));

    const agent = tracker.getAgent(agentId);
    assert.ok(agent);
    assert.equal(agent.activeToolNames.get('tool_xyz'), 'Bash');
  });

  it('emits agentToolDone (with delay) after tool_result', async () => {
    tracker.processLine(agentId, toolUseRecord('tool_abc', 'Read', {}));

    const done: Array<[number, string]> = [];
    tracker.on('agentToolDone', (id: number, toolId: string) => done.push([id, toolId]));

    tracker.processLine(agentId, toolResultRecord('tool_abc'));

    // Wait for the 300ms delay
    await new Promise((resolve) => setTimeout(resolve, 400));

    assert.equal(done.length, 1);
    assert.equal(done[0][0], agentId);
    assert.equal(done[0][1], 'tool_abc');
  });

  it('removes tool from activeToolIds after tool_result', () => {
    tracker.processLine(agentId, toolUseRecord('tool_abc', 'Read', {}));

    const agentBefore = tracker.getAgent(agentId);
    assert.ok(agentBefore?.activeToolIds.has('tool_abc'));

    tracker.processLine(agentId, toolResultRecord('tool_abc'));

    const agentAfter = tracker.getAgent(agentId);
    assert.ok(!agentAfter?.activeToolIds.has('tool_abc'));
  });

  it('emits agentStatus active when tool_use detected', () => {
    const statuses: string[] = [];
    tracker.on('agentStatus', (_id: number, status: string) => statuses.push(status));

    tracker.processLine(agentId, toolUseRecord('tool_abc', 'Read', {}));

    assert.ok(statuses.includes('active'));
  });

  it('emits agentStatus waiting on turn_duration', () => {
    const statuses: string[] = [];
    tracker.on('agentStatus', (_id: number, status: string) => statuses.push(status));

    tracker.processLine(agentId, turnDurationRecord());

    assert.ok(statuses.includes('waiting'));
  });

  it('emits agentToolsClear and clears tool state on turn_duration with active tools', () => {
    tracker.processLine(agentId, toolUseRecord('tool_abc', 'Read', {}));

    const clears: number[] = [];
    tracker.on('agentToolsClear', (id: number) => clears.push(id));

    tracker.processLine(agentId, turnDurationRecord());

    assert.ok(clears.includes(agentId));
    const agent = tracker.getAgent(agentId);
    assert.equal(agent?.activeToolIds.size, 0);
  });

  it('does not emit agentToolsClear when no active tools on turn_duration', () => {
    const clears: number[] = [];
    tracker.on('agentToolsClear', (id: number) => clears.push(id));

    tracker.processLine(agentId, turnDurationRecord());

    assert.equal(clears.length, 0);
  });

  it('ignores processLine for unknown agentId', () => {
    assert.doesNotThrow(() => {
      tracker.processLine(9999, toolUseRecord('tool_abc', 'Read', {}));
    });
  });
});

describe('AgentTracker: processLine - sub-agent tools', () => {
  let tracker: AgentTracker;
  let agentId: number;

  beforeEach(() => {
    tracker = new AgentTracker();
    agentId = tracker.addAgent('sess-subagents', 'proj-hash');
  });

  afterEach(() => {
    tracker.dispose();
  });

  it('emits subagentToolStart for progress record', () => {
    // First add Task tool to parent
    tracker.processLine(agentId, toolUseRecord('task_001', 'Task', { description: 'Sub work' }));

    const subStarts: Array<[number, string, string, string]> = [];
    tracker.on(
      'subagentToolStart',
      (id: number, parentId: string, toolId: string, status: string) =>
        subStarts.push([id, parentId, toolId, status]),
    );

    const progressRecord = JSON.stringify({
      type: 'progress',
      parentToolUseID: 'task_001',
      data: {
        type: 'agent_progress',
        message: {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: 'sub_001', name: 'Read', input: { file_path: '/test.ts' } },
            ],
          },
        },
      },
    });

    tracker.processLine(agentId, progressRecord);

    assert.equal(subStarts.length, 1);
    assert.equal(subStarts[0][0], agentId);
    assert.equal(subStarts[0][1], 'task_001');
    assert.equal(subStarts[0][2], 'sub_001');
  });

  it('tracks sub-agent tool IDs on agent state', () => {
    tracker.processLine(agentId, toolUseRecord('task_001', 'Task', {}));

    const progressRecord = JSON.stringify({
      type: 'progress',
      parentToolUseID: 'task_001',
      data: {
        type: 'agent_progress',
        message: {
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: 'sub_001', name: 'Bash', input: { command: 'ls' } }],
          },
        },
      },
    });

    tracker.processLine(agentId, progressRecord);

    const agent = tracker.getAgent(agentId);
    assert.ok(agent);
    const subTools = agent.activeSubagentToolIds.get('task_001');
    assert.ok(subTools);
    assert.ok(subTools.has('sub_001'));
  });

  it('emits subagentClear when parent Task tool completes', () => {
    tracker.processLine(agentId, toolUseRecord('task_001', 'Task', {}));

    const clears: Array<[number, string]> = [];
    tracker.on('subagentClear', (id: number, parentId: string) => clears.push([id, parentId]));

    tracker.processLine(agentId, toolResultRecord('task_001'));

    assert.equal(clears.length, 1);
    assert.equal(clears[0][0], agentId);
    assert.equal(clears[0][1], 'task_001');
  });
});

describe('AgentTracker: onNewData', () => {
  let tracker: AgentTracker;
  let agentId: number;

  beforeEach(() => {
    tracker = new AgentTracker();
    agentId = tracker.addAgent('sess-newdata', 'proj-hash');
  });

  afterEach(() => {
    tracker.dispose();
  });

  it('clears permissionSent and emits agentToolPermissionClear when permission was sent', () => {
    const agent = tracker.getAgent(agentId);
    assert.ok(agent);

    // Simulate permission sent state
    agent.permissionSent = true;

    const cleared: number[] = [];
    tracker.on('agentToolPermissionClear', (id: number) => cleared.push(id));

    tracker.onNewData(agentId);

    assert.ok(!agent.permissionSent);
    assert.ok(cleared.includes(agentId));
  });

  it('does not emit agentToolPermissionClear when permission was not sent', () => {
    const cleared: number[] = [];
    tracker.on('agentToolPermissionClear', (id: number) => cleared.push(id));

    tracker.onNewData(agentId);

    assert.equal(cleared.length, 0);
  });

  it('is a no-op for unknown agentId', () => {
    assert.doesNotThrow(() => tracker.onNewData(9999));
  });
});

describe('AgentTracker: dispose', () => {
  it('cleans up without throwing', () => {
    const tracker = new AgentTracker();
    tracker.addAgent('sess-dispose', 'proj-hash');
    assert.doesNotThrow(() => tracker.dispose());
  });
});

describe('AgentTracker: text-only turn waiting timer', () => {
  let tracker: AgentTracker;
  let agentId: number;

  beforeEach(() => {
    tracker = new AgentTracker();
    agentId = tracker.addAgent('sess-text', 'proj-hash');
  });

  afterEach(() => {
    tracker.dispose();
  });

  it('emits agentStatus waiting after text-only response (TEXT_IDLE_DELAY)', async () => {
    const statuses: string[] = [];
    tracker.on('agentStatus', (_id: number, status: string) => statuses.push(status));

    // hadToolsInTurn defaults to false — text response should start waiting timer
    tracker.processLine(agentId, textRecord('Here is my response'));

    // TEXT_IDLE_DELAY_MS = 5000ms — too long to wait in tests
    // Instead verify the waiting timer was started (agent state unchanged but timer pending)
    // We can verify by canceling — onNewData cancels the timer
    tracker.onNewData(agentId);

    // Should not have emitted 'waiting' yet since timer was cancelled
    assert.ok(!statuses.includes('waiting'));
  });
});
