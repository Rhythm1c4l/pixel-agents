/**
 * Unit tests for server/sessionScanner.ts
 *
 * Tests project discovery with a mock directory structure.
 * Uses real filesystem via temp directories — no mocking of fs needed
 * since SessionScanner reads real directories.
 *
 * Run with: npm run test:server
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { SessionScanner } from '../sessionScanner.ts';
import type { ProjectInfo } from '../types.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-test-'));
}

function makeProjectDir(rootDir: string, hash: string): string {
  const dir = path.join(rootDir, hash);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore cleanup errors */
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SessionScanner: hashToName', () => {
  // We test the name derivation indirectly by checking discovered project names

  it('derives name from last segment of hash', async () => {
    const tmpDir = makeTempDir();
    try {
      makeProjectDir(tmpDir, 'C--Users-foo-projects-myapp');

      const scanner = new (class extends SessionScanner {
        constructor() {
          super();
          // Override projectsDir to our temp dir
          (this as unknown as { projectsDir: string }).projectsDir = tmpDir;
        }
      })();

      const discovered: ProjectInfo[] = [];
      scanner.on('project:discovered', (p: ProjectInfo) => discovered.push(p));
      scanner.start();

      // Give scan one tick to complete
      await new Promise((resolve) => setTimeout(resolve, 50));
      scanner.dispose();

      assert.equal(discovered.length, 1);
      assert.equal(discovered[0].name, 'myapp');
    } finally {
      cleanup(tmpDir);
    }
  });

  it('falls back to full hash when no segments', async () => {
    const tmpDir = makeTempDir();
    try {
      makeProjectDir(tmpDir, 'singlehash');

      const scanner = new (class extends SessionScanner {
        constructor() {
          super();
          (this as unknown as { projectsDir: string }).projectsDir = tmpDir;
        }
      })();

      const discovered: ProjectInfo[] = [];
      scanner.on('project:discovered', (p: ProjectInfo) => discovered.push(p));
      scanner.start();

      await new Promise((resolve) => setTimeout(resolve, 50));
      scanner.dispose();

      assert.equal(discovered.length, 1);
      // hash is "singlehash" — no dashes, last segment is "singlehash" itself
      assert.equal(discovered[0].name, 'singlehash');
    } finally {
      cleanup(tmpDir);
    }
  });
});

describe('SessionScanner: project discovery', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  it('discovers existing project directories on start', async () => {
    makeProjectDir(tmpDir, 'C--Users-foo-myproject');

    const scanner = new (class extends SessionScanner {
      constructor() {
        super();
        (this as unknown as { projectsDir: string }).projectsDir = tmpDir;
      }
    })();

    const discovered: ProjectInfo[] = [];
    scanner.on('project:discovered', (p: ProjectInfo) => discovered.push(p));
    scanner.start();

    await new Promise((resolve) => setTimeout(resolve, 50));
    scanner.dispose();

    assert.equal(discovered.length, 1);
    assert.equal(discovered[0].hash, 'C--Users-foo-myproject');
  });

  it('discovers multiple project directories', async () => {
    makeProjectDir(tmpDir, 'project-alpha');
    makeProjectDir(tmpDir, 'project-beta');
    makeProjectDir(tmpDir, 'project-gamma');

    const scanner = new (class extends SessionScanner {
      constructor() {
        super();
        (this as unknown as { projectsDir: string }).projectsDir = tmpDir;
      }
    })();

    const discovered: ProjectInfo[] = [];
    scanner.on('project:discovered', (p: ProjectInfo) => discovered.push(p));
    scanner.start();

    await new Promise((resolve) => setTimeout(resolve, 50));
    scanner.dispose();

    assert.equal(discovered.length, 3);
    const hashes = discovered.map((p) => p.hash).sort();
    assert.deepEqual(hashes, ['project-alpha', 'project-beta', 'project-gamma'].sort());
  });

  it('ignores non-directory files', async () => {
    makeProjectDir(tmpDir, 'real-project');
    fs.writeFileSync(path.join(tmpDir, 'notadirectory.txt'), 'content');

    const scanner = new (class extends SessionScanner {
      constructor() {
        super();
        (this as unknown as { projectsDir: string }).projectsDir = tmpDir;
      }
    })();

    const discovered: ProjectInfo[] = [];
    scanner.on('project:discovered', (p: ProjectInfo) => discovered.push(p));
    scanner.start();

    await new Promise((resolve) => setTimeout(resolve, 50));
    scanner.dispose();

    assert.equal(discovered.length, 1);
    assert.equal(discovered[0].hash, 'real-project');
  });

  it('does not emit duplicate discoveries for the same project', async () => {
    makeProjectDir(tmpDir, 'stable-project');

    const scanner = new (class extends SessionScanner {
      constructor() {
        super();
        (this as unknown as { projectsDir: string }).projectsDir = tmpDir;
      }
    })();

    const discovered: ProjectInfo[] = [];
    scanner.on('project:discovered', (p: ProjectInfo) => discovered.push(p));
    scanner.start();

    // Let multiple scan cycles run
    await new Promise((resolve) => setTimeout(resolve, 3000));
    scanner.dispose();

    // Should only be discovered once even if scanner runs multiple times
    const stableProj = discovered.filter((p) => p.hash === 'stable-project');
    assert.equal(stableProj.length, 1);
  });

  it('returns empty array when projects dir does not exist', async () => {
    const nonExistentDir = path.join(tmpDir, 'nonexistent-projects');

    const scanner = new (class extends SessionScanner {
      constructor() {
        super();
        (this as unknown as { projectsDir: string }).projectsDir = nonExistentDir;
      }
    })();

    const discovered: ProjectInfo[] = [];
    scanner.on('project:discovered', (p: ProjectInfo) => discovered.push(p));
    scanner.start();

    await new Promise((resolve) => setTimeout(resolve, 50));
    scanner.dispose();

    assert.equal(discovered.length, 0);
  });

  it('getProjects() returns currently known projects', async () => {
    makeProjectDir(tmpDir, 'proj-one');
    makeProjectDir(tmpDir, 'proj-two');

    const scanner = new (class extends SessionScanner {
      constructor() {
        super();
        (this as unknown as { projectsDir: string }).projectsDir = tmpDir;
      }
    })();

    scanner.start();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const projects = scanner.getProjects();
    scanner.dispose();

    assert.equal(projects.length, 2);
    const hashes = projects.map((p) => p.hash).sort();
    assert.deepEqual(hashes, ['proj-one', 'proj-two'].sort());
  });

  it('getProject() returns project by hash', async () => {
    makeProjectDir(tmpDir, 'findme-project');

    const scanner = new (class extends SessionScanner {
      constructor() {
        super();
        (this as unknown as { projectsDir: string }).projectsDir = tmpDir;
      }
    })();

    scanner.start();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const project = scanner.getProject('findme-project');
    scanner.dispose();

    assert.ok(project);
    assert.equal(project.hash, 'findme-project');
    assert.ok(project.dir.includes('findme-project'));
  });

  it('getProject() returns undefined for unknown hash', async () => {
    const scanner = new (class extends SessionScanner {
      constructor() {
        super();
        (this as unknown as { projectsDir: string }).projectsDir = tmpDir;
      }
    })();

    scanner.start();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const result = scanner.getProject('no-such-project');
    scanner.dispose();

    assert.equal(result, undefined);
  });

  it('discovered project has correct dir path', async () => {
    const projHash = 'path-test-project';
    const projDir = makeProjectDir(tmpDir, projHash);

    const scanner = new (class extends SessionScanner {
      constructor() {
        super();
        (this as unknown as { projectsDir: string }).projectsDir = tmpDir;
      }
    })();

    const discovered: ProjectInfo[] = [];
    scanner.on('project:discovered', (p: ProjectInfo) => discovered.push(p));
    scanner.start();

    await new Promise((resolve) => setTimeout(resolve, 50));
    scanner.dispose();

    assert.equal(discovered.length, 1);
    assert.equal(discovered[0].dir, projDir);
  });
});

describe('SessionScanner: project removal', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  it('emits project:removed when a directory is deleted', async () => {
    const projDir = makeProjectDir(tmpDir, 'temp-project');

    const scanner = new (class extends SessionScanner {
      constructor() {
        super();
        (this as unknown as { projectsDir: string }).projectsDir = tmpDir;
      }
    })();

    const discovered: string[] = [];
    const removed: string[] = [];
    scanner.on('project:discovered', (p: ProjectInfo) => discovered.push(p.hash));
    scanner.on('project:removed', (p: ProjectInfo) => removed.push(p.hash));
    scanner.start();

    // Wait for initial discovery
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(discovered.includes('temp-project'), 'Should have discovered temp-project');

    // Delete the directory
    cleanup(projDir);

    // Wait for removal to be detected (scan interval is 2000ms)
    await new Promise((resolve) => setTimeout(resolve, 2500));
    scanner.dispose();

    assert.ok(removed.includes('temp-project'), 'Should have emitted project:removed');
  });
});

describe('SessionScanner: dispose', () => {
  it('stops scanning after dispose', async () => {
    const tmpDir = makeTempDir();
    try {
      const scanner = new (class extends SessionScanner {
        constructor() {
          super();
          (this as unknown as { projectsDir: string }).projectsDir = tmpDir;
        }
      })();

      scanner.start();
      scanner.dispose();

      // Create a project after dispose — should NOT be discovered
      makeProjectDir(tmpDir, 'post-dispose-project');

      const discovered: ProjectInfo[] = [];
      scanner.on('project:discovered', (p: ProjectInfo) => discovered.push(p));

      // Wait enough time for a scan interval to pass
      await new Promise((resolve) => setTimeout(resolve, 2500));

      assert.equal(discovered.length, 0);
    } finally {
      cleanup(tmpDir);
    }
  });
});
