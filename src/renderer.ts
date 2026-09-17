/**
 * Procedural 2D renderer for the motorcycle trials game.
 *
 * Every pixel on screen is produced by primitive drawing calls on a single
 * `Graphics` instance: there are no textures, atlases, spritesheets or any
 * other external asset, and no image is ever generated off-screen. The scene
 * renders in screen space and projects Matter world coordinates through a
 * responsive transform, so `world.ts` stays completely independent from how
 * the simulation is presented.
 *
 * The art direction is a premium editorial outdoor look: a pale mint sky, a
 * soft sun, angular mountain silhouettes in atmospheric layers, a conifer
 * forest on three parallax planes, and cream/earth ground with a narrow
 * charcoal-green surface. Nothing in the background is ever darkened, so the
 * viewport stays spacious and readable at any aspect ratio.
 */

import Phaser from 'phaser';
import { CHUNK, clamp, hash } from './world.js';
import type { Bike, Simulation, Terrain, TerrainChunk } from './world.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Canvas height the world scale of `1` is authored against. */
const SCALE_REFERENCE_HEIGHT = 540;
const SCALE_MIN = 0.45;
const SCALE_MAX = 1.5;

/** Horizontal screen fraction the camera keeps the rider at. */
const FOCUS_X_FRACTION = 0.36;
/** Vertical screen fraction the ground under the rider is pinned to. */
const FOCUS_Y_FRACTION = 0.66;
/** Tighter vertical framing for narrow (portrait-ish) canvases. */
const FOCUS_Y_FRACTION_NARROW = 0.6;
/** Canvases narrower than this are framed with `FOCUS_Y_FRACTION_NARROW`. */
const NARROW_WIDTH = 720;

/** Exponential follow constants, in milliseconds. */
const CAM_SMOOTH_X_MS = 95;
const CAM_SMOOTH_Y_MS = 150;
/** A target further than this is treated as a teleport and snapped to. */
const CAM_SNAP_DISTANCE = 520;
/** Extra camera lift applied once the rider is high above the ground. */
const CAM_AIR_THRESHOLD = 130;
const CAM_AIR_FOLLOW = 0.45;

/** Hard cap on live dust particles. */
const MAX_DUST = 80;
/** Dust starts appearing once the rear wheel is roughly this fast. */
const DUST_MIN_SPEED = 3;
/** Speed above which dust emission is at full rate. */
const DUST_FULL_SPEED = 22;
/** Maximum dust spawned per second at full speed. */
const DUST_RATE = 46;
const DUST_LIFE_MIN = 0.28;
const DUST_LIFE_MAX = 0.62;
/** World radius of a wheel body, used for the tyre artwork. */
const WHEEL_RADIUS = 19;

// ---------------------------------------------------------------------------
// Sprite asset keys and base sizing
// ---------------------------------------------------------------------------

/** Parallax / shape tables for the three mountain planes. */
const RIDGE_PARALLAX: readonly number[] = [0.08, 0.17, 0.3];
const RIDGE_BASE: readonly number[] = [0.42, 0.455, 0.5];
const RIDGE_AMP: readonly number[] = [0.22, 0.165, 0.115];
const RIDGE_CELL: readonly number[] = [260, 200, 150];

/** Parallax / shape tables for the three forest planes. */
const FOREST_PARALLAX: readonly number[] = [0.34, 0.5, 0.68];
const FOREST_BASE: readonly number[] = [0.505, 0.55, 0.595];
const FOREST_HEIGHT: readonly number[] = [0.075, 0.105, 0.145];
const FOREST_SPACING: readonly number[] = [74, 92, 118];

/** Decorative cloud streaks and birds. */
const CLOUDS: readonly { y: number; w: number; h: number; speed: number; offset: number }[] = [
  { y: 0.1, w: 0.3, h: 0.024, speed: 5.5, offset: 0.05 },
  { y: 0.175, w: 0.22, h: 0.017, speed: 8, offset: 0.42 },
  { y: 0.072, w: 0.38, h: 0.028, speed: 3.6, offset: 0.71 },
];
const BIRDS: readonly { y: number; speed: number; offset: number; size: number }[] = [
  { y: 0.135, speed: 14, offset: 0.2, size: 1 },
  { y: 0.095, speed: 11, offset: 0.62, size: 0.82 },
  { y: 0.163, speed: 17, offset: 0.86, size: 0.7 },
];

/** Start marker placed on the first slope. */
const START_FLAG_X = 95;

// ---------------------------------------------------------------------------
// Shared paint constants
// ---------------------------------------------------------------------------

const TYRE = 0x1c1f1c;
const TYRE_KNOB = 0x30352d;
const RIM = 0xc9cfc9;
const RIM_DARK = 0x8d958f;
const SPOKE = 0xe2e7e0;
const HUB = 0x5a6159;
const SILVER = 0xcdd3cd;
const CHROME = 0xe8ece7;
const COIN_GOLD = 0xe3b132;
const COIN_LIGHT = 0xf8dd8d;
const COIN_RIM = 0xa97f16;
const COIN_SPEC = 0xfff6d2;
const ROCK_BODY = 0x8a8f84;
const ROCK_FACE = 0xa8ada0;
const ROCK_LINE = 0x6d7268;
const BARREL_BODY = 0xa8523a;
const BARREL_BAND = 0x6f3527;
const PLANK_BODY = 0xa8834f;
const PLANK_EDGE = 0x7d5f38;
const BEAM_BODY = 0x9aa39c;
const BEAM_EDGE = 0x6f7a74;

/** Body plastics for `SaveData.selectedBike`, in bike-id order. */
interface BikePaint {
  body: number;
  bodyDark: number;
  frame: number;
  seat: number;
  jersey: number;
  pants: number;
  helmet: number;
  boots: number;
}

const BIKE_PAINTS: readonly BikePaint[] = [
  {
    body: 0x7d8a4f,
    bodyDark: 0x5c6739,
    frame: 0x3c4232,
    seat: 0x2b2f28,
    jersey: 0x8f9a58,
    pants: 0x39402f,
    helmet: 0x4c5638,
    boots: 0x24261f,
  },
  {
    body: 0xd97429,
    bodyDark: 0xa9541a,
    frame: 0x34362f,
    seat: 0x26281f,
    jersey: 0xe28d3e,
    pants: 0x3a3a33,
    helmet: 0xb85c1c,
    boots: 0x242620,
  },
  {
    body: 0x3f74b0,
    bodyDark: 0x2b5285,
    frame: 0x2f3336,
    seat: 0x23272a,
    jersey: 0x5090cf,
    pants: 0x333c45,
    helmet: 0x2f5f96,
    boots: 0x212528,
  },
  {
    body: 0xc93838,
    bodyDark: 0x962020,
    frame: 0x332626,
    seat: 0x232020,
    jersey: 0xdc4848,
    pants: 0x3a2a2a,
    helmet: 0xa82626,
    boots: 0x222020,
  },
];

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

/** Full colour set for one track theme. */
export interface LandscapePalette {
  skyTop: number;
  skyMid: number;
  skyLow: number;
  sun: number;
  sunGlow: number;
  haze: number;
  ridges: readonly [number, number, number];
  ridgeLine: number;
  ridgeSnow: number;
  trees: readonly [number, number, number];
  groundBody: number;
  groundDeep: number;
  groundSurface: number;
  groundEdge: number;
  groundSpeck: number;
  bird: number;
  /** Silhouette used for the parallax vegetation planes. */
  foliage: 'conifer' | 'scrub';
  /** Dusts the nearest vegetation plane with snow. */
  snow: boolean;
}

const PALETTES: Readonly<Record<string, LandscapePalette>> = {
  pine: {
    skyTop: 0xdde8e0,
    skyMid: 0xe7eee5,
    skyLow: 0xf4f8f0,
    sun: 0xfdf8e8,
    sunGlow: 0xf2ebd4,
    haze: 0xeaf1e6,
    ridges: [0xcfdbcf, 0xb8cbbb, 0x94b4a3],
    ridgeLine: 0xa9c0b0,
    ridgeSnow: 0xf6faf4,
    trees: [0xb9cbbb, 0x93b09d, 0x66856f],
    groundBody: 0xbca790,
    groundDeep: 0xa38e77,
    groundSurface: 0x3f4a3a,
    groundEdge: 0x5d6d50,
    groundSpeck: 0x8f7c66,
    bird: 0x7d8f82,
    foliage: 'conifer',
    snow: false,
  },
  desert: {
    skyTop: 0xe9e2d6,
    skyMid: 0xf1e9dc,
    skyLow: 0xf9f3e7,
    sun: 0xfdf4dd,
    sunGlow: 0xf5e6c8,
    haze: 0xf2e7d6,
    ridges: [0xe3c8ae, 0xd2a488, 0xb87a5c],
    ridgeLine: 0xc59a7e,
    ridgeSnow: 0xf7ecd9,
    trees: [0xcbb596, 0xb29a75, 0x8e7a58],
    groundBody: 0xc4ab8e,
    groundDeep: 0xab9278,
    groundSurface: 0x4a4a34,
    groundEdge: 0x6b6a45,
    groundSpeck: 0x9c8163,
    bird: 0x9a8874,
    foliage: 'scrub',
    snow: false,
  },
  ice: {
    skyTop: 0xdfeaf0,
    skyMid: 0xe8f0f4,
    skyLow: 0xf6fafc,
    sun: 0xfbfdff,
    sunGlow: 0xe4eef4,
    haze: 0xe9f2f6,
    ridges: [0xd8e4ea, 0xbcd0da, 0x9ab8c8],
    ridgeLine: 0xa8c3d0,
    ridgeSnow: 0xffffff,
    trees: [0xc4d6dd, 0xa9c1cd, 0x87a7b8],
    groundBody: 0xc3ced4,
    groundDeep: 0xacb9c0,
    groundSurface: 0x44565e,
    groundEdge: 0x63787f,
    groundSpeck: 0x9fb0b8,
    bird: 0x8ba3b0,
    foliage: 'conifer',
    snow: true,
  },
};

const DEFAULT_PALETTE: LandscapePalette = PALETTES.pine as LandscapePalette;

/** Palette for a track theme; unknown themes fall back to the pine set. */
export function themePalette(theme: string): LandscapePalette {
  const found = Object.prototype.hasOwnProperty.call(PALETTES, theme)
    ? PALETTES[theme]
    : undefined;
  return found ?? DEFAULT_PALETTE;
}

/** World-to-screen scale for a given canvas height. */
export function landscapeScale(viewHeight: number): number {
  if (!Number.isFinite(viewHeight) || viewHeight <= 0) return 1;
  return clamp(viewHeight / SCALE_REFERENCE_HEIGHT, SCALE_MIN, SCALE_MAX);
}

/** Linear blend between two packed 0xRRGGBB colours. */
function mixColor(a: number, b: number, t: number): number {
  const k = clamp(t, 0, 1);
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * k);
  const g = Math.round(ag + (bg - ag) * k);
  const bl = Math.round(ab + (bb - ab) * k);
  return (r << 16) | (g << 8) | bl;
}

function pickPaint(id: number): BikePaint {
  const raw = Number.isFinite(id) ? Math.trunc(id) : 0;
  const index = clamp(raw, 0, BIKE_PAINTS.length - 1);
  return BIKE_PAINTS[index] as BikePaint;
}

function pickNumber(table: readonly number[], index: number): number {
  return table[clamp(index, 0, table.length - 1)] as number;
}

function pickColor(table: readonly [number, number, number], index: number): number {
  const i = clamp(Math.trunc(index), 0, 2);
  if (i <= 0) return table[0];
  if (i === 1) return table[1];
  return table[2];
}

/** Deterministic value in `[0,1)` used to scatter decoration. */
function scatter(index: number, salt: number, seed: number): number {
  return hash(index * 977 + salt * 31, seed);
}

interface Pt {
  x: number;
  y: number;
}

interface Dust {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
}

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

/**
 * Draws the whole game view for a single track. The scene never owns physics:
 * `sim` is supplied by the host, stepped elsewhere, and only read here.
 */
export class LandscapeScene extends Phaser.Scene {
  /** Simulation to visualise. `null` renders background scenery only. */
  public sim: Simulation | null = null;
  /** Preview framing: the camera locks onto the rider instead of easing. */
  public preview = true;
  /** Called once per frame with the frame delta, before anything is drawn. */
  public onFrame: ((delta: number) => void) | null = null;
  /** World x the camera centres its focus on; updated every frame. */
  public focusX = 170;
  /** World y pinned to the vertical focus line; updated every frame. */
  public focusY = 420;

  private gfx: Phaser.GameObjects.Graphics | null = null;

  private viewW = 0;
  private viewH = 0;
  private worldScale = 1;
  private anchorX = 0;
  private anchorY = 0;

  private camX = 0;
  private camY = 0;
  private camReady = false;

  private sceneTime = 0;
  private dust: Dust[] = [];
  private dustAccumulator = 0;

  preload(): void {
    // Every visual (terrain, bike, rider) is drawn procedurally with
    // Graphics in drawBike()/drawTerrain()/etc. — no image assets to load.
  }

  create(): void {
    this.gfx = this.add.graphics();
    this.gfx.setDepth(0);
    this.gfx.setScrollFactor(0);

    this.refreshViewport();
    this.scale.on(Phaser.Scale.Events.RESIZE, this.handleResize, this);
    this.events.on(Phaser.Scenes.Events.SHUTDOWN, this.handleShutdown, this);
    this.events.on(Phaser.Scenes.Events.DESTROY, this.handleShutdown, this);
  }

  update(_time: number, delta: number): void {
    this.onFrame?.(delta);

    const g = this.gfx;
    if (!g) return;

    const dt = clamp(Number.isFinite(delta) ? delta : 0, 0, 64) / 1000;
    this.sceneTime += dt;

    this.refreshViewport();
    this.updateCamera(delta);

    const sim = this.sim;
    const palette = themePalette(sim ? sim.config.theme : 'pine');

    g.clear();
    this.drawSky(g, palette);
    this.drawSun(g, palette);
    this.drawClouds(g, palette);
    this.drawBirds(g, palette);
    this.drawMountains(g, palette);
    this.drawHaze(g, palette);
    this.drawForest(g, palette);
    this.drawTerrain(g, palette);
    this.updateDust(dt);
    this.drawDust(g, palette);

    if (sim) {
      this.drawCoins(g);
      this.drawObstacles(g);
      this.drawFlags(g);
      this.drawBike(g, sim.bike);
    }

    this.drawFog(g, palette);
  }

  // -------------------------------------------------------------------------
  // Lifecycle helpers
  // -------------------------------------------------------------------------

  private handleResize(): void {
    this.refreshViewport();
  }

  private handleShutdown(): void {
    this.scale.off(Phaser.Scale.Events.RESIZE, this.handleResize, this);
    this.events.off(Phaser.Scenes.Events.SHUTDOWN, this.handleShutdown, this);
    this.events.off(Phaser.Scenes.Events.DESTROY, this.handleShutdown, this);
    this.dust = [];
    this.dustAccumulator = 0;
    if (this.gfx) {
      this.gfx.destroy();
      this.gfx = null;
    }
  }

  private refreshViewport(): void {
    const camera = this.cameras.main;
    const fallback = this.scale.gameSize;
    const width = camera ? camera.width : fallback.width;
    const height = camera ? camera.height : fallback.height;

    this.viewW = Math.max(1, Math.floor(Number.isFinite(width) && width > 0 ? width : 960));
    this.viewH = Math.max(1, Math.floor(Number.isFinite(height) && height > 0 ? height : 540));
    this.worldScale = landscapeScale(this.viewH);
    this.anchorX = this.viewW * FOCUS_X_FRACTION;
    this.anchorY =
      this.viewH * (this.viewW < NARROW_WIDTH ? FOCUS_Y_FRACTION_NARROW : FOCUS_Y_FRACTION);
  }

  // -------------------------------------------------------------------------
  // Projection
  // -------------------------------------------------------------------------

  private toScreenX(worldX: number): number {
    return (worldX - this.camX) * this.worldScale + this.anchorX;
  }

  private toScreenY(worldY: number): number {
    return (worldY - this.camY) * this.worldScale + this.anchorY;
  }

  /** Screen x of a parallax plane anchored at `parallax` (0 = static). */
  private planeX(worldX: number, parallax: number): number {
    return (worldX - this.camX * parallax) * this.worldScale + this.anchorX;
  }

  private planeStart(parallax: number, spacing: number): number {
    const left = this.camX * parallax - this.anchorX / this.worldScale;
    return Math.floor(left / spacing) * spacing;
  }

  private planeCount(spacing: number): number {
    return Math.ceil(this.viewW / (spacing * this.worldScale)) + 2;
  }

  private updateCamera(delta: number): void {
    const sim = this.sim;
    const bike = sim ? sim.bike : null;

    const targetX = bike ? bike.x : this.focusX;
    let targetY: number;

    if (sim && bike) {
      const ground = sim.terrain.height(targetX);
      const air = Math.max(0, ground - bike.y - CAM_AIR_THRESHOLD);
      targetY = ground - air * CAM_AIR_FOLLOW;
    } else {
      targetY = this.focusY;
    }

    const teleported = Math.abs(targetX - this.camX) > CAM_SNAP_DISTANCE;
    if (!this.camReady || this.preview || teleported) {
      this.camX = targetX;
      this.camY = targetY;
      this.camReady = true;
    } else {
      const step = clamp(Number.isFinite(delta) ? delta : 0, 0, 200);
      const kx = 1 - Math.exp(-step / CAM_SMOOTH_X_MS);
      const ky = 1 - Math.exp(-step / CAM_SMOOTH_Y_MS);
      this.camX += (targetX - this.camX) * kx;
      this.camY += (targetY - this.camY) * ky;
    }

    this.focusX = this.camX;
    this.focusY = this.camY;
  }

  // -------------------------------------------------------------------------
  // Sky and weather
  // -------------------------------------------------------------------------

  private drawSky(g: Phaser.GameObjects.Graphics, p: LandscapePalette): void {
    const bands = 10;
    const bandHeight = this.viewH / bands;
    for (let i = 0; i < bands; i++) {
      const t = i / (bands - 1);
      const color = t < 0.5
        ? mixColor(p.skyTop, p.skyMid, t * 2)
        : mixColor(p.skyMid, p.skyLow, (t - 0.5) * 2);
      g.fillStyle(color, 1);
      g.fillRect(0, i * bandHeight, this.viewW, bandHeight + 1.5);
    }
  }

  private drawSun(g: Phaser.GameObjects.Graphics, p: LandscapePalette): void {
    const x = this.viewW * 0.78;
    const y = this.viewH * 0.17;
    const radius = Math.max(24, this.viewH * 0.052);

    for (let ring = 4; ring >= 1; ring--) {
      g.fillStyle(p.sunGlow, 0.05 + (4 - ring) * 0.028);
      g.fillCircle(x, y, radius * (1 + ring * 0.52));
    }

    g.fillStyle(p.sun, 0.92);
    g.fillCircle(x, y, radius);
  }

  private drawClouds(g: Phaser.GameObjects.Graphics, p: LandscapePalette): void {
    const span = this.viewW + 640;
    const tone = mixColor(p.skyLow, 0xffffff, 0.7);

    for (let i = 0; i < CLOUDS.length; i++) {
      const cloud = CLOUDS[i];
      if (!cloud) continue;
      const width = this.viewW * cloud.w;
      const height = Math.max(6, this.viewH * cloud.h);
      const y = this.viewH * cloud.y;
      let x = (cloud.offset * span - this.sceneTime * cloud.speed) % span;
      if (x < 0) x += span;
      x -= 320;

      g.fillStyle(tone, 0.55);
      g.fillEllipse(x, y, width, height);
      g.fillStyle(tone, 0.4);
      g.fillEllipse(x + width * 0.34, y + height * 0.16, width * 0.66, height * 0.86);
      g.fillStyle(tone, 0.34);
      g.fillEllipse(x - width * 0.3, y + height * 0.24, width * 0.56, height * 0.7);
    }
  }

  private drawBirds(g: Phaser.GameObjects.Graphics, p: LandscapePalette): void {
    const span = this.viewW + 320;
    g.lineStyle(Math.max(1.1, this.viewH * 0.0032), p.bird, 0.5);

    for (let i = 0; i < BIRDS.length; i++) {
      const bird = BIRDS[i];
      if (!bird) continue;
      const size = Math.max(3.5, this.viewH * 0.013 * bird.size);
      let x = (bird.offset * span - this.sceneTime * bird.speed) % span;
      if (x < 0) x += span;
      x -= 160;
      const y = this.viewH * bird.y + Math.sin(this.sceneTime * 0.8 + i * 1.9) * this.viewH * 0.01;
      const flap = 0.55 + Math.sin(this.sceneTime * 3.4 + i * 1.7) * 0.45;

      g.beginPath();
      g.moveTo(x - size, y + size * flap);
      g.lineTo(x, y);
      g.lineTo(x + size, y + size * flap);
      g.strokePath();
    }
  }

  // -------------------------------------------------------------------------
  // Distant landscape
  // -------------------------------------------------------------------------

  private ridgeProfile(worldX: number, cell: number, seed: number): number {
    const f = worldX / cell;
    const i = Math.floor(f);
    const t = f - i;
    const a = hash(i, seed);
    const b = hash(i + 1, seed);

    const f2 = worldX / (cell * 0.42);
    const i2 = Math.floor(f2);
    const t2 = f2 - i2;
    const a2 = hash(i2, seed + 7);
    const b2 = hash(i2 + 1, seed + 7);

    return (a + (b - a) * t) * 0.74 + (a2 + (b2 - a2) * t2) * 0.26;
  }

  private drawMountains(g: Phaser.GameObjects.Graphics, p: LandscapePalette): void {
    for (let layer = 0; layer < 3; layer++) {
      this.drawRidgeLayer(g, layer, p);
    }
  }

  private drawRidgeLayer(
    g: Phaser.GameObjects.Graphics,
    layer: number,
    p: LandscapePalette,
  ): void {
    const parallax = pickNumber(RIDGE_PARALLAX, layer);
    const baseY = this.viewH * pickNumber(RIDGE_BASE, layer);
    const amplitude = this.viewH * pickNumber(RIDGE_AMP, layer);
    const cell = pickNumber(RIDGE_CELL, layer);
    const seed = 9001 + layer * 137;
    const color = pickColor(p.ridges, layer);

    const start = this.planeStart(parallax, cell);
    const count = this.planeCount(cell);
    const bottom = this.viewH * 0.62;

    const points: Pt[] = [];
    for (let i = 0; i <= count; i++) {
      const worldX = start + i * cell;
      points.push({
        x: this.planeX(worldX, parallax),
        y: baseY - this.ridgeProfile(worldX, cell, seed) * amplitude,
      });
    }

    g.fillStyle(color, 1);
    g.beginPath();
    g.moveTo(points[0]?.x ?? 0, points[0]?.y ?? baseY);
    for (let i = 1; i < points.length; i++) {
      const point = points[i];
      if (point) g.lineTo(point.x, point.y);
    }
    g.lineTo(points[points.length - 1]?.x ?? this.viewW, bottom);
    g.lineTo(points[0]?.x ?? 0, bottom);
    g.closePath();
    g.fillPath();

    // Subtle hand-drawn contour lines echo the silhouette further down.
    const contour = Math.max(1, this.viewH * 0.0018);
    for (let line = 1; line <= 2; line++) {
      const drop = this.viewH * (0.018 + line * 0.022);
      g.lineStyle(contour, p.ridgeLine, 0.16 / line);
      g.beginPath();
      g.moveTo((points[0]?.x ?? 0) - 40, (points[0]?.y ?? baseY) + drop);
      for (let i = 1; i < points.length; i++) {
        const point = points[i];
        if (point) g.lineTo(point.x, point.y + drop);
      }
      g.strokePath();
    }

    if (p.ridgeSnow !== color && layer >= 1) {
      g.lineStyle(Math.max(1.6, this.viewH * 0.005), p.ridgeSnow, layer === 2 ? 0.55 : 0.38);
      g.beginPath();
      g.moveTo(points[0]?.x ?? 0, (points[0]?.y ?? baseY) + 2);
      for (let i = 1; i < points.length; i++) {
        const point = points[i];
        if (point) g.lineTo(point.x, point.y + 2);
      }
      g.strokePath();
    }
  }

  private drawHaze(g: Phaser.GameObjects.Graphics, p: LandscapePalette): void {
    const centre = this.viewH * 0.47;
    const spread = this.viewH * 0.15;
    const bands = 10;
    const bandHeight = (spread * 2) / bands;

    for (let i = 0; i < bands; i++) {
      const t = i / (bands - 1);
      const alpha = 0.15 * (1 - Math.abs(t * 2 - 1));
      g.fillStyle(p.haze, alpha);
      g.fillRect(0, centre - spread + t * spread * 2, this.viewW, bandHeight + 1.5);
    }
  }

  private drawForest(g: Phaser.GameObjects.Graphics, p: LandscapePalette): void {
    for (let layer = 0; layer < 3; layer++) {
      const parallax = pickNumber(FOREST_PARALLAX, layer);
      const spacing = pickNumber(FOREST_SPACING, layer);
      const baseY = this.viewH * pickNumber(FOREST_BASE, layer);
      const height = this.viewH * pickNumber(FOREST_HEIGHT, layer);
      const color = pickColor(p.trees, layer);
      const alpha = 1;
      const seed = 4201 + layer * 313;

      const start = this.planeStart(parallax, spacing);
      const count = this.planeCount(spacing);

      for (let i = 0; i <= count; i++) {
        const worldX = start + i * spacing;
        const jitter = scatter(i + layer * 101, 3, seed);
        if (jitter < 0.17) continue;

        const x = this.planeX(worldX + jitter * spacing * 0.7, parallax);
        const scale = 0.68 + scatter(i + layer * 101, 11, seed) * 0.62;
        const y = baseY + (scatter(i + layer * 101, 19, seed) - 0.5) * this.viewH * 0.012;

        if (p.groundSurface === PALETTES.desert?.groundSurface) {
          this.drawScrub(g, x, y, height * scale, color, alpha);
        } else {
          this.drawConifer(g, x, y, height * scale, color, alpha, p.snow && layer === 2);
        }
      }
    }
  }

  private drawConifer(
    g: Phaser.GameObjects.Graphics,
    x: number,
    baseY: number,
    height: number,
    color: number,
    alpha: number,
    snowy: boolean,
  ): void {
    const halfWidth = height * 0.3;

    g.fillStyle(mixColor(color, 0x000000, 0.25), alpha);
    g.fillRect(x - Math.max(1, height * 0.025), baseY - height * 0.16, Math.max(2, height * 0.05), height * 0.2);

    g.fillStyle(color, alpha);
    for (let tier = 0; tier < 3; tier++) {
      const bottom = baseY - tier * height * 0.235;
      const top = bottom - height * 0.54;
      const width = halfWidth * (1 - tier * 0.2);
      g.fillTriangle(x, top, x - width, bottom, x + width, bottom);
    }

    if (snowy) {
      g.fillStyle(0xffffff, 0.34);
      for (let tier = 0; tier < 3; tier++) {
        const bottom = baseY - tier * height * 0.235;
        const top = bottom - height * 0.54;
        const width = halfWidth * (1 - tier * 0.2) * 0.55;
        g.fillTriangle(x, top, x - width, top + height * 0.2, x + width, top + height * 0.2);
      }
    }
  }

  private drawScrub(
    g: Phaser.GameObjects.Graphics,
    x: number,
    baseY: number,
    height: number,
    color: number,
    alpha: number,
  ): void {
    const radius = height * 0.24;
    g.fillStyle(mixColor(color, 0x000000, 0.18), alpha);
    g.fillEllipse(x, baseY - radius * 0.5, radius * 2.4, radius * 1.1);
    g.fillStyle(color, alpha);
    g.fillCircle(x - radius * 0.55, baseY - radius * 0.85, radius * 0.72);
    g.fillCircle(x + radius * 0.5, baseY - radius * 0.95, radius * 0.66);
    g.fillCircle(x, baseY - radius * 1.5, radius * 0.82);
  }

  // -------------------------------------------------------------------------
  // Ground
  // -------------------------------------------------------------------------

  private drawTerrain(g: Phaser.GameObjects.Graphics, p: LandscapePalette): void {
    const sim = this.sim;
    if (!sim) return;

    const x0 = this.camX - this.anchorX / this.worldScale - 48;
    const x1 = this.camX + (this.viewW - this.anchorX) / this.worldScale + 48;
    const bottomY = this.viewH + 24;

    // Every run shares one gradient origin. Deriving it per run would make the
    // depth bands disagree across a chunk seam and draw a visible vertical line.
    let topY = bottomY;
    for (const chunk of sim.terrain.chunks.values()) {
      const chunkStart = chunk.index * CHUNK;
      if (chunkStart + CHUNK < x0 || chunkStart > x1) continue;
      for (const point of chunk.points) {
        const screenY = this.toScreenY(point.y);
        if (screenY < topY) topY = screenY;
      }
    }

    for (const chunk of sim.terrain.chunks.values()) {
      const chunkStart = chunk.index * CHUNK;
      if (chunkStart + CHUNK < x0 || chunkStart > x1) continue;
      this.drawGroundChunk(g, chunk, sim.terrain, p, bottomY, topY);
    }
  }

  private drawGroundChunk(
    g: Phaser.GameObjects.Graphics,
    chunk: TerrainChunk,
    terrain: Terrain,
    p: LandscapePalette,
    bottomY: number,
    topY: number,
  ): void {
    const points = chunk.points;
    let run: Pt[] = [];

    const flush = (): void => {
      if (run.length >= 2) this.drawGroundRun(g, run, p, bottomY, topY, chunk.index);
      run = [];
    };

    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      if (!a || !b) continue;

      // A hole is exactly where the physics refused to build a collider, so
      // the drawn surface and the simulated surface never disagree.
      if (terrain.gap((a.x + b.x) / 2)) {
        flush();
        continue;
      }
      if (run.length === 0) run.push({ x: this.toScreenX(a.x), y: this.toScreenY(a.y) });
      run.push({ x: this.toScreenX(b.x), y: this.toScreenY(b.y) });
    }
    flush();
  }

  private drawGroundRun(
    g: Phaser.GameObjects.Graphics,
    run: Pt[],
    p: LandscapePalette,
    bottomY: number,
    topY: number,
    chunkIndex: number,
  ): void {
    const first = run[0];
    const last = run[run.length - 1];
    if (!first || !last) return;

    // Earth body, split into horizontal bands so it gains depth downwards.
    const bands = 12;
    const span = Math.max(24, bottomY - topY);
    for (let band = 0; band < bands; band++) {
      const y0 = topY + (span * band) / bands;
      const y1 = topY + (span * (band + 1)) / bands;
      g.fillStyle(mixColor(p.groundBody, p.groundDeep, Math.pow(band / (bands - 1), 1.3)), 1);
      g.beginPath();
      g.moveTo(first.x, clamp(first.y, y0, y1));
      for (let i = 1; i < run.length; i++) {
        const point = run[i];
        if (point) g.lineTo(point.x, clamp(point.y, y0, y1));
      }
      g.lineTo(last.x, y1);
      g.lineTo(first.x, y1);
      g.closePath();
      g.fillPath();
    }

    this.drawGroundTexture(g, run, p, bottomY, chunkIndex);

    // Narrow charcoal-green surface riding on the crest of the earth.
    const surfaceWidth = Math.max(4, 9 * this.worldScale);
    g.lineStyle(surfaceWidth, p.groundSurface, 1);
    g.beginPath();
    g.moveTo(first.x, first.y + surfaceWidth * 0.45);
    for (let i = 1; i < run.length; i++) {
      const point = run[i];
      if (point) g.lineTo(point.x, point.y + surfaceWidth * 0.45);
    }
    g.strokePath();

    g.lineStyle(Math.max(1.2, 1.9 * this.worldScale), p.groundEdge, 0.95);
    g.beginPath();
    g.moveTo(first.x, first.y);
    for (let i = 1; i < run.length; i++) {
      const point = run[i];
      if (point) g.lineTo(point.x, point.y);
    }
    g.strokePath();
  }

  private drawGroundTexture(
    g: Phaser.GameObjects.Graphics,
    run: Pt[],
    p: LandscapePalette,
    bottomY: number,
    chunkIndex: number,
  ): void {
    const seed = this.sim ? this.sim.config.seed : 1;
    const scale = this.worldScale;

    for (let i = 0; i < run.length; i += 2) {
      const point = run[i];
      if (!point) continue;

      const key = chunkIndex * 977 + i;
      if (scatter(key, 5, seed) > 0.55) continue;

      const depth = (26 + scatter(key, 13, seed) * 130) * scale;
      const y = point.y + depth;
      if (y > bottomY - 6) continue;

      // Never let a stratum poke out of a slope that rises away from it.
      let inside = true;
      for (let k = i; k < Math.min(run.length, i + 3); k++) {
        const ahead = run[k];
        if (ahead && ahead.y > y) {
          inside = false;
          break;
        }
      }
      if (!inside) continue;

      const length = (16 + scatter(key, 23, seed) * 48) * scale;
      g.lineStyle(Math.max(1, 1.9 * scale), p.groundSpeck, 0.3);
      g.lineBetween(point.x, y, point.x + length, y);

      if (scatter(key, 29, seed) < 0.5) {
        const dotY = y + (16 + scatter(key, 37, seed) * 40) * scale;
        if (dotY < bottomY - 6) {
          g.fillStyle(p.groundSpeck, 0.24);
          g.fillCircle(point.x + length * 0.5, dotY, Math.max(1, 1.7 * scale));
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Collectables and props
  // -------------------------------------------------------------------------

  private drawCoins(g: Phaser.GameObjects.Graphics): void {
    const sim = this.sim;
    if (!sim) return;

    const scale = this.worldScale;
    const elapsed = sim.elapsed;
    const x0 = this.camX - this.anchorX / this.worldScale - 80;
    const x1 = this.camX + (this.viewW - this.anchorX) / this.worldScale + 80;

    for (const chunk of sim.terrain.chunks.values()) {
      for (const coin of chunk.coins) {
        if (sim.terrain.collected.has(coin.id)) continue;
        if (coin.x < x0 || coin.x > x1) continue;

        const x = this.toScreenX(coin.x);
        const y = this.toScreenY(coin.y);
        const pulse = 1 + Math.sin(elapsed * 4 + coin.x * 0.05) * 0.05;
        const radius = Math.max(5, 13 * scale * pulse);

        g.fillStyle(COIN_GOLD, 1);
        g.fillCircle(x, y, radius);
        g.fillStyle(COIN_LIGHT, 1);
        g.fillCircle(x, y, radius * 0.62);
        g.fillStyle(COIN_SPEC, 0.9);
        g.fillCircle(x - radius * 0.2, y - radius * 0.24, radius * 0.24);
        g.lineStyle(Math.max(1, 1.8 * scale), COIN_RIM, 0.85);
        g.strokeCircle(x, y, radius);
      }
    }
  }

  private drawObstacles(g: Phaser.GameObjects.Graphics): void {
    const sim = this.sim;
    if (!sim) return;

    const scale = this.worldScale;
    const x0 = this.camX - this.anchorX / this.worldScale - 220;
    const x1 = this.camX + (this.viewW - this.anchorX) / this.worldScale + 220;

    for (const obstacle of sim.terrain.obstacles) {
      const body = obstacle.body;
      const worldX = body.position.x;
      if (worldX < x0 || worldX > x1) continue;

      const vertices: Pt[] = body.vertices.map((vertex) => ({
        x: this.toScreenX(vertex.x),
        y: this.toScreenY(vertex.y),
      }));
      if (vertices.length < 3) continue;

      switch (obstacle.kind) {
        case 'rock':
          this.drawRock(g, vertices, scale);
          break;
        case 'barrel':
          this.drawBarrel(g, vertices, body.angle, body.circleRadius ?? 20, scale);
          break;
        case 'platform':
          this.drawPlatform(g, vertices, scale);
          break;
        case 'beam':
          this.drawBeam(g, vertices, scale);
          break;
        default:
          this.fillPolygon(g, vertices, ROCK_BODY, 1);
          break;
      }
    }
  }

  private drawRock(g: Phaser.GameObjects.Graphics, vertices: Pt[], scale: number): void {
    this.fillPolygon(g, vertices, ROCK_BODY, 1);
    this.fillPolygon(g, shrinkPolygon(vertices, 0.42), ROCK_FACE, 0.85);
    g.lineStyle(Math.max(1, 1.6 * scale), ROCK_LINE, 0.5);
    this.strokePolygon(g, vertices);
    g.lineStyle(Math.max(1, 1.3 * scale), ROCK_LINE, 0.45);
    const a = vertices[0];
    const b = vertices[Math.floor(vertices.length / 2)];
    if (a && b) g.lineBetween(a.x, a.y, b.x, b.y);
  }

  private drawBarrel(
    g: Phaser.GameObjects.Graphics,
    vertices: Pt[],
    angle: number,
    radius: number,
    scale: number,
  ): void {
    const centre = centroid(vertices);
    const r = Math.max(6, radius * scale);
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    const nx = Math.cos(angle + Math.PI / 2);
    const ny = Math.sin(angle + Math.PI / 2);

    g.fillStyle(BARREL_BODY, 1);
    g.fillCircle(centre.x, centre.y, r);

    g.lineStyle(Math.max(1.2, 2.4 * scale), BARREL_BAND, 0.85);
    g.beginPath();
    for (const offset of [-0.46, 0, 0.46]) {
      const half = Math.sqrt(Math.max(0, r * r - (offset * r) * (offset * r)));
      g.moveTo(
        centre.x + nx * offset * r - ux * half,
        centre.y + ny * offset * r - uy * half,
      );
      g.lineTo(
        centre.x + nx * offset * r + ux * half,
        centre.y + ny * offset * r + uy * half,
      );
    }
    g.strokePath();

    g.fillStyle(0xffffff, 0.16);
    g.fillCircle(centre.x - r * 0.32, centre.y - r * 0.34, r * 0.34);
  }

  private drawPlatform(g: Phaser.GameObjects.Graphics, vertices: Pt[], scale: number): void {
    this.fillPolygon(g, vertices, PLANK_BODY, 1);
    g.lineStyle(Math.max(1.2, 2.4 * scale), PLANK_EDGE, 1);
    this.strokePolygon(g, vertices);

    const top = topEdge(vertices);
    if (top) {
      g.lineStyle(Math.max(1.4, 3 * scale), PLANK_EDGE, 0.9);
      g.lineBetween(top[0].x, top[0].y, top[1].x, top[1].y);
    }
  }

  private drawBeam(g: Phaser.GameObjects.Graphics, vertices: Pt[], scale: number): void {
    this.fillPolygon(g, vertices, BEAM_BODY, 1);
    this.fillPolygon(g, shrinkPolygon(vertices, 0.3), 0xc3ccc5, 0.5);
    g.lineStyle(Math.max(1.2, 2.2 * scale), BEAM_EDGE, 1);
    this.strokePolygon(g, vertices);
  }

  private drawFlags(g: Phaser.GameObjects.Graphics): void {
    const sim = this.sim;
    if (!sim) return;

    const scale = this.worldScale;
    const x0 = this.camX - this.anchorX / this.worldScale - 90;
    const x1 = this.camX + (this.viewW - this.anchorX) / this.worldScale + 90;

    if (START_FLAG_X >= x0 && START_FLAG_X <= x1) {
      this.drawStartFlag(g, START_FLAG_X, sim.terrain.height(START_FLAG_X), scale);
    }

    const finishX = sim.terrain.finishX;
    if (Number.isFinite(finishX) && finishX >= x0 && finishX <= x1) {
      this.drawFinishFlag(g, finishX, sim.terrain.height(finishX), scale);
    }
  }

  private drawStartFlag(
    g: Phaser.GameObjects.Graphics,
    worldX: number,
    groundY: number,
    scale: number,
  ): void {
    const x = this.toScreenX(worldX);
    const base = this.toScreenY(groundY);
    const height = 46 * scale;

    g.lineStyle(Math.max(1.4, 2.4 * scale), 0x5b6350, 1);
    g.lineBetween(x, base, x, base - height);

    g.fillStyle(0x7f8b4c, 1);
    g.beginPath();
    g.moveTo(x, base - height);
    g.lineTo(x + 22 * scale, base - height + 7 * scale);
    g.lineTo(x, base - height + 15 * scale);
    g.closePath();
    g.fillPath();
  }

  private drawFinishFlag(
    g: Phaser.GameObjects.Graphics,
    worldX: number,
    groundY: number,
    scale: number,
  ): void {
    const x = this.toScreenX(worldX);
    const base = this.toScreenY(groundY);
    const height = 82 * scale;

    g.fillStyle(0xd8ddd6, 0.35);
    g.fillRect(x - 3 * scale, base - height, 6 * scale, height);
    g.fillStyle(0x545c50, 1);
    g.fillRect(x - 1.4 * scale, base - height, 2.8 * scale, height);

    const flagW = 46 * scale;
    const flagH = 30 * scale;
    const top = base - height;
    const cols = 4;
    const rows = 3;
    const cellW = flagW / cols;
    const cellH = flagH / rows;

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const dark = (row + col) % 2 === 0;
        g.fillStyle(dark ? 0x2f342c : 0xf2f4ee, 1);
        g.fillRect(x + 1.4 * scale + col * cellW, top + row * cellH, cellW + 0.6, cellH + 0.6);
      }
    }

    g.lineStyle(Math.max(1, 1.4 * scale), 0x6d746a, 0.8);
    g.strokeRect(x + 1.4 * scale, top, flagW, flagH);
  }

  // -------------------------------------------------------------------------
  // Dust
  // -------------------------------------------------------------------------

  private updateDust(dt: number): void {
    const sim = this.sim;
    const bike = sim ? sim.bike : null;

    for (let i = this.dust.length - 1; i >= 0; i--) {
      const particle = this.dust[i];
      if (!particle) continue;
      particle.life -= dt;
      if (particle.life <= 0) {
        this.dust.splice(i, 1);
        continue;
      }
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.vy += 46 * dt;
      particle.vx *= 1 - 1.6 * dt;
      particle.vy *= 1 - 0.6 * dt;
    }

    if (!bike || this.preview || !bike.grounded) {
      this.dustAccumulator = 0;
      return;
    }

    const speed = bike.speed;
    if (speed < DUST_MIN_SPEED) {
      this.dustAccumulator = 0;
      return;
    }

    const intensity = clamp(
      (speed - DUST_MIN_SPEED) / (DUST_FULL_SPEED - DUST_MIN_SPEED),
      0,
      1,
    );
    this.dustAccumulator += dt * DUST_RATE * intensity;

    while (this.dustAccumulator >= 1) {
      this.dustAccumulator -= 1;
      if (this.dust.length >= MAX_DUST) break;
      this.spawnDust(bike, intensity);
    }

    if (this.dust.length > MAX_DUST) this.dust.length = MAX_DUST;
  }

  private spawnDust(bike: Bike, intensity: number): void {
    const life = DUST_LIFE_MIN + Math.random() * (DUST_LIFE_MAX - DUST_LIFE_MIN);
    this.dust.push({
      x: bike.rear.position.x - 12 + Math.random() * 16,
      y: bike.rear.position.y + WHEEL_RADIUS - Math.random() * 8,
      vx: -22 - Math.random() * 34 * intensity,
      vy: -14 - Math.random() * 30 * intensity,
      life,
      max: life,
      size: 4 + Math.random() * 7,
    });
  }

  private drawDust(g: Phaser.GameObjects.Graphics, p: LandscapePalette): void {
    if (this.dust.length === 0) return;
    const scale = this.worldScale;
    const tone = mixColor(p.groundBody, 0xffffff, 0.45);

    for (const particle of this.dust) {
      const t = clamp(particle.life / particle.max, 0, 1);
      g.fillStyle(tone, 0.36 * t);
      g.fillCircle(
        this.toScreenX(particle.x),
        this.toScreenY(particle.y),
        Math.max(1.5, particle.size * (1.6 - t) * scale),
      );
    }
  }

  // -------------------------------------------------------------------------
  // Weather overlay
  // -------------------------------------------------------------------------

  private drawFog(g: Phaser.GameObjects.Graphics, p: LandscapePalette): void {
    const sim = this.sim;
    if (!sim || sim.config.modifier !== 'fog') return;

    const bands = 9;
    const bandHeight = this.viewH / bands;
    for (let i = 0; i < bands; i++) {
      const t = i / (bands - 1);
      const alpha = 0.06 + 0.1 * (1 - Math.abs(t * 2 - 1));
      g.fillStyle(p.haze, alpha);
      g.fillRect(0, i * bandHeight, this.viewW, bandHeight + 1.5);
    }
  }

  // -------------------------------------------------------------------------
  // Bike and rider
  // -------------------------------------------------------------------------

  private drawBike(g: Phaser.GameObjects.Graphics, bike: Bike): void {
    const scale = this.worldScale;
    const paint = pickPaint(bike.save.selectedBike);
    const chassis = bike.chassis;
    const angle = chassis.angle;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const originX = chassis.position.x;
    const originY = chassis.position.y;

    const local = (lx: number, ly: number): Pt => ({
      x: this.toScreenX(originX + lx * cos - ly * sin),
      y: this.toScreenY(originY + lx * sin + ly * cos),
    });

    const rearHub: Pt = {
      x: this.toScreenX(bike.rear.position.x),
      y: this.toScreenY(bike.rear.position.y),
    };
    const frontHub: Pt = {
      x: this.toScreenX(bike.front.position.x),
      y: this.toScreenY(bike.front.position.y),
    };
    const headWorld = bike.head.position;
    const head: Pt = { x: this.toScreenX(headWorld.x), y: this.toScreenY(headWorld.y) };

    // Head expressed in chassis space so the rider stays welded to physics.
    const headLocalX = (headWorld.x - originX) * cos + (headWorld.y - originY) * sin;
    const headLocalY = -(headWorld.x - originX) * sin + (headWorld.y - originY) * cos;

    const lean = clamp(bike.lean, -1, 1) * 11;

    const pivot = local(-30, 4);
    const steer = local(24, -12);
    const engine = local(-4, 6);
    const seatRear = local(-22, -12);
    const seatFront = local(0, -14);
    const bar = local(28, -26);
    const foot = local(-8, 9);

    const wheelRadius = WHEEL_RADIUS * scale;

    // --- suspension and wheels -------------------------------------------
    this.pill(g, pivot.x, pivot.y, rearHub.x, rearHub.y, Math.max(2.5, 5.4 * scale), 0x2f342e);
    this.drawShock(g, local(-18, -14), { x: rearHub.x, y: rearHub.y - wheelRadius * 0.3 }, scale);

    const forkTop = steer;
    this.pill(g, forkTop.x, forkTop.y, frontHub.x, frontHub.y, Math.max(2, 4.6 * scale), SILVER);
    this.pill(
      g,
      forkTop.x + 3 * scale,
      forkTop.y + 2 * scale,
      frontHub.x + 3 * scale,
      frontHub.y,
      Math.max(1.2, 2.2 * scale),
      RIM_DARK,
    );

    this.drawFender(g, frontHub, wheelRadius * 1.16, angle, paint.body);
    this.drawFender(g, rearHub, wheelRadius * 1.14, angle, paint.bodyDark);

    this.drawWheel(g, rearHub, bike.rear.angle, scale);
    this.drawWheel(g, frontHub, bike.front.angle, scale);

    // --- frame ------------------------------------------------------------
    const tube = Math.max(2, 4.4 * scale);
    this.pill(g, seatRear.x, seatRear.y, steer.x, steer.y, tube, paint.bodyDark);
    this.pill(g, seatRear.x, seatRear.y, pivot.x, pivot.y, tube, paint.bodyDark);
    this.pill(g, steer.x, steer.y, engine.x, engine.y, tube, paint.bodyDark);
    this.pill(g, engine.x, engine.y, pivot.x, pivot.y, tube, paint.bodyDark);
    this.pill(g, seatFront.x, seatFront.y, engine.x, engine.y, Math.max(1.4, 2.6 * scale), paint.frame);

    // --- controls and bodywork -------------------------------------------
    this.pill(g, steer.x, steer.y, bar.x, bar.y, Math.max(1.4, 2.8 * scale), 0x30342d);
    this.pill(g, bar.x - 7 * scale, bar.y - 5 * scale, bar.x + 7 * scale, bar.y + 5 * scale, Math.max(1.4, 3 * scale), 0x24271f);

    this.pill(g, seatRear.x, seatRear.y, seatFront.x + 4 * scale, seatFront.y, Math.max(2.4, 6.4 * scale), paint.seat);

    const tankA = local(-4, -17);
    const tankB = local(15, -13);
    this.pill(g, tankA.x, tankA.y, tankB.x, tankB.y, Math.max(3, 10 * scale), paint.body);

    const panelA = local(-16, -6);
    const panelB = local(2, -8);
    this.pill(g, panelA.x, panelA.y, panelB.x, panelB.y, Math.max(2.4, 8 * scale), paint.bodyDark);

    const exhaustA = local(-6, 10);
    const exhaustB = local(18, 12);
    const exhaustC = local(30, 2);
    this.pill(g, exhaustA.x, exhaustA.y, exhaustB.x, exhaustB.y, Math.max(1.8, 3.6 * scale), CHROME);
    this.pill(g, exhaustB.x, exhaustB.y, exhaustC.x, exhaustC.y, Math.max(1.6, 3.2 * scale), SILVER);

    // --- rider ------------------------------------------------------------
    // A trials rider stands on the pegs: hips back and low, knees forward,
    // torso angled over the bars, shoulders carried by the physics head body.
    const shoulderLocalX = headLocalX + lean * 0.9;
    const shoulderLocalY = headLocalY + 14;
    const hip = local(-16 + lean * 0.3, -14);
    const knee = local(2 + lean * 0.7, -10);
    const shoulder = local(shoulderLocalX, shoulderLocalY);

    const farLeg = mixColor(paint.pants, 0x000000, 0.24);
    const farArm = mixColor(paint.jersey, 0x000000, 0.22);

    const kneeFar: Pt = { x: knee.x - 5 * scale, y: knee.y + 2 * scale };
    const hipFar: Pt = { x: hip.x - 5 * scale, y: hip.y + 2 * scale };
    const footFar: Pt = { x: foot.x - 6 * scale, y: foot.y + 1 * scale };
    const elbowFar: Pt = {
      x: (shoulder.x + bar.x) / 2 - 5 * scale + lean * scale,
      y: (shoulder.y + bar.y) / 2 + 4 * scale,
    };

    // Far side limbs first so the near side reads in front of the body.
    this.pill(g, hipFar.x, hipFar.y, kneeFar.x, kneeFar.y, Math.max(2.6, 6.6 * scale), farLeg);
    this.pill(g, kneeFar.x, kneeFar.y, footFar.x, footFar.y, Math.max(2.4, 5.8 * scale), farLeg);
    this.pill(g, shoulder.x, shoulder.y, elbowFar.x, elbowFar.y, Math.max(2, 4.8 * scale), farArm);
    this.pill(g, elbowFar.x, elbowFar.y, bar.x, bar.y, Math.max(1.8, 4.2 * scale), farArm);

    this.pill(g, hip.x, hip.y, knee.x, knee.y, Math.max(2.8, 7.6 * scale), paint.pants);
    this.pill(g, knee.x, knee.y, foot.x, foot.y, Math.max(2.6, 6.6 * scale), paint.pants);
    this.pill(g, foot.x - 3 * scale, foot.y, foot.x + 10 * scale, foot.y + 1.5 * scale, Math.max(2.2, 5.2 * scale), paint.boots);

    this.pill(g, hip.x, hip.y, shoulder.x, shoulder.y, Math.max(5, 16 * scale), paint.jersey);
    this.pill(g, shoulder.x, shoulder.y, head.x + 2 * scale, head.y + 5 * scale, Math.max(2.4, 5.6 * scale), mixColor(paint.jersey, 0x000000, 0.1));

    const elbowNear: Pt = {
      x: (shoulder.x + bar.x) / 2 + 2 * scale + lean * scale,
      y: (shoulder.y + bar.y) / 2 - 1 * scale,
    };
    this.pill(g, shoulder.x, shoulder.y, elbowNear.x, elbowNear.y, Math.max(2.4, 5.8 * scale), paint.jersey);
    this.pill(g, elbowNear.x, elbowNear.y, bar.x, bar.y, Math.max(2, 5 * scale), mixColor(paint.jersey, 0x000000, 0.16));
    g.fillStyle(0x2a2d26, 1);
    g.fillCircle(bar.x, bar.y, Math.max(1.8, 3.6 * scale));

    this.drawHelmet(g, head, scale, paint);
  }

  private drawHelmet(
    g: Phaser.GameObjects.Graphics,
    head: Pt,
    scale: number,
    paint: BikePaint,
  ): void {
    const r = Math.max(5, 9 * scale);

    g.fillStyle(paint.helmet, 1);
    g.fillCircle(head.x, head.y, r);
    g.fillStyle(mixColor(paint.helmet, 0xffffff, 0.28), 0.55);
    g.fillCircle(head.x - r * 0.22, head.y - r * 0.3, r * 0.52);

    g.lineStyle(Math.max(1.4, 2.6 * scale), 0x1f231d, 0.9);
    g.beginPath();
    g.arc(head.x, head.y, r * 0.86, -0.42, 0.62, false);
    g.strokePath();

    this.pill(
      g,
      head.x - r * 0.2,
      head.y - r * 0.86,
      head.x + r * 1.02,
      head.y - r * 0.6,
      Math.max(1.6, 3.4 * scale),
      mixColor(paint.helmet, 0x000000, 0.35),
    );
  }

  private drawWheel(
    g: Phaser.GameObjects.Graphics,
    hub: Pt,
    angle: number,
    scale: number,
  ): void {
    const r = WHEEL_RADIUS * scale;

    g.fillStyle(TYRE, 1);
    g.fillCircle(hub.x, hub.y, r * 0.94);

    const knobs = 13;
    g.lineStyle(Math.max(1.6, 3.4 * scale), TYRE_KNOB, 1);
    g.beginPath();
    for (let i = 0; i < knobs; i++) {
      const a = angle + (i * Math.PI * 2) / knobs;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      g.moveTo(hub.x + ca * r * 0.83, hub.y + sa * r * 0.83);
      g.lineTo(hub.x + ca * r, hub.y + sa * r);
    }
    g.strokePath();

    g.lineStyle(Math.max(1.4, r * 0.24), RIM, 1);
    g.strokeCircle(hub.x, hub.y, r * 0.56);

    g.lineStyle(Math.max(1, 1.5 * scale), SPOKE, 0.85);
    g.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = angle + (i * Math.PI) / 6;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      g.moveTo(hub.x - ca * r * 0.54, hub.y - sa * r * 0.54);
      g.lineTo(hub.x + ca * r * 0.54, hub.y + sa * r * 0.54);
    }
    g.strokePath();

    g.lineStyle(Math.max(1, 1.8 * scale), RIM_DARK, 0.55);
    g.strokeCircle(hub.x, hub.y, r * 0.4);

    g.fillStyle(HUB, 1);
    g.fillCircle(hub.x, hub.y, r * 0.19);
    g.fillStyle(SILVER, 1);
    g.fillCircle(hub.x, hub.y, r * 0.09);
  }

  private drawShock(
    g: Phaser.GameObjects.Graphics,
    from: Pt,
    to: Pt,
    scale: number,
  ): void {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    if (length < 1) return;

    const ux = dx / length;
    const uy = dy / length;
    const nx = -uy;
    const ny = ux;

    g.lineStyle(Math.max(1.2, 2.2 * scale), SILVER, 1);
    g.lineBetween(from.x, from.y, to.x, to.y);

    g.lineStyle(Math.max(1, 1.6 * scale), RIM_DARK, 0.9);
    g.beginPath();
    for (let i = 1; i <= 5; i++) {
      const t = i / 6;
      const cx = from.x + dx * t;
      const cy = from.y + dy * t;
      const half = Math.max(2, 4.4 * scale);
      g.moveTo(cx - nx * half, cy - ny * half);
      g.lineTo(cx + nx * half, cy + ny * half);
    }
    g.strokePath();
  }

  private drawFender(
    g: Phaser.GameObjects.Graphics,
    hub: Pt,
    radius: number,
    angle: number,
    color: number,
  ): void {
    g.lineStyle(Math.max(2, 4.4 * this.worldScale), color, 0.95);
    g.beginPath();
    g.arc(hub.x, hub.y, radius, angle - Math.PI * 0.94, angle - Math.PI * 0.34, false);
    g.strokePath();
  }

  // -------------------------------------------------------------------------
  // Small drawing helpers
  // -------------------------------------------------------------------------

  /** Thick two-point stroke; Phaser renders round caps, giving a pill shape. */
  private pill(
    g: Phaser.GameObjects.Graphics,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    width: number,
    color: number,
    alpha = 1,
  ): void {
    g.lineStyle(width, color, alpha);
    g.strokePoints([{ x: ax, y: ay }, { x: bx, y: by }], false, false);
  }

  private fillPolygon(
    g: Phaser.GameObjects.Graphics,
    vertices: Pt[],
    color: number,
    alpha: number,
  ): void {
    if (vertices.length < 3) return;
    g.fillStyle(color, alpha);
    g.fillPoints(vertices, true, true);
  }

  private strokePolygon(g: Phaser.GameObjects.Graphics, vertices: Pt[]): void {
    if (vertices.length < 3) return;
    g.strokePoints(vertices, true, true);
  }
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function centroid(vertices: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const vertex of vertices) {
    x += vertex.x;
    y += vertex.y;
  }
  const count = Math.max(1, vertices.length);
  return { x: x / count, y: y / count };
}

/** Vertices pulled towards the centroid, used for lit facets. */
function shrinkPolygon(vertices: Pt[], amount: number): Pt[] {
  const centre = centroid(vertices);
  const k = clamp(amount, 0, 0.95);
  return vertices.map((vertex) => ({
    x: vertex.x + (centre.x - vertex.x) * k,
    y: vertex.y + (centre.y - vertex.y) * k,
  }));
}

/** The two vertices forming the highest edge, used as a surface highlight. */
function topEdge(vertices: Pt[]): [Pt, Pt] | null {
  let best: Pt | null = null;
  let second: Pt | null = null;
  for (const vertex of vertices) {
    if (!best || vertex.y < best.y) {
      second = best;
      best = vertex;
    } else if (!second || vertex.y < second.y) {
      second = vertex;
    }
  }
  return best && second ? [best, second] : null;
}
