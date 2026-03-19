/**
 * Unit tests for shared/transcriptParser.ts
 *
 * Tests the pure parseTranscriptLine() and formatToolStatus() functions.
 * No mocking needed — these are side-effect-free functions.
 *
 * Run with: node --import tsx/esm --test shared/test/transcriptParser.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatToolStatus,
  parseTranscriptLine,
  PERMISSION_EXEMPT_TOOLS,
  type AgentParseState,
} from '../transcriptParser.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeAgent(overrides?: Partial<AgentParseState>): AgentParseState {
  return {
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    ...overrides,
  };
}

function line(record: unknown): string {
  return JSON.stringify(record);
}

const AGENT_ID = 1;
const TEXT_IDLE_DELAY = 5000;

function parse(record: unknown, agent?: AgentParseState) {
  return parseTranscriptLine(AGENT_ID, line(record), agent ?? makeAgent(), TEXT_IDLE_DELAY);
}

function eventKinds(record: unknown, agent?: AgentParseState): string[] {
  return parse(record, agent).map((e) => e.kind);
}

// ── formatToolStatus ──────────────────────────────────────────────────────────

describe('formatToolStatus', () => {
  it('formats Read with basename', () => {
    assert.equal(formatToolStatus('Read', { file_path: '/some/path/file.ts' }), 'Reading file.ts');
  });

  it('formats Edit with basename', () => {
    assert.equal(formatToolStatus('Edit', { file_path: '/dir/foo.ts' }), 'Editing foo.ts');
  });

  it('formats Write with basename', () => {
    assert.equal(formatToolStatus('Write', { file_path: '/dir/bar.ts' }), 'Writing bar.ts');
  });

  it('formats short Bash command verbatim', () => {
    assert.equal(formatToolStatus('Bash', { command: 'ls -la' }), 'Running: ls -la');
  });

  it('truncates long Bash commands at 30 chars with ellipsis', () => {
    const longCmd = 'a'.repeat(40);
    const result = formatToolStatus('Bash', { command: longCmd });
    assert.ok(result.startsWith('Running: '));
    // Should be truncated: 'Running: ' + 30 chars + '…'
    assert.ok(result.endsWith('…'));
    // Total length: 'Running: ' (9) + 30 + '…' (1 char = 3 bytes but 1 code unit)
    assert.equal(result.replace('Running: ', '').replace('…', '').length, 30);
  });

  it('formats Glob', () => {
    assert.equal(formatToolStatus('Glob', {}), 'Searching files');
  });

  it('formats Grep', () => {
    assert.equal(formatToolStatus('Grep', {}), 'Searching code');
  });

  it('formats WebFetch', () => {
    assert.equal(formatToolStatus('WebFetch', {}), 'Fetching web content');
  });

  it('formats WebSearch', () => {
    assert.equal(formatToolStatus('WebSearch', {}), 'Searching the web');
  });

  it('formats Task with short description', () => {
    assert.equal(
      formatToolStatus('Task', { description: 'Build the feature' }),
      'Subtask: Build the feature',
    );
  });

  it('formats Agent with short description', () => {
    assert.equal(
      formatToolStatus('Agent', { description: 'Write tests' }),
      'Subtask: Write tests',
    );
  });

  it('formats Task without description', () => {
    assert.equal(formatToolStatus('Task', {}), 'Running subtask');
  });

  it('truncates long Task description at 40 chars', () => {
    const longDesc = 'x'.repeat(50);
    const result = formatToolStatus('Task', { description: longDesc });
    assert.ok(result.startsWith('Subtask: '));
    assert.ok(result.endsWith('…'));
  });

  it('formats AskUserQuestion', () => {
    assert.equal(formatToolStatus('AskUserQuestion', {}), 'Waiting for your answer');
  });

  it('formats unknown tool as Using <Name>', () => {
    assert.equal(formatToolStatus('CustomTool', {}), 'Using CustomTool');
  });

  it('formats NotebookEdit', () => {
    assert.equal(formatToolStatus('NotebookEdit', {}), 'Editing notebook');
  });

  it('formats EnterPlanMode', () => {
    assert.equal(formatToolStatus('EnterPlanMode', {}), 'Planning');
  });
});

// ── PERMISSION_EXEMPT_TOOLS ───────────────────────────────────────────────────

describe('PERMISSION_EXEMPT_TOOLS', () => {
  it('includes Task, Agent, AskUserQuestion', () => {
    assert.ok(PERMISSION_EXEMPT_TOOLS.has('Task'));
    assert.ok(PERMISSION_EXEMPT_TOOLS.has('Agent'));
    assert.ok(PERMISSION_EXEMPT_TOOLS.has('AskUserQuestion'));
  });

  it('does not include Read, Bash, Edit', () => {
    assert.ok(!PERMISSION_EXEMPT_TOOLS.has('Read'));
    assert.ok(!PERMISSION_EXEMPT_TOOLS.has('Bash'));
    assert.ok(!PERMISSION_EXEMPT_TOOLS.has('Edit'));
  });
});

// ── parseTranscriptLine: malformed input ──────────────────────────────────────

describe('parseTranscriptLine: malformed input', () => {
  it('returns empty array for invalid JSON', () => {
    const events = parseTranscriptLine(AGENT_ID, 'not json', makeAgent(), TEXT_IDLE_DELAY);
    assert.deepEqual(events, []);
  });

  it('returns empty array for empty string', () => {
    const events = parseTranscriptLine(AGENT_ID, '', makeAgent(), TEXT_IDLE_DELAY);
    assert.deepEqual(events, []);
  });

  it('returns empty array for unknown record type', () => {
    const events = parse({ type: 'unknown', data: {} });
    assert.deepEqual(events, []);
  });
});

// ── parseTranscriptLine: assistant records ────────────────────────────────────

describe('parseTranscriptLine: assistant with tool_use', () => {
  const record = {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'tool_abc',
          name: 'Read',
          input: { file_path: '/foo/bar.ts' },
        },
      ],
    },
  };

  it('emits cancelWaitingTimer', () => {
    assert.ok(eventKinds(record).includes('cancelWaitingTimer'));
  });

  it('emits setHadToolsInTurn true', () => {
    const events = parse(record);
    const flag = events.find((e) => e.kind === 'setHadToolsInTurn');
    assert.ok(flag);
    assert.equal(flag.kind, 'setHadToolsInTurn');
    if (flag.kind === 'setHadToolsInTurn') {
      assert.equal(flag.value, true);
    }
  });

  it('emits statusChange active', () => {
    const events = parse(record);
    const status = events.find((e) => e.kind === 'statusChange');
    assert.ok(status);
    if (status?.kind === 'statusChange') {
      assert.equal(status.status, 'active');
    }
  });

  it('emits toolStart with correct fields', () => {
    const events = parse(record);
    const toolStart = events.find((e) => e.kind === 'toolStart');
    assert.ok(toolStart);
    if (toolStart?.kind === 'toolStart') {
      assert.equal(toolStart.toolId, 'tool_abc');
      assert.equal(toolStart.toolName, 'Read');
      assert.equal(toolStart.status, 'Reading bar.ts');
      assert.equal(toolStart.agentId, AGENT_ID);
    }
  });

  it('emits startPermissionTimer for non-exempt tool (Read)', () => {
    assert.ok(eventKinds(record).includes('startPermissionTimer'));
  });
});

describe('parseTranscriptLine: assistant with exempt tool only (Task)', () => {
  const record = {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'task_001',
          name: 'Task',
          input: { description: 'Do something' },
        },
      ],
    },
  };

  it('does NOT emit startPermissionTimer for exempt tool', () => {
    assert.ok(!eventKinds(record).includes('startPermissionTimer'));
  });

  it('still emits toolStart', () => {
    assert.ok(eventKinds(record).includes('toolStart'));
  });
});

describe('parseTranscriptLine: assistant with mixed exempt and non-exempt tools', () => {
  const record = {
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id: 'task_001', name: 'Task', input: { description: 'sub' } },
        { type: 'tool_use', id: 'bash_001', name: 'Bash', input: { command: 'ls' } },
      ],
    },
  };

  it('emits startPermissionTimer when at least one non-exempt tool present', () => {
    assert.ok(eventKinds(record).includes('startPermissionTimer'));
  });

  it('emits toolStart for both tools', () => {
    const events = parse(record);
    const toolStarts = events.filter((e) => e.kind === 'toolStart');
    assert.equal(toolStarts.length, 2);
  });
});

describe('parseTranscriptLine: assistant with text only, no prior tools', () => {
  const record = {
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: 'Here is my response' }],
    },
  };

  it('emits startWaitingTimer when hadToolsInTurn is false', () => {
    const agent = makeAgent({ hadToolsInTurn: false });
    const events = parseTranscriptLine(AGENT_ID, line(record), agent, TEXT_IDLE_DELAY);
    const timerEvent = events.find((e) => e.kind === 'startWaitingTimer');
    assert.ok(timerEvent);
    if (timerEvent?.kind === 'startWaitingTimer') {
      assert.equal(timerEvent.delayMs, TEXT_IDLE_DELAY);
    }
  });

  it('does NOT emit startWaitingTimer when hadToolsInTurn is true', () => {
    const agent = makeAgent({ hadToolsInTurn: true });
    const events = parseTranscriptLine(AGENT_ID, line(record), agent, TEXT_IDLE_DELAY);
    assert.ok(!events.some((e) => e.kind === 'startWaitingTimer'));
  });
});

// ── parseTranscriptLine: user records ─────────────────────────────────────────

describe('parseTranscriptLine: user record with tool_result', () => {
  it('emits toolDone for completed tool', () => {
    const agent = makeAgent({
      activeToolIds: new Set(['tool_abc']),
      activeToolNames: new Map([['tool_abc', 'Read']]),
    });
    const record = {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tool_abc' }],
      },
    };
    const events = parseTranscriptLine(AGENT_ID, line(record), agent, TEXT_IDLE_DELAY);
    const toolDone = events.find((e) => e.kind === 'toolDone');
    assert.ok(toolDone);
    if (toolDone?.kind === 'toolDone') {
      assert.equal(toolDone.toolId, 'tool_abc');
      assert.equal(toolDone.toolName, 'Read');
    }
  });

  it('emits subagentClear when completed tool is Task', () => {
    const agent = makeAgent({
      activeToolIds: new Set(['task_001']),
      activeToolNames: new Map([['task_001', 'Task']]),
    });
    const record = {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'task_001' }],
      },
    };
    const events = parseTranscriptLine(AGENT_ID, line(record), agent, TEXT_IDLE_DELAY);
    const subClear = events.find((e) => e.kind === 'subagentClear');
    assert.ok(subClear);
    if (subClear?.kind === 'subagentClear') {
      assert.equal(subClear.parentToolId, 'task_001');
    }
  });

  it('emits setHadToolsInTurn false when all tools done', () => {
    const agent = makeAgent({
      activeToolIds: new Set(['tool_abc']),
      activeToolNames: new Map([['tool_abc', 'Read']]),
    });
    const record = {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tool_abc' }],
      },
    };
    const events = parseTranscriptLine(AGENT_ID, line(record), agent, TEXT_IDLE_DELAY);
    const flag = events.find((e) => e.kind === 'setHadToolsInTurn');
    assert.ok(flag);
    if (flag?.kind === 'setHadToolsInTurn') {
      assert.equal(flag.value, false);
    }
  });

  it('does NOT emit setHadToolsInTurn false if other tools remain', () => {
    const agent = makeAgent({
      activeToolIds: new Set(['tool_abc', 'tool_xyz']),
      activeToolNames: new Map([
        ['tool_abc', 'Read'],
        ['tool_xyz', 'Bash'],
      ]),
    });
    const record = {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tool_abc' }],
      },
    };
    const events = parseTranscriptLine(AGENT_ID, line(record), agent, TEXT_IDLE_DELAY);
    const flag = events.find((e) => e.kind === 'setHadToolsInTurn');
    assert.equal(flag, undefined);
  });
});

describe('parseTranscriptLine: user record with new text prompt', () => {
  const record = {
    type: 'user',
    message: { content: 'Run this task please' },
  };

  it('emits cancelWaitingTimer', () => {
    assert.ok(eventKinds(record).includes('cancelWaitingTimer'));
  });

  it('emits clearActivity', () => {
    assert.ok(eventKinds(record).includes('clearActivity'));
  });

  it('emits setHadToolsInTurn false', () => {
    const events = parse(record);
    const flag = events.find((e) => e.kind === 'setHadToolsInTurn');
    assert.ok(flag);
    if (flag?.kind === 'setHadToolsInTurn') {
      assert.equal(flag.value, false);
    }
  });
});

describe('parseTranscriptLine: user record with array content non-tool', () => {
  const record = {
    type: 'user',
    message: {
      content: [{ type: 'text', text: 'Hello' }],
    },
  };

  it('does not emit toolDone or subagentClear', () => {
    const kinds = eventKinds(record);
    assert.ok(!kinds.includes('toolDone'));
    assert.ok(!kinds.includes('subagentClear'));
  });
});

// ── parseTranscriptLine: system turn_duration ─────────────────────────────────

describe('parseTranscriptLine: system turn_duration', () => {
  const record = {
    type: 'system',
    subtype: 'turn_duration',
    duration_ms: 12000,
  };

  it('emits cancelWaitingTimer', () => {
    assert.ok(eventKinds(record).includes('cancelWaitingTimer'));
  });

  it('emits cancelPermissionTimer', () => {
    assert.ok(eventKinds(record).includes('cancelPermissionTimer'));
  });

  it('emits statusChange waiting', () => {
    const events = parse(record);
    const status = events.find((e) => e.kind === 'statusChange');
    assert.ok(status);
    if (status?.kind === 'statusChange') {
      assert.equal(status.status, 'waiting');
    }
  });

  it('emits setHadToolsInTurn false', () => {
    const events = parse(record);
    const flag = events.find((e) => e.kind === 'setHadToolsInTurn');
    assert.ok(flag);
    if (flag?.kind === 'setHadToolsInTurn') {
      assert.equal(flag.value, false);
    }
  });

  it('emits toolsClear when there are active tools', () => {
    const agent = makeAgent({
      activeToolIds: new Set(['tool_abc']),
    });
    const events = parseTranscriptLine(AGENT_ID, line(record), agent, TEXT_IDLE_DELAY);
    assert.ok(events.some((e) => e.kind === 'toolsClear'));
  });

  it('does NOT emit toolsClear when no active tools', () => {
    const agent = makeAgent({ activeToolIds: new Set() });
    const events = parseTranscriptLine(AGENT_ID, line(record), agent, TEXT_IDLE_DELAY);
    assert.ok(!events.some((e) => e.kind === 'toolsClear'));
  });
});

// ── parseTranscriptLine: progress records (subagent) ─────────────────────────

describe('parseTranscriptLine: progress record with bash_progress', () => {
  const record = {
    type: 'progress',
    parentToolUseID: 'tool_abc',
    data: { type: 'bash_progress', output: 'still running' },
  };

  it('emits startPermissionTimer when parent tool is active', () => {
    const agent = makeAgent({ activeToolIds: new Set(['tool_abc']) });
    const events = parseTranscriptLine(AGENT_ID, line(record), agent, TEXT_IDLE_DELAY);
    assert.ok(events.some((e) => e.kind === 'startPermissionTimer'));
  });

  it('does NOT emit startPermissionTimer when parent tool is NOT active', () => {
    const agent = makeAgent({ activeToolIds: new Set() });
    const events = parseTranscriptLine(AGENT_ID, line(record), agent, TEXT_IDLE_DELAY);
    assert.ok(!events.some((e) => e.kind === 'startPermissionTimer'));
  });
});

describe('parseTranscriptLine: progress record with agent_progress (subagent tool start)', () => {
  const record = {
    type: 'progress',
    parentToolUseID: 'task_001',
    data: {
      type: 'agent_progress',
      message: {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'sub_tool_001',
              name: 'Read',
              input: { file_path: '/path/file.ts' },
            },
          ],
        },
      },
    },
  };

  it('emits subagentToolStart for sub-agent Read tool', () => {
    const agent = makeAgent({
      activeToolNames: new Map([['task_001', 'Task']]),
    });
    const events = parseTranscriptLine(AGENT_ID, line(record), agent, TEXT_IDLE_DELAY);
    const subStart = events.find((e) => e.kind === 'subagentToolStart');
    assert.ok(subStart);
    if (subStart?.kind === 'subagentToolStart') {
      assert.equal(subStart.parentToolId, 'task_001');
      assert.equal(subStart.toolId, 'sub_tool_001');
      assert.equal(subStart.toolName, 'Read');
    }
  });

  it('emits startPermissionTimer for non-exempt sub-agent tool', () => {
    const agent = makeAgent({
      activeToolNames: new Map([['task_001', 'Task']]),
    });
    const events = parseTranscriptLine(AGENT_ID, line(record), agent, TEXT_IDLE_DELAY);
    assert.ok(events.some((e) => e.kind === 'startPermissionTimer'));
  });

  it('ignores progress record when parent is not Task/Agent', () => {
    // Parent is 'Read', not Task/Agent — should be ignored
    const agent = makeAgent({
      activeToolNames: new Map([['task_001', 'Read']]),
    });
    const events = parseTranscriptLine(AGENT_ID, line(record), agent, TEXT_IDLE_DELAY);
    assert.equal(events.length, 0);
  });
});

describe('parseTranscriptLine: progress record with agent_progress (subagent tool done)', () => {
  const record = {
    type: 'progress',
    parentToolUseID: 'task_001',
    data: {
      type: 'agent_progress',
      message: {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'sub_tool_001' }],
        },
      },
    },
  };

  it('emits subagentToolDone', () => {
    const subNames = new Map([['sub_tool_001', 'Read']]);
    const agent = makeAgent({
      activeToolNames: new Map([['task_001', 'Task']]),
      activeSubagentToolNames: new Map([['task_001', subNames]]),
    });
    const events = parseTranscriptLine(AGENT_ID, line(record), agent, TEXT_IDLE_DELAY);
    const done = events.find((e) => e.kind === 'subagentToolDone');
    assert.ok(done);
    if (done?.kind === 'subagentToolDone') {
      assert.equal(done.parentToolId, 'task_001');
      assert.equal(done.toolId, 'sub_tool_001');
    }
  });
});

// ── Agent ID propagation ──────────────────────────────────────────────────────

describe('parseTranscriptLine: agentId propagation', () => {
  it('every event carries the provided agentId', () => {
    const customAgentId = 42;
    const record = {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'tool_abc', name: 'Read', input: {} }],
      },
    };
    const events = parseTranscriptLine(
      customAgentId,
      line(record),
      makeAgent(),
      TEXT_IDLE_DELAY,
    );
    for (const event of events) {
      assert.equal(event.agentId, customAgentId, `event ${event.kind} has wrong agentId`);
    }
  });
});
