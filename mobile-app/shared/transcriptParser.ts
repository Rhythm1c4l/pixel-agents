import * as path from 'path';

// ── Constants (duplicated from src/constants.ts to keep shared/ dependency-free) ──
const BASH_COMMAND_DISPLAY_MAX_LENGTH = 30;
const TASK_DESCRIPTION_DISPLAY_MAX_LENGTH = 40;

export const PERMISSION_EXEMPT_TOOLS = new Set(['Task', 'Agent', 'AskUserQuestion']);

// ── Event types emitted by the parser ──

export interface ToolStartEvent {
  kind: 'toolStart';
  agentId: number;
  toolId: string;
  toolName: string;
  status: string;
}

export interface ToolDoneEvent {
  kind: 'toolDone';
  agentId: number;
  toolId: string;
  /** Tool name of the completed tool (for subagent cleanup) */
  toolName: string;
}

export interface StatusChangeEvent {
  kind: 'statusChange';
  agentId: number;
  status: 'active' | 'waiting';
}

export interface ToolsClearEvent {
  kind: 'toolsClear';
  agentId: number;
}

export interface PermissionEvent {
  kind: 'permission';
  agentId: number;
}

export interface SubagentToolStartEvent {
  kind: 'subagentToolStart';
  agentId: number;
  parentToolId: string;
  toolId: string;
  toolName: string;
  status: string;
}

export interface SubagentToolDoneEvent {
  kind: 'subagentToolDone';
  agentId: number;
  parentToolId: string;
  toolId: string;
}

export interface SubagentClearEvent {
  kind: 'subagentClear';
  agentId: number;
  parentToolId: string;
}

export interface SubagentPermissionEvent {
  kind: 'subagentPermission';
  agentId: number;
  parentToolId: string;
}

export interface ClearActivityEvent {
  kind: 'clearActivity';
  agentId: number;
}

/** Request to start/cancel a waiting timer */
export interface WaitingTimerEvent {
  kind: 'startWaitingTimer';
  agentId: number;
  delayMs: number;
}

export interface CancelWaitingTimerEvent {
  kind: 'cancelWaitingTimer';
  agentId: number;
}

/** Request to start/cancel a permission timer */
export interface StartPermissionTimerEvent {
  kind: 'startPermissionTimer';
  agentId: number;
}

export interface CancelPermissionTimerEvent {
  kind: 'cancelPermissionTimer';
  agentId: number;
}

/** Signals that hadToolsInTurn should be updated */
export interface TurnFlagEvent {
  kind: 'setHadToolsInTurn';
  agentId: number;
  value: boolean;
}

export type TranscriptEvent =
  | ToolStartEvent
  | ToolDoneEvent
  | StatusChangeEvent
  | ToolsClearEvent
  | PermissionEvent
  | SubagentToolStartEvent
  | SubagentToolDoneEvent
  | SubagentClearEvent
  | SubagentPermissionEvent
  | ClearActivityEvent
  | WaitingTimerEvent
  | CancelWaitingTimerEvent
  | StartPermissionTimerEvent
  | CancelPermissionTimerEvent
  | TurnFlagEvent;

// ── Minimal agent state interface needed for parsing ──

export interface AgentParseState {
  isWaiting: boolean;
  permissionSent: boolean;
  hadToolsInTurn: boolean;
  activeToolIds: Set<string>;
  activeToolStatuses: Map<string, string>;
  activeToolNames: Map<string, string>;
  activeSubagentToolIds: Map<string, Set<string>>;
  activeSubagentToolNames: Map<string, Map<string, string>>;
}

// ── Pure functions ──

export function formatToolStatus(toolName: string, input: Record<string, unknown>): string {
  const base = (p: unknown) => (typeof p === 'string' ? path.basename(p) : '');
  switch (toolName) {
    case 'Read':
      return `Reading ${base(input.file_path)}`;
    case 'Edit':
      return `Editing ${base(input.file_path)}`;
    case 'Write':
      return `Writing ${base(input.file_path)}`;
    case 'Bash': {
      const cmd = (input.command as string) || '';
      return `Running: ${cmd.length > BASH_COMMAND_DISPLAY_MAX_LENGTH ? cmd.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH) + '\u2026' : cmd}`;
    }
    case 'Glob':
      return 'Searching files';
    case 'Grep':
      return 'Searching code';
    case 'WebFetch':
      return 'Fetching web content';
    case 'WebSearch':
      return 'Searching the web';
    case 'Task':
    case 'Agent': {
      const desc = typeof input.description === 'string' ? input.description : '';
      return desc
        ? `Subtask: ${desc.length > TASK_DESCRIPTION_DISPLAY_MAX_LENGTH ? desc.slice(0, TASK_DESCRIPTION_DISPLAY_MAX_LENGTH) + '\u2026' : desc}`
        : 'Running subtask';
    }
    case 'AskUserQuestion':
      return 'Waiting for your answer';
    case 'EnterPlanMode':
      return 'Planning';
    case 'NotebookEdit':
      return `Editing notebook`;
    default:
      return `Using ${toolName}`;
  }
}

/**
 * Parse a single JSONL transcript line into an array of TranscriptEvents.
 * This is a pure function — it reads `agent` state but does NOT mutate it.
 * The caller is responsible for applying state mutations based on the returned events.
 *
 * @param textIdleDelayMs - delay for text-idle waiting timer (e.g. 5000)
 */
export function parseTranscriptLine(
  agentId: number,
  line: string,
  agent: AgentParseState,
  textIdleDelayMs: number,
): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];

  try {
    const record = JSON.parse(line);

    if (record.type === 'assistant' && Array.isArray(record.message?.content)) {
      const blocks = record.message.content as Array<{
        type: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
      }>;
      const hasToolUse = blocks.some((b) => b.type === 'tool_use');

      if (hasToolUse) {
        events.push({ kind: 'cancelWaitingTimer', agentId });
        events.push({ kind: 'setHadToolsInTurn', agentId, value: true });
        events.push({ kind: 'statusChange', agentId, status: 'active' });

        let hasNonExemptTool = false;
        for (const block of blocks) {
          if (block.type === 'tool_use' && block.id) {
            const toolName = block.name || '';
            const status = formatToolStatus(toolName, block.input || {});
            events.push({ kind: 'toolStart', agentId, toolId: block.id, toolName, status });
            if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
              hasNonExemptTool = true;
            }
          }
        }
        if (hasNonExemptTool) {
          events.push({ kind: 'startPermissionTimer', agentId });
        }
      } else if (blocks.some((b) => b.type === 'text') && !agent.hadToolsInTurn) {
        events.push({ kind: 'startWaitingTimer', agentId, delayMs: textIdleDelayMs });
      }
    } else if (record.type === 'progress') {
      parseProgressRecord(agentId, record, agent, events);
    } else if (record.type === 'user') {
      const content = record.message?.content;
      if (Array.isArray(content)) {
        const blocks = content as Array<{ type: string; tool_use_id?: string }>;
        const hasToolResult = blocks.some((b) => b.type === 'tool_result');
        if (hasToolResult) {
          for (const block of blocks) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              const toolName = agent.activeToolNames.get(block.tool_use_id) || '';
              events.push({
                kind: 'toolDone',
                agentId,
                toolId: block.tool_use_id,
                toolName,
              });
              if (toolName === 'Task' || toolName === 'Agent') {
                events.push({
                  kind: 'subagentClear',
                  agentId,
                  parentToolId: block.tool_use_id,
                });
              }
            }
          }
          // If all tools would be completed, allow text-idle timer
          const remainingTools = new Set(agent.activeToolIds);
          for (const block of blocks) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              remainingTools.delete(block.tool_use_id);
            }
          }
          if (remainingTools.size === 0) {
            events.push({ kind: 'setHadToolsInTurn', agentId, value: false });
          }
        } else {
          // New user text prompt — new turn starting
          events.push({ kind: 'cancelWaitingTimer', agentId });
          events.push({ kind: 'clearActivity', agentId });
          events.push({ kind: 'setHadToolsInTurn', agentId, value: false });
        }
      } else if (typeof content === 'string' && content.trim()) {
        // New user text prompt — new turn starting
        events.push({ kind: 'cancelWaitingTimer', agentId });
        events.push({ kind: 'clearActivity', agentId });
        events.push({ kind: 'setHadToolsInTurn', agentId, value: false });
      }
    } else if (record.type === 'system' && record.subtype === 'turn_duration') {
      events.push({ kind: 'cancelWaitingTimer', agentId });
      events.push({ kind: 'cancelPermissionTimer', agentId });

      // Definitive turn-end: clean up any stale tool state
      if (agent.activeToolIds.size > 0) {
        events.push({ kind: 'toolsClear', agentId });
      }

      events.push({ kind: 'statusChange', agentId, status: 'waiting' });
      events.push({ kind: 'setHadToolsInTurn', agentId, value: false });
    }
  } catch {
    // Ignore malformed lines
  }

  return events;
}

function parseProgressRecord(
  agentId: number,
  record: Record<string, unknown>,
  agent: AgentParseState,
  events: TranscriptEvent[],
): void {
  const parentToolId = record.parentToolUseID as string | undefined;
  if (!parentToolId) return;

  const data = record.data as Record<string, unknown> | undefined;
  if (!data) return;

  const dataType = data.type as string | undefined;
  if (dataType === 'bash_progress' || dataType === 'mcp_progress') {
    if (agent.activeToolIds.has(parentToolId)) {
      events.push({ kind: 'startPermissionTimer', agentId });
    }
    return;
  }

  // Verify parent is an active Task/Agent tool
  const parentToolName = agent.activeToolNames.get(parentToolId);
  if (parentToolName !== 'Task' && parentToolName !== 'Agent') return;

  const msg = data.message as Record<string, unknown> | undefined;
  if (!msg) return;

  const msgType = msg.type as string;
  const innerMsg = msg.message as Record<string, unknown> | undefined;
  const content = innerMsg?.content;
  if (!Array.isArray(content)) return;

  if (msgType === 'assistant') {
    let hasNonExemptSubTool = false;
    for (const block of content) {
      if (block.type === 'tool_use' && block.id) {
        const toolName = block.name || '';
        const status = formatToolStatus(toolName, block.input || {});
        events.push({
          kind: 'subagentToolStart',
          agentId,
          parentToolId,
          toolId: block.id,
          toolName,
          status,
        });
        if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
          hasNonExemptSubTool = true;
        }
      }
    }
    if (hasNonExemptSubTool) {
      events.push({ kind: 'startPermissionTimer', agentId });
    }
  } else if (msgType === 'user') {
    for (const block of content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        events.push({
          kind: 'subagentToolDone',
          agentId,
          parentToolId,
          toolId: block.tool_use_id,
        });
      }
    }
    // Check if there are still non-exempt sub-agent tools after removing completed ones
    const completedIds = new Set(
      content
        .filter((b: { type: string; tool_use_id?: string }) => b.type === 'tool_result' && b.tool_use_id)
        .map((b: { tool_use_id?: string }) => b.tool_use_id!),
    );

    let stillHasNonExempt = false;
    for (const [pId, subNames] of agent.activeSubagentToolNames) {
      for (const [subId, toolName] of subNames) {
        if (!completedIds.has(subId) && !PERMISSION_EXEMPT_TOOLS.has(toolName)) {
          stillHasNonExempt = true;
          break;
        }
      }
      if (stillHasNonExempt) break;
    }
    if (stillHasNonExempt) {
      events.push({ kind: 'startPermissionTimer', agentId });
    }
  }
}
