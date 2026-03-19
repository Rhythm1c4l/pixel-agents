/**
 * PWA entry point.
 *
 * Used when the app is served as a standalone PWA (not inside VS Code).
 * Shows ConnectionScreen → establishes WebSocket transport → renders PwaApp.
 *
 * Referenced by index.pwa.html (built via vite.config.pwa.ts).
 */

import '../../webview-ui/src/index.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { PwaApp } from './PwaApp.js';

// Register service worker for offline caching
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/service-worker.js')
      .then((reg) => {
        console.log('[PWA] Service worker registered:', reg.scope);
      })
      .catch((err) => {
        console.warn('[PWA] Service worker registration failed:', err);
      });
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PwaApp />
  </StrictMode>,
);
