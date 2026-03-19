/**
 * Global session scanner — enumerates all project directories under ~/.claude/projects/
 * and watches for new ones appearing. Manages per-project SessionWatcher instances.
 * No VS Code dependency.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';

import type { ProjectInfo } from './types.js';

const SCAN_INTERVAL_MS = 2000;

export interface SessionScannerEvents {
  'project:discovered': (project: ProjectInfo) => void;
  'project:removed': (project: ProjectInfo) => void;
}

/**
 * Scans ~/.claude/projects/ for project directories.
 * Emits events when projects appear or disappear.
 */
export class SessionScanner extends EventEmitter {
  private projectsDir: string;
  private knownProjects = new Map<string, ProjectInfo>();
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor() {
    super();
    this.projectsDir = path.join(os.homedir(), '.claude', 'projects');
  }

  /** Start scanning for projects. */
  start(): void {
    this.scan();
    this.scanTimer = setInterval(() => {
      if (!this.disposed) this.scan();
    }, SCAN_INTERVAL_MS);
  }

  /** Get all currently known projects. */
  getProjects(): ProjectInfo[] {
    return Array.from(this.knownProjects.values());
  }

  /** Get a specific project by hash. */
  getProject(hash: string): ProjectInfo | undefined {
    return this.knownProjects.get(hash);
  }

  /** Derive a human-readable name from the project hash. */
  private hashToName(hash: string): string {
    // Hash is like "C--Users-foo-projects-myapp" — take the last segment
    const parts = hash.split('-').filter(Boolean);
    return parts[parts.length - 1] || hash;
  }

  private scan(): void {
    let entries: string[];
    try {
      if (!fs.existsSync(this.projectsDir)) return;
      entries = fs.readdirSync(this.projectsDir);
    } catch {
      return;
    }

    const currentHashes = new Set<string>();

    for (const entry of entries) {
      const fullPath = path.join(this.projectsDir, entry);
      try {
        const stat = fs.statSync(fullPath);
        if (!stat.isDirectory()) continue;
      } catch {
        continue;
      }

      currentHashes.add(entry);

      if (!this.knownProjects.has(entry)) {
        const project: ProjectInfo = {
          hash: entry,
          dir: fullPath,
          name: this.hashToName(entry),
        };
        this.knownProjects.set(entry, project);
        this.emit('project:discovered', project);
      }
    }

    // Check for removed projects
    for (const [hash, project] of this.knownProjects) {
      if (!currentHashes.has(hash)) {
        this.knownProjects.delete(hash);
        this.emit('project:removed', project);
      }
    }
  }

  /** Stop scanning and clean up. */
  dispose(): void {
    this.disposed = true;
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
  }
}
