/**
 * Synthesized audio for the motorcycle trials game.
 *
 * Everything is generated with the Web Audio API at runtime — no media files.
 * Audio starts disabled, is only created after a user gesture, and every entry
 * point degrades to a no-op when the browser has no usable AudioContext.
 */

type EffectKind = 'coin' | 'crash' | 'finish' | 'click';

/** Speed value that maps to the top of the motor pitch range. */
const MAX_SPEED = 80;
const MOTOR_MIN_HZ = 38;
const MOTOR_MAX_HZ = 128;
const MOTOR_LOWPASS_HZ = 420;
const MOTOR_NOISE_HZ = 320;

interface AudioContextConstructor {
  new (): AudioContext;
}

function getWindow(): Window | null {
  return typeof window === 'undefined' ? null : window;
}

function getAudioContextConstructor(): AudioContextConstructor | null {
  if (!getWindow()) return null;
  const scope = globalThis as typeof globalThis & {
    webkitAudioContext?: AudioContextConstructor;
  };
  if (typeof scope.AudioContext === 'function') return scope.AudioContext;
  if (typeof scope.webkitAudioContext === 'function') return scope.webkitAudioContext;
  return null;
}

/** Audio is optional: a failing node must never break the game loop. */
function guard(action: () => void): void {
  try {
    action();
  } catch {
    /* ignore */
  }
}

export class AudioEngine {
  enabled = false;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private motorOsc: OscillatorNode | null = null;
  private motorFilter: BiquadFilterNode | null = null;
  private motorGain: GainNode | null = null;
  private noiseSource: AudioBufferSourceNode | null = null;
  private noiseFilter: BiquadFilterNode | null = null;
  private noiseGain: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private gestureHandler: (() => void) | null = null;
  private destroyed = false;

  constructor() {
    const target = getWindow();
    if (!target) return;
    this.gestureHandler = () => {
      this.unlock();
    };
    target.addEventListener('pointerdown', this.gestureHandler, { passive: true });
    target.addEventListener('keydown', this.gestureHandler, { passive: true });
    target.addEventListener('touchstart', this.gestureHandler, { passive: true });
  }

  setEnabled(on: boolean): void {
    const next = on === true;
    this.enabled = next;
    if (next) {
      this.unlock();
      this.setMasterGain(1);
    } else {
      this.silence();
      this.setMasterGain(0);
    }
  }

  /** Call from a user gesture when the browser blocks autoplay. */
  unlock(): void {
    if (this.destroyed || !this.enabled) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    guard(() => {
      if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    });
    this.ensureMotor();
    this.setMasterGain(1);
  }

  /**
   * Drives the engine tone. `speed` is expected in world units per second and is
   * clamped, so out-of-range or NaN values are harmless.
   */
  update(speed: number, throttle: boolean, running: boolean): void {
    const ctx = this.ctx;
    const motorGain = this.motorGain;
    const noiseGain = this.noiseGain;
    if (!ctx || !motorGain || !noiseGain) return;
    if (this.destroyed || !this.enabled) return;
    if (ctx.state !== 'running') return;

    const now = ctx.currentTime;
    const rawSpeed = typeof speed === 'number' && Number.isFinite(speed) ? speed : 0;
    const norm = Math.min(Math.max(rawSpeed, 0), MAX_SPEED) / MAX_SPEED;
    const onThrottle = throttle === true;
    const active = running === true;

    const frequency =
      MOTOR_MIN_HZ + norm * (MOTOR_MAX_HZ - MOTOR_MIN_HZ) + (onThrottle ? 16 : 0);

    guard(() => {
      if (this.motorOsc) {
        this.motorOsc.frequency.setTargetAtTime(frequency, now, 0.08);
      }
      if (this.motorFilter) {
        const cutoff = MOTOR_LOWPASS_HZ + norm * 700 + (onThrottle ? 250 : 0);
        this.motorFilter.frequency.setTargetAtTime(cutoff, now, 0.1);
      }
      const tone = active ? 0.03 + norm * 0.05 + (onThrottle ? 0.025 : 0) : 0;
      motorGain.gain.setTargetAtTime(tone, now, 0.1);
      const hiss = active ? 0.006 + norm * 0.02 : 0;
      noiseGain.gain.setTargetAtTime(hiss, now, 0.12);
      if (this.noiseFilter) {
        this.noiseFilter.frequency.setTargetAtTime(MOTOR_NOISE_HZ + norm * 900, now, 0.12);
      }
    });
  }

  effect(kind: EffectKind): void {
    if (this.destroyed || !this.enabled) return;
    const ctx = this.ensureContext();
    if (!ctx || ctx.state !== 'running') return;

    switch (kind) {
      case 'coin':
        this.blip(880, 1320, 0.09, 'triangle', 0.16, 0);
        break;
      case 'crash':
        this.noiseBurst(0.28, 0.3);
        break;
      case 'finish':
        this.blip(523, 523, 0.12, 'triangle', 0.16, 0);
        this.blip(659, 659, 0.12, 'triangle', 0.16, 0.13);
        this.blip(784, 784, 0.24, 'triangle', 0.18, 0.26);
        break;
      case 'click':
        this.blip(520, 440, 0.05, 'square', 0.1, 0);
        break;
      default:
        break;
    }
  }

  pause(): void {
    const ctx = this.ctx;
    if (!ctx || this.destroyed) return;
    const now = ctx.currentTime;
    guard(() => {
      this.motorGain?.gain.setTargetAtTime(0, now, 0.03);
      this.noiseGain?.gain.setTargetAtTime(0, now, 0.03);
    });
    guard(() => {
      if (ctx.state === 'running') void ctx.suspend().catch(() => undefined);
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.enabled = false;

    const target = getWindow();
    if (target && this.gestureHandler) {
      target.removeEventListener('pointerdown', this.gestureHandler);
      target.removeEventListener('keydown', this.gestureHandler);
      target.removeEventListener('touchstart', this.gestureHandler);
    }
    this.gestureHandler = null;

    const ctx = this.ctx;
    guard(() => {
      this.motorOsc?.stop();
      this.noiseSource?.stop();
    });
    guard(() => {
      this.motorOsc?.disconnect();
      this.motorFilter?.disconnect();
      this.motorGain?.disconnect();
      this.noiseSource?.disconnect();
      this.noiseFilter?.disconnect();
      this.noiseGain?.disconnect();
      this.master?.disconnect();
    });

    this.ctx = null;
    this.master = null;
    this.motorOsc = null;
    this.motorFilter = null;
    this.motorGain = null;
    this.noiseSource = null;
    this.noiseFilter = null;
    this.noiseGain = null;
    this.noiseBuffer = null;

    if (ctx && ctx.state !== 'closed') {
      guard(() => {
        void ctx.close().catch(() => undefined);
      });
    }
  }

  private ensureContext(): AudioContext | null {
    if (this.destroyed) return null;
    if (this.ctx) return this.ctx;

    const Ctor = getAudioContextConstructor();
    if (!Ctor) return null;

    try {
      const ctx = new Ctor();
      const master = ctx.createGain();
      master.gain.value = this.enabled ? 1 : 0;
      master.connect(ctx.destination);
      this.ctx = ctx;
      this.master = master;
      return ctx;
    } catch {
      this.ctx = null;
      this.master = null;
      return null;
    }
  }

  /** Builds the looping motor voice once; later updates only touch parameters. */
  private ensureMotor(): void {
    const ctx = this.ensureContext();
    const master = this.master;
    if (!ctx || !master) return;

    if (!this.motorOsc) {
      guard(() => {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = MOTOR_MIN_HZ;
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = MOTOR_LOWPASS_HZ;
        filter.Q.value = 6;
        const gain = ctx.createGain();
        gain.gain.value = 0;
        osc.connect(filter);
        filter.connect(gain);
        gain.connect(master);
        osc.start();
        this.motorOsc = osc;
        this.motorFilter = filter;
        this.motorGain = gain;
      });
    }

    if (!this.noiseSource) {
      guard(() => {
        const source = ctx.createBufferSource();
        source.buffer = this.getNoiseBuffer(ctx);
        source.loop = true;
        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = MOTOR_NOISE_HZ;
        filter.Q.value = 0.8;
        const gain = ctx.createGain();
        gain.gain.value = 0;
        source.connect(filter);
        filter.connect(gain);
        gain.connect(master);
        source.start();
        this.noiseSource = source;
        this.noiseFilter = filter;
        this.noiseGain = gain;
      });
    }
  }

  private setMasterGain(value: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const now = ctx.currentTime;
    guard(() => {
      this.master?.gain.setTargetAtTime(value, now, 0.04);
    });
  }

  private silence(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    guard(() => {
      this.motorGain?.gain.setTargetAtTime(0, now, 0.03);
      this.noiseGain?.gain.setTargetAtTime(0, now, 0.03);
    });
  }

  private getNoiseBuffer(ctx: AudioContext): AudioBuffer {
    if (this.noiseBuffer) return this.noiseBuffer;
    const length = Math.max(1, Math.floor(ctx.sampleRate * 0.5));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) {
      channel[i] = Math.random() * 2 - 1;
    }
    this.noiseBuffer = buffer;
    return buffer;
  }

  private blip(
    startHz: number,
    endHz: number,
    duration: number,
    type: OscillatorType,
    peak: number,
    delay: number,
  ): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;

    guard(() => {
      const start = ctx.currentTime + Math.max(0, delay);
      const end = start + duration;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(Math.max(1, startHz), start);
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, endHz), end);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      osc.connect(gain);
      gain.connect(master);
      osc.start(start);
      osc.stop(end + 0.02);
      osc.onended = () => {
        guard(() => {
          osc.disconnect();
          gain.disconnect();
        });
      };
    });
  }

  private noiseBurst(duration: number, peak: number): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;

    guard(() => {
      const start = ctx.currentTime;
      const end = start + duration;
      const source = ctx.createBufferSource();
      source.buffer = this.getNoiseBuffer(ctx);
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(1200, start);
      filter.frequency.exponentialRampToValueAtTime(120, end);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(Math.max(0.0001, peak), start);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      source.connect(filter);
      filter.connect(gain);
      gain.connect(master);
      source.start(start);
      source.stop(end + 0.02);
      source.onended = () => {
        guard(() => {
          source.disconnect();
          filter.disconnect();
          gain.disconnect();
        });
      };
    });
  }
}
