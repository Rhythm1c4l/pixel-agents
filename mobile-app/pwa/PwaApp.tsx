/**
 * PwaApp — The root component for the standalone PWA mode.
 *
 * Differences from App.tsx:
 * - Shows ConnectionScreen until a WebSocket transport is established
 * - Uses useWebSocketMessages instead of useExtensionMessages
 * - Sends saveLayout/saveAgentSeats via transport instead of vscode.postMessage
 * - Shows connection status dot in BottomToolbar
 * - No "+ Agent" button (can't spawn Claude processes remotely)
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { BottomToolbar } from '../../webview-ui/src/components/BottomToolbar.js';
import {
  clearCredentials,
  ConnectionScreen,
  loadStoredCredentials,
  saveCredentials,
} from './components/ConnectionScreen.js';
import type { ConnectionCredentials } from './components/ConnectionScreen.js';
import { DebugView } from '../../webview-ui/src/components/DebugView.js';
import { ZoomControls } from '../../webview-ui/src/components/ZoomControls.js';
import { PULSE_ANIMATION_DURATION_SEC } from '../../webview-ui/src/constants.js';
import { useEditorActions } from '../../webview-ui/src/hooks/useEditorActions.js';
import { useEditorKeyboard } from '../../webview-ui/src/hooks/useEditorKeyboard.js';
import { useWebSocketMessages } from './hooks/useWebSocketMessages.js';
import { OfficeCanvas } from '../../webview-ui/src/office/components/OfficeCanvas.js';
import { ToolOverlay } from '../../webview-ui/src/office/components/ToolOverlay.js';
import { EditorState } from '../../webview-ui/src/office/editor/editorState.js';
import { EditorToolbar } from '../../webview-ui/src/office/editor/EditorToolbar.js';
import { OfficeState } from '../../webview-ui/src/office/engine/officeState.js';
import { isRotatable } from '../../webview-ui/src/office/layout/furnitureCatalog.js';
import { EditTool } from '../../webview-ui/src/office/types.js';
import type { ProjectInfo } from './components/ProjectPicker.js';
import { ProjectPicker } from './components/ProjectPicker.js';
import { connectToServer } from './transport.js';
import type { Transport, TransportState } from './transport.js';

// ── Game state (module-level, outside React) ──────────────────────────────────

const pwaOfficeStateRef = { current: null as OfficeState | null };
const pwaEditorState = new EditorState();

function getPwaOfficeState(): OfficeState {
  if (!pwaOfficeStateRef.current) {
    pwaOfficeStateRef.current = new OfficeState();
  }
  return pwaOfficeStateRef.current;
}

// ── Action bar (shared with App.tsx pattern) ──────────────────────────────────

const actionBarBtnStyle: React.CSSProperties = {
  padding: '4px 10px',
  fontSize: '22px',
  background: 'var(--pixel-btn-bg)',
  color: 'var(--pixel-text-dim)',
  border: '2px solid transparent',
  borderRadius: 0,
  cursor: 'pointer',
};

const actionBarBtnDisabled: React.CSSProperties = {
  ...actionBarBtnStyle,
  opacity: 'var(--pixel-btn-disabled-opacity)',
  cursor: 'default',
};

function EditActionBar({
  editor,
  editorState: es,
}: {
  editor: ReturnType<typeof useEditorActions>;
  editorState: EditorState;
}) {
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const undoDisabled = es.undoStack.length === 0;
  const redoDisabled = es.redoStack.length === 0;

  return (
    <div
      style={{
        position: 'absolute',
        top: 8,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 'var(--pixel-controls-z)',
        display: 'flex',
        gap: 4,
        alignItems: 'center',
        background: 'var(--pixel-bg)',
        border: '2px solid var(--pixel-border)',
        borderRadius: 0,
        padding: '4px 8px',
        boxShadow: 'var(--pixel-shadow)',
      }}
    >
      <button
        style={undoDisabled ? actionBarBtnDisabled : actionBarBtnStyle}
        onClick={undoDisabled ? undefined : editor.handleUndo}
        title="Undo (Ctrl+Z)"
      >
        Undo
      </button>
      <button
        style={redoDisabled ? actionBarBtnDisabled : actionBarBtnStyle}
        onClick={redoDisabled ? undefined : editor.handleRedo}
        title="Redo (Ctrl+Y)"
      >
        Redo
      </button>
      <button style={actionBarBtnStyle} onClick={editor.handleSave} title="Save layout">
        Save
      </button>
      {!showResetConfirm ? (
        <button
          style={actionBarBtnStyle}
          onClick={() => setShowResetConfirm(true)}
          title="Reset to last saved layout"
        >
          Reset
        </button>
      ) : (
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <span style={{ fontSize: '22px', color: 'var(--pixel-reset-text)' }}>Reset?</span>
          <button
            style={{ ...actionBarBtnStyle, background: 'var(--pixel-danger-bg)', color: '#fff' }}
            onClick={() => {
              setShowResetConfirm(false);
              editor.handleReset();
            }}
          >
            Yes
          </button>
          <button style={actionBarBtnStyle} onClick={() => setShowResetConfirm(false)}>
            No
          </button>
        </div>
      )}
    </div>
  );
}

// ── OfficeView — rendered once transport is connected ─────────────────────────

function OfficeView({
  transport,
  wsUrl,
  connectionStatus,
  onDisconnect,
}: {
  transport: Transport;
  wsUrl: string;
  connectionStatus: TransportState;
  onDisconnect: () => void;
}) {
  const editor = useEditorActions(getPwaOfficeState, pwaEditorState);

  const isEditDirty = useCallback(
    () => editor.isEditMode && editor.isDirty,
    [editor.isEditMode, editor.isDirty],
  );

  const {
    agents,
    selectedAgent,
    agentTools,
    agentStatuses,
    subagentTools,
    subagentCharacters,
    layoutReady,
    loadedAssets,
    projects,
    selectedProjectHash,
  } = useWebSocketMessages(
    transport,
    wsUrl,
    getPwaOfficeState,
    editor.setLastSavedLayout,
    isEditDirty,
  );

  const handleProjectSelect = useCallback(
    (hash: string | null) => {
      transport.send({ type: 'selectProject', projectHash: hash ?? '' });
    },
    [transport],
  );

  const [isDebugMode, setIsDebugMode] = useState(false);
  const [alwaysShowOverlay, setAlwaysShowOverlay] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const [editorTickForKeyboard, setEditorTickForKeyboard] = useState(0);
  useEditorKeyboard(
    editor.isEditMode,
    pwaEditorState,
    editor.handleDeleteSelected,
    editor.handleRotateSelected,
    editor.handleToggleState,
    editor.handleUndo,
    editor.handleRedo,
    useCallback(() => setEditorTickForKeyboard((n) => n + 1), []),
    editor.handleToggleEditMode,
  );
  void editorTickForKeyboard;

  const handleClick = useCallback((agentId: number) => {
    const os = getPwaOfficeState();
    const meta = os.subagentMeta.get(agentId);
    const focusId = meta ? meta.parentAgentId : agentId;
    transport.send({ type: 'focusAgent', id: focusId });
  }, [transport]);

  const handleCloseAgent = useCallback((_id: number) => {
    // PWA is view-only — cannot close agents remotely
  }, []);

  const officeState = getPwaOfficeState();

  const showRotateHint =
    editor.isEditMode &&
    (() => {
      if (pwaEditorState.selectedFurnitureUid) {
        const item = officeState
          .getLayout()
          .furniture.find((f) => f.uid === pwaEditorState.selectedFurnitureUid);
        if (item && isRotatable(item.type)) return true;
      }
      if (
        pwaEditorState.activeTool === EditTool.FURNITURE_PLACE &&
        isRotatable(pwaEditorState.selectedFurnitureType)
      ) {
        return true;
      }
      return false;
    })();

  if (!layoutReady) {
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'rgba(255,255,255,0.7)',
          fontFamily: 'FS Pixel Sans, sans-serif',
          fontSize: 24,
        }}
      >
        Loading…
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}
    >
      <style>{`
        @keyframes pixel-agents-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
        .pixel-agents-pulse { animation: pixel-agents-pulse ${PULSE_ANIMATION_DURATION_SEC}s ease-in-out infinite; }
      `}</style>

      <OfficeCanvas
        officeState={officeState}
        onClick={handleClick}
        isEditMode={editor.isEditMode}
        editorState={pwaEditorState}
        onEditorTileAction={editor.handleEditorTileAction}
        onEditorEraseAction={editor.handleEditorEraseAction}
        onEditorSelectionChange={editor.handleEditorSelectionChange}
        onDeleteSelected={editor.handleDeleteSelected}
        onRotateSelected={editor.handleRotateSelected}
        onDragMove={editor.handleDragMove}
        editorTick={editor.editorTick}
        zoom={editor.zoom}
        onZoomChange={editor.handleZoomChange}
        panRef={editor.panRef}
      />

      {!isDebugMode && <ZoomControls zoom={editor.zoom} onZoomChange={editor.handleZoomChange} />}

      {/* Vignette */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'var(--pixel-vignette)',
          pointerEvents: 'none',
          zIndex: 40,
        }}
      />

      <BottomToolbar
        isEditMode={editor.isEditMode}
        onOpenClaude={() => {/* PWA: no agent spawning */}}
        onToggleEditMode={editor.handleToggleEditMode}
        isDebugMode={isDebugMode}
        onToggleDebugMode={() => setIsDebugMode((v) => !v)}
        alwaysShowOverlay={alwaysShowOverlay}
        onToggleAlwaysShowOverlay={() => setAlwaysShowOverlay((v) => !v)}
        workspaceFolders={[]}
        connectionStatus={connectionStatus}
      />

      {editor.isEditMode && editor.isDirty && (
        <EditActionBar editor={editor} editorState={pwaEditorState} />
      )}

      {showRotateHint && (
        <div
          style={{
            position: 'absolute',
            top: editor.isDirty ? 52 : 8,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 49,
            background: 'var(--pixel-hint-bg)',
            color: '#fff',
            fontSize: '20px',
            padding: '3px 8px',
            borderRadius: 0,
            border: '2px solid var(--pixel-accent)',
            boxShadow: 'var(--pixel-shadow)',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          Rotate (R)
        </div>
      )}

      {editor.isEditMode &&
        (() => {
          const selUid = pwaEditorState.selectedFurnitureUid;
          const selColor = selUid
            ? (officeState.getLayout().furniture.find((f) => f.uid === selUid)?.color ?? null)
            : null;
          return (
            <EditorToolbar
              activeTool={pwaEditorState.activeTool}
              selectedTileType={pwaEditorState.selectedTileType}
              selectedFurnitureType={pwaEditorState.selectedFurnitureType}
              selectedFurnitureUid={selUid}
              selectedFurnitureColor={selColor}
              floorColor={pwaEditorState.floorColor}
              wallColor={pwaEditorState.wallColor}
              selectedWallSet={pwaEditorState.selectedWallSet}
              onToolChange={editor.handleToolChange}
              onTileTypeChange={editor.handleTileTypeChange}
              onFloorColorChange={editor.handleFloorColorChange}
              onWallColorChange={editor.handleWallColorChange}
              onWallSetChange={editor.handleWallSetChange}
              onSelectedFurnitureColorChange={editor.handleSelectedFurnitureColorChange}
              onFurnitureTypeChange={editor.handleFurnitureTypeChange}
              loadedAssets={loadedAssets}
            />
          );
        })()}

      {!isDebugMode && (
        <ToolOverlay
          officeState={officeState}
          agents={agents}
          agentTools={agentTools}
          subagentCharacters={subagentCharacters}
          containerRef={containerRef}
          zoom={editor.zoom}
          panRef={editor.panRef}
          onCloseAgent={handleCloseAgent}
          alwaysShowOverlay={alwaysShowOverlay}
        />
      )}

      {isDebugMode && (
        <DebugView
          agents={agents}
          selectedAgent={selectedAgent}
          agentTools={agentTools}
          agentStatuses={agentStatuses}
          subagentTools={subagentTools}
          onSelectAgent={() => {/* no-op in PWA */}}
        />
      )}

      {/* Disconnect button (bottom-right) */}
      <button
        onClick={onDisconnect}
        title="Disconnect from server"
        style={{
          position: 'absolute',
          bottom: 'calc(10px + var(--safe-area-bottom, 0px))',
          right: 'calc(10px + var(--safe-area-right, 0px))',
          zIndex: 'var(--pixel-controls-z)',
          padding: '4px 8px',
          fontSize: '18px',
          background: 'rgba(200,50,50,0.15)',
          color: 'rgba(255,100,100,0.8)',
          border: '2px solid rgba(200,50,50,0.4)',
          borderRadius: 0,
          cursor: 'pointer',
        }}
      >
        Disconnect
      </button>
    </div>
  );
}

// ── PwaApp ────────────────────────────────────────────────────────────────────

export function PwaApp() {
  const [transport, setTransport] = useState<Transport | null>(null);
  const [wsUrl, setWsUrl] = useState<string>('');
  const [connectionStatus, setConnectionStatus] = useState<TransportState>('disconnected');
  const transportRef = useRef<Transport | null>(null);

  // Auto-connect from stored credentials on mount
  useEffect(() => {
    const stored = loadStoredCredentials();
    if (stored) {
      handleConnect(stored);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleConnect = useCallback((creds: ConnectionCredentials) => {
    // Disconnect any existing transport
    if (transportRef.current) {
      transportRef.current.disconnect();
    }

    saveCredentials(creds);
    setWsUrl(creds.wsUrl);
    setConnectionStatus('connecting');

    const t = connectToServer(creds.wsUrl, creds.authToken);
    transportRef.current = t;
    setTransport(t);

    t.onStateChange((state) => {
      setConnectionStatus(state);
    });
  }, []);

  const handleDisconnect = useCallback(() => {
    if (transportRef.current) {
      transportRef.current.disconnect();
      transportRef.current = null;
    }
    clearCredentials();
    pwaOfficeStateRef.current = null;
    setTransport(null);
    setWsUrl('');
    setConnectionStatus('disconnected');
  }, []);

  // Show connection screen if not yet connected or if disconnected
  const showConnectionScreen = transport === null || connectionStatus === 'disconnected';

  if (showConnectionScreen) {
    return (
      <ConnectionScreen
        onConnect={handleConnect}
        connectionState={connectionStatus === 'disconnected' ? undefined : connectionStatus}
      />
    );
  }

  return (
    <OfficeView
      transport={transport}
      wsUrl={wsUrl}
      connectionStatus={connectionStatus}
      onDisconnect={handleDisconnect}
    />
  );
}
