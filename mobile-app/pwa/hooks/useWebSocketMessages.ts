import { useCallback, useEffect, useRef, useState } from 'react';

import type { FullStateMessage } from '../../shared/protocol.js';
import { playDoneSound, setSoundEnabled } from '../../../webview-ui/src/notificationSound.js';
import type { OfficeState } from '../../../webview-ui/src/office/engine/officeState.js';
import { setFloorSprites } from '../../../webview-ui/src/office/floorTiles.js';
import { buildDynamicCatalog } from '../../../webview-ui/src/office/layout/furnitureCatalog.js';
import { migrateLayoutColors } from '../../../webview-ui/src/office/layout/layoutSerializer.js';
import { setCharacterTemplates } from '../../../webview-ui/src/office/sprites/spriteData.js';
import { extractToolName } from '../../../webview-ui/src/office/toolUtils.js';
import type { OfficeLayout, ToolActivity } from '../../../webview-ui/src/office/types.js';
import { setWallSprites } from '../../../webview-ui/src/office/wallTiles.js';
import type { Transport } from '../transport.js';
import type {
  FurnitureAsset,
  SubagentCharacter,
  WorkspaceFolder,
} from '../../../webview-ui/src/hooks/useExtensionMessages.js';
import type { ProjectInfo } from '../components/ProjectPicker.js';

export interface WsMessageState {
  agents: number[];
  selectedAgent: number | null;
  agentTools: Record<number, ToolActivity[]>;
  agentStatuses: Record<number, string>;
  subagentTools: Record<number, Record<string, ToolActivity[]>>;
  subagentCharacters: SubagentCharacter[];
  layoutReady: boolean;
  layoutWasReset: boolean;
  loadedAssets?: { catalog: FurnitureAsset[]; sprites: Record<string, string[][]> };
  workspaceFolders: WorkspaceFolder[];
  /** The currently selected project hash */
  selectedProjectHash: string | null;
  /** All discovered projects from the server's global scanner */
  projects: ProjectInfo[];
}

function saveAgentSeats(os: OfficeState, transport: Transport): void {
  const seats: Record<number, { palette: number; hueShift: number; seatId: string | null }> = {};
  for (const ch of os.characters.values()) {
    if (ch.isSubagent) continue;
    seats[ch.id] = { palette: ch.palette, hueShift: ch.hueShift, seatId: ch.seatId };
  }
  transport.send({ type: 'saveAgentSeats', seats });
}

/**
 * Fetch pre-decoded assets from the server HTTP API.
 * Returns null if any fetch fails (graceful — caller should handle).
 */
async function fetchAssets(baseUrl: string): Promise<{
  characters: Array<{ down: string[][][]; up: string[][][]; right: string[][][] }>;
  floors: string[][][];
  walls: string[][][][];
  catalog: FurnitureAsset[];
  sprites: Record<string, string[][]>;
} | null> {
  try {
    const [charsRes, floorsRes, wallsRes, furnitureRes] = await Promise.all([
      fetch(`${baseUrl}/assets/characters`),
      fetch(`${baseUrl}/assets/floors`),
      fetch(`${baseUrl}/assets/walls`),
      fetch(`${baseUrl}/assets/furniture`),
    ]);
    const [characters, floors, walls, furnitureData] = await Promise.all([
      charsRes.json(),
      floorsRes.json(),
      wallsRes.json(),
      furnitureRes.json(),
    ]);
    return {
      characters: characters as Array<{ down: string[][][]; up: string[][][]; right: string[][][] }>,
      floors: floors as string[][][],
      walls: walls as string[][][][],
      catalog: furnitureData.catalog as FurnitureAsset[],
      sprites: furnitureData.sprites as Record<string, string[][]>,
    };
  } catch (err) {
    console.error('[useWebSocketMessages] Failed to fetch assets:', err);
    return null;
  }
}

/**
 * Derive the HTTP base URL from a WebSocket URL.
 * ws://192.168.1.5:3000/ws → http://192.168.1.5:3000
 */
function wsUrlToHttpBase(wsUrl: string): string {
  return wsUrl.replace(/^wss?:\/\//, (p) => (p === 'wss://' ? 'https://' : 'http://')).replace(
    /\/ws$/,
    '',
  );
}

/**
 * WebSocket message hook — replaces useExtensionMessages for PWA mode.
 *
 * Receives messages via the transport (dispatched to window as MessageEvents
 * by transport.ts), handles fullState for initial hydration, and fetches
 * assets via HTTP from the server.
 */
export function useWebSocketMessages(
  transport: Transport,
  wsUrl: string,
  getOfficeState: () => OfficeState,
  onLayoutLoaded?: (layout: OfficeLayout) => void,
  isEditDirty?: () => boolean,
): WsMessageState {
  const [agents, setAgents] = useState<number[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<number | null>(null);
  const [agentTools, setAgentTools] = useState<Record<number, ToolActivity[]>>({});
  const [agentStatuses, setAgentStatuses] = useState<Record<number, string>>({});
  const [subagentTools, setSubagentTools] = useState<
    Record<number, Record<string, ToolActivity[]>>
  >({});
  const [subagentCharacters, setSubagentCharacters] = useState<SubagentCharacter[]>([]);
  const [layoutReady, setLayoutReady] = useState(false);
  const [layoutWasReset, setLayoutWasReset] = useState(false);
  const [loadedAssets, setLoadedAssets] = useState<
    { catalog: FurnitureAsset[]; sprites: Record<string, string[][]> } | undefined
  >();
  const [workspaceFolders, setWorkspaceFolders] = useState<WorkspaceFolder[]>([]);
  const [selectedProjectHash, setSelectedProjectHash] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);

  const layoutReadyRef = useRef(false);
  const assetsLoadedRef = useRef(false);

  // Fetch assets on mount (HTTP, not postMessage)
  const httpBase = wsUrlToHttpBase(wsUrl);
  useEffect(() => {
    if (assetsLoadedRef.current) return;
    assetsLoadedRef.current = true;

    fetchAssets(httpBase).then((assets) => {
      if (!assets) return;
      console.log('[PWA] Fetched assets from server');
      setCharacterTemplates(assets.characters);
      setFloorSprites(assets.floors);
      setWallSprites(assets.walls);
      buildDynamicCatalog({ catalog: assets.catalog, sprites: assets.sprites });
      setLoadedAssets({ catalog: assets.catalog, sprites: assets.sprites });
    });
  }, [httpBase]);

  // Handle fullState — used for initial load and reconnect
  const handleFullState = useCallback(
    (msg: FullStateMessage, os: OfficeState) => {
      setSelectedProjectHash(msg.projectHash);

      // Rebuild layout
      if (!layoutReadyRef.current || !isEditDirty?.()) {
        const rawLayout = msg.layout as OfficeLayout | null;
        const layout = rawLayout && rawLayout.version === 1 ? migrateLayoutColors(rawLayout) : null;
        if (layout) {
          os.rebuildFromLayout(layout);
          onLayoutLoaded?.(layout);
        } else {
          onLayoutLoaded?.(os.getLayout());
        }
      }

      // Restore agents
      for (const id of msg.agents) {
        const meta = msg.agentMeta[id];
        const folderName = msg.folderNames[id];
        if (!os.characters.has(id)) {
          os.addAgent(id, meta?.palette, meta?.hueShift, meta?.seatId, true, folderName);
        }
      }

      // Restore tool states
      for (const [idStr, tools] of Object.entries(msg.agentTools)) {
        const id = Number(idStr);
        const activeTools = tools.filter((t) => !t.done);
        if (activeTools.length > 0) {
          const last = activeTools[activeTools.length - 1];
          os.setAgentTool(id, extractToolName(last.status));
          os.setAgentActive(id, true);
          if (last.permissionWait) {
            os.showPermissionBubble(id);
          }
        }
        setAgentTools((prev) => ({ ...prev, [id]: tools }));
      }

      // Restore statuses
      for (const [idStr, status] of Object.entries(msg.agentStatuses)) {
        const id = Number(idStr);
        os.setAgentActive(id, status === 'active');
        if (status === 'waiting') {
          os.showWaitingBubble(id);
        }
      }

      setAgents(msg.agents);
      setAgentStatuses(msg.agentStatuses);
      layoutReadyRef.current = true;
      setLayoutReady(true);
    },
    [isEditDirty, onLayoutLoaded],
  );

  useEffect(() => {
    let pendingAgents: Array<{
      id: number;
      palette?: number;
      hueShift?: number;
      seatId?: string;
      folderName?: string;
    }> = [];

    const handler = (e: MessageEvent) => {
      // Transport dispatches as { data: { data: msg } } to match VS Code webview format
      const msg = (e.data as { data?: unknown })?.data ?? e.data;
      if (!msg || typeof msg !== 'object' || !('type' in msg)) return;

      const os = getOfficeState();
      const typedMsg = msg as { type: string } & Record<string, unknown>;

      if (typedMsg.type === 'fullState') {
        handleFullState(typedMsg as unknown as FullStateMessage, os);
        return;
      }

      if (typedMsg.type === 'layoutLoaded') {
        if (layoutReadyRef.current && isEditDirty?.()) return;
        const rawLayout = typedMsg.layout as OfficeLayout | null;
        const layout = rawLayout && rawLayout.version === 1 ? migrateLayoutColors(rawLayout) : null;
        if (layout) {
          os.rebuildFromLayout(layout);
          onLayoutLoaded?.(layout);
        } else {
          onLayoutLoaded?.(os.getLayout());
        }
        for (const p of pendingAgents) {
          os.addAgent(p.id, p.palette, p.hueShift, p.seatId, true, p.folderName);
        }
        pendingAgents = [];
        layoutReadyRef.current = true;
        setLayoutReady(true);
        if (typedMsg.wasReset) setLayoutWasReset(true);
        if (os.characters.size > 0) saveAgentSeats(os, transport);
      } else if (typedMsg.type === 'agentCreated') {
        const id = typedMsg.id as number;
        const folderName = typedMsg.folderName as string | undefined;
        setAgents((prev) => (prev.includes(id) ? prev : [...prev, id]));
        setSelectedAgent(id);
        os.addAgent(id, undefined, undefined, undefined, undefined, folderName);
        saveAgentSeats(os, transport);
      } else if (typedMsg.type === 'agentClosed') {
        const id = typedMsg.id as number;
        setAgents((prev) => prev.filter((a) => a !== id));
        setSelectedAgent((prev) => (prev === id ? null : prev));
        setAgentTools((prev) => {
          if (!(id in prev)) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
        setAgentStatuses((prev) => {
          if (!(id in prev)) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
        setSubagentTools((prev) => {
          if (!(id in prev)) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
        os.removeAllSubagents(id);
        setSubagentCharacters((prev) => prev.filter((s) => s.parentAgentId !== id));
        os.removeAgent(id);
      } else if (typedMsg.type === 'existingAgents') {
        const incoming = typedMsg.agents as number[];
        const meta = (typedMsg.agentMeta ?? {}) as Record<
          number,
          { palette?: number; hueShift?: number; seatId?: string }
        >;
        const folderNames = (typedMsg.folderNames ?? {}) as Record<number, string>;
        for (const id of incoming) {
          const m = meta[id];
          pendingAgents.push({
            id,
            palette: m?.palette,
            hueShift: m?.hueShift,
            seatId: m?.seatId,
            folderName: folderNames[id],
          });
        }
        setAgents((prev) => {
          const ids = new Set(prev);
          const merged = [...prev];
          for (const id of incoming) {
            if (!ids.has(id)) merged.push(id);
          }
          return merged.sort((a, b) => a - b);
        });
      } else if (typedMsg.type === 'agentToolStart') {
        const id = typedMsg.id as number;
        const toolId = typedMsg.toolId as string;
        const status = typedMsg.status as string;
        setAgentTools((prev) => {
          const list = prev[id] || [];
          if (list.some((t) => t.toolId === toolId)) return prev;
          return { ...prev, [id]: [...list, { toolId, status, done: false }] };
        });
        const toolName = extractToolName(status);
        os.setAgentTool(id, toolName);
        os.setAgentActive(id, true);
        os.clearPermissionBubble(id);
        if (status.startsWith('Subtask:')) {
          const label = status.slice('Subtask:'.length).trim();
          const subId = os.addSubagent(id, toolId);
          setSubagentCharacters((prev) => {
            if (prev.some((s) => s.id === subId)) return prev;
            return [...prev, { id: subId, parentAgentId: id, parentToolId: toolId, label }];
          });
        }
      } else if (typedMsg.type === 'agentToolDone') {
        const id = typedMsg.id as number;
        const toolId = typedMsg.toolId as string;
        setAgentTools((prev) => {
          const list = prev[id];
          if (!list) return prev;
          return { ...prev, [id]: list.map((t) => (t.toolId === toolId ? { ...t, done: true } : t)) };
        });
      } else if (typedMsg.type === 'agentToolsClear') {
        const id = typedMsg.id as number;
        setAgentTools((prev) => {
          if (!(id in prev)) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
        setSubagentTools((prev) => {
          if (!(id in prev)) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
        os.removeAllSubagents(id);
        setSubagentCharacters((prev) => prev.filter((s) => s.parentAgentId !== id));
        os.setAgentTool(id, null);
        os.clearPermissionBubble(id);
      } else if (typedMsg.type === 'agentSelected') {
        setSelectedAgent(typedMsg.id as number);
      } else if (typedMsg.type === 'agentStatus') {
        const id = typedMsg.id as number;
        const status = typedMsg.status as string;
        setAgentStatuses((prev) => {
          if (status === 'active') {
            if (!(id in prev)) return prev;
            const next = { ...prev };
            delete next[id];
            return next;
          }
          return { ...prev, [id]: status };
        });
        os.setAgentActive(id, status === 'active');
        if (status === 'waiting') {
          os.showWaitingBubble(id);
          playDoneSound();
        }
      } else if (typedMsg.type === 'agentToolPermission') {
        const id = typedMsg.id as number;
        setAgentTools((prev) => {
          const list = prev[id];
          if (!list) return prev;
          return { ...prev, [id]: list.map((t) => (t.done ? t : { ...t, permissionWait: true })) };
        });
        os.showPermissionBubble(id);
      } else if (typedMsg.type === 'subagentToolPermission') {
        const id = typedMsg.id as number;
        const parentToolId = typedMsg.parentToolId as string;
        const subId = os.getSubagentId(id, parentToolId);
        if (subId !== null) os.showPermissionBubble(subId);
      } else if (typedMsg.type === 'agentToolPermissionClear') {
        const id = typedMsg.id as number;
        setAgentTools((prev) => {
          const list = prev[id];
          if (!list) return prev;
          const hasPermission = list.some((t) => t.permissionWait);
          if (!hasPermission) return prev;
          return { ...prev, [id]: list.map((t) => (t.permissionWait ? { ...t, permissionWait: false } : t)) };
        });
        os.clearPermissionBubble(id);
        for (const [subId, meta] of os.subagentMeta) {
          if (meta.parentAgentId === id) os.clearPermissionBubble(subId);
        }
      } else if (typedMsg.type === 'subagentToolStart') {
        const id = typedMsg.id as number;
        const parentToolId = typedMsg.parentToolId as string;
        const toolId = typedMsg.toolId as string;
        const status = typedMsg.status as string;
        setSubagentTools((prev) => {
          const agentSubs = prev[id] || {};
          const list = agentSubs[parentToolId] || [];
          if (list.some((t) => t.toolId === toolId)) return prev;
          return { ...prev, [id]: { ...agentSubs, [parentToolId]: [...list, { toolId, status, done: false }] } };
        });
        const subId = os.getSubagentId(id, parentToolId);
        if (subId !== null) {
          os.setAgentTool(subId, extractToolName(status));
          os.setAgentActive(subId, true);
        }
      } else if (typedMsg.type === 'subagentToolDone') {
        const id = typedMsg.id as number;
        const parentToolId = typedMsg.parentToolId as string;
        const toolId = typedMsg.toolId as string;
        setSubagentTools((prev) => {
          const agentSubs = prev[id];
          if (!agentSubs) return prev;
          const list = agentSubs[parentToolId];
          if (!list) return prev;
          return { ...prev, [id]: { ...agentSubs, [parentToolId]: list.map((t) => (t.toolId === toolId ? { ...t, done: true } : t)) } };
        });
      } else if (typedMsg.type === 'subagentClear') {
        const id = typedMsg.id as number;
        const parentToolId = typedMsg.parentToolId as string;
        setSubagentTools((prev) => {
          const agentSubs = prev[id];
          if (!agentSubs || !(parentToolId in agentSubs)) return prev;
          const next = { ...agentSubs };
          delete next[parentToolId];
          if (Object.keys(next).length === 0) {
            const outer = { ...prev };
            delete outer[id];
            return outer;
          }
          return { ...prev, [id]: next };
        });
        os.removeSubagent(id, parentToolId);
        setSubagentCharacters((prev) =>
          prev.filter((s) => !(s.parentAgentId === id && s.parentToolId === parentToolId)),
        );
      } else if (typedMsg.type === 'characterSpritesLoaded') {
        setCharacterTemplates(typedMsg.characters as Array<{ down: string[][][]; up: string[][][]; right: string[][][] }>);
      } else if (typedMsg.type === 'floorTilesLoaded') {
        setFloorSprites(typedMsg.sprites as string[][][]);
      } else if (typedMsg.type === 'wallTilesLoaded') {
        setWallSprites(typedMsg.sets as string[][][][]);
      } else if (typedMsg.type === 'workspaceFolders') {
        setWorkspaceFolders(typedMsg.folders as WorkspaceFolder[]);
      } else if (typedMsg.type === 'settingsLoaded') {
        setSoundEnabled(typedMsg.soundEnabled as boolean);
      } else if (typedMsg.type === 'furnitureAssetsLoaded') {
        const catalog = typedMsg.catalog as FurnitureAsset[];
        const sprites = typedMsg.sprites as Record<string, string[][]>;
        buildDynamicCatalog({ catalog, sprites });
        setLoadedAssets({ catalog, sprites });
      } else if (typedMsg.type === 'projectList') {
        const list = (typedMsg.projects ?? []) as ProjectInfo[];
        setProjects(list);
      }
    };

    window.addEventListener('message', handler);
    // Signal ready to server
    transport.send({ type: 'webviewReady' });

    return () => window.removeEventListener('message', handler);
  }, [transport, getOfficeState, handleFullState, isEditDirty, onLayoutLoaded]);

  return {
    agents,
    selectedAgent,
    agentTools,
    agentStatuses,
    subagentTools,
    subagentCharacters,
    layoutReady,
    layoutWasReset,
    loadedAssets,
    workspaceFolders,
    selectedProjectHash,
    projects,
  };
}
