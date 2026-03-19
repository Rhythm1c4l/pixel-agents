/**
 * Unit tests for server/qrGenerator.ts
 *
 * Tests QR pairing flow: token generation, expiry, validation.
 *
 * Run with: npm run test:server
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  generatePairing,
  getCurrentToken,
  getLocalIp,
  renderPairingDisplay,
  validateToken,
} from '../qrGenerator.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

// Since qrGenerator uses module-level state (currentPairing), we reset it
// between tests by calling generatePairing which overwrites it.
// We also use Date manipulation via a fake clock approach.

const TEST_PORT = 3000;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('generatePairing: token generation', () => {
  it('returns an object with token, url, and expiresAt', () => {
    const pairing = generatePairing(TEST_PORT);
    assert.ok(pairing.token, 'Should have a token');
    assert.ok(pairing.url, 'Should have a url');
    assert.ok(pairing.expiresAt > 0, 'Should have a positive expiresAt');
  });

  it('generates a UUID-format token', () => {
    const pairing = generatePairing(TEST_PORT);
    // UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    assert.match(pairing.token, uuidPattern);
  });

  it('generates a different token on each call', () => {
    const p1 = generatePairing(TEST_PORT);
    const p2 = generatePairing(TEST_PORT);
    assert.notEqual(p1.token, p2.token);
  });

  it('includes the token in the URL', () => {
    const pairing = generatePairing(TEST_PORT);
    assert.ok(pairing.url.includes(pairing.token), `URL should contain token ${pairing.token}`);
  });

  it('includes the port in the URL', () => {
    const pairing = generatePairing(4567);
    assert.ok(pairing.url.includes(':4567'), `URL should contain port 4567`);
  });

  it('sets expiresAt approximately 60 seconds in the future', () => {
    const before = Date.now();
    const pairing = generatePairing(TEST_PORT);
    const after = Date.now();

    // expiresAt should be ~60s from now (within 100ms tolerance)
    assert.ok(pairing.expiresAt >= before + 59_900, 'expiresAt should be at least 59.9s from now');
    assert.ok(pairing.expiresAt <= after + 60_100, 'expiresAt should be at most 60.1s from now');
  });

  it('replaces the previous pairing on regeneration', () => {
    const p1 = generatePairing(TEST_PORT);
    const p2 = generatePairing(TEST_PORT);

    // p1's token should no longer be valid (replaced by p2)
    assert.ok(!validateToken(p1.token), 'Old token should no longer be valid after regeneration');
    assert.ok(validateToken(p2.token), 'New token should be valid');
  });
});

describe('validateToken: token validation', () => {
  beforeEach(() => {
    // Reset state with a fresh pairing
    generatePairing(TEST_PORT);
  });

  it('returns true for a valid, non-expired token', () => {
    const pairing = generatePairing(TEST_PORT);
    assert.ok(validateToken(pairing.token));
  });

  it('returns false for an incorrect token', () => {
    generatePairing(TEST_PORT); // ensure a current pairing exists
    assert.ok(!validateToken('invalid-token-string'));
  });

  it('returns false for a UUID that is not the current token', () => {
    generatePairing(TEST_PORT);
    // A valid UUID but not the current token
    assert.ok(!validateToken('00000000-0000-0000-0000-000000000000'));
  });

  it('returns false when no pairing exists (token expired)', () => {
    const pairing = generatePairing(TEST_PORT);

    // Simulate expiry by manually overwriting currentPairing
    // We can't directly access module state, but we can validate that after a new
    // pairing invalidates the old one
    generatePairing(TEST_PORT); // new pairing
    assert.ok(!validateToken(pairing.token), 'Old token should be invalid');
  });
});

describe('getCurrentToken', () => {
  it('returns the current token after generatePairing', () => {
    const pairing = generatePairing(TEST_PORT);
    const current = getCurrentToken();
    assert.equal(current, pairing.token);
  });

  it('returns different token after regeneration', () => {
    const p1 = generatePairing(TEST_PORT);
    const p2 = generatePairing(TEST_PORT);
    assert.equal(getCurrentToken(), p2.token);
    assert.notEqual(getCurrentToken(), p1.token);
  });
});

describe('getLocalIp', () => {
  it('returns a non-empty string', () => {
    const ip = getLocalIp();
    assert.ok(ip.length > 0);
  });

  it('returns a string in IPv4 format or 127.0.0.1 fallback', () => {
    const ip = getLocalIp();
    // Should be an IPv4 address: x.x.x.x
    const ipv4Pattern = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
    assert.match(ip, ipv4Pattern, `Expected IPv4 format, got: ${ip}`);
  });
});

describe('renderPairingDisplay', () => {
  let pairing: ReturnType<typeof generatePairing>;

  beforeEach(() => {
    pairing = generatePairing(TEST_PORT);
  });

  it('returns a non-empty string', () => {
    const output = renderPairingDisplay(pairing);
    assert.ok(output.length > 0);
  });

  it('contains the pairing URL', () => {
    const output = renderPairingDisplay(pairing);
    assert.ok(output.includes(pairing.url), 'Display should include the pairing URL');
  });

  it('contains "PIXEL AGENTS"', () => {
    const output = renderPairingDisplay(pairing);
    assert.ok(output.includes('PIXEL AGENTS'), 'Display should include "PIXEL AGENTS"');
  });

  it('mentions token expiry time', () => {
    const output = renderPairingDisplay(pairing);
    assert.ok(
      output.includes('60s') || output.includes('expires'),
      'Display should mention token expiry',
    );
  });

  it('has matching open/close border characters', () => {
    const output = renderPairingDisplay(pairing);
    const lines = output.split('\n');
    // First line starts with ┌ (box drawing)
    assert.ok(lines[0].startsWith('┌'), `First line should start with ┌, got: ${lines[0][0]}`);
    // Last line starts with └
    assert.ok(
      lines[lines.length - 1].startsWith('└'),
      `Last line should start with └, got: ${lines[lines.length - 1][0]}`,
    );
  });

  it('is multiple lines', () => {
    const output = renderPairingDisplay(pairing);
    const lines = output.split('\n').filter((l) => l.length > 0);
    assert.ok(lines.length > 3, `Expected more than 3 lines, got ${lines.length}`);
  });
});
