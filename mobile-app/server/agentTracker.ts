/**
 * Agent tracker — manages agent state across all sessions.
 * Each active JSONL session gets a positive agent ID.
 * Tracks tool state, sub-agents, permission/waiting timers, and palette assignment.
 * No VS Code dependency.
 */

import { EventEmitter } from 'events';

import type { AgentParseState } from '../shared/transcriptParser.js';
import { parseTranscriptLine, PERMISSION_EXEMPT_TOOLS } from '../shared/transcriptParser.js';
import type { TranscriptEvent } from '../shared/transcriptParser.js';
import {
  cancelPermissionTimer,
  cancelWaitingTimer,
  clearAgentActivity,
  startPermissionTimer,
  startWaitingTimer,
} from '../shared/timerManager.js';
import type { TimerCallbacks } from '../shared/timerManager.js';

const TEXT_IDLE_DELAY_MS = 5000;
const PERMISSION_TIMER_DELAY_MS = 7000;
const TOOL_DONE_DELAY_MS = 300;
const PALETTE_COUNT = 6;

// ── Agent state ───────────────────────────────────────────────

export interface ServerAgentState extends AgentParseState {
  id: number;
  sessionId: string;
  projectHash: string;
  palette: number;
  hueShift: number;
  seatId: string | null;
}

// ── Agent tracker ─────────────────────────────────────────────

export class AgentTracker extends EventEmitter {
  private agents = new Map<number, ServerAgentState>();
  private sessionToAgent = new Map<string, number>(); // sessionId → agentId
  private nextAgentId = 1;
  private waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private callbacks: TimerCallbacks;

  constructor() {
    super();
    this.callbacks = {
      onStatusChange: (agentId, status) => {
        const agent = this.agents.get(agentId);
        if (agent) {
          agent.isWaiting = status === 'waiting';
          if (status === 'waiting') agent.permissionSent = false;
        }
        this.emit('agentStatus', agentId, status);
      },
      onToolsClear: (agentId) => {
        this.emit('agentToolsClear', agentId);
      },
      onPermission: (agentId) => {
        this.emit('agentToolPermission', agentId);
      },
      onSubagentPermission: (agentId, parentToolId) => {
        this.emit('subagentToolPermission', agentId, parentToolId);
      },
    };
  }

  /** Create or retrieve an agent for a session. Returns the agent ID. */
  addAgent(sessionId: string, projectHash: string): number {
    const existing = this.sessionToAgent.get(sessionId);
    if (existing !== undefined) return existing;

    const id = this.nextAgentId++;
    const palette = this.pickDiversePalette();
    const hueShift = this.agents.size >= PALETTE_COUNT
      ? 45 + Math.floor(Math.random() * 270)
      : 0;

    const agent: ServerAgentState = {
      id,
      sessionId,
      projectHash,
      palette,
      hueShift,
      seatId: null,
      isWaiting: false,
      permissionSent: false,
      hadToolsInTurn: false,
      activeToolIds: new Set(),
      activeToolStatuses: new Map(),
      activeToolNames: new Map(),
      activeSubagentToolIds: new Map(),
      activeSubagentToolNames: new Map(),
    };

    this.agents.set(id, agent);
    this.sessionToAgent.set(sessionId, id);
    this.emit('agentCreated', id, projectHash);
    return id;
  }

  /** Remove an agent by ID. */
  removeAgent(agentId: number): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    cancelWaitingTimer(agentId, this.waitingTimers);
    cancelPermissionTimer(agentId, this.permissionTimers);
    this.sessionToAgent.delete(agent.sessionId);
    this.agents.delete(agentId);
    this.emit('agentClosed', agentId, agent.projectHash);
  }

  /** Get agent by ID. */
  getAgent(agentId: number): ServerAgentState | undefined {
    return this.agents.get(agentId);
  }

  /** Get agent ID for a session. */
  getAgentForSession(sessionId: string): number | undefined {
    return this.sessionToAgent.get(sessionId);
  }

  /** Get all agents for a project. */
  getAgentsForProject(projectHash: string): ServerAgentState[] {
    return Array.from(this.agents.values()).filter((a) => a.projectHash === projectHash);
  }

  /** Get all agents. */
  getAllAgents(): ServerAgentState[] {
    return Array.from(this.agents.values());
  }

  /** Process a JSONL transcript line for an agent. */
  processLine(agentId: number, line: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    const events = parseTranscriptLine(agentId, line, agent, TEXT_IDLE_DELAY_MS);

    for (const event of events) {
      this.applyEvent(event);
    }
  }

  /** Handle new data arriving for an agent (cancel timers, clear permission). */
  onNewData(agentId: number): void {
    cancelWaitingTimer(agentId, this.waitingTimers);
    cancelPermissionTimer(agentId, this.permissionTimers);
    const agent = this.agents.get(agentId);
    if (agent?.permissionSent) {
      agent.permissionSent = false;
      this.emit('agentToolPermissionClear', agentId);
    }
  }

  private applyEvent(event: TranscriptEvent): void {
    const agent = this.agents.get(event.agentId);

    switch (event.kind) {
      case 'cancelWaitingTimer':
        cancelWaitingTimer(event.agentId, this.waitingTimers);
        break;

      case 'cancelPermissionTimer':
        cancelPermissionTimer(event.agentId, this.permissionTimers);
        break;

      case 'setHadToolsInTurn':
        if (agent) agent.hadToolsInTurn = event.value;
        break;

      case 'statusChange':
        if (agent) {
          agent.isWaiting = event.status === 'waiting';
          if (event.status === 'waiting') agent.permissionSent = false;
        }
        this.emit('agentStatus', event.agentId, event.status);
        break;

      case 'toolStart':
        if (agent) {
          agent.activeToolIds.add(event.toolId);
          agent.activeToolStatuses.set(event.toolId, event.status);
          agent.activeToolNames.set(event.toolId, event.toolName);
        }
        this.emit('agentToolStart', event.agentId, event.toolId, event.status);
        break;

      case 'toolDone':
        if (agent) {
          agent.activeToolIds.delete(event.toolId);
          agent.activeToolStatuses.delete(event.toolId);
          agent.activeToolNames.delete(event.toolId);
        }
        setTimeout(() => {
          this.emit('agentToolDone', event.agentId, event.toolId);
        }, TOOL_DONE_DELAY_MS);
        break;

      case 'toolsClear':
        if (agent) {
          agent.activeToolIds.clear();
          agent.activeToolStatuses.clear();
          agent.activeToolNames.clear();
          agent.activeSubagentToolIds.clear();
          agent.activeSubagentToolNames.clear();
        }
        this.emit('agentToolsClear', event.agentId);
        break;

      case 'clearActivity':
        if (agent) {
          clearAgentActivity(agent, event.agentId, this.permissionTimers, this.callbacks);
        }
        break;

      case 'startPermissionTimer':
        startPermissionTimer(
          event.agentId,
          this.agents as Map<number, ServerAgentState>,
          this.permissionTimers,
          PERMISSION_EXEMPT_TOOLS,
          PERMISSION_TIMER_DELAY_MS,
          this.callbacks,
        );
        break;

      case 'startWaitingTimer':
        startWaitingTimer(
          event.agentId,
          event.delayMs,
          this.agents as Map<number, ServerAgentState>,
          this.waitingTimers,
          this.callbacks,
        );
        break;

      case 'subagentToolStart':
        if (agent) {
          let subTools = agent.activeSubagentToolIds.get(event.parentToolId);
          if (!subTools) {
            subTools = new Set();
            agent.activeSubagentToolIds.set(event.parentToolId, subTools);
          }
          subTools.add(event.toolId);

          let subNames = agent.activeSubagentToolNames.get(event.parentToolId);
          if (!subNames) {
            subNames = new Map();
            agent.activeSubagentToolNames.set(event.parentToolId, subNames);
          }
          subNames.set(event.toolId, event.toolName);
        }
        this.emit('subagentToolStart', event.agentId, event.parentToolId, event.toolId, event.status);
        break;

      case 'subagentToolDone':
        if (agent) {
          const subTools = agent.activeSubagentToolIds.get(event.parentToolId);
          if (subTools) subTools.delete(event.toolId);
          const subNames = agent.activeSubagentToolNames.get(event.parentToolId);
          if (subNames) subNames.delete(event.toolId);
        }
        setTimeout(() => {
          this.emit('subagentToolDone', event.agentId, event.parentToolId, event.toolId);
        }, TOOL_DONE_DELAY_MS);
        break;

      case 'subagentClear':
        if (agent) {
          agent.activeSubagentToolIds.delete(event.parentToolId);
          agent.activeSubagentToolNames.delete(event.parentToolId);
        }
        this.emit('subagentClear', event.agentId, event.parentToolId);
        break;

      case 'permission':
        this.emit('agentToolPermission', event.agentId);
        break;

      case 'subagentPermission':
        this.emit('subagentToolPermission', event.agentId, event.parentToolId);
        break;
    }
  }

  /** Pick the least-used palette for diverse agent appearance. */
  private pickDiversePalette(): number {
    const counts = new Array(PALETTE_COUNT).fill(0) as number[];
    for (const agent of this.agents.values()) {
      counts[agent.palette]++;
    }
    const min = Math.min(...counts);
    const candidates = counts.reduce<number[]>((acc, c, i) => {
      if (c === min) acc.push(i);
      return acc;
    }, []);
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  /** Clean up all timers. */
  dispose(): void {
    for (const timer of this.waitingTimers.values()) clearTimeout(timer);
    for (const timer of this.permissionTimers.values()) clearTimeout(timer);
    this.waitingTimers.clear();
    this.permissionTimers.clear();
  }
}
