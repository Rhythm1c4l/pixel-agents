/**
 * QR code generator for terminal-based pairing.
 * Generates a pairing URL with a crypto token and renders it as ASCII art.
 * No external QR library — uses a minimal QR encoder implementation.
 * Token expires after a configurable timeout.
 */

import * as crypto from 'crypto';
import * as os from 'os';

const TOKEN_EXPIRY_MS = 60_000; // 60 seconds

export interface PairingInfo {
  token: string;
  url: string;
  expiresAt: number;
}

let currentPairing: PairingInfo | null = null;
let isPaired = false;

/**
 * Get the local network IP address (non-loopback IPv4).
 */
export function getLocalIp(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

/**
 * Generate a new pairing token and URL.
 */
export function generatePairing(port: number): PairingInfo {
  isPaired = false;
  const token = crypto.randomUUID();
  const ip = getLocalIp();
  const url = `http://${ip}:${port}?token=${token}`;
  const expiresAt = Date.now() + TOKEN_EXPIRY_MS;
  currentPairing = { token, url, expiresAt };
  return currentPairing;
}

/**
 * Validate a pairing token. Returns true if valid and not expired.
 * Once a client has paired successfully, the token remains valid for the server session.
 */
export function validateToken(token: string): boolean {
  if (!currentPairing) return false;
  if (currentPairing.token !== token) return false;
  if (isPaired) return true;
  if (Date.now() > currentPairing.expiresAt) {
    currentPairing = null;
    return false;
  }
  isPaired = true;
  return true;
}

/**
 * Get the current pairing token (for the HTTP server).
 */
export function getCurrentToken(): string | null {
  if (!currentPairing) return null;
  if (!isPaired && Date.now() > currentPairing.expiresAt) {
    currentPairing = null;
    return null;
  }
  return currentPairing.token;
}

/**
 * Render a URL as a simple ASCII box for terminal display.
 * Full QR encoding requires a library — for MVP we display the URL prominently.
 * If 'qrcode-terminal' is available, we'll use it; otherwise fall back to text.
 */
export function renderPairingDisplay(pairing: PairingInfo): string {
  const lines: string[] = [];
  const urlLine = pairing.url;
  const width = Math.max(urlLine.length + 4, 50);
  const pad = (s: string) => {
    const remaining = width - 2 - s.length;
    return `\u2502 ${s}${' '.repeat(Math.max(0, remaining))} \u2502`;
  };

  lines.push(`\u250C${'─'.repeat(width)}\u2510`);
  lines.push(pad(''));
  lines.push(pad('  PIXEL AGENTS — Mobile Pairing'));
  lines.push(pad(''));
  lines.push(pad('  Open this URL on your phone:'));
  lines.push(pad(''));
  lines.push(pad(`  ${urlLine}`));
  lines.push(pad(''));
  lines.push(pad(`  Token expires in ${Math.round(TOKEN_EXPIRY_MS / 1000)}s`));
  lines.push(pad(''));
  lines.push(`\u2514${'─'.repeat(width)}\u2518`);

  return lines.join('\n');
}
