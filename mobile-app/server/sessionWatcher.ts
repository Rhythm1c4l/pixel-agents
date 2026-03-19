/**
 * Per-project session watcher — watches a single project directory for .jsonl files.
 * Detects new sessions, /clear (new JSONL file for same terminal), and session activity.
 * Uses the shared JsonlWatcher class for file watching.
 * No VS Code dependency.
 */

import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';

import { JsonlWatcher } from '../shared/fileWatcher.js';
import type { SessionInfo } from './types.js';

const SCAN_INTERVAL_MS = 1000;

export interface SessionWatcherEvents {
  'session:discovered': (session: SessionInfo) => void;
  'session:line': (session: SessionInfo, line: string) => void;
  'session:newData': (session: SessionInfo) => void;
}

/**
 * Watches a project directory for .jsonl session files.
 * Creates a JsonlWatcher for each discovered session.
 */
export class SessionWatcher extends EventEmitter {
  private projectDir: string;
  private projectHash: string;
  private knownSessions = new Map<string, { info: SessionInfo; watcher: JsonlWatcher }>();
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(projectDir: string, projectHash: string) {
    super();
    this.projectDir = projectDir;
    this.projectHash = projectHash;
  }

  /** Start scanning and watching for sessions. */
  start(): void {
    this.scan();
    this.scanTimer = setInterval(() => {
      if (!this.disposed) this.scan();
    }, SCAN_INTERVAL_MS);
  }

  /** Get all known sessions. */
  getSessions(): SessionInfo[] {
    return Array.from(this.knownSessions.values()).map((s) => s.info);
  }

  private scan(): void {
    let files: string[];
    try {
      files = fs.readdirSync(this.projectDir)
        .filter((f) => f.endsWith('.jsonl'));
    } catch {
      return;
    }

    for (const file of files) {
      const filePath = path.join(this.projectDir, file);
      const sessionId = file.replace(/\.jsonl$/, '');

      if (!this.knownSessions.has(filePath)) {
        const info: SessionInfo = {
          sessionId,
          filePath,
          projectHash: this.projectHash,
        };

        const watcher = new JsonlWatcher(
          filePath,
          // onLine
          (line: string) => {
            this.emit('session:line', info, line);
          },
          // onNewData
          () => {
            this.emit('session:newData', info);
          },
          { pollIntervalMs: SCAN_INTERVAL_MS },
        );

        this.knownSessions.set(filePath, { info, watcher });
        this.emit('session:discovered', info);

        // Start watching from the end of the file (don't replay history)
        try {
          const stat = fs.statSync(filePath);
          watcher.start(stat.size);
        } catch {
          watcher.start(0);
        }
      }
    }
  }

  /** Stop all watchers and clean up. */
  dispose(): void {
    this.disposed = true;
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    for (const { watcher } of this.knownSessions.values()) {
      watcher.dispose();
    }
    this.knownSessions.clear();
  }
}
