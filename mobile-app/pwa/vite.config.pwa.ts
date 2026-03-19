/**
 * Vite config for the standalone PWA build.
 *
 * Output: dist/pwa/ (served by the Node.js server as static files)
 *
 * Differences from the VS Code webview build (vite.config.ts):
 * - Entry: src/pwaMain.tsx (instead of src/main.tsx)
 * - Output: dist/pwa/ (instead of dist/webview/)
 * - base: '/' (absolute paths for standalone HTTP serving)
 * - Service worker built as a separate chunk via the sw entry
 * - Copies pwa-manifest.json and icon.png to dist/pwa/
 * - Does not use VS Code postMessage mock (browser runtime)
 */

import react from '@vitejs/plugin-react';
import * as fs from 'fs';
import * as path from 'path';
import type { Plugin, ResolvedConfig } from 'vite';
import { defineConfig } from 'vite';

import { buildAssetIndex, buildFurnitureCatalog } from '../../shared/assets/build.ts';
import {
  decodeAllCharacters,
  decodeAllFloors,
  decodeAllFurniture,
  decodeAllWalls,
} from '../../shared/assets/loader.ts';

// ── PWA static file copy plugin ───────────────────────────────────────────────

function pwaStaticPlugin(): Plugin {
  let resolvedConfig: ResolvedConfig;
  const assetsDir = path.resolve(__dirname, '../../webview-ui/public/assets');

  return {
    name: 'pwa-static',
    configResolved(config) {
      resolvedConfig = config;
    },
    closeBundle() {
      const outDir = resolvedConfig.build.outDir;

      // Copy icon.png from project root for PWA install icon
      const iconSrc = path.resolve(__dirname, '../../icon.png');
      if (fs.existsSync(iconSrc)) {
        fs.copyFileSync(iconSrc, path.join(outDir, 'icon.png'));
      }

      // Write furniture catalog and asset index (same as existing build)
      const catalog = buildFurnitureCatalog(assetsDir);
      const distAssetsDir = path.join(outDir, 'assets');
      fs.mkdirSync(distAssetsDir, { recursive: true });
      fs.writeFileSync(path.join(distAssetsDir, 'furniture-catalog.json'), JSON.stringify(catalog));
      fs.writeFileSync(
        path.join(distAssetsDir, 'asset-index.json'),
        JSON.stringify(buildAssetIndex(assetsDir)),
      );

      // Pre-decoded sprite JSON (consumed by browser runtime via HTTP fetch)
      const decodedDir = path.join(distAssetsDir, 'decoded');
      fs.mkdirSync(decodedDir, { recursive: true });
      fs.writeFileSync(
        path.join(decodedDir, 'characters.json'),
        JSON.stringify(decodeAllCharacters(assetsDir)),
      );
      fs.writeFileSync(
        path.join(decodedDir, 'floors.json'),
        JSON.stringify(decodeAllFloors(assetsDir)),
      );
      fs.writeFileSync(
        path.join(decodedDir, 'walls.json'),
        JSON.stringify(decodeAllWalls(assetsDir)),
      );
      fs.writeFileSync(
        path.join(decodedDir, 'furniture.json'),
        JSON.stringify(decodeAllFurniture(assetsDir, catalog)),
      );
    },
  };
}

// ── Dev server middleware (mirrors vite.config.ts for parity) ─────────────────

function browserMockAssetsPlugin(): Plugin {
  const assetsDir = path.resolve(__dirname, '../../webview-ui/public/assets');

  interface DecodedCache {
    characters: ReturnType<typeof decodeAllCharacters> | null;
    floors: ReturnType<typeof decodeAllFloors> | null;
    walls: ReturnType<typeof decodeAllWalls> | null;
    furniture: ReturnType<typeof decodeAllFurniture> | null;
  }
  const cache: DecodedCache = { characters: null, floors: null, walls: null, furniture: null };

  return {
    name: 'browser-mock-assets-pwa',
    configureServer(server) {
      const base = server.config.base.replace(/\/$/, '');

      server.middlewares.use(`${base}/assets/furniture-catalog.json`, (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(buildFurnitureCatalog(assetsDir)));
      });
      server.middlewares.use(`${base}/assets/asset-index.json`, (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(buildAssetIndex(assetsDir)));
      });
      server.middlewares.use(`${base}/assets/decoded/characters.json`, (_req, res) => {
        cache.characters ??= decodeAllCharacters(assetsDir);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(cache.characters));
      });
      server.middlewares.use(`${base}/assets/decoded/floors.json`, (_req, res) => {
        cache.floors ??= decodeAllFloors(assetsDir);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(cache.floors));
      });
      server.middlewares.use(`${base}/assets/decoded/walls.json`, (_req, res) => {
        cache.walls ??= decodeAllWalls(assetsDir);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(cache.walls));
      });
      server.middlewares.use(`${base}/assets/decoded/furniture.json`, (_req, res) => {
        cache.furniture ??= decodeAllFurniture(assetsDir, buildFurnitureCatalog(assetsDir));
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(cache.furniture));
      });
    },
  };
}

// ── Config ────────────────────────────────────────────────────────────────────

export default defineConfig({
  plugins: [react(), browserMockAssetsPlugin(), pwaStaticPlugin()],
  build: {
    outDir: '../../dist/pwa',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        // Main PWA entry
        main: path.resolve(__dirname, 'index.pwa.html'),
        // Service worker as a separate chunk at the root
        'service-worker': path.resolve(__dirname, 'service-worker.ts'),
      },
      output: {
        // Service worker must live at root scope for full-origin cache access
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'service-worker') return 'service-worker.js';
          return 'assets/[name]-[hash].js';
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  // Serve at root (not ./ relative) for service worker scope
  base: '/',
});
