/**
 * Optional Yandex Games bridge.
 *
 * The bridge stays completely inert outside the Yandex Games platform: the SDK
 * script is only requested when the page is actually hosted on a Yandex Games
 * domain, or when the developer opts in explicitly with `?yandex=1` (which
 * loads the official development SDK). Local and offline builds therefore never
 * touch the network here.
 */

import type { SaveData } from './storage.js';

/** Cloud storage slot used for the whole save. */
const DATA_KEY = 'gravity';

const SDK_LOCAL_URL = '/sdk.js';
/** Official SDK entry point used for local development with `?yandex=1`. */
const SDK_DEV_URL = 'https://yandex.ru/games/sdk/v2';
const SDK_SCRIPT_ATTRIBUTE = 'data-gravity-sdk';
const SDK_LOAD_TIMEOUT_MS = 10_000;

const YANDEX_HOST_SUFFIXES = ['.yandex.net', '.yandex.ru', '.yandex.com'];
const PAUSE_EVENT = 'game_api_pause';
const RESUME_EVENT = 'game_api_resume';
const SET_SCORE_METHOD = 'leaderboards.setScore';
const MAX_LEADERBOARD_NAME_LENGTH = 64;

interface YandexRewardedCallbacks {
  onOpen?: () => void;
  onRewarded?: () => void;
  onClose?: (wasShown: boolean) => void;
  onError?: (error: unknown) => void;
}

interface YandexAdv {
  showRewardedVideo(callbacks?: YandexRewardedCallbacks): unknown;
}

interface YandexPlayer {
  getData(keys?: string[]): Promise<Record<string, unknown>>;
  setData(data: Record<string, unknown>, flush?: boolean): Promise<void>;
}

interface YandexFeatures {
  LoadingAPI?: { ready(): void };
  GameplayAPI?: { start(): void; stop(): void };
}

interface YandexLeaderboards {
  setScore(name: string, score: number, extraData?: string): Promise<void>;
}

interface YandexSdk {
  features?: YandexFeatures;
  adv?: YandexAdv;
  leaderboards?: YandexLeaderboards;
  getLeaderboards?(): Promise<YandexLeaderboards>;
  isAvailableMethod?(method: string): Promise<boolean>;
  getPlayer(options?: { scopes?: boolean; signed?: boolean }): Promise<YandexPlayer>;
  on?(event: string, listener: () => void): unknown;
  off?(event: string, listener: () => void): unknown;
}

interface YaGamesGlobal {
  init(options?: { signed?: boolean }): Promise<YandexSdk>;
}

interface GravityConfig {
  /** Technical leaderboard name configured in the Yandex developer console. */
  leaderboard?: string;
}

declare global {
  interface Window {
    YaGames?: YaGamesGlobal;
    GRAVITY_CONFIG?: GravityConfig;
  }
}

function getWindow(): Window | null {
  return typeof window === 'undefined' ? null : window;
}

/** SDK and player callbacks must never throw into the game loop. */
function guard(action: () => void): void {
  try {
    action();
  } catch {
    /* ignore */
  }
}

function hasSearchFlag(flag: string): boolean {
  const target = getWindow();
  if (!target) return false;
  try {
    return new URLSearchParams(target.location.search).get(flag) === '1';
  } catch {
    return false;
  }
}

function isYandexHost(): boolean {
  const target = getWindow();
  if (!target) return false;
  if (hasSearchFlag('yandex')) return true;
  try {
    const host = target.location.hostname.toLowerCase();
    return YANDEX_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
  } catch {
    return false;
  }
}

function resolveSdkUrl(): string {
  return hasSearchFlag('yandex') ? SDK_DEV_URL : SDK_LOCAL_URL;
}

function getYaGames(): YaGamesGlobal | null {
  const candidate = getWindow()?.YaGames;
  if (candidate && typeof candidate.init === 'function') return candidate;
  return null;
}

function leaderboardName(): string | null {
  const name = getWindow()?.GRAVITY_CONFIG?.leaderboard;
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LEADERBOARD_NAME_LENGTH) return null;
  return trimmed;
}

function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/** Injects the SDK script and resolves with the global, or null on failure. */
function loadSdkScript(url: string): Promise<YaGamesGlobal | null> {
  return new Promise<YaGamesGlobal | null>((resolve) => {
    const target = getWindow();
    if (!target) {
      resolve(null);
      return;
    }

    const existing = getYaGames();
    if (existing) {
      resolve(existing);
      return;
    }

    const parent = target.document.head ?? target.document.body;
    if (!parent) {
      resolve(null);
      return;
    }

    let timer = 0;
    let settled = false;
    const script = target.document.createElement('script');

    const finish = (value: YaGamesGlobal | null): void => {
      if (settled) return;
      settled = true;
      target.clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
      resolve(value);
    };

    script.src = url;
    script.async = true;
    script.setAttribute(SDK_SCRIPT_ATTRIBUTE, '1');
    script.onload = () => {
      finish(getYaGames());
    };
    script.onerror = () => {
      finish(null);
    };

    timer = target.setTimeout(() => {
      finish(getYaGames());
    }, SDK_LOAD_TIMEOUT_MS);

    parent.appendChild(script);
  });
}

export class YandexBridge {
  available = false;
  onPause: (() => void) | null = null;
  onResume: (() => void) | null = null;

  private sdk: YandexSdk | null = null;
  private player: YandexPlayer | null = null;
  private initPromise: Promise<void> | null = null;
  private offlineHandler: (() => void) | null = null;

  init(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.bootstrap();
    return this.initPromise;
  }

  /** Tells the platform the game finished loading and can be interacted with. */
  ready(): void {
    guard(() => {
      this.sdk?.features?.LoadingAPI?.ready();
    });
  }

  start(): void {
    guard(() => {
      this.sdk?.features?.GameplayAPI?.start();
    });
  }

  stop(): void {
    guard(() => {
      this.sdk?.features?.GameplayAPI?.stop();
    });
  }

  /** Returns the cloud save payload, or null when unavailable/absent. */
  async load(): Promise<unknown> {
    const player = await this.getPlayer();
    if (!player) return null;

    try {
      const data = await player.getData([DATA_KEY]);
      if (!data || typeof data !== 'object') return null;
      if (!Object.prototype.hasOwnProperty.call(data, DATA_KEY)) return null;
      return (data as Record<string, unknown>)[DATA_KEY];
    } catch {
      return null;
    }
  }

  async save(data: SaveData): Promise<void> {
    const player = await this.getPlayer();
    if (!player) return;

    try {
      await player.setData({ [DATA_KEY]: data }, true);
    } catch {
      // Offline or rate limited: the local save stays the source of truth.
    }
  }

  /**
   * Shows a rewarded video. Resolves true only when the platform reports a
   * counted impression via `onRewarded`; every other outcome resolves false.
   */
  rewarded(): Promise<boolean> {
    const target = getWindow();
    const adv = this.sdk?.adv;

    if (!target || !this.available || !adv || typeof adv.showRewardedVideo !== 'function') {
      return Promise.resolve(false);
    }
    if (isOffline()) return Promise.resolve(false);

    return new Promise<boolean>((resolve) => {
      let settled = false;
      let opened = false;

      const settle = (value: boolean): void => {
        if (settled) return;
        settled = true;
        if (this.offlineHandler) {
          target.removeEventListener('offline', this.offlineHandler);
          this.offlineHandler = null;
        }
        resolve(value);
      };

      /** Gameplay resumes when the ad surface is gone, not when the reward lands. */
      const release = (): void => {
        if (!opened) return;
        opened = false;
        this.notifyResume();
      };

      const onOffline = (): void => {
        release();
        settle(false);
      };
      this.offlineHandler = onOffline;
      target.addEventListener('offline', onOffline);

      try {
        adv.showRewardedVideo({
          onOpen: () => {
            opened = true;
            this.notifyPause();
          },
          onRewarded: () => {
            settle(true);
          },
          onClose: () => {
            release();
            settle(false);
          },
          onError: () => {
            release();
            settle(false);
          },
        });
      } catch {
        release();
        settle(false);
      }
    });
  }

  /** Submits a score; returns false when no leaderboard is configured. */
  async submit(score: number): Promise<boolean> {
    const sdk = this.sdk;
    const name = leaderboardName();
    if (!this.available || !sdk || !name) return false;
    if (typeof score !== 'number' || !Number.isFinite(score)) return false;

    try {
      if (typeof sdk.isAvailableMethod === 'function') {
        const supported = await sdk.isAvailableMethod(SET_SCORE_METHOD);
        if (supported === false) return false;
      }

      const boards = await this.getLeaderboards(sdk);
      if (!boards || typeof boards.setScore !== 'function') return false;

      await boards.setScore(name, Math.max(0, Math.floor(score)));
      return true;
    } catch {
      return false;
    }
  }

  private async bootstrap(): Promise<void> {
    if (!isYandexHost()) {
      this.available = false;
      return;
    }

    try {
      const yaGames = getYaGames() ?? (await loadSdkScript(resolveSdkUrl()));
      if (!yaGames) return;

      const sdk = await yaGames.init();
      if (!sdk) return;

      this.sdk = sdk;
      this.bindEvents(sdk);
      this.available = true;
    } catch {
      this.available = false;
    }
  }

  private bindEvents(sdk: YandexSdk): void {
    if (typeof sdk.on !== 'function') return;
    guard(() => {
      sdk.on?.(PAUSE_EVENT, () => {
        this.notifyPause();
      });
      sdk.on?.(RESUME_EVENT, () => {
        this.notifyResume();
      });
    });
  }

  private notifyPause(): void {
    guard(() => {
      this.onPause?.();
    });
  }

  private notifyResume(): void {
    guard(() => {
      this.onResume?.();
    });
  }

  /**
   * The player object is requested without personal-data scopes; the game only
   * needs cloud storage and never triggers an authorization dialog.
   */
  private async getPlayer(): Promise<YandexPlayer | null> {
    if (this.player) return this.player;

    const sdk = this.sdk;
    if (!this.available || !sdk || typeof sdk.getPlayer !== 'function') return null;

    try {
      this.player = await sdk.getPlayer({ scopes: false });
      return this.player;
    } catch {
      try {
        this.player = await sdk.getPlayer();
        return this.player;
      } catch {
        return null;
      }
    }
  }

  private async getLeaderboards(sdk: YandexSdk): Promise<YandexLeaderboards | null> {
    if (sdk.leaderboards) return sdk.leaderboards;
    if (typeof sdk.getLeaderboards !== 'function') return null;
    try {
      return await sdk.getLeaderboards();
    } catch {
      return null;
    }
  }
}
