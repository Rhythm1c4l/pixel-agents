/**
 * Shared JSONL file watcher — no VS Code dependency.
 * Hybrid fs.watch + stat-based polling + partial line buffering.
 */

import * as fs from 'fs';

export interface JsonlWatcherOptions {
  /** Polling interval in ms (default: 1000) */
  pollIntervalMs?: number;
}

export type LineCallback = (line: string) => void;
export type DataCallback = () => void;

/**
 * Watches a JSONL file for new lines appended to the end.
 * Uses hybrid fs.watch + fs.watchFile + manual polling for reliability.
 * Handles partial line buffering for mid-write reads.
 */
export class JsonlWatcher {
  private filePath: string;
  private fileOffset = 0;
  private lineBuffer = '';
  private disposed = false;

  private fsWatcher: fs.FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollIntervalMs: number;

  private onLine: LineCallback;
  private onNewData: DataCallback | null;
  private watchFileListener: (() => void) | null = null;

  constructor(
    filePath: string,
    onLine: LineCallback,
    onNewData?: DataCallback,
    options?: JsonlWatcherOptions,
  ) {
    this.filePath = filePath;
    this.onLine = onLine;
    this.onNewData = onNewData ?? null;
    this.pollIntervalMs = options?.pollIntervalMs ?? 1000;
  }

  /** Start watching. Optionally start from a given byte offset. */
  start(fromOffset = 0): void {
    this.fileOffset = fromOffset;

    // Primary: fs.watch (event-based, may miss events on some platforms)
    try {
      this.fsWatcher = fs.watch(this.filePath, () => {
        this.readNewLines();
      });
    } catch (e) {
      console.log(`[JsonlWatcher] fs.watch failed for ${this.filePath}: ${e}`);
    }

    // Secondary: fs.watchFile (stat-based polling, reliable on macOS)
    try {
      this.watchFileListener = () => { this.readNewLines(); };
      fs.watchFile(this.filePath, { interval: this.pollIntervalMs }, this.watchFileListener);
    } catch (e) {
      console.log(`[JsonlWatcher] fs.watchFile failed for ${this.filePath}: ${e}`);
    }

    // Tertiary: manual poll as last resort
    this.pollTimer = setInterval(() => {
      if (this.disposed) return;
      this.readNewLines();
    }, this.pollIntervalMs);
  }

  /** Read new lines appended since last read. Returns true if new data was found. */
  readNewLines(): boolean {
    if (this.disposed) return false;
    try {
      const stat = fs.statSync(this.filePath);
      if (stat.size <= this.fileOffset) return false;

      const buf = Buffer.alloc(stat.size - this.fileOffset);
      const fd = fs.openSync(this.filePath, 'r');
      fs.readSync(fd, buf, 0, buf.length, this.fileOffset);
      fs.closeSync(fd);
      this.fileOffset = stat.size;

      const text = this.lineBuffer + buf.toString('utf-8');
      const lines = text.split('\n');
      this.lineBuffer = lines.pop() || '';

      const hasLines = lines.some((l) => l.trim());
      if (hasLines) {
        this.onNewData?.();
      }

      for (const line of lines) {
        if (!line.trim()) continue;
        this.onLine(line);
      }

      return hasLines;
    } catch (e) {
      console.log(`[JsonlWatcher] Read error for ${this.filePath}: ${e}`);
      return false;
    }
  }

  /** Current byte offset in the file */
  get offset(): number {
    return this.fileOffset;
  }

  /** Stop watching and clean up all resources */
  dispose(): void {
    this.disposed = true;
    this.fsWatcher?.close();
    this.fsWatcher = null;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    try {
      if (this.watchFileListener) {
        fs.unwatchFile(this.filePath, this.watchFileListener);
        this.watchFileListener = null;
      }
    } catch {
      /* ignore */
    }
  }
}
