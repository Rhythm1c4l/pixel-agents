import { useCallback, useEffect, useRef, useState } from 'react';

import type { TransportState } from '../transport.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ConnectionCredentials {
  wsUrl: string;
  authToken: string;
}

interface ConnectionScreenProps {
  /** Called when pairing succeeds — consumer connects to the returned credentials */
  onConnect: (creds: ConnectionCredentials) => void;
  /** Current transport state, if already attempting a connection */
  connectionState?: TransportState;
}

// ── Storage keys ──────────────────────────────────────────────────────────────

const STORAGE_WS_URL = 'pixel-agents-ws-url';
const STORAGE_TOKEN = 'pixel-agents-auth-token';

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

// ── BarcodeDetector availability ──────────────────────────────────────────────

declare const BarcodeDetector: {
  new (options?: { formats: string[] }): {
    detect(image: ImageBitmapSource): Promise<Array<{ rawValue: string; format: string }>>;
  };
  getSupportedFormats?: () => Promise<string[]>;
};

const hasBarcodeDetector = typeof BarcodeDetector !== 'undefined';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parse a pairing QR payload.
 * Expected format: http://<ip>:<port>/pair?token=<uuid>
 * Returns the WebSocket URL and token if valid, or null.
 */
function parsePairingUrl(raw: string): ConnectionCredentials | null {
  try {
    const u = new URL(raw);
    const token = u.searchParams.get('token');
    if (!token) return null;
    // Convert http → ws, https → wss
    const wsProtocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${u.host}/ws`;
    return { wsUrl, authToken: token };
  } catch {
    return null;
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<TransportState, string> = {
  connecting: 'Connecting…',
  connected: 'Connected',
  disconnected: 'Disconnected',
  reconnecting: 'Reconnecting…',
};

const STATUS_COLORS: Record<TransportState, string> = {
  connecting: '#cca700',
  connected: '#5ac88c',
  disconnected: '#e55',
  reconnecting: '#cca700',
};

export function ConnectionScreen({ onConnect, connectionState }: ConnectionScreenProps) {
  const [mode, setMode] = useState<'camera' | 'manual'>(!hasBarcodeDetector ? 'manual' : 'camera');
  const [manualUrl, setManualUrl] = useState('');
  const [manualToken, setManualToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Start camera for QR scanning
  const startCamera = useCallback(async () => {
    setError(null);
    setScanning(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      const detector = new BarcodeDetector({ formats: ['qr_code'] });

      // Poll every 300ms
      scanIntervalRef.current = setInterval(async () => {
        const video = videoRef.current;
        if (!video || video.readyState < 2) return;
        try {
          const results = await detector.detect(video);
          for (const result of results) {
            const creds = parsePairingUrl(result.rawValue);
            if (creds) {
              stopCamera();
              saveCredentials(creds);
              onConnect(creds);
              return;
            }
          }
        } catch {
          // Detection can fail on some frames — ignore
        }
      }, 300);
    } catch (err) {
      setScanning(false);
      setError(
        err instanceof Error ? err.message : 'Camera access denied. Use manual entry instead.',
      );
    }
  }, [onConnect]);

  const stopCamera = useCallback(() => {
    if (scanIntervalRef.current !== null) {
      clearInterval(scanIntervalRef.current);
      scanIntervalRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setScanning(false);
  }, []);

  // Clean up on unmount
  useEffect(() => {
    return () => stopCamera();
  }, [stopCamera]);

  const handleManualConnect = () => {
    setError(null);
    const url = manualUrl.trim();
    const token = manualToken.trim();
    if (!url) {
      setError('Please enter a server URL.');
      return;
    }
    if (!token) {
      setError('Please enter a pairing token.');
      return;
    }
    // Normalise: if user entered http URL, convert to ws
    let wsUrl = url;
    if (url.startsWith('http://') || url.startsWith('https://')) {
      const creds = parsePairingUrl(url);
      if (creds) {
        saveCredentials(creds);
        onConnect(creds);
        return;
      }
      // Just convert protocol
      wsUrl = url.replace(/^https?/, (p) => (p === 'https' ? 'wss' : 'ws'));
    }
    const creds: ConnectionCredentials = { wsUrl, authToken: token };
    saveCredentials(creds);
    onConnect(creds);
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: '#1e1e2e',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'FS Pixel Sans, sans-serif',
        color: 'rgba(255,255,255,0.85)',
        padding: 24,
        boxSizing: 'border-box',
      }}
    >
      {/* Title */}
      <div style={{ fontSize: 32, marginBottom: 8, letterSpacing: 1 }}>Pixel Agents</div>
      <div style={{ fontSize: 20, color: 'rgba(255,255,255,0.5)', marginBottom: 32 }}>
        Connect to your desktop server
      </div>

      {/* Connection status indicator (shown when reconnecting / connecting) */}
      {connectionState && connectionState !== 'disconnected' && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 20,
            padding: '6px 14px',
            background: 'rgba(255,255,255,0.06)',
            border: '2px solid rgba(255,255,255,0.12)',
          }}
        >
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: STATUS_COLORS[connectionState],
            }}
          />
          <span style={{ fontSize: 20 }}>{STATUS_LABELS[connectionState]}</span>
        </div>
      )}

      {/* Mode toggle */}
      {hasBarcodeDetector && (
        <div
          style={{
            display: 'flex',
            gap: 0,
            marginBottom: 24,
            border: '2px solid #4a4a6a',
          }}
        >
          {(['camera', 'manual'] as const).map((m) => (
            <button
              key={m}
              onClick={() => {
                if (mode !== m) {
                  if (m === 'manual') stopCamera();
                  setMode(m);
                  setError(null);
                }
              }}
              style={{
                padding: '6px 16px',
                fontSize: 22,
                background: mode === m ? 'rgba(90,140,255,0.25)' : 'transparent',
                color: mode === m ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.5)',
                border: 'none',
                borderLeft: m === 'manual' ? '2px solid #4a4a6a' : 'none',
                borderRadius: 0,
                cursor: 'pointer',
              }}
            >
              {m === 'camera' ? 'Scan QR' : 'Manual'}
            </button>
          ))}
        </div>
      )}

      {/* Camera scanner */}
      {mode === 'camera' && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
          <div
            style={{
              width: 240,
              height: 240,
              border: '2px solid #4a4a6a',
              position: 'relative',
              background: '#0a0a14',
              overflow: 'hidden',
            }}
          >
            <video
              ref={videoRef}
              playsInline
              muted
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
            {!scanning && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 20,
                  color: 'rgba(255,255,255,0.4)',
                  textAlign: 'center',
                  padding: 16,
                }}
              >
                Point at QR code in terminal
              </div>
            )}
          </div>
          <button
            onClick={scanning ? stopCamera : startCamera}
            style={{
              padding: '8px 20px',
              fontSize: 22,
              background: scanning ? 'rgba(200,50,50,0.2)' : 'rgba(90,140,255,0.2)',
              color: scanning ? '#e88' : 'rgba(255,255,255,0.85)',
              border: `2px solid ${scanning ? '#a33' : '#5a8cff'}`,
              borderRadius: 0,
              cursor: 'pointer',
            }}
          >
            {scanning ? 'Stop' : 'Start Camera'}
          </button>
          <p style={{ fontSize: 18, color: 'rgba(255,255,255,0.4)', textAlign: 'center', margin: 0 }}>
            Run <code style={{ color: '#5ac88c' }}>node dist/server.js --qr</code> on your PC
          </p>
        </div>
      )}

      {/* Manual entry */}
      {mode === 'manual' && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            width: '100%',
            maxWidth: 320,
          }}
        >
          <label style={{ fontSize: 20, color: 'rgba(255,255,255,0.6)' }}>
            Server URL
            <input
              type="text"
              placeholder="ws://192.168.1.5:3000/ws"
              value={manualUrl}
              onChange={(e) => setManualUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleManualConnect()}
              style={{
                display: 'block',
                width: '100%',
                marginTop: 4,
                padding: '6px 8px',
                fontSize: 20,
                background: '#2a2a3a',
                color: 'rgba(255,255,255,0.85)',
                border: '2px solid #4a4a6a',
                borderRadius: 0,
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          </label>
          <label style={{ fontSize: 20, color: 'rgba(255,255,255,0.6)' }}>
            Pairing Token
            <input
              type="text"
              placeholder="Paste token from QR code"
              value={manualToken}
              onChange={(e) => setManualToken(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleManualConnect()}
              style={{
                display: 'block',
                width: '100%',
                marginTop: 4,
                padding: '6px 8px',
                fontSize: 20,
                background: '#2a2a3a',
                color: 'rgba(255,255,255,0.85)',
                border: '2px solid #4a4a6a',
                borderRadius: 0,
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          </label>
          <button
            onClick={handleManualConnect}
            style={{
              marginTop: 6,
              padding: '8px 0',
              fontSize: 22,
              background: 'rgba(90,200,140,0.15)',
              color: 'rgba(200,255,220,0.95)',
              border: '2px solid #5ac88c',
              borderRadius: 0,
              cursor: 'pointer',
            }}
          >
            Connect
          </button>
          <p style={{ fontSize: 18, color: 'rgba(255,255,255,0.4)', textAlign: 'center', margin: 0 }}>
            Or scan the QR code with your camera
          </p>
        </div>
      )}

      {/* Error */}
      {error && (
        <div
          style={{
            marginTop: 16,
            padding: '6px 12px',
            background: 'rgba(200,50,50,0.15)',
            border: '2px solid #a33',
            fontSize: 20,
            color: '#ecc',
            maxWidth: 320,
            textAlign: 'center',
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
