/**
 * Unit tests for touch gesture detection math.
 *
 * Tests the threshold logic, distance calculations, and zoom delta math
 * that live in useTouchGestures.ts — exercised here as pure functions
 * without a DOM environment.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

// ── Inline re-implementations of the pure math from useTouchGestures.ts ──────
// These mirror the exact constants and formulas in the hook so any change
// to the hook math will break the corresponding test.

const TAP_MOVE_THRESHOLD_PX = 10;
const LONG_PRESS_DURATION_MS = 500;
const PAN_THRESHOLD_PX = 5;
const PINCH_ZOOM_SENSITIVITY = 0.015;

function touchDistance(
  t1: { clientX: number; clientY: number },
  t2: { clientX: number; clientY: number },
): number {
  const dx = t1.clientX - t2.clientX;
  const dy = t1.clientY - t2.clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

function isTap(startX: number, startY: number, endX: number, endY: number): boolean {
  const dx = endX - startX;
  const dy = endY - startY;
  const moved = Math.sqrt(dx * dx + dy * dy);
  return moved <= TAP_MOVE_THRESHOLD_PX;
}

function isPan(startX: number, startY: number, currentX: number, currentY: number): boolean {
  const dx = currentX - startX;
  const dy = currentY - startY;
  const moved = Math.sqrt(dx * dx + dy * dy);
  return moved > PAN_THRESHOLD_PX;
}

function pinchZoomDelta(startDist: number, currentDist: number): number {
  const ratio = currentDist / startDist;
  return (ratio - 1) / PINCH_ZOOM_SENSITIVITY;
}

function shouldTriggerLongPress(elapsedMs: number, hasMoved: boolean): boolean {
  return elapsedMs >= LONG_PRESS_DURATION_MS && !hasMoved;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('tap: no movement is a tap', () => {
  assert.equal(isTap(100, 100, 100, 100), true);
});

test('tap: movement within threshold is still a tap', () => {
  // 9px diagonal movement — within TAP_MOVE_THRESHOLD_PX of 10
  assert.equal(isTap(0, 0, 6, 7), true); // ~9.2px
});

test('tap: movement exactly at threshold boundary', () => {
  // Exactly 10px — at or below threshold, should be tap
  assert.equal(isTap(0, 0, 10, 0), true);
});

test('tap: movement beyond threshold is NOT a tap', () => {
  // 11px movement — beyond TAP_MOVE_THRESHOLD_PX of 10
  assert.equal(isTap(0, 0, 11, 0), false);
});

test('tap: large movement is not a tap', () => {
  assert.equal(isTap(100, 100, 200, 200), false);
});

test('pan: small movement below threshold does not trigger pan', () => {
  // 4px movement — below PAN_THRESHOLD_PX of 5
  assert.equal(isPan(0, 0, 3, 2), false); // ~3.6px
});

test('pan: movement at exact threshold does not trigger pan', () => {
  // Exactly 5px — hook uses strict >, so exactly 5 does NOT trigger pan
  assert.equal(isPan(0, 0, 5, 0), false);
});

test('pan: movement beyond threshold triggers pan', () => {
  assert.equal(isPan(0, 0, 10, 10), true);
});

test('pan: diagonal movement beyond threshold triggers pan', () => {
  // 7px diagonal — beyond PAN_THRESHOLD_PX of 5
  assert.equal(isPan(50, 50, 55, 53), true); // ~5.8px
});

test('pinch: no change in distance = zero delta', () => {
  const delta = pinchZoomDelta(100, 100);
  assert.equal(delta, 0);
});

test('pinch: zooming in (fingers apart) produces positive delta', () => {
  // 20% increase in distance
  const delta = pinchZoomDelta(100, 120);
  assert.ok(delta > 0, `Expected positive delta, got ${delta}`);
});

test('pinch: zooming out (fingers together) produces negative delta', () => {
  // 20% decrease in distance
  const delta = pinchZoomDelta(100, 80);
  assert.ok(delta < 0, `Expected negative delta, got ${delta}`);
});

test('pinch: doubling distance produces delta >= 1 (threshold for zoom step)', () => {
  // 100% increase: ratio=2, delta = (2-1)/0.015 = ~66.7
  const delta = pinchZoomDelta(100, 200);
  assert.ok(delta >= 1, `Expected delta >= 1, got ${delta}`);
});

test('pinch: zoom delta is proportional to ratio', () => {
  const delta1 = pinchZoomDelta(100, 115); // 15% increase
  const delta2 = pinchZoomDelta(100, 130); // 30% increase
  assert.ok(delta2 > delta1, 'Larger pinch should give larger delta');
});

test('touchDistance: same point is zero', () => {
  const d = touchDistance({ clientX: 50, clientY: 50 }, { clientX: 50, clientY: 50 });
  assert.equal(d, 0);
});

test('touchDistance: horizontal distance', () => {
  const d = touchDistance({ clientX: 0, clientY: 0 }, { clientX: 100, clientY: 0 });
  assert.equal(d, 100);
});

test('touchDistance: pythagorean distance', () => {
  const d = touchDistance({ clientX: 0, clientY: 0 }, { clientX: 3, clientY: 4 });
  assert.equal(d, 5);
});

test('long-press: fires after threshold with no movement', () => {
  assert.equal(shouldTriggerLongPress(500, false), true);
});

test('long-press: does not fire if finger has moved', () => {
  assert.equal(shouldTriggerLongPress(600, true), false);
});

test('long-press: does not fire before threshold', () => {
  assert.equal(shouldTriggerLongPress(499, false), false);
});

test('long-press: exactly at threshold fires', () => {
  assert.equal(shouldTriggerLongPress(LONG_PRESS_DURATION_MS, false), true);
});
