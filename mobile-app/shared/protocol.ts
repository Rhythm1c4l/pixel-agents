/**
 * Shared WebSocket protocol types for server↔client communication.
 * Mirrors the existing postMessage types used in extension↔webview IPC,
 * with `projectHash` added to agent-related messages for multi-project support.
 */

// ── Server → Client messages ──

export interface AgentCreatedMessage {
  type: 'agentCreated';
  id: number;
  folderName?: string;
  projectHash: string;
}

export interface AgentClosedMessage {
  type: 'agentClosed';
  id: number;
  projectHash: string;
}

export interface ExistingAgentsMessage {
  type: 'existingAgents';
  agents: number[];
  agentMeta: Record<number, { palette?: number; hueShift?: number; seatId?: string }>;
  folderNames: Record<number, string>;
  projectHash: string;
}

export interface AgentSelectedMessage {
  type: 'agentSelected';
  id: number;
  projectHash: string;
}

export interface AgentStatusMessage {
  type: 'agentStatus';
  id: number;
  status: 'active' | 'waiting';
  projectHash: string;
}

export interface AgentToolStartMessage {
  type: 'agentToolStart';
  id: number;
  toolId: string;
  status: string;
  projectHash: string;
}

export interface AgentToolDoneMessage {
  type: 'agentToolDone';
  id: number;
  toolId: string;
  projectHash: string;
}

export interface AgentToolsClearMessage {
  type: 'agentToolsClear';
  id: number;
  projectHash: string;
}

export interface AgentToolPermissionMessage {
  type: 'agentToolPermission';
  id: number;
  projectHash: string;
}

export interface AgentToolPermissionClearMessage {
  type: 'agentToolPermissionClear';
  id: number;
  projectHash: string;
}

export interface SubagentToolStartMessage {
  type: 'subagentToolStart';
  id: number;
  parentToolId: string;
  toolId: string;
  status: string;
  projectHash: string;
}

export interface SubagentToolDoneMessage {
  type: 'subagentToolDone';
  id: number;
  parentToolId: string;
  toolId: string;
  projectHash: string;
}

export interface SubagentClearMessage {
  type: 'subagentClear';
  id: number;
  parentToolId: string;
  projectHash: string;
}

export interface SubagentToolPermissionMessage {
  type: 'subagentToolPermission';
  id: number;
  parentToolId: string;
  projectHash: string;
}

export interface LayoutLoadedMessage {
  type: 'layoutLoaded';
  layout: Record<string, unknown>;
  wasReset?: boolean;
}

export interface SettingsLoadedMessage {
  type: 'settingsLoaded';
  soundEnabled: boolean;
}

export interface FurnitureAssetsLoadedMessage {
  type: 'furnitureAssetsLoaded';
  catalog: Array<{
    id: string;
    name: string;
    label: string;
    category: string;
    file: string;
    width: number;
    height: number;
    footprintW: number;
    footprintH: number;
    isDesk: boolean;
    canPlaceOnWalls: boolean;
    groupId?: string;
    canPlaceOnSurfaces?: boolean;
    backgroundTiles?: number;
    orientation?: string;
    state?: string;
    mirrorSide?: boolean;
    rotationScheme?: string;
    animationGroup?: string;
    frame?: number;
  }>;
  sprites: Record<string, string[][]>;
}

export interface CharacterSpritesLoadedMessage {
  type: 'characterSpritesLoaded';
  characters: Array<{
    down: string[][][];
    up: string[][][];
    right: string[][][];
  }>;
}

export interface FloorTilesLoadedMessage {
  type: 'floorTilesLoaded';
  sprites: string[][][];
}

export interface WallTilesLoadedMessage {
  type: 'wallTilesLoaded';
  sets: string[][][][];
}

export interface WorkspaceFoldersMessage {
  type: 'workspaceFolders';
  folders: Array<{ name: string; path: string }>;
}

/** Full state snapshot sent on initial connection / reconnect */
export interface FullStateMessage {
  type: 'fullState';
  projectHash: string;
  agents: number[];
  agentMeta: Record<number, { palette?: number; hueShift?: number; seatId?: string }>;
  folderNames: Record<number, string>;
  agentStatuses: Record<number, 'active' | 'waiting'>;
  agentTools: Record<number, Array<{ toolId: string; status: string; done: boolean; permissionWait?: boolean }>>;
  layout: Record<string, unknown>;
}

/** List of available projects the mobile client can choose from */
export interface ProjectListMessage {
  type: 'projectList';
  projects: Array<{
    hash: string;
    name: string;
    agentCount: number;
  }>;
}

export type ServerToClientMessage =
  | AgentCreatedMessage
  | AgentClosedMessage
  | ExistingAgentsMessage
  | AgentSelectedMessage
  | AgentStatusMessage
  | AgentToolStartMessage
  | AgentToolDoneMessage
  | AgentToolsClearMessage
  | AgentToolPermissionMessage
  | AgentToolPermissionClearMessage
  | SubagentToolStartMessage
  | SubagentToolDoneMessage
  | SubagentClearMessage
  | SubagentToolPermissionMessage
  | LayoutLoadedMessage
  | SettingsLoadedMessage
  | FurnitureAssetsLoadedMessage
  | CharacterSpritesLoadedMessage
  | FloorTilesLoadedMessage
  | WallTilesLoadedMessage
  | WorkspaceFoldersMessage
  | FullStateMessage
  | ProjectListMessage;

// ── Client → Server messages ──

export interface SelectProjectMessage {
  type: 'selectProject';
  projectHash: string;
}

export interface WebviewReadyMessage {
  type: 'webviewReady';
}

export interface SaveLayoutMessage {
  type: 'saveLayout';
  layout: Record<string, unknown>;
}

export interface SaveAgentSeatsMessage {
  type: 'saveAgentSeats';
  seats: Record<number, { palette: number; hueShift: number; seatId: string | null }>;
}

export interface ExportLayoutMessage {
  type: 'exportLayout';
}

export interface ImportLayoutMessage {
  type: 'importLayout';
  layout: Record<string, unknown>;
}

export interface OpenClaudeMessage {
  type: 'openClaude';
  /** Agent ID — optional; if present, focus that agent's terminal */
  id?: number;
  folderName?: string;
}

export interface FocusAgentMessage {
  type: 'focusAgent';
  id: number;
}

export interface SetSoundEnabledMessage {
  type: 'setSoundEnabled';
  enabled: boolean;
}

export type ClientToServerMessage =
  | SelectProjectMessage
  | WebviewReadyMessage
  | SaveLayoutMessage
  | SaveAgentSeatsMessage
  | ExportLayoutMessage
  | ImportLayoutMessage
  | OpenClaudeMessage
  | FocusAgentMessage
  | SetSoundEnabledMessage;
