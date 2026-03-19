/**
 * Server-side asset loader — loads and decodes all assets from the assets directory.
 * Uses shared decoders (pngDecoder, manifestUtils, loader). No VS Code dependency.
 *
 * Provides pre-decoded asset data that can be served via HTTP or WebSocket.
 */

import * as fs from 'fs';
import * as path from 'path';

import { decodeCharacterPng, parseWallPng, pngToSpriteData } from '../../shared/assets/pngDecoder.js';
import type {
  FurnitureAsset,
  FurnitureManifest,
  InheritedProps,
  ManifestGroup,
} from '../../shared/assets/manifestUtils.js';
import { flattenManifest } from '../../shared/assets/manifestUtils.js';
import type { CharacterDirectionSprites } from '../../shared/assets/types.js';

// ── Loaded asset data ─────────────────────────────────────────

export interface DecodedAssets {
  characters: CharacterDirectionSprites[];
  floorSprites: string[][][];
  wallSets: string[][][][];
  furnitureCatalog: FurnitureAsset[];
  furnitureSprites: Record<string, string[][]>;
  defaultLayout: Record<string, unknown> | null;
}

// ── Floor tile loading ────────────────────────────────────────

function loadFloorSprites(assetsDir: string): string[][][] {
  const floorsFile = path.join(assetsDir, 'floors.png');
  if (!fs.existsSync(floorsFile)) {
    console.warn('[AssetServer] floors.png not found');
    return [];
  }

  const pngBuffer = fs.readFileSync(floorsFile);
  // floors.png is a horizontal strip: N tiles × 16px each, all 16px tall
  const { PNG } = require('pngjs') as typeof import('pngjs');
  const png = PNG.sync.read(pngBuffer);
  const tileSize = 16;
  const tileCount = Math.floor(png.width / tileSize);
  const sprites: string[][][] = [];

  for (let t = 0; t < tileCount; t++) {
    const sprite: string[][] = [];
    for (let y = 0; y < tileSize; y++) {
      const row: string[] = [];
      for (let x = 0; x < tileSize; x++) {
        const idx = (y * png.width + (t * tileSize + x)) * 4;
        const r = png.data[idx];
        const g = png.data[idx + 1];
        const b = png.data[idx + 2];
        const a = png.data[idx + 3];
        if (a < 2) {
          row.push('');
        } else {
          const hex = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`.toUpperCase();
          row.push(a >= 255 ? hex : `${hex}${a.toString(16).padStart(2, '0').toUpperCase()}`);
        }
      }
      sprite.push(row);
    }
    sprites.push(sprite);
  }
  return sprites;
}

// ── Wall tile loading ─────────────────────────────────────────

function loadWallSets(assetsDir: string): string[][][][] {
  const wallsFile = path.join(assetsDir, 'walls.png');
  if (!fs.existsSync(wallsFile)) {
    console.warn('[AssetServer] walls.png not found');
    return [];
  }
  const pngBuffer = fs.readFileSync(wallsFile);
  return [parseWallPng(pngBuffer)];
}

// ── Character sprite loading ──────────────────────────────────

function loadCharacters(assetsDir: string): CharacterDirectionSprites[] {
  const charDir = path.join(assetsDir, 'characters');
  if (!fs.existsSync(charDir)) {
    console.warn('[AssetServer] characters/ directory not found');
    return [];
  }

  const files = fs.readdirSync(charDir)
    .filter((f) => /^char_\d+\.png$/i.test(f))
    .sort((a, b) => {
      const na = parseInt(a.match(/\d+/)![0], 10);
      const nb = parseInt(b.match(/\d+/)![0], 10);
      return na - nb;
    });

  return files.map((filename) => {
    const pngBuffer = fs.readFileSync(path.join(charDir, filename));
    return decodeCharacterPng(pngBuffer);
  });
}

// ── Furniture loading ─────────────────────────────────────────

function loadFurniture(assetsDir: string): { catalog: FurnitureAsset[]; sprites: Record<string, string[][]> } {
  const furnitureDir = path.join(assetsDir, 'furniture');
  if (!fs.existsSync(furnitureDir)) {
    console.warn('[AssetServer] furniture/ directory not found');
    return { catalog: [], sprites: {} };
  }

  const entries = fs.readdirSync(furnitureDir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory());

  const catalog: FurnitureAsset[] = [];
  const sprites: Record<string, string[][]> = {};

  for (const dir of dirs) {
    const itemDir = path.join(furnitureDir, dir.name);
    const manifestPath = path.join(itemDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;

    try {
      const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(manifestContent) as FurnitureManifest;

      const inherited: InheritedProps = {
        groupId: manifest.id,
        name: manifest.name,
        category: manifest.category,
        canPlaceOnWalls: manifest.canPlaceOnWalls,
        canPlaceOnSurfaces: manifest.canPlaceOnSurfaces,
        backgroundTiles: manifest.backgroundTiles,
      };

      let assets: FurnitureAsset[];

      if (manifest.type === 'asset') {
        assets = [{
          id: manifest.id,
          name: manifest.name,
          label: manifest.name,
          category: manifest.category,
          file: manifest.file ?? `${manifest.id}.png`,
          width: manifest.width!,
          height: manifest.height!,
          footprintW: manifest.footprintW!,
          footprintH: manifest.footprintH!,
          isDesk: manifest.category === 'desks',
          canPlaceOnWalls: manifest.canPlaceOnWalls,
          canPlaceOnSurfaces: manifest.canPlaceOnSurfaces,
          backgroundTiles: manifest.backgroundTiles,
          groupId: manifest.id,
        }];
      } else {
        if (manifest.rotationScheme) {
          inherited.rotationScheme = manifest.rotationScheme;
        }
        const rootGroup: ManifestGroup = {
          type: 'group',
          groupType: manifest.groupType as 'rotation' | 'state' | 'animation',
          rotationScheme: manifest.rotationScheme,
          members: manifest.members!,
        };
        assets = flattenManifest(rootGroup, inherited);
      }

      for (const asset of assets) {
        try {
          const assetPath = path.join(itemDir, asset.file);
          if (!fs.existsSync(assetPath)) continue;
          const pngBuffer = fs.readFileSync(assetPath);
          sprites[asset.id] = pngToSpriteData(pngBuffer, asset.width, asset.height);
        } catch (err) {
          console.warn(`[AssetServer] Error loading ${asset.id}:`, err);
        }
      }

      catalog.push(...assets);
    } catch (err) {
      console.warn(`[AssetServer] Error processing manifest in ${dir.name}:`, err);
    }
  }

  return { catalog, sprites };
}

// ── Default layout loading ────────────────────────────────────

function loadDefaultLayout(assetsDir: string): Record<string, unknown> | null {
  const layoutPath = path.join(assetsDir, 'default-layout.json');
  try {
    if (!fs.existsSync(layoutPath)) return null;
    const raw = fs.readFileSync(layoutPath, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ── Main loader ───────────────────────────────────────────────

/**
 * Load and decode all assets from the given assets directory.
 * This is synchronous and should be called at server startup.
 */
export function loadAllAssets(assetsDir: string): DecodedAssets {
  console.log(`[AssetServer] Loading assets from: ${assetsDir}`);

  const characters = loadCharacters(assetsDir);
  console.log(`[AssetServer] Loaded ${characters.length} character sprites`);

  const floorSprites = loadFloorSprites(assetsDir);
  console.log(`[AssetServer] Loaded ${floorSprites.length} floor tile patterns`);

  const wallSets = loadWallSets(assetsDir);
  console.log(`[AssetServer] Loaded ${wallSets.length} wall tile set(s)`);

  const { catalog: furnitureCatalog, sprites: furnitureSprites } = loadFurniture(assetsDir);
  console.log(`[AssetServer] Loaded ${furnitureCatalog.length} furniture assets`);

  const defaultLayout = loadDefaultLayout(assetsDir);
  console.log(`[AssetServer] Default layout: ${defaultLayout ? 'found' : 'not found'}`);

  return {
    characters,
    floorSprites,
    wallSets,
    furnitureCatalog,
    furnitureSprites,
    defaultLayout,
  };
}
