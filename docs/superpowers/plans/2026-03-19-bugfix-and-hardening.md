# Bugfix & Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all critical bugs, security vulnerabilities, and performance issues identified by code review, security audit, performance analysis, and test coverage analysis.

**Architecture:** Each task is an independent fix targeting a specific file or module. Tasks are ordered by severity — critical blockers first, then security, then performance, then quality-of-life. Each task is self-contained and can be committed independently.

**Tech Stack:** TypeScript, Node.js built-in modules (http, crypto, fs), React 19, Canvas 2D, node:test

---

### Task 1: Fix WebSocket GUID constant (CRITICAL — WS connections fail in all browsers)

**Files:**
- Modify: `mobile-app/server/wsServer.ts:22`

- [ ] **Step 1: Fix the WS_GUID constant**

Replace the malformed GUID with the correct RFC 6455 value:

```typescript
// Line 22 — replace:
const WS_GUID = '258EAFA5-E914-47DA-95CA-5AB5-38DC-FE0E2F57';
// with:
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB57C8A2AE';
```

- [ ] **Step 2: Run existing WS server tests**

Run: `cd pixel-agents && npm run test:server`
Expected: All tests pass (existing tests use raw sockets that don't validate the accept hash, so they still pass).

- [ ] **Step 3: Commit**

```bash
git add mobile-app/server/wsServer.ts
git commit -m "fix: correct WebSocket GUID to match RFC 6455

Browser WebSocket clients validate Sec-WebSocket-Accept against the
standard GUID. The old value had extra hyphens and wrong characters,
causing every browser connection to be rejected."
```

---

### Task 2: Fix asset fetch URLs to match server routes (CRITICAL — all assets 404 in production)

**Files:**
- Modify: `mobile-app/pwa/hooks/useWebSocketMessages.ts:59-64`

The PWA fetches from `/assets/decoded/characters.json` etc., but the server serves from `/assets/characters` (no `/decoded/` prefix, no `.json` extension). The furniture catalog is fetched from `/assets/furniture-catalog.json` but the server bundles it inside `/assets/furniture`.

- [ ] **Step 1: Fix the fetchAssets function**

Replace the 5 fetch calls with the 4 correct server routes. The furniture catalog comes bundled inside the `/assets/furniture` response (as `{ catalog, sprites }`), so we don't need a separate fetch.

```typescript
// In fetchAssets(), replace the Promise.all block:
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
```

- [ ] **Step 2: Run PWA tests**

Run: `cd pixel-agents && npm run test:pwa`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add mobile-app/pwa/hooks/useWebSocketMessages.ts
git commit -m "fix: align asset fetch URLs with server routes

The PWA was fetching from /assets/decoded/*.json but the server
serves from /assets/* without the /decoded/ prefix or .json extension.
The furniture catalog is already bundled in /assets/furniture."
```

---

### Task 3: Fix token expiry — make it pairing-window only, not session lifetime (CRITICAL)

**Files:**
- Modify: `mobile-app/server/qrGenerator.ts`
- Modify: `mobile-app/server/httpServer.ts:76-78`

The token expires after 60s and is never regenerated. After 60s, reconnecting clients are permanently rejected. The `/pair` endpoint also bypasses `validateToken()`.

- [ ] **Step 1: Make validateToken() non-expiring after first successful validation**

In `qrGenerator.ts`, add a `paired` flag. Once a client successfully validates, the token becomes permanent for that server session:

```typescript
let isPaired = false;

export function generatePairing(port: number): PairingInfo {
  isPaired = false; // Reset pairing flag for new token
  const token = crypto.randomUUID();
  const ip = getLocalIp();
  const url = `http://${ip}:${port}?token=${token}`;
  const expiresAt = Date.now() + TOKEN_EXPIRY_MS;

  currentPairing = { token, url, expiresAt };
  return currentPairing;
}

export function validateToken(token: string): boolean {
  if (!currentPairing) return false;
  if (currentPairing.token !== token) return false;
  // After first successful pairing, token is permanent
  if (isPaired) return true;
  // Before first pairing, enforce the 60s window
  if (Date.now() > currentPairing.expiresAt) {
    currentPairing = null;
    return false;
  }
  isPaired = true;
  return true;
}
```

Also update `getCurrentToken()` to respect `isPaired`:

```typescript
export function getCurrentToken(): string | null {
  if (!currentPairing) return null;
  if (!isPaired && Date.now() > currentPairing.expiresAt) {
    currentPairing = null;
    return null;
  }
  return currentPairing.token;
}
```

- [ ] **Step 2: Make /pair endpoint use validateToken()**

In `httpServer.ts`, replace the raw string comparison:

```typescript
// Replace lines 76-78:
if (pathname === '/pair') {
  const token = url.searchParams.get('token');
  if (token && validateToken(token)) {
// (rest stays the same)
```

Update the `createHttpServer` function signature to accept `validateToken` instead of `pairingToken`:

```typescript
export interface HttpServerOptions {
  port: number;
  pwaDir: string;
  assets: DecodedAssets;
  validateToken: (token: string) => boolean;
}
```

- [ ] **Step 3: Update index.ts to pass validateToken instead of pairingToken**

```typescript
// In index.ts, change createHttpServer call:
const httpServer = createHttpServer({
  port: args.port,
  pwaDir: resolvedPwa,
  assets,
  validateToken,
});
```

- [ ] **Step 4: Run tests**

Run: `cd pixel-agents && npm run test:server`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add mobile-app/server/qrGenerator.ts mobile-app/server/httpServer.ts mobile-app/server/index.ts
git commit -m "fix: make pairing token permanent after first successful validation

The 60s expiry now only applies to the initial pairing window.
Once a client pairs, the token stays valid for the server session,
allowing reconnects. Also routes /pair through validateToken()."
```

---

### Task 4: Replace require() with static import in transcriptProcessor.ts (CRITICAL)

**Files:**
- Modify: `mobile-app/server/transcriptProcessor.ts:51`

The `require()` call will crash in ESM environments. There is no actual circular dependency.

- [ ] **Step 1: Replace require with static import**

Add `SessionWatcher` to the existing type import at line 8, changing it from `import type` to `import`:

```typescript
// Line 8 — change from:
import type { SessionWatcher } from './sessionWatcher.js';
// to:
import { SessionWatcher } from './sessionWatcher.js';
```

Then replace line 51:
```typescript
// Remove:
const { SessionWatcher: SW } = require('./sessionWatcher.js') as { SessionWatcher: typeof SessionWatcher };
const watcher = new SW(project.dir, project.hash);
// Replace with:
const watcher = new SessionWatcher(project.dir, project.hash);
```

- [ ] **Step 2: Run tests**

Run: `cd pixel-agents && npm run test:server`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add mobile-app/server/transcriptProcessor.ts
git commit -m "fix: replace require() with static import in transcriptProcessor

The require() call would crash in ESM. The claimed circular dependency
between transcriptProcessor and sessionWatcher does not exist."
```

---

### Task 5: Fix HTTP stream error handler (writeHead after headers sent)

**Files:**
- Modify: `mobile-app/server/httpServer.ts:158-161`

- [ ] **Step 1: Guard against double writeHead**

```typescript
// Replace lines 158-161:
stream.on('error', () => {
  if (!res.headersSent) {
    res.writeHead(500);
    res.end('Internal Server Error');
  } else {
    res.destroy();
  }
});
```

- [ ] **Step 2: Run tests**

Run: `cd pixel-agents && npm run test:server`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add mobile-app/server/httpServer.ts
git commit -m "fix: guard stream error handler against double writeHead

If a file stream errors mid-transfer, headers are already sent.
Calling writeHead(500) again throws ERR_HTTP_HEADERS_SENT."
```

---

### Task 6: Fix handleTouchCancel dead code (onPanEnd never fires)

**Files:**
- Modify: `mobile-app/pwa/hooks/useTouchGestures.ts:168-176`

- [ ] **Step 1: Save state before nulling**

```typescript
// Replace the handleTouchCancel callback body:
const handleTouchCancel = useCallback(
  (_e: React.TouchEvent) => {
    clearLongPressTimer();
    const state = touchStateRef.current;
    touchStateRef.current = null;
    pinchStartDistRef.current = null;
    if (state?.isPanning) {
      handlers.onPanEnd?.();
    }
  },
  [handlers, clearLongPressTimer],
);
```

- [ ] **Step 2: Run PWA tests**

Run: `cd pixel-agents && npm run test:pwa`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add mobile-app/pwa/hooks/useTouchGestures.ts
git commit -m "fix: handleTouchCancel now properly calls onPanEnd

The ref was nulled before being checked, making onPanEnd dead code.
This caused the canvas to get stuck in panning state when a touch
was cancelled (e.g., incoming phone call)."
```

---

### Task 7: Reset OfficeState on disconnect (ghost agents persist)

**Files:**
- Modify: `mobile-app/pwa/PwaApp.tsx:42-50, 454-462`

- [ ] **Step 1: Reset OfficeState in handleDisconnect**

Add a reset call when disconnecting:

```typescript
// In handleDisconnect callback, after clearCredentials():
const handleDisconnect = useCallback(() => {
  if (transportRef.current) {
    transportRef.current.disconnect();
    transportRef.current = null;
  }
  clearCredentials();
  // Reset game state so ghost agents don't persist across sessions
  pwaOfficeStateRef.current = null;
  setTransport(null);
  setWsUrl('');
  setConnectionStatus('disconnected');
}, []);
```

- [ ] **Step 2: Run PWA tests**

Run: `cd pixel-agents && npm run test:pwa`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add mobile-app/pwa/PwaApp.tsx
git commit -m "fix: reset OfficeState on disconnect to prevent ghost agents

Module-level OfficeState was never cleared, so characters from a
previous session persisted after disconnect/reconnect."
```

---

### Task 8: Add WebSocket payload size limit (DoS prevention)

**Files:**
- Modify: `mobile-app/server/wsServer.ts:20, 170-174`

- [ ] **Step 1: Add MAX_PAYLOAD_SIZE and enforce it**

Add constant after line 20:

```typescript
const MAX_PAYLOAD_SIZE = 1_048_576; // 1 MB
```

Add a size check after the payload length is determined (after the existing `payloadLen === 127` block, around line 174):

```typescript
// After payloadLen is resolved, before maskLen:
if (payloadLen > MAX_PAYLOAD_SIZE) {
  this.removeClient(client);
  return;
}
```

- [ ] **Step 2: Run tests**

Run: `cd pixel-agents && npm run test:server`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add mobile-app/server/wsServer.ts
git commit -m "security: add 1MB WebSocket payload size limit

Prevents memory exhaustion from malicious clients advertising
extremely large payload lengths in the WS frame header."
```

---

### Task 9: Add runtime validation for incoming WebSocket messages

**Files:**
- Modify: `mobile-app/server/wsServer.ts:236-242`

- [ ] **Step 1: Add type guard for message validation**

Add a validation function before the `WsServer` class:

```typescript
const VALID_CLIENT_TYPES = new Set([
  'selectProject', 'webviewReady', 'saveLayout',
  'saveAgentSeats', 'focusAgent', 'setSoundEnabled',
]);

function isValidClientMessage(msg: unknown): msg is ClientToServerMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'type' in msg &&
    typeof (msg as Record<string, unknown>).type === 'string' &&
    VALID_CLIENT_TYPES.has((msg as Record<string, unknown>).type as string)
  );
}
```

Then in `handleMessage`, replace the `as` cast:

```typescript
private handleMessage(client: WsClient, text: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  if (!isValidClientMessage(parsed)) return;
  const msg = parsed;
  // ... rest stays the same
```

- [ ] **Step 2: Run tests**

Run: `cd pixel-agents && npm run test:server`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add mobile-app/server/wsServer.ts
git commit -m "security: validate incoming WebSocket message types

Rejects messages with unknown types instead of silently casting.
Prevents type confusion bugs from malformed client messages."
```

---

### Task 10: Remove filesystem paths from projectList messages

**Files:**
- Modify: `mobile-app/server/wsServer.ts:283-291`
- Modify: `mobile-app/shared/protocol.ts:184`

- [ ] **Step 1: Remove path from sendProjectList**

In `wsServer.ts`, remove the `path` field from the project list mapping:

```typescript
private sendProjectList(client: WsClient): void {
  const projects = this.scanner.getProjects().map((p) => ({
    hash: p.hash,
    name: getProjectName(p.hash),
    agentCount: this.tracker.getAgentsForProject(p.hash).length,
  }));
  this.sendToClient(client, { type: 'projectList', projects });
}
```

- [ ] **Step 2: Remove path from protocol type**

In `protocol.ts`, remove the `path` field from the `ProjectListMessage` interface:

```typescript
export interface ProjectListMessage {
  type: 'projectList';
  projects: Array<{
    hash: string;
    name: string;
    agentCount: number;
  }>;
}
```

- [ ] **Step 3: Update ProjectPicker if it references path**

Check `ProjectPicker.tsx` for `project.path` references and remove them (e.g., tooltip/title attributes).

- [ ] **Step 4: Run tests**

Run: `cd pixel-agents && npm run test:server && npm run test:pwa`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add mobile-app/server/wsServer.ts mobile-app/shared/protocol.ts mobile-app/pwa/components/ProjectPicker.tsx
git commit -m "security: remove filesystem paths from projectList messages

Full paths like C:\\Users\\username\\... were leaked to mobile clients.
Only the project hash and derived name are needed."
```

---

### Task 11: Replace wildcard CORS with server origin

**Files:**
- Modify: `mobile-app/server/httpServer.ts:58-60`

- [ ] **Step 1: Remove wildcard CORS**

Since the PWA is served from the same origin as the API, CORS headers are not needed at all. Remove them:

```typescript
// Remove these 3 lines:
res.setHeader('Access-Control-Allow-Origin', '*');
res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
```

Also remove the OPTIONS handler (lines 62-66) since it's only needed for CORS preflight.

- [ ] **Step 2: Run tests**

Run: `cd pixel-agents && npm run test:server`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add mobile-app/server/httpServer.ts
git commit -m "security: remove wildcard CORS headers

PWA and API are same-origin, so CORS headers are unnecessary.
Wildcard CORS allowed any website to fetch assets."
```

---

### Task 12: Fix fs.unwatchFile to pass listener reference

**Files:**
- Modify: `mobile-app/shared/fileWatcher.ts:59-66, 114-128`

- [ ] **Step 1: Store the watchFile listener and pass it to unwatchFile**

Add a field to store the bound listener:

```typescript
// Add field after the other private fields:
private watchFileListener: (() => void) | null = null;
```

In `start()`, store the listener:

```typescript
// Replace the fs.watchFile block:
try {
  this.watchFileListener = () => { this.readNewLines(); };
  fs.watchFile(this.filePath, { interval: this.pollIntervalMs }, this.watchFileListener);
} catch (e) {
  console.log(`[JsonlWatcher] fs.watchFile failed for ${this.filePath}: ${e}`);
}
```

In `dispose()`, pass the listener:

```typescript
try {
  if (this.watchFileListener) {
    fs.unwatchFile(this.filePath, this.watchFileListener);
    this.watchFileListener = null;
  }
} catch {
  /* ignore */
}
```

- [ ] **Step 2: Run tests**

Run: `cd pixel-agents && npm run test:server`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add mobile-app/shared/fileWatcher.ts
git commit -m "fix: pass listener to fs.unwatchFile to avoid removing other watchers

Without the listener arg, unwatchFile removes ALL listeners on that
file path, which could silence another watcher on the same file."
```

---

### Task 13: Make projectMapper.writeMap async (blocking I/O in WS path)

**Files:**
- Modify: `mobile-app/server/projectMapper.ts:31-45, 119-141`

- [ ] **Step 1: Debounce writeMap calls**

Replace the synchronous `writeMap` with a debounced async version:

```typescript
let writeTimeout: ReturnType<typeof setTimeout> | null = null;
let pendingMap: ProjectMap | null = null;

function scheduleWriteMap(map: ProjectMap): void {
  pendingMap = { ...map };
  if (writeTimeout) return; // already scheduled
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
```

Then in `getProjectName` and `setProjectName`, replace `writeMap(map)` with `scheduleWriteMap(map)`.

- [ ] **Step 2: Run tests**

Run: `cd pixel-agents && npm run test:server`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add mobile-app/server/projectMapper.ts
git commit -m "perf: debounce projectMapper disk writes

writeMap was called synchronously for every new project hash
inside the WebSocket broadcast path, blocking the event loop."
```

---

### Task 14: Remove redundant imageSmoothingEnabled in game loop

**Files:**
- Modify: `webview-ui/src/office/engine/gameLoop.ts:23`

- [ ] **Step 1: Remove the redundant line**

Delete line 23 (`ctx.imageSmoothingEnabled = false;`) inside the frame callback. It's already set once at line 10.

- [ ] **Step 2: Run PWA tests**

Run: `cd pixel-agents && npm run test:pwa`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add webview-ui/src/office/engine/gameLoop.ts
git commit -m "perf: remove redundant imageSmoothingEnabled set per frame

Already set once when the game loop starts. The property persists
on the canvas context."
```

---

### Task 15: Cache getCharacters() array and fix getCharacterAt() sort-per-call

**Files:**
- Modify: `webview-ui/src/office/engine/officeState.ts`

- [ ] **Step 1: Add a cached character array**

Add a private field and invalidation:

```typescript
// Add field:
private _characterArray: Character[] | null = null;
private _characterArraySorted: Character[] | null = null;
```

Update `getCharacters()`:

```typescript
getCharacters(): Character[] {
  if (!this._characterArray) {
    this._characterArray = Array.from(this.characters.values());
  }
  return this._characterArray;
}
```

Invalidate the cache when characters change — find all places that call `this.characters.set()`, `this.characters.delete()`, and add:

```typescript
this._characterArray = null;
this._characterArraySorted = null;
```

Update `getCharacterAt()` to use a sorted cache:

```typescript
getCharacterAt(worldX: number, worldY: number): number | null {
  if (!this._characterArraySorted) {
    this._characterArraySorted = [...this.getCharacters()].sort((a, b) => b.y - a.y);
  }
  const chars = this._characterArraySorted;
  // ... rest stays the same
```

Also invalidate `_characterArraySorted` in the `update()` method (characters move each frame), or after `updateCharacters()`.

- [ ] **Step 2: Run PWA tests**

Run: `cd pixel-agents && npm run test:pwa`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add webview-ui/src/office/engine/officeState.ts
git commit -m "perf: cache getCharacters() array, avoid sort on every mousemove

getCharacters() called Array.from() on every invocation (multiple
times per frame). getCharacterAt() sorted the full array on every
mousemove event."
```

---

### Task 16: Cache wall instances (static, rebuilt every frame)

**Files:**
- Modify: `webview-ui/src/office/engine/officeState.ts`
- Modify: `webview-ui/src/office/engine/renderer.ts:610-611`

- [ ] **Step 1: Add wallInstances cache to OfficeState**

In `OfficeState`, add a cached field:

```typescript
private _wallInstances: FurnitureInstance[] | null = null;
```

Add a getter:

```typescript
getWallInstances(): FurnitureInstance[] {
  if (!this._wallInstances) {
    const layout = this.getLayout();
    this._wallInstances = hasWallSprites()
      ? getWallInstances(this.tileMap, layout.tileColors ?? [], layout.cols)
      : [];
  }
  return this._wallInstances;
}
```

Invalidate in `rebuildFromLayout()`:

```typescript
this._wallInstances = null;
```

- [ ] **Step 2: Pass wall instances from OfficeCanvas caller into renderFrame**

The `renderFrame` function in `renderer.ts` currently calls `getWallInstances()` directly. Instead, compute it in `OfficeCanvas.tsx` where `officeState` is already available, and pass the result as a parameter.

In `OfficeCanvas.tsx`, where `renderFrame` is called in the game loop render callback, compute wall instances before calling render:

```typescript
const wallInstances = officeState.getWallInstances();
```

Then pass `wallInstances` to `renderFrame` as an additional parameter. In `renderer.ts`, update the `renderFrame` signature to accept `wallInstances: FurnitureInstance[]` and use it instead of calling `getWallInstances()`:

```typescript
// In renderFrame, replace lines 610-611:
const allFurniture = wallInstances.length > 0 ? [...wallInstances, ...furniture] : furniture;
```

Remove the `getWallInstances` import from `renderer.ts` since it's no longer called there.

- [ ] **Step 3: Run PWA tests**

Run: `cd pixel-agents && npm run test:pwa`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add webview-ui/src/office/engine/officeState.ts webview-ui/src/office/engine/renderer.ts
git commit -m "perf: cache wall instances, avoid rebuilding every frame

getWallInstances() was called on every render frame but the result
is static between layout changes."
```

---

### Task 17: Use sessionStorage instead of localStorage for auth token

**Files:**
- Modify: `mobile-app/pwa/components/ConnectionScreen.tsx:21-22`

- [ ] **Step 1: Switch to sessionStorage**

Replace `localStorage` with `sessionStorage` in all three credential functions:

```typescript
export function loadStoredCredentials(): ConnectionCredentials | null {
  try {
    const wsUrl = sessionStorage.getItem(STORAGE_WS_URL);
    const authToken = sessionStorage.getItem(STORAGE_TOKEN);
    if (wsUrl && authToken) return { wsUrl, authToken };
  } catch {
    // sessionStorage may be unavailable
  }
  return null;
}

export function saveCredentials(creds: ConnectionCredentials): void {
  try {
    sessionStorage.setItem(STORAGE_WS_URL, creds.wsUrl);
    sessionStorage.setItem(STORAGE_TOKEN, creds.authToken);
  } catch {
    // ignore
  }
}

export function clearCredentials(): void {
  try {
    sessionStorage.removeItem(STORAGE_WS_URL);
    sessionStorage.removeItem(STORAGE_TOKEN);
  } catch {
    // ignore
  }
}
```

- [ ] **Step 2: Run PWA tests**

Run: `cd pixel-agents && npm run test:pwa`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add mobile-app/pwa/components/ConnectionScreen.tsx
git commit -m "security: use sessionStorage instead of localStorage for auth token

sessionStorage clears on tab close, reducing the window for token
theft from shared devices."
```
