import Phaser from 'phaser';
import { AudioEngine } from './audio.js';
import { YandexBridge } from './platform.js';
import { LandscapeScene } from './renderer.js';
import {
  BIKE_PRICES,
  MAX_UPGRADE_LEVEL,
  Storage,
  UPGRADE_KEYS,
  bikePrice,
  type UpgradeKey,
} from './storage.js';
import {
  STEP,
  Simulation,
  TRACKS,
  clamp,
  type Controls,
  type Mode,
  type TrackConfig,
} from './world.js';

type RunState = 'menu' | 'race' | 'paused' | 'crashed' | 'finished';

type TrackView = (typeof TRACKS)[number] & {
  id: string;
  mode: Mode;
  modifier: string;
};

interface RunContext {
  config: TrackConfig;
  id: string;
  name: string;
  region: string;
  target: number;
  description: string;
  campaignIndex: number | null;
}

const storage = new Storage();
const audio = new AudioEngine();
const platform = new YandexBridge();
const input: Controls = { gas: false, brake: false, left: false, right: false };

const gameHost = required<HTMLElement>('#game-canvas');
const menuScreen = required<HTMLElement>('#menu-screen');
const trackScreen = required<HTMLElement>('#track-screen');
const trackGrid = required<HTMLElement>('#track-grid');
const modePanel = required<HTMLElement>('#mode-panel');
const trackPreview = required<HTMLElement>('#track-preview');
const raceHud = required<HTMLElement>('#race-hud');
const raceTip = required<HTMLElement>('#race-tip');
const speedometer = required<HTMLElement>('#speedometer');
const durabilityHud = required<HTMLElement>('#hud-durability');
const touchControls = required<HTMLElement>('#touch-controls');
const modalBackdrop = required<HTMLElement>('#modal-backdrop');
const modal = required<HTMLElement>('#modal');
const toast = required<HTMLElement>('#toast');
const loading = required<HTMLElement>('#loading');

const ui = {
  wallet: required('#wallet'),
  walletTrack: required('#wallet-track'),
  soundButton: required<HTMLButtonElement>('#sound-button'),
  sceneLabel: required('#scene-label'),
  trackName: required('#track-name'),
  trackDescription: required('#track-description'),
  trackLength: required('#track-length'),
  difficultyBars: required('#difficulty-bars'),
  raceTime: required('#race-time'),
  raceTrack: required('#race-track'),
  raceDistance: required('#race-distance'),
  progressFill: required<HTMLElement>('#progress-fill'),
  raceCoins: required('#race-coins'),
  speedValue: required('#speed-value'),
  speedBars: required('#speed-bars'),
  durabilityRear: required<HTMLElement>('#durability-rear'),
  durabilityFront: required<HTMLElement>('#durability-front'),
  durabilityChassis: required<HTMLElement>('#durability-chassis'),
};

let mode: Mode = 'campaign';
let selectedTrack = 0;
let state: RunState = 'menu';
let sim: Simulation | null = null;
let run: RunContext | null = null;
let accumulator = 0;
let lastCoins = 0;
let resultReward = 0;
let resultDoubled = false;
let toastTimer = 0;
let customSeed = Math.floor(Math.random() * 900000) + 100000;
let customDifficulty = 4;
let customChunks = 10;
let customTheme = 'pine';

const scene = new LandscapeScene({ key: 'LandscapeScene' });
const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: gameHost,
  width: Math.max(320, window.innerWidth),
  height: Math.max(300, window.innerHeight),
  transparent: true,
  antialias: true,
  render: { antialias: true, roundPixels: false },
  scale: { mode: Phaser.Scale.RESIZE, autoCenter: Phaser.Scale.CENTER_BOTH },
  scene,
  banner: false,
});

scene.onFrame = frame;
window.addEventListener('beforeunload', () => {
  sim?.destroy();
  audio.destroy();
  game.destroy(true);
});

// Try to lock landscape on mobile devices
if ('screen' in window && 'orientation' in window.screen) {
  try {
    void (window.screen.orientation as any).lock?.('landscape').catch(() => {});
  } catch {
    // ignore
  }
}

// Handle window resize for Phaser
window.addEventListener('resize', () => {
  game.scale.resize(Math.max(320, window.innerWidth), Math.max(300, window.innerHeight));
});

audio.setEnabled(storage.data.sound);
updateSoundButton();
renderWallet();
renderMode('campaign');
setPreview(campaignContext(0));
bindInterface();
void initPlatform();

function required<T extends Element = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Не найден элемент ${selector}`);
  return element;
}

async function initPlatform(): Promise<void> {
  await platform.init();
  const cloud = await platform.load();
  if (cloud && storage.mergeCloud(cloud)) {
    audio.setEnabled(storage.data.sound);
    updateSoundButton();
    renderWallet();
    renderMode(mode);
  }
  platform.onPause = () => {
    if (state === 'race') pauseRace();
  };
  platform.onResume = () => {
    if (state === 'paused') resumeRace();
  };
  platform.ready();
  loading.classList.add('hidden');
}

function bindInterface(): void {
  document.addEventListener('click', (event) => {
    const target = event.target as Element | null;
    const button = target?.closest<HTMLElement>('[data-action]');
    if (button) handleAction(button.dataset.action ?? '', button);

    const modeButton = target?.closest<HTMLButtonElement>('[data-mode]');
    if (modeButton?.dataset.mode) renderMode(modeButton.dataset.mode as Mode);

    const trackButton = target?.closest<HTMLButtonElement>('[data-track]');
    if (trackButton?.dataset.track) selectCampaignTrack(Number(trackButton.dataset.track));

    const upgradeButton = target?.closest<HTMLButtonElement>('[data-upgrade]');
    if (upgradeButton?.dataset.upgrade) purchaseUpgrade(upgradeButton.dataset.upgrade as UpgradeKey);

    const bikeButton = target?.closest<HTMLButtonElement>('[data-bike]');
    if (bikeButton?.dataset.bike) chooseBike(Number(bikeButton.dataset.bike));
  });

  document.addEventListener('keydown', (event) => {
    const tag = (event.target as HTMLElement | null)?.tagName;
    const editing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
    if (!editing && controlKey(event.code)) event.preventDefault();
    if (event.repeat && ['KeyR', 'Escape', 'Enter', 'Space'].includes(event.code)) return;

    if (!editing) {
      setKey(event.code, true);
      if (event.code === 'Enter' && state === 'menu') startRace();
      if (event.code === 'KeyR' && state !== 'menu') restartRace();
      if ((event.code === 'Escape' || event.code === 'Space') && state === 'race') pauseRace();
      else if ((event.code === 'Escape' || event.code === 'Space') && state === 'paused') resumeRace();
    }
  });

  document.addEventListener('keyup', (event) => setKey(event.code, false));
  window.addEventListener('blur', () => {
    resetInput();
    if (state === 'race') pauseRace();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state === 'race') pauseRace();
  });

  for (const button of touchControls.querySelectorAll<HTMLButtonElement>('[data-control]')) {
    const key = button.dataset.control as keyof Controls;
    const on = (event: PointerEvent) => {
      event.preventDefault();
      button.setPointerCapture?.(event.pointerId);
      input[key] = true;
      audio.unlock();
    };
    const off = (event: PointerEvent) => {
      event.preventDefault();
      input[key] = false;
      button.releasePointerCapture?.(event.pointerId);
    };
    button.addEventListener('pointerdown', on);
    button.addEventListener('pointerup', off);
    button.addEventListener('pointercancel', off);
    button.addEventListener('pointerleave', (event) => {
      if (event.buttons === 0) off(event);
    });
  }

  modePanel.addEventListener('input', (event) => {
    const element = event.target as HTMLInputElement | HTMLSelectElement;
    if (element.id === 'custom-seed') customSeed = sanitizeSeed(element.value);
    if (element.id === 'custom-difficulty') {
      customDifficulty = clamp(Number(element.value), 1, 10);
      required('#custom-difficulty-value').textContent = String(customDifficulty);
    }
    if (element.id === 'custom-length') {
      customChunks = clamp(Number(element.value), 6, 18);
      required('#custom-length-value').textContent = `${customChunks} чанков`;
    }
    if (element.id === 'custom-theme') customTheme = element.value;
  });
}

function controlKey(code: string): boolean {
  return ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space'].includes(code);
}

function setKey(code: string, down: boolean): void {
  if (code === 'ArrowUp' || code === 'KeyW') input.gas = down;
  if (code === 'ArrowDown' || code === 'KeyS') input.brake = down;
  if (code === 'ArrowLeft' || code === 'KeyA') input.left = down;
  if (code === 'ArrowRight' || code === 'KeyD') input.right = down;
}

function resetInput(): void {
  input.gas = false;
  input.brake = false;
  input.left = false;
  input.right = false;
}

function handleAction(action: string, element: HTMLElement): void {
  audio.effect('click');
  switch (action) {
    case 'start':
      if (!menuScreen.classList.contains('hidden') && state === 'menu') showTrackScreen();
      else startRace();
      break;
    case 'restart': restartRace(); break;
    case 'pause': pauseRace(); break;
    case 'resume': resumeRace(); break;
    case 'home': returnToMenu(); break;
    case 'garage': showGarage(); break;
    case 'records': showRecords(); break;
    case 'tracks': showTrackScreen(); break;
    case 'help': showHelp(); break;
    case 'about': showAbout(); break;
    case 'sound': toggleSound(); break;
    case 'close-modal': closeModal(); break;
    case 'random-seed':
      customSeed = Math.floor(Math.random() * 900000) + 100000;
      renderMode('custom');
      break;
    case 'double-reward': void doubleReward(element as HTMLButtonElement); break;
    default: break;
  }
}

function showTrackScreen(): void {
  menuScreen.classList.add('hidden');
  trackScreen.classList.remove('hidden');
  renderMode(mode);
}

function renderMode(nextMode: Mode): void {
  if (!['campaign', 'daily', 'endless', 'custom', 'progression'].includes(nextMode)) return;
  mode = nextMode;
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });

  if (mode === 'campaign') {
    modePanel.classList.add('hidden');
    trackGrid.classList.remove('hidden');
    trackPreview.classList.remove('hidden');
    renderTracks();
    const index = Math.min(selectedTrack, Math.max(0, storage.data.unlocked - 1), TRACKS.length - 1);
    selectCampaignTrack(index);
    return;
  }

  trackGrid.classList.add('hidden');
  trackPreview.classList.remove('hidden');
  modePanel.classList.remove('hidden');
  const context = mode === 'daily' ? dailyContext() : mode === 'endless' ? endlessContext() : mode === 'progression' ? progressionContext() : customContext();
  renderModePanel(context);
  setMission(context);
  setPreview(context);
}

function renderTracks(): void {
  trackGrid.innerHTML = TRACKS.map((track, index) => {
    const unlocked = index < storage.data.unlocked;
    const record = storage.data.records[`campaign-${index}`];
    const stars = record?.stars ?? 0;
    return `<button class="track-card ${selectedTrack === index ? 'active' : ''} ${unlocked ? '' : 'locked'}" data-track="${index}" ${unlocked ? '' : 'disabled'} aria-label="${track.name}">
      <span class="track-art">🏔️</span>
      <span class="track-info"><b>${track.name}</b><span>${Math.round((track.chunks * 720 - 370) / 10)} м</span><span class="stars">${'★'.repeat(stars)}${'☆'.repeat(3 - stars)}</span></span>
      ${unlocked ? '' : '<span class="track-lock">🔒</span>'}
    </button>`;
  }).join('');
}

function renderModePanel(context: RunContext): void {
  if (mode === 'daily') {
    const modifier = modifierLabel(context.config.modifier);
    const record = storage.data.records[context.id];
    modePanel.innerHTML = `<div class="mode-copy"><span class="modal-kicker">ИСПЫТАНИЕ ДНЯ</span><h3>${context.name}</h3><p>${context.description}</p></div>
      <div class="preview-stats"><div><span>МОДИФИКАТОР</span><strong>${modifier}</strong></div><div><span>СЛОЖНОСТЬ</span><strong>${context.config.difficulty}/10</strong></div><div><span>ЛУЧШЕЕ</span><strong>${record ? formatTime(record.time) : '—'}</strong></div></div>
      <button class="btn-play-small" data-action="start">▶ Начать</button>`;
  } else if (mode === 'endless') {
    modePanel.innerHTML = `<div class="mode-copy"><span class="modal-kicker">СВОБОДНЫЙ ЗАЕЗД</span><h3>Дорога без финиша</h3><p>Трасса строится впереди. Монеты сохраняются после падения.</p></div>
      <div class="preview-stats"><div><span>РЕКОРД</span><strong>${storage.data.stats.bestEndless} м</strong></div><div><span>СЛОЖНОСТЬ</span><strong>НАРАСТАЕТ</strong></div></div>
      <button class="btn-play-small" data-action="start">▶ В свободный заезд</button>`;
  } else if (mode === 'progression') {
    modePanel.innerHTML = `<div class="mode-copy"><span class="modal-kicker">ПРОГРЕССИЯ</span><h3>Бесконечный путь</h3><p>Трасса усложняется с каждым метром: холмы, трамплины, ямы, обрывы. До куда дойдёшь?</p></div>
      <div class="preview-stats"><div><span>РЕКОРД</span><strong>${storage.data.stats.bestEndless} м</strong></div><div><span>ТИПЫ</span><strong>8 ВИДОВ</strong></div></div>
      <button class="btn-play-small" data-action="start">▶ В путь</button>`;
  } else {
    modePanel.innerHTML = `<div class="mode-copy"><span class="modal-kicker">КОНСТРУКТОР</span><h3>Свой маршрут</h3><p>Настрой сид, длину и характер трассы.</p></div>
      <div class="custom-controls">
        <label>СИД <span><input id="custom-seed" inputmode="numeric" value="${customSeed}" maxlength="9"><button data-action="random-seed" type="button">↻</button></span></label>
        <label>СЛОЖНОСТЬ <b id="custom-difficulty-value">${customDifficulty}</b><input id="custom-difficulty" type="range" min="1" max="10" value="${customDifficulty}"></label>
        <label>ДЛИНА <b id="custom-length-value">${customChunks} чанков</b><input id="custom-length" type="range" min="6" max="18" value="${customChunks}"></label>
        <label>БИОМ <select id="custom-theme"><option value="pine" ${customTheme === 'pine' ? 'selected' : ''}>Хвойный</option><option value="desert" ${customTheme === 'desert' ? 'selected' : ''}>Каньон</option><option value="ice" ${customTheme === 'ice' ? 'selected' : ''}>Ледник</option></select></label>
      </div><button class="btn-play-small" data-action="start">▶ Построить и ехать</button>`;
  }
}

function selectCampaignTrack(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= TRACKS.length || index >= storage.data.unlocked) return;
  selectedTrack = index;
  renderTracks();
  const context = campaignContext(index);
  setMission(context);
  setPreview(context);
}

function campaignContext(index: number): RunContext {
  const track = TRACKS[index] ?? TRACKS[0]!;
  return {
    config: {
      seed: track.seed,
      difficulty: track.difficulty,
      chunks: track.chunks,
      theme: track.theme,
      mode: 'campaign',
      modifier: '',
    },
    id: `campaign-${index}`,
    name: track.name,
    region: track.region,
    target: track.target,
    description: track.description,
    campaignIndex: index,
  };
}

function dailyContext(): RunContext {
  const day = new Date();
  const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  const numeric = Number(key.replaceAll('-', ''));
  const modifiers = ['fog', 'ice', 'lowgravity'];
  const modifier = modifiers[numeric % modifiers.length] ?? 'fog';
  const difficulty = 3 + (numeric % 5);
  const themes = ['pine', 'desert', 'ice'];
  const theme = modifier === 'ice' ? 'ice' : (themes[(numeric >> 2) % themes.length] ?? 'pine');
  return {
    config: { seed: numeric, difficulty, chunks: 10, theme, mode: 'daily', modifier },
    id: `daily-${key}`,
    name: `Маршрут ${key.slice(5).replace('-', '.')}`,
    region: 'ИСПЫТАНИЕ ДНЯ',
    target: 62 + difficulty * 3,
    description: `Одинаковая трасса для всех игроков. Сегодня действует модификатор «${modifierLabel(modifier)}».`,
    campaignIndex: null,
  };
}

function endlessContext(): RunContext {
  return {
    config: { seed: 417239, difficulty: 4, chunks: 999999, theme: 'pine', mode: 'endless', modifier: '' },
    id: 'endless',
    name: 'За линию горизонта',
    region: 'СВОБОДНЫЙ ЗАЕЗД',
    target: 0,
    description: 'Путь не заканчивается. Ставь новый рекорд дистанции.',
    campaignIndex: null,
  };
}

function progressionContext(): RunContext {
  const day = new Date().getDate();
  return {
    config: { seed: 729183 + day, difficulty: 3, chunks: 999999, theme: 'pine', mode: 'progression', modifier: '' },
    id: 'progression',
    name: 'Бесконечный путь',
    region: 'ПРОГРЕССИЯ',
    target: 0,
    description: 'Трасса усложняется с каждым метром: холмы, подъёмы, трамплины, ямы, обрывы.',
    campaignIndex: null,
  };
}

function customContext(): RunContext {
  const seed = sanitizeSeed(String(customSeed));
  return {
    config: { seed, difficulty: customDifficulty, chunks: customChunks, theme: customTheme, mode: 'custom', modifier: '' },
    id: `custom-${seed}-${customDifficulty}-${customChunks}-${customTheme}`,
    name: `Маршрут #${seed}`,
    region: 'СВОЙ МАРШРУТ',
    target: 36 + customChunks * 4 + customDifficulty * 3,
    description: `Сид ${seed}. Сложность ${customDifficulty}/10. Длина ${customChunks} чанков.`,
    campaignIndex: null,
  };
}

function sanitizeSeed(value: string): number {
  const parsed = Math.abs(Math.trunc(Number(value.replace(/[^0-9-]/g, ''))));
  return Number.isFinite(parsed) && parsed > 0 ? clamp(parsed, 1, 999999999) : 1;
}

function modifierLabel(modifier: string): string {
  if (modifier === 'ice') return 'ЛЁД';
  if (modifier === 'lowgravity') return 'НИЗКАЯ ГРАВИТАЦИЯ';
  if (modifier === 'fog') return 'ТУМАН';
  return 'БЕЗ МОДИФИКАТОРА';
}

function setMission(context: RunContext): void {
  ui.trackName.textContent = context.name;
  ui.trackDescription.textContent = context.description;
  ui.trackLength.textContent = context.config.mode === 'endless'
    ? '∞'
    : `${Math.round((context.config.chunks * 720 - 370) / 10)} м`;
  ui.sceneLabel.textContent = context.region;
  Array.from(ui.difficultyBars.children).forEach((bar, index) => {
    bar.classList.toggle('on', index < Math.ceil(context.config.difficulty / 2));
  });
}

function setPreview(context: RunContext): void {
  if (state !== 'menu') return;
  destroySimulation();
  sim = new Simulation(context.config, storage.data);
  scene.sim = sim;
  scene.preview = true;
  scene.focusX = 350;
}

function startRace(): void {
  if (state !== 'menu') return;
  const context = mode === 'campaign' ? campaignContext(selectedTrack)
    : mode === 'daily' ? dailyContext()
      : mode === 'endless' ? endlessContext()
        : mode === 'progression' ? progressionContext()
          : customContext();
  run = context;
  destroySimulation();
  sim = new Simulation(context.config, storage.data);
  scene.sim = sim;
  scene.preview = false;
  accumulator = 0;
  lastCoins = 0;
  resultReward = 0;
  resultDoubled = false;
  state = 'race';
  resetInput();
  closeModal();
  menuScreen.classList.add('hidden');
  trackScreen.classList.add('hidden');
  raceHud.classList.remove('hidden');
  raceTip.classList.remove('hidden');
  speedometer.classList.remove('hidden');
  durabilityHud.classList.remove('hidden');
  touchControls.classList.remove('hidden');
  ui.raceTrack.textContent = context.name;
  ui.raceCoins.textContent = '0';
  updateHud();
  window.setTimeout(() => raceTip.classList.add('hidden'), 4500);
  audio.unlock();
  platform.start();
  gameHost.focus();
}

function restartRace(): void {
  if (!run) return;
  const context = run;
  destroySimulation();
  sim = new Simulation(context.config, storage.data);
  scene.sim = sim;
  scene.preview = false;
  accumulator = 0;
  lastCoins = 0;
  resultReward = 0;
  resultDoubled = false;
  state = 'race';
  resetInput();
  closeModal(true);
  ui.raceCoins.textContent = '0';
  raceTip.classList.remove('hidden');
  window.setTimeout(() => raceTip.classList.add('hidden'), 3000);
  platform.start();
}

function pauseRace(): void {
  if (state !== 'race') return;
  state = 'paused';
  resetInput();
  audio.pause();
  platform.stop();
  showModal(`<span class="modal-kicker">ПАУЗА</span><h2>Переведи дух.</h2><p>Трасса подождёт.</p>
    <div class="modal-actions"><button class="primary" data-action="resume">Продолжить</button><button class="secondary" data-action="restart">Заново</button><button class="text-button" data-action="home">В меню</button></div>`, false);
}

function resumeRace(): void {
  if (state !== 'paused') return;
  state = 'race';
  closeModal(true);
  audio.setEnabled(storage.data.sound);
  audio.unlock();
  platform.start();
}

function frame(delta: number): void {
  if (!sim) return;
  if (state === 'race') {
    accumulator += Math.min(Math.max(delta, 0), 80);
    let steps = 0;
    while (accumulator >= STEP && steps < 12) {
      sim.step(input);
      accumulator -= STEP;
      steps += 1;
    }
    if (steps >= 12) accumulator = 0;
    if (sim.coins > lastCoins) {
      audio.effect('coin');
      lastCoins = sim.coins;
    }
    audio.update(sim.bike.speed, input.gas, true);
    updateHud();
    if (sim.bike.crashed) handleCrash();
    else if (sim.finished) handleFinish();
  } else {
    audio.update(0, false, false);
  }
}

function updateHud(): void {
  if (!sim || !run) return;
  const total = Math.max(1, (run.config.chunks * 720 - 370) / 10);
  const distance = Math.max(0, Math.floor(sim.distance));
  const progress = run.config.mode === 'endless' || run.config.mode === 'progression' ? (distance % 500) / 500 : clamp(distance / total, 0, 1);
  ui.raceTime.textContent = formatTime(sim.elapsed);
  ui.raceDistance.textContent = run.config.mode === 'endless' || run.config.mode === 'progression' ? `${distance} м` : `${distance} / ${Math.round(total)} м`;
  ui.progressFill.style.width = `${progress * 100}%`;
  ui.raceCoins.textContent = String(sim.coins);
  const speed = Math.round(sim.bike.speed);
  ui.speedValue.textContent = String(speed);
  const bars = clamp(Math.round(speed / 8), 0, 10);
  ui.speedBars.innerHTML = Array.from({ length: 10 }, (_, index) => `<i class="${index < bars ? 'on' : ''}"></i>`).join('');
  // Durability
  updateDurabilityBar(ui.durabilityRear, sim.bike.rearHP, sim.bike.maxRearHP, sim.bike.rearDetached);
  updateDurabilityBar(ui.durabilityFront, sim.bike.frontHP, sim.bike.maxFrontHP, sim.bike.frontDetached);
  updateDurabilityBar(ui.durabilityChassis, sim.bike.chassisHP, sim.bike.maxChassisHP, false);
}

function updateDurabilityBar(el: HTMLElement, hp: number, max: number, broken: boolean): void {
  const pct = Math.max(0, Math.min(1, hp / max));
  const bar = el.querySelector('i') as HTMLElement;
  if (bar) bar.style.width = `${pct * 100}%`;
  el.classList.remove('warning', 'critical', 'broken');
  if (broken) el.classList.add('broken');
  else if (pct <= 0.2) el.classList.add('critical');
  else if (pct <= 0.5) el.classList.add('warning');
}

function handleCrash(): void {
  if (!sim || !run || state !== 'race') return;
  state = 'crashed';
  resetInput();
  platform.stop();
  audio.effect('crash');
  const distance = Math.max(0, Math.floor(sim.distance));
  const distanceBonus = run.config.mode === 'endless' ? Math.floor(distance / 50) * 5 : 0;
  resultReward = sim.coins + distanceBonus;
  storage.recordRun(distance, true, resultReward, run.config.mode === 'endless');
  void syncCloud();
  renderWallet();
  const recordText = run.config.mode === 'endless' && distance >= storage.data.stats.bestEndless ? '<b>Новый рекорд дистанции!</b>' : 'Ещё одна попытка — ещё точнее.';
  showModal(`<span class="modal-kicker">ЗАЕЗД ОКОНЧЕН</span><h2>Гравитация победила.</h2><p>${recordText}</p>
    <div class="result-grid"><span>ДИСТАНЦИЯ <b>${distance} м</b></span><span>МОНЕТЫ <b>+${resultReward}</b></span><span>ВРЕМЯ <b>${formatTime(sim.elapsed)}</b></span></div>
    <div class="modal-actions"><button class="primary" data-action="restart">Попробовать снова</button>${rewardButton()}<button class="text-button" data-action="home">В меню</button></div>`, false);
}

function handleFinish(): void {
  if (!sim || !run || state !== 'race') return;
  state = 'finished';
  resetInput();
  platform.stop();
  audio.effect('finish');
  const stars = run.target > 0 ? (sim.elapsed <= run.target ? 3 : sim.elapsed <= run.target * 1.35 ? 2 : 1) : 1;
  const baseReward = 40 + run.config.difficulty * 20 + stars * 15;
  resultReward = baseReward + sim.coins;
  const nextLevel = run.campaignIndex === null ? undefined : Math.min(TRACKS.length, run.campaignIndex + 2);
  storage.finish(run.id, sim.elapsed, stars, resultReward, nextLevel);
  storage.recordRun(Math.floor(sim.distance), false);
  void platform.submit(Math.round(sim.elapsed * 1000));
  void syncCloud();
  renderWallet();
  const best = storage.data.records[run.id]?.time ?? sim.elapsed;
  showModal(`<span class="modal-kicker">ФИНИШ</span><h2>${stars === 3 ? 'Идеальная траектория!' : 'Маршрут пройден.'}</h2><div class="finish-stars">${'★'.repeat(stars)}${'☆'.repeat(3 - stars)}</div>
    <div class="result-grid"><span>ВРЕМЯ <b>${formatTime(sim.elapsed)}</b></span><span>РЕКОРД <b>${formatTime(best)}</b></span><span>НАГРАДА <b>+${resultReward}</b></span></div>
    <div class="modal-actions"><button class="primary" data-action="restart">Ещё раз</button>${rewardButton()}<button class="text-button" data-action="home">К трассам</button></div>`, false);
}

function rewardButton(): string {
  return platform.available && resultReward > 0
    ? '<button class="secondary" data-action="double-reward">×2 за рекламу</button>'
    : '';
}

async function doubleReward(button: HTMLButtonElement): Promise<void> {
  if (resultDoubled || resultReward <= 0 || !platform.available) return;
  button.disabled = true;
  button.textContent = 'Проверяем…';
  const rewarded = await platform.rewarded();
  if (rewarded) {
    resultDoubled = true;
    storage.addCoins(resultReward);
    renderWallet();
    void syncCloud();
    button.textContent = `Получено +${resultReward}`;
    showToast('Награда удвоена!');
  } else {
    button.disabled = false;
    button.textContent = '×2 за рекламу';
    showToast('Реклама недоступна');
  }
}

function returnToMenu(): void {
  platform.stop();
  closeModal(true);
  state = 'menu';
  resetInput();
  menuScreen.classList.remove('hidden');
  trackScreen.classList.add('hidden');
  raceHud.classList.add('hidden');
  raceTip.classList.add('hidden');
  speedometer.classList.add('hidden');
  durabilityHud.classList.add('hidden');
  touchControls.classList.add('hidden');
  renderMode(mode);
}

function destroySimulation(): void {
  if (sim) sim.destroy();
  sim = null;
  scene.sim = null;
}

function renderWallet(): void {
  const text = storage.data.coins.toLocaleString('ru-RU');
  ui.wallet.textContent = text;
  ui.walletTrack.textContent = text;
}

function toggleSound(): void {
  storage.data.sound = !storage.data.sound;
  storage.data.updatedAt = Date.now();
  storage.save();
  audio.setEnabled(storage.data.sound);
  audio.unlock();
  updateSoundButton();
  void syncCloud();
}

function updateSoundButton(): void {
  ui.soundButton.textContent = storage.data.sound ? '🔊' : '🔇';
  ui.soundButton.setAttribute('aria-label', storage.data.sound ? 'Выключить звук' : 'Включить звук');
}

function showGarage(): void {
  const upgradeNames: Record<UpgradeKey, { name: string; text: string }> = {
    power: { name: 'Мощность', text: 'Быстрее набирает скорость.' },
    suspension: { name: 'Подвеска', text: 'Мягче гасит удары.' },
    grip: { name: 'Сцепление', text: 'Лучше держит склон и лёд.' },
  };
  const upgradeCards = UPGRADE_KEYS.map((key) => {
    const level = storage.data.upgrades[key];
    const cost = storage.upgradeCost(key);
    return `<article class="upgrade-card"><span>${upgradeNames[key].name}</span><div class="level-dots">${Array.from({ length: MAX_UPGRADE_LEVEL }, (_, i) => `<i class="${i < level ? 'on' : ''}"></i>`).join('')}</div><p>${upgradeNames[key].text}</p><button data-upgrade="${key}" ${level >= MAX_UPGRADE_LEVEL || storage.data.coins < cost ? 'disabled' : ''}>${level >= MAX_UPGRADE_LEVEL ? 'МАКС' : `УЛУЧШИТЬ · ${cost}`}</button></article>`;
  }).join('');
  const bikeAssets = ['bike-green.png', 'bike-orange.png', 'bike-blue.png', 'bike-red.png'];
  const bikeNames = ['TRAIL 125', 'RALLY 250', 'ALPINE X', 'FIRE 450'];
  const bikeCards = bikeNames.map((name, id) => {
    const owned = storage.data.bikes.includes(id);
    const selected = storage.data.selectedBike === id;
    const price = bikePrice(id);
    const asset = bikeAssets[id] ?? 'bike-green.png';
    return `<button class="garage-bike ${selected ? 'selected' : ''}" data-bike="${id}" ${!owned && storage.data.coins < (price ?? Infinity) ? 'disabled' : ''}><span class="bike-swatch bike-${id}"><img src="/assets/${asset}" alt="${name}" draggable="false"></span><b>${name}</b><small>${selected ? 'ВЫБРАН' : owned ? 'ВЫБРАТЬ' : `${price} М`}</small></button>`;
  }).join('');
  showModal(`<button class="modal-close" data-action="close-modal" aria-label="Закрыть">×</button><span class="modal-kicker">ГАРАЖ</span><h2>Настрой свой байк</h2><p>Улучшения действуют на все режимы.</p><div class="garage-bikes">${bikeCards}</div><div class="upgrade-grid">${upgradeCards}</div>`, true);
}

function purchaseUpgrade(key: UpgradeKey): void {
  if (storage.purchaseUpgrade(key)) {
    renderWallet();
    showToast('Улучшение установлено!');
    showGarage();
    void syncCloud();
  } else showToast('Не хватает монет');
}

function chooseBike(id: number): void {
  if (!Number.isInteger(id) || id < 0 || id > 3) return;
  if (!storage.data.bikes.includes(id)) {
    if (!storage.buyBike(id)) {
      showToast('Не хватает монет');
      return;
    }
  }
  storage.data.selectedBike = id;
  storage.data.updatedAt = Date.now();
  storage.save();
  renderWallet();
  showGarage();
  showToast('Мотоцикл выбран!');
  void syncCloud();
}

function showRecords(): void {
  const rows = TRACKS.map((track, index) => {
    const record = storage.data.records[`campaign-${index}`];
    return `<tr><td>${String(index + 1).padStart(2, '0')}</td><td>${track.name}</td><td>${record ? formatTime(record.time) : '—'}</td><td>${record ? '★'.repeat(record.stars) : '—'}</td></tr>`;
  }).join('');
  showModal(`<button class="modal-close" data-action="close-modal" aria-label="Закрыть">×</button><span class="modal-kicker">РЕКОРДЫ</span><h2>Твои достижения</h2><div class="record-summary"><span>ЗАЕЗДОВ <b>${storage.data.stats.runs}</b></span><span>ПРОЙДЕНО <b>${storage.data.stats.totalDistance} м</b></span><span>РЕКОРД <b>${storage.data.stats.bestEndless} м</b></span></div><div class="records-table"><table><thead><tr><th>#</th><th>Трасса</th><th>Время</th><th>Звёзды</th></tr></thead><tbody>${rows}</tbody></table></div>`, true);
}

function showHelp(): void {
  showModal(`<button class="modal-close" data-action="close-modal" aria-label="Закрыть">×</button><span class="modal-kicker">УПРАВЛЕНИЕ</span><h2>Скорость — не главное.</h2><div class="help-grid"><article><b>↑ / W</b><span>Газ</span></article><article><b>↓ / S</b><span>Тормоз</span></article><article><b>← / A</b><span>Назад</span></article><article><b>→ / D</b><span>Вперёд</span></article><article><b>R</b><span>Перезапуск</span></article><article><b>SPACE</b><span>Пауза</span></article></div><p style="color:#94a3b8;font-size:12px;margin-top:12px;text-align:center;">На телефоне — кнопки по краям экрана.</p>`, true);
}

function showAbout(): void {
  showModal(`<button class="modal-close" data-action="close-modal" aria-label="Закрыть">×</button><span class="modal-kicker">ОБ ИГРЕ</span><h2>Gravity Defied</h2><p>HTML5-игра о точности, ритме и балансе. Трассы процедурные, физика с фиксированным шагом.</p><p style="color:#94a3b8;font-size:12px;margin-top:8px;">Интеграция с Яндекс Играми: облачные сохранения, лидерборды, реклама.</p>`, true);
}

function showModal(content: string, closable: boolean): void {
  modal.innerHTML = content;
  modalBackdrop.classList.remove('hidden');
  modalBackdrop.classList.toggle('locked', !closable);
}

function closeModal(force = false): void {
  if (!force && (state === 'paused' || state === 'crashed' || state === 'finished') && modalBackdrop.classList.contains('locked')) return;
  modalBackdrop.classList.add('hidden');
  modalBackdrop.classList.remove('locked');
  modal.innerHTML = '';
}

function showToast(message: string): void {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.remove('hidden');
  toastTimer = window.setTimeout(() => toast.classList.add('hidden'), 2200);
}

function formatTime(seconds: number): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const minutes = Math.floor(safe / 60);
  const whole = Math.floor(safe % 60);
  const hundredths = Math.floor((safe % 1) * 100);
  return `${String(minutes).padStart(2, '0')}:${String(whole).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`;
}

async function syncCloud(): Promise<void> {
  if (platform.available) await platform.save(storage.data);
}
