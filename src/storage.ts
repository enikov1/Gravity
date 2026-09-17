/**
 * Persistent save state for the motorcycle trials game.
 *
 * Everything that comes from outside the module (localStorage, cloud saves,
 * console callers) is treated as untrusted and sanitized before it is used.
 */

export type UpgradeKey = 'power' | 'suspension' | 'grip';

export interface SaveStats {
  bestEndless: number;
  runs: number;
  crashes: number;
  totalDistance: number;
}

export interface SaveData {
  version: 1;
  coins: number;
  unlocked: number;
  selectedBike: number;
  bikes: number[];
  upgrades: Record<UpgradeKey, number>;
  records: Record<string, { time: number; stars: number }>;
  stats: SaveStats;
  sound: boolean;
  updatedAt: number;
}

export const STORAGE_KEY = 'gravity-trail-v1';
export const UPGRADE_KEYS: readonly UpgradeKey[] = ['power', 'suspension', 'grip'];
export const MAX_UPGRADE_LEVEL = 5;
export const UPGRADE_BASE_COST = 100;
/** Purchase price of each non-starter bike. Bike 0 is owned from the start. */
export const BIKE_PRICES: Readonly<Record<number, number>> = { 1: 400, 2: 900, 3: 1600 };
export const MAX_RECORDS = 200;

const SAVE_VERSION = 1;
const MAX_COINS = 99_999_999;
const MAX_LEVEL_INDEX = 200;
const MAX_BIKE_ID = 3;
const MAX_TIME = 86_400;
const MAX_STARS = 3;
const MAX_KEY_LENGTH = 64;
const MAX_TIMESTAMP = 8_640_000_000_000_000;
const MAX_STAT_VALUE = 99_999_999;

const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'];

/** Fresh save used on first launch and whenever stored data cannot be trusted. */
export function createDefaultSave(): SaveData {
  return {
    version: SAVE_VERSION,
    coins: 0,
    unlocked: 1,
    selectedBike: 0,
    bikes: [0],
    upgrades: { power: 0, suspension: 0, grip: 0 },
    records: {},
    stats: { bestEndless: 0, runs: 0, crashes: 0, totalDistance: 0 },
    sound: false,
    updatedAt: 0,
  };
}

/** Purchase price of a bike, or null when the id is not a buyable bike. */
export function bikePrice(id: number): number | null {
  if (!Number.isInteger(id)) return null;
  const price = Object.prototype.hasOwnProperty.call(BIKE_PRICES, id)
    ? BIKE_PRICES[id]
    : undefined;
  return typeof price === 'number' && Number.isFinite(price) && price > 0 ? price : null;
}

interface WebStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function getLocalStorage(): WebStorage | null {
  try {
    const store = (globalThis as { localStorage?: WebStorage }).localStorage;
    if (!store) return null;
    const probe = '__gravity_probe__';
    store.setItem(probe, '1');
    store.removeItem(probe);
    return store;
  } catch {
    // Blocked by privacy settings, sandboxed iframe, or unavailable entirely.
    return null;
  }
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

/**
 * Integer that must fall inside [min, max]; anything else yields the fallback.
 * Used where an out-of-range value would otherwise be a free reward (coins,
 * upgrades, unlocks).
 */
function boundedInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = toFiniteNumber(value);
  if (parsed === null) return fallback;
  const truncated = Math.trunc(parsed);
  if (truncated < min || truncated > max) return fallback;
  return truncated;
}

/** Integer clamped into [min, max]; only non-finite values yield the fallback. */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = toFiniteNumber(value);
  if (parsed === null) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUpgradeKey(value: unknown): value is UpgradeKey {
  return value === 'power' || value === 'suspension' || value === 'grip';
}

function isSafeRecordKey(key: string): boolean {
  return (
    key.length > 0 &&
    key.length <= MAX_KEY_LENGTH &&
    !FORBIDDEN_KEYS.includes(key)
  );
}

function sanitizeBikes(value: unknown): number[] {
  const bikes = new Set<number>([0]);
  if (Array.isArray(value)) {
    for (const entry of value) {
      const id = boundedInt(entry, 0, MAX_BIKE_ID, -1);
      if (id >= 0) bikes.add(id);
    }
  }
  return Array.from(bikes).sort((a, b) => a - b);
}

function sanitizeUpgrades(value: unknown): Record<UpgradeKey, number> {
  const source = isPlainObject(value) ? value : {};
  const upgrades: Record<UpgradeKey, number> = { power: 0, suspension: 0, grip: 0 };
  for (const key of UPGRADE_KEYS) {
    upgrades[key] = boundedInt(source[key], 0, MAX_UPGRADE_LEVEL, 0);
  }
  return upgrades;
}

function sanitizeRecords(value: unknown): Record<string, { time: number; stars: number }> {
  const records: Record<string, { time: number; stars: number }> = {};
  if (!isPlainObject(value)) return records;

  // Sorted so the trim below is deterministic for identical inputs.
  const keys = Object.keys(value).filter(isSafeRecordKey).sort();
  for (const key of keys) {
    if (Object.keys(records).length >= MAX_RECORDS) break;
    const entry = value[key];
    if (!isPlainObject(entry)) continue;
    const time = toFiniteNumber(entry.time);
    if (time === null || time < 0 || time > MAX_TIME) continue;
    records[key] = { time, stars: clampInt(entry.stars, 0, MAX_STARS, 0) };
  }
  return records;
}

function sanitizeStats(value: unknown): SaveStats {
  const source = isPlainObject(value) ? value : {};
  return {
    bestEndless: clampInt(source.bestEndless, 0, MAX_STAT_VALUE, 0),
    runs: clampInt(source.runs, 0, MAX_STAT_VALUE, 0),
    crashes: clampInt(source.crashes, 0, MAX_STAT_VALUE, 0),
    totalDistance: clampInt(source.totalDistance, 0, MAX_STAT_VALUE, 0),
  };
}

/** Returns a fully validated save, or null when the payload is not a v1 save. */
function sanitizeSave(value: unknown): SaveData | null {
  if (!isPlainObject(value)) return null;
  if (value.version !== SAVE_VERSION) return null;

  const bikes = sanitizeBikes(value.bikes);
  const selectedBike = boundedInt(value.selectedBike, 0, MAX_BIKE_ID, 0);

  return {
    version: SAVE_VERSION,
    coins: boundedInt(value.coins, 0, MAX_COINS, 0),
    unlocked: boundedInt(value.unlocked, 1, MAX_LEVEL_INDEX, 1),
    selectedBike: bikes.includes(selectedBike) ? selectedBike : 0,
    bikes,
    upgrades: sanitizeUpgrades(value.upgrades),
    records: sanitizeRecords(value.records),
    stats: sanitizeStats(value.stats),
    sound: typeof value.sound === 'boolean' ? value.sound : false,
    updatedAt: boundedInt(value.updatedAt, 0, MAX_TIMESTAMP, 0),
  };
}

export class Storage {
  data: SaveData;
  available: boolean;

  private store: WebStorage | null;

  constructor() {
    this.store = getLocalStorage();
    this.available = this.store !== null;
    this.data = createDefaultSave();

    if (this.store) {
      const raw = this.readRaw();
      if (raw !== null) {
        const parsed = this.parse(raw);
        if (parsed) this.data = parsed;
      }
    }
  }

  save(): void {
    const store = this.store;
    if (!store) return;
    try {
      store.setItem(STORAGE_KEY, JSON.stringify(this.data));
      this.available = true;
    } catch {
      // Quota exceeded or storage revoked mid-session: stay in-memory only.
      this.available = false;
    }
  }

  upgradeCost(key: UpgradeKey): number {
    if (!isUpgradeKey(key)) return 0;
    const level = boundedInt(this.data.upgrades[key], 0, MAX_UPGRADE_LEVEL, 0);
    if (level >= MAX_UPGRADE_LEVEL) return 0;
    return UPGRADE_BASE_COST * (level + 1);
  }

  addCoins(amount: number): boolean {
    const reward = boundedInt(amount, 1, MAX_COINS, 0);
    if (reward <= 0) return false;
    this.data.coins = Math.min(MAX_COINS, this.data.coins + reward);
    this.touch();
    return true;
  }

  purchaseUpgrade(key: UpgradeKey): boolean {
    if (!isUpgradeKey(key)) return false;
    const level = boundedInt(this.data.upgrades[key], 0, MAX_UPGRADE_LEVEL, 0);
    if (level >= MAX_UPGRADE_LEVEL) return false;

    const cost = UPGRADE_BASE_COST * (level + 1);
    if (this.data.coins < cost) return false;

    this.data.coins -= cost;
    this.data.upgrades[key] = level + 1;
    this.touch();
    return true;
  }

  buyBike(id: number): boolean {
    const price = bikePrice(id);
    if (price === null) return false;
    if (this.data.bikes.includes(id)) return false;
    if (this.data.coins < price) return false;

    this.data.coins -= price;
    this.data.bikes.push(id);
    this.data.bikes.sort((a, b) => a - b);
    this.touch();
    return true;
  }

  /** Records the outcome of a single finished run. The caller must invoke this once per run. */
  finish(id: string, time: number, stars: number, coins: number, nextLevel?: number): void {
    const key = typeof id === 'string' ? id.trim() : '';
    if (!isSafeRecordKey(key)) return;

    const safeTime = toFiniteNumber(time);
    const reward = boundedInt(coins, 0, MAX_COINS, 0);

    if (safeTime !== null && safeTime >= 0 && safeTime <= MAX_TIME) {
      const previous = this.data.records[key];
      this.data.records[key] = {
        time: previous ? Math.min(previous.time, safeTime) : safeTime,
        stars: Math.max(previous ? previous.stars : 0, clampInt(stars, 0, MAX_STARS, 0)),
      };
      this.trimRecords();
    }

    this.data.coins = Math.min(MAX_COINS, this.data.coins + reward);

    const unlock = boundedInt(nextLevel, 1, MAX_LEVEL_INDEX, 0);
    if (unlock > 0) this.data.unlocked = Math.max(this.data.unlocked, unlock);

    this.touch();
  }

  /** Adds durable run statistics and optional endless-mode earnings. */
  recordRun(distance: number, crashed: boolean, reward = 0, endless = false): void {
    const safeDistance = clampInt(distance, 0, MAX_STAT_VALUE, 0);
    const safeReward = clampInt(reward, 0, MAX_COINS, 0);
    this.data.stats.runs = Math.min(MAX_STAT_VALUE, this.data.stats.runs + 1);
    this.data.stats.totalDistance = Math.min(
      MAX_STAT_VALUE,
      this.data.stats.totalDistance + safeDistance,
    );
    if (crashed) this.data.stats.crashes = Math.min(MAX_STAT_VALUE, this.data.stats.crashes + 1);
    if (endless) this.data.stats.bestEndless = Math.max(this.data.stats.bestEndless, safeDistance);
    this.data.coins = Math.min(MAX_COINS, this.data.coins + safeReward);
    this.touch();
  }

  /**
   * Adopts a cloud save wholesale when it is valid and strictly newer than the
   * local one (last write wins). Values are sanitized, never summed.
   */
  mergeCloud(value: unknown): boolean {
    const incoming = sanitizeSave(value);
    if (!incoming) return false;
    if (incoming.updatedAt <= this.data.updatedAt) return false;

    this.data = incoming;
    this.save();
    return true;
  }

  private readRaw(): string | null {
    try {
      return this.store ? this.store.getItem(STORAGE_KEY) : null;
    } catch {
      return null;
    }
  }

  private parse(raw: string): SaveData | null {
    try {
      return sanitizeSave(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  /** Keeps the records map bounded without touching entries that were just written. */
  private trimRecords(): void {
    const keys = Object.keys(this.data.records);
    if (keys.length <= MAX_RECORDS) return;
    keys.sort();
    for (const key of keys.slice(MAX_RECORDS)) delete this.data.records[key];
  }

  private touch(): void {
    this.data.updatedAt = Date.now();
    this.save();
  }
}
