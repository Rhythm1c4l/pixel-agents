import { useCallback, useRef } from 'react';

// Thresholds
const TAP_MOVE_THRESHOLD_PX = 10;
const LONG_PRESS_DURATION_MS = 500;
const PAN_THRESHOLD_PX = 5;
const PINCH_ZOOM_SENSITIVITY = 0.015;

export interface TouchGestureHandlers {
  onTap?: (clientX: number, clientY: number) => void;
  onLongPress?: (clientX: number, clientY: number) => void;
  onPanStart?: (clientX: number, clientY: number) => void;
  onPanMove?: (deltaX: number, deltaY: number) => void;
  onPanEnd?: () => void;
  onPinchZoom?: (zoomDelta: number) => void;
}

interface TouchState {
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  startTime: number;
  hasMoved: boolean;
  isPanning: boolean;
}

function distance(t1: React.Touch, t2: React.Touch): number {
  const dx = t1.clientX - t2.clientX;
  const dy = t1.clientY - t2.clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Touch gesture hook for OfficeCanvas.
 * Handles: single-finger tap (select), single-finger drag (pan),
 * two-finger pinch (zoom), long-press (erase context action).
 *
 * Returns event handlers to spread onto the target element.
 */
export function useTouchGestures(handlers: TouchGestureHandlers) {
  const touchStateRef = useRef<TouchState | null>(null);
  const pinchStartDistRef = useRef<number | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = useRef(false);

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      e.preventDefault();

      if (e.touches.length === 2) {
        // Two fingers: start pinch
        clearLongPressTimer();
        touchStateRef.current = null;
        pinchStartDistRef.current = distance(e.touches[0], e.touches[1]);
        return;
      }

      if (e.touches.length === 1) {
        const touch = e.touches[0];
        touchStateRef.current = {
          startX: touch.clientX,
          startY: touch.clientY,
          lastX: touch.clientX,
          lastY: touch.clientY,
          startTime: Date.now(),
          hasMoved: false,
          isPanning: false,
        };
        longPressFiredRef.current = false;
        pinchStartDistRef.current = null;

        // Start long-press timer
        longPressTimerRef.current = setTimeout(() => {
          const state = touchStateRef.current;
          if (state && !state.hasMoved) {
            longPressFiredRef.current = true;
            handlers.onLongPress?.(state.startX, state.startY);
          }
        }, LONG_PRESS_DURATION_MS);
      }
    },
    [handlers, clearLongPressTimer],
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      e.preventDefault();

      if (e.touches.length === 2 && pinchStartDistRef.current !== null) {
        // Pinch-zoom
        const currentDist = distance(e.touches[0], e.touches[1]);
        const ratio = currentDist / pinchStartDistRef.current;
        // Convert ratio to a zoom delta: positive = zoom in, negative = zoom out
        // sensitivity factor controls how much a small pinch maps to zoom steps
        const zoomDelta = (ratio - 1) / PINCH_ZOOM_SENSITIVITY;
        if (Math.abs(zoomDelta) >= 1) {
          handlers.onPinchZoom?.(zoomDelta);
          pinchStartDistRef.current = currentDist;
        }
        return;
      }

      if (e.touches.length === 1) {
        const state = touchStateRef.current;
        if (!state) return;
        const touch = e.touches[0];

        const totalDx = touch.clientX - state.startX;
        const totalDy = touch.clientY - state.startY;
        const moved = Math.sqrt(totalDx * totalDx + totalDy * totalDy);

        if (moved > TAP_MOVE_THRESHOLD_PX) {
          state.hasMoved = true;
          clearLongPressTimer();
        }

        if (moved > PAN_THRESHOLD_PX) {
          if (!state.isPanning) {
            state.isPanning = true;
            handlers.onPanStart?.(touch.clientX, touch.clientY);
          }
          const dx = touch.clientX - state.lastX;
          const dy = touch.clientY - state.lastY;
          handlers.onPanMove?.(dx, dy);
        }

        state.lastX = touch.clientX;
        state.lastY = touch.clientY;
      }
    },
    [handlers, clearLongPressTimer],
  );

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      e.preventDefault();
      clearLongPressTimer();
      pinchStartDistRef.current = null;

      const state = touchStateRef.current;
      if (!state) return;
      touchStateRef.current = null;

      if (state.isPanning) {
        handlers.onPanEnd?.();
        return;
      }

      if (!longPressFiredRef.current && !state.hasMoved) {
        // It's a tap — use the changedTouches position
        const touch = e.changedTouches[0];
        if (touch) {
          handlers.onTap?.(touch.clientX, touch.clientY);
        }
      }
    },
    [handlers, clearLongPressTimer],
  );

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

  return {
    onTouchStart: handleTouchStart,
    onTouchMove: handleTouchMove,
    onTouchEnd: handleTouchEnd,
    onTouchCancel: handleTouchCancel,
  };
}
