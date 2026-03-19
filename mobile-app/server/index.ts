#!/usr/bin/env node
/**
 * Pixel Agents — standalone server CLI entry point.
 *
 * Usage:
 *   node server/index.js [options]
 *
 * Options:
 *   --port <n>       Port to listen on (default: 3000)
 *   --assets <dir>   Assets directory (default: webview-ui/public/assets)
 *   --pwa <dir>      PWA build directory (default: dist/pwa)
 *   --qr             Show pairing QR/URL on startup
 *   --dry-run        Load assets and exit (for testing)
 */

import * as path from 'path';

import { DEFAULT_ASSETS_DIR, DEFAULT_PORT, DEFAULT_PWA_DIR } from './constants.js';
import { loadAllAssets } from './assetServer.js';
import { createHttpServer } from './httpServer.js';
import { SessionScanner } from './sessionScanner.js';
import { AgentTracker } from './agentTracker.js';
import { TranscriptProcessor } from './transcriptProcessor.js';
import { WsServer } from './wsServer.js';
import { watchLayout, writeLayout, readLayout } from './layoutManager.js';
import { generatePairing, validateToken, renderPairingDisplay } from './qrGenerator.js';

// ── CLI argument parsing ──────────────────────────────────────

function parseArgs(argv: string[]): {
  port: number;
  assetsDir: string;
  pwaDir: string;
  showQr: boolean;
  dryRun: boolean;
} {
  let port = DEFAULT_PORT;
  let assetsDir = DEFAULT_ASSETS_DIR;
  let pwaDir = DEFAULT_PWA_DIR;
  let showQr = false;
  let dryRun = false;

  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--port':
        port = parseInt(argv[++i], 10) || DEFAULT_PORT;
        break;
      case '--assets':
        assetsDir = argv[++i];
        break;
      case '--pwa':
        pwaDir = argv[++i];
        break;
      case '--qr':
        showQr = true;
        break;
      case '--dry-run':
        dryRun = true;
        break;
    }
  }

  return { port, assetsDir, pwaDir, showQr, dryRun };
}

// ── Main ──────────────────────────────────────────────────────

function main(): void {
  const args = parseArgs(process.argv);
  const resolvedAssets = path.resolve(args.assetsDir);
  const resolvedPwa = path.resolve(args.pwaDir);

  console.log(`[Pixel Agents Server] Loading assets from: ${resolvedAssets}`);
  const assets = loadAllAssets(resolvedAssets);

  if (args.dryRun) {
    console.log('[Pixel Agents Server] Dry run complete — assets loaded successfully.');
    process.exit(0);
  }

  // Generate pairing token
  const pairing = generatePairing(args.port);

  // Create HTTP server
  const httpServer = createHttpServer({
    port: args.port,
    pwaDir: resolvedPwa,
    assets,
    validateToken,
  });

  // Create session scanner and agent tracker
  const scanner = new SessionScanner();
  const tracker = new AgentTracker();

  // Create transcript processor (bridges sessions → agent tracker)
  const processor = new TranscriptProcessor(scanner, tracker);

  // Create WebSocket server
  const wsServer = new WsServer(tracker, scanner, validateToken);
  wsServer.attach(httpServer);

  // Watch layout file for external changes → broadcast to clients
  const layoutWatcher = watchLayout((layout) => {
    // Broadcast layout update to all connected clients
    // (WsServer doesn't have a direct broadcastAll, but we can use tracker events)
    // For now, layout changes are picked up on client reconnect via fullState
    console.log('[Pixel Agents Server] Layout changed externally');
  });

  // Start everything
  scanner.start();
  processor.start();

  httpServer.listen(args.port, '0.0.0.0', () => {
    console.log(`[Pixel Agents Server] Listening on port ${args.port}`);

    if (args.showQr) {
      console.log('');
      console.log(renderPairingDisplay(pairing));
      console.log('');
    } else {
      console.log(`[Pixel Agents Server] Pairing URL: ${pairing.url}`);
    }
  });

  // Graceful shutdown
  function shutdown(): void {
    console.log('\n[Pixel Agents Server] Shutting down...');
    layoutWatcher.dispose();
    wsServer.dispose();
    processor.dispose();
    scanner.dispose();
    tracker.dispose();
    httpServer.close(() => {
      console.log('[Pixel Agents Server] Goodbye.');
      process.exit(0);
    });
    // Force exit after 3s if server doesn't close gracefully
    setTimeout(() => process.exit(0), 3000);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
