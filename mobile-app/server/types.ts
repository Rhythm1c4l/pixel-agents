/**
 * Server-side type definitions.
 */

export interface ProjectInfo {
  /** The hashed directory name (e.g. "C--Users-foo-myproject") */
  hash: string;
  /** Full path to the project's JSONL directory (~/.claude/projects/<hash>/) */
  dir: string;
  /** Human-readable project name (derived from hash) */
  name: string;
}

export interface SessionInfo {
  /** Session UUID (filename without .jsonl extension) */
  sessionId: string;
  /** Full path to the .jsonl file */
  filePath: string;
  /** The project this session belongs to */
  projectHash: string;
}
