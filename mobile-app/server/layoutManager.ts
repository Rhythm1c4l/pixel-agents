/**
 * Server-side layout manager — reads/writes ~/.pixel-agents/layout.json.
 * Uses atomic .tmp + rename pattern. Watches for external changes.
 * No VS Code dependency.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const LAYOUT_DIR = '.pixel-agents';
const LAYOUT_FILE = 'layout.json';
const POLL_INTERVAL_MS = 2000;

function getLayoutFilePath(): string {
  return path.join(os.homedir(), LAYOUT_DIR, LAYOUT_FILE);
}

export function readLayout(): Record<string, unknown> | null {
  const filePath = getLayoutFilePath();
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    console.error('[LayoutManager] Failed to read layout file:', err);
    return null;
  }
}

export function writeLayout(layout: Record<string, unknown>): void {
  const filePath = getLayoutFilePath();
  const dir = path.dirname(filePath);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const json = JSON.stringify(layout, null, 2);
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, json, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    console.error('[LayoutManager] Failed to write layout file:', err);
  }
}

export interface LayoutWatcher {
  /** Call before writing to prevent the watcher from treating our own write as external */
  markOwnWrite(): void;
  dispose(): void;
}

/**
 * Watch ~/.pixel-agents/layout.json for external changes.
 * Uses hybrid fs.watch + polling (same pattern as the VS Code extension).
 */
export function watchLayout(
  onExternalChange: (layout: Record<string, unknown>) => void,
): LayoutWatcher {
  const filePath = getLayoutFilePath();
  let skipNextChange = false;
  let lastMtime = 0;
  let fsWatcher: fs.FSWatcher | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  // Initialize lastMtime
  try {
    if (fs.existsSync(filePath)) {
      lastMtime = fs.statSync(filePath).mtimeMs;
    }
  } catch {
    /* ignore */
  }

  function checkForChange(): void {
    if (disposed) return;
    try {
      if (!fs.existsSync(filePath)) return;
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs <= lastMtime) return;
      lastMtime = stat.mtimeMs;

      if (skipNextChange) {
        skipNextChange = false;
        return;
      }

      const raw = fs.readFileSync(filePath, 'utf-8');
      const layout = JSON.parse(raw) as Record<string, unknown>;
      console.log('[LayoutManager] External layout change detected');
      onExternalChange(layout);
    } catch (err) {
      console.error('[LayoutManager] Error checking layout file:', err);
    }
  }

  function startFsWatch(): void {
    if (disposed || fsWatcher) return;
    try {
      if (!fs.existsSync(filePath)) return;
      fsWatcher = fs.watch(filePath, () => {
        checkForChange();
      });
      fsWatcher.on('error', () => {
        fsWatcher?.close();
        fsWatcher = null;
      });
    } catch {
      // File may not exist yet — polling will retry
    }
  }

  startFsWatch();

  pollTimer = setInterval(() => {
    if (disposed) return;
    if (!fsWatcher) {
      startFsWatch();
    }
    checkForChange();
  }, POLL_INTERVAL_MS);

  return {
    markOwnWrite(): void {
      skipNextChange = true;
      try {
        if (fs.existsSync(filePath)) {
          lastMtime = fs.statSync(filePath).mtimeMs;
        }
      } catch {
        /* ignore */
      }
    },
    dispose(): void {
      disposed = true;
      fsWatcher?.close();
      fsWatcher = null;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    },
  };
}
