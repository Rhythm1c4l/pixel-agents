/**
 * Project mapper — maintains ~/.pixel-agents/project-map.json mapping
 * project hashes to human-readable names. Scans .git/config for repo names.
 * No VS Code dependency.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const MAP_DIR = '.pixel-agents';
const MAP_FILE = 'project-map.json';

type ProjectMap = Record<string, string>;

function getMapPath(): string {
  return path.join(os.homedir(), MAP_DIR, MAP_FILE);
}

function readMap(): ProjectMap {
  try {
    const filePath = getMapPath();
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as ProjectMap;
  } catch {
    return {};
  }
}

let writeTimeout: ReturnType<typeof setTimeout> | null = null;
let pendingMap: ProjectMap | null = null;

function scheduleWriteMap(map: ProjectMap): void {
  pendingMap = { ...map };
  if (writeTimeout) return;
  writeTimeout = setTimeout(() => {
    writeTimeout = null;
    if (!pendingMap) return;
    const toWrite = pendingMap;
    pendingMap = null;
    try {
      const filePath = getMapPath();
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const json = JSON.stringify(toWrite, null, 2);
      const tmpPath = filePath + '.tmp';
      fs.writeFileSync(tmpPath, json, 'utf-8');
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      console.error('[ProjectMapper] Failed to write map:', err);
    }
  }, 500);
}

/**
 * Try to extract a repo name from a workspace path by reading .git/config.
 */
function extractRepoName(workspacePath: string): string | null {
  try {
    const gitConfigPath = path.join(workspacePath, '.git', 'config');
    if (!fs.existsSync(gitConfigPath)) return null;
    const content = fs.readFileSync(gitConfigPath, 'utf-8');
    // Look for [remote "origin"] url = ...
    const urlMatch = content.match(/\[remote\s+"origin"\][^[]*url\s*=\s*(.+)/m);
    if (!urlMatch) return null;
    const url = urlMatch[1].trim();
    // Extract repo name from URL (handles both SSH and HTTPS)
    const repoMatch = url.match(/\/([^/]+?)(?:\.git)?$/);
    return repoMatch ? repoMatch[1] : null;
  } catch {
    return null;
  }
}

/**
 * Derive a human-readable name from a project hash.
 * Hash format: path segments joined by '-' (e.g. "C--Users-foo-projects-myapp")
 */
function hashToFallbackName(hash: string): string {
  const parts = hash.split('-').filter(Boolean);
  return parts[parts.length - 1] || hash;
}

/**
 * Try to reconstruct the original workspace path from a project hash.
 * The hash replaces :, \, / with - . We try common patterns.
 */
function hashToPath(hash: string): string | null {
  // On Windows: "C--Users-foo-bar" → "C:\Users\foo\bar"
  // On Unix: "-home-foo-bar" → "/home/foo/bar"
  const isWindows = process.platform === 'win32';

  if (isWindows) {
    // Try to match "X--rest" pattern (drive letter)
    const driveMatch = hash.match(/^([A-Za-z])--(.*)/);
    if (driveMatch) {
      const drive = driveMatch[1].toUpperCase();
      const rest = driveMatch[2].replace(/-/g, '\\');
      return `${drive}:\\${rest}`;
    }
  }

  // Unix: leading dash = /
  if (hash.startsWith('-')) {
    return '/' + hash.slice(1).replace(/-/g, '/');
  }

  return null;
}

// ── Public API ────────────────────────────────────────────────

const mapCache: { map: ProjectMap; loaded: boolean } = { map: {}, loaded: false };

function ensureLoaded(): ProjectMap {
  if (!mapCache.loaded) {
    mapCache.map = readMap();
    mapCache.loaded = true;
  }
  return mapCache.map;
}

/**
 * Get a human-readable name for a project hash.
 * Returns cached name, or derives one from .git/config or hash segments.
 */
export function getProjectName(hash: string): string {
  const map = ensureLoaded();

  if (map[hash]) return map[hash];

  // Try to discover the name
  let name: string | null = null;

  const workspacePath = hashToPath(hash);
  if (workspacePath) {
    name = extractRepoName(workspacePath);
  }

  if (!name) {
    name = hashToFallbackName(hash);
  }

  // Cache for future lookups
  map[hash] = name;
  scheduleWriteMap(map);

  return name;
}

/**
 * Manually set a project name.
 */
export function setProjectName(hash: string, name: string): void {
  const map = ensureLoaded();
  map[hash] = name;
  scheduleWriteMap(map);
}

/**
 * Get all known project mappings.
 */
export function getAllProjectNames(): Record<string, string> {
  return { ...ensureLoaded() };
}
