/**
 * Transcript processor — bridges SessionWatcher events to AgentTracker state.
 * Listens for new sessions and JSONL lines, creates agents, and processes tool events.
 * No VS Code dependency.
 */

import type { SessionScanner } from './sessionScanner.js';
import { SessionWatcher } from './sessionWatcher.js';
import type { AgentTracker } from './agentTracker.js';
import type { ProjectInfo, SessionInfo } from './types.js';

/**
 * Wire up session discovery and JSONL processing.
 *
 * Creates a SessionWatcher for each discovered project,
 * and feeds JSONL lines into the AgentTracker.
 */
export class TranscriptProcessor {
  private scanner: SessionScanner;
  private tracker: AgentTracker;
  private watchers = new Map<string, SessionWatcher>();
  private disposed = false;

  constructor(scanner: SessionScanner, tracker: AgentTracker) {
    this.scanner = scanner;
    this.tracker = tracker;
  }

  /** Start processing. Call after scanner.start(). */
  start(): void {
    // Handle projects already discovered
    for (const project of this.scanner.getProjects()) {
      this.onProjectDiscovered(project);
    }

    // Watch for new projects
    this.scanner.on('project:discovered', (project: ProjectInfo) => {
      this.onProjectDiscovered(project);
    });

    this.scanner.on('project:removed', (project: ProjectInfo) => {
      this.onProjectRemoved(project);
    });
  }

  private onProjectDiscovered(project: ProjectInfo): void {
    if (this.disposed) return;
    if (this.watchers.has(project.hash)) return;

    const watcher = new SessionWatcher(project.dir, project.hash);

    watcher.on('session:discovered', (session: SessionInfo) => {
      this.tracker.addAgent(session.sessionId, session.projectHash);
    });

    watcher.on('session:line', (session: SessionInfo, line: string) => {
      const agentId = this.tracker.getAgentForSession(session.sessionId);
      if (agentId !== undefined) {
        this.tracker.processLine(agentId, line);
      }
    });

    watcher.on('session:newData', (session: SessionInfo) => {
      const agentId = this.tracker.getAgentForSession(session.sessionId);
      if (agentId !== undefined) {
        this.tracker.onNewData(agentId);
      }
    });

    this.watchers.set(project.hash, watcher);
    watcher.start();
  }

  private onProjectRemoved(project: ProjectInfo): void {
    const watcher = this.watchers.get(project.hash);
    if (watcher) {
      // Remove all agents for this project
      const agents = this.tracker.getAgentsForProject(project.hash);
      for (const agent of agents) {
        this.tracker.removeAgent(agent.id);
      }
      watcher.dispose();
      this.watchers.delete(project.hash);
    }
  }

  /** Stop all watchers and clean up. */
  dispose(): void {
    this.disposed = true;
    for (const watcher of this.watchers.values()) {
      watcher.dispose();
    }
    this.watchers.clear();
  }
}
