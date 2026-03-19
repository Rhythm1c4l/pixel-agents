/**
 * HTTP server — serves the PWA, assets, health check, and pairing endpoint.
 * Uses Node.js http.createServer (no Express dependency).
 */

import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';

import type { DecodedAssets } from './assetServer.js';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

export interface HttpServerOptions {
  /** Port to listen on (default: 3000) */
  port: number;
  /** Directory containing built PWA files (dist/pwa/) */
  pwaDir: string;
  /** Pre-decoded asset data */
  assets: DecodedAssets;
  /** Token validation function for mobile client pairing */
  validateToken: (token: string) => boolean;
}

/**
 * Create and start the HTTP server.
 * Returns the server instance for WebSocket upgrade attachment.
 */
export function createHttpServer(options: HttpServerOptions): http.Server {
  const { pwaDir, assets, validateToken } = options;

  // Pre-serialize asset JSON responses
  const characterJson = JSON.stringify(assets.characters);
  const floorJson = JSON.stringify(assets.floorSprites);
  const wallJson = JSON.stringify(assets.wallSets);
  const furnitureJson = JSON.stringify({
    catalog: assets.furnitureCatalog,
    sprites: assets.furnitureSprites,
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;


    // ── API routes ──

    if (pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', timestamp: Date.now() }));
      return;
    }

    if (pathname === '/pair') {
      const token = url.searchParams.get('token');
      if (token && validateToken(token)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ paired: true }));
      } else {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ paired: false, error: 'Invalid token' }));
      }
      return;
    }

    // ── Asset endpoints ──

    if (pathname === '/assets/characters') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(characterJson);
      return;
    }

    if (pathname === '/assets/floors') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(floorJson);
      return;
    }

    if (pathname === '/assets/walls') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(wallJson);
      return;
    }

    if (pathname === '/assets/furniture') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(furnitureJson);
      return;
    }

    // ── Static file serving (PWA) ──

    let filePath = path.join(pwaDir, pathname === '/' ? 'index.html' : pathname);

    // Security: prevent directory traversal
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(pwaDir))) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    // Try exact file, then .html, then index.html for SPA routing
    if (!fs.existsSync(filePath)) {
      if (fs.existsSync(filePath + '.html')) {
        filePath = filePath + '.html';
      } else {
        // SPA fallback — serve index.html for any unknown route
        filePath = path.join(pwaDir, 'index.html');
      }
    }

    try {
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        filePath = path.join(filePath, 'index.html');
      }

      if (!fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';

      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
      });

      const stream = fs.createReadStream(filePath);
      stream.pipe(res);
      stream.on('error', () => {
        if (!res.headersSent) {
          res.writeHead(500);
          res.end('Internal Server Error');
        } else {
          res.destroy();
        }
      });
    } catch {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  return server;
}
