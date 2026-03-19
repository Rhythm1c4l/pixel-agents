/**
 * Shared timer manager — no vscode dependency.
 * Uses a callback-based event emitter pattern instead of postMessage.
 */

export interface TimerCallbacks {
  onStatusChange(agentId: number, status: 'active' | 'waiting'): void;
  onToolsClear(agentId: number): void;
  onPermission(agentId: number): void;
  onSubagentPermission(agentId: number, parentToolId: string): void;
}

/** Minimal agent state needed by timers */
export interface TimerAgentState {
  isWaiting: boolean;
  permissionSent: boolean;
  activeToolIds: Set<string>;
  activeToolNames: Map<string, string>;
  activeToolStatuses: Map<string, string>;
  activeSubagentToolIds: Map<string, Set<string>>;
  activeSubagentToolNames: Map<string, Map<string, string>>;
}

export function clearAgentActivity(
  agent: TimerAgentState | undefined,
  agentId: number,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  callbacks: TimerCallbacks,
): void {
  if (!agent) return;
  agent.activeToolIds.clear();
  agent.activeToolStatuses.clear();
  agent.activeToolNames.clear();
  agent.activeSubagentToolIds.clear();
  agent.activeSubagentToolNames.clear();
  agent.isWaiting = false;
  agent.permissionSent = false;
  cancelPermissionTimer(agentId, permissionTimers);
  callbacks.onToolsClear(agentId);
  callbacks.onStatusChange(agentId, 'active');
}

export function cancelWaitingTimer(
  agentId: number,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
): void {
  const timer = waitingTimers.get(agentId);
  if (timer) {
    clearTimeout(timer);
    waitingTimers.delete(agentId);
  }
}

export function startWaitingTimer(
  agentId: number,
  delayMs: number,
  agents: Map<number, TimerAgentState>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  callbacks: TimerCallbacks,
): void {
  cancelWaitingTimer(agentId, waitingTimers);
  const timer = setTimeout(() => {
    waitingTimers.delete(agentId);
    const agent = agents.get(agentId);
    if (agent) {
      agent.isWaiting = true;
    }
    callbacks.onStatusChange(agentId, 'waiting');
  }, delayMs);
  waitingTimers.set(agentId, timer);
}

export function cancelPermissionTimer(
  agentId: number,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
): void {
  const timer = permissionTimers.get(agentId);
  if (timer) {
    clearTimeout(timer);
    permissionTimers.delete(agentId);
  }
}

export function startPermissionTimer(
  agentId: number,
  agents: Map<number, TimerAgentState>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionExemptTools: Set<string>,
  permissionTimerDelayMs: number,
  callbacks: TimerCallbacks,
): void {
  cancelPermissionTimer(agentId, permissionTimers);
  const timer = setTimeout(() => {
    permissionTimers.delete(agentId);
    const agent = agents.get(agentId);
    if (!agent) return;

    let hasNonExempt = false;
    for (const toolId of agent.activeToolIds) {
      const toolName = agent.activeToolNames.get(toolId);
      if (!permissionExemptTools.has(toolName || '')) {
        hasNonExempt = true;
        break;
      }
    }

    const stuckSubagentParentToolIds: string[] = [];
    for (const [parentToolId, subToolNames] of agent.activeSubagentToolNames) {
      for (const [, toolName] of subToolNames) {
        if (!permissionExemptTools.has(toolName)) {
          stuckSubagentParentToolIds.push(parentToolId);
          hasNonExempt = true;
          break;
        }
      }
    }

    if (hasNonExempt) {
      agent.permissionSent = true;
      callbacks.onPermission(agentId);
      for (const parentToolId of stuckSubagentParentToolIds) {
        callbacks.onSubagentPermission(agentId, parentToolId);
      }
    }
  }, permissionTimerDelayMs);
  permissionTimers.set(agentId, timer);
}
