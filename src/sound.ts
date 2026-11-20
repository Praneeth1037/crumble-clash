/** Small synthesized sound kit (Web Audio, no files). Created on the first user gesture. */
export type Sfx = 'jump' | 'airhop' | 'land' | 'landHard' | 'crack' | 'collapse' | 'count' | 'go' | 'eliminated' | 'roundWin' | 'draw' | 'matchWin' | 'pickup' | 'spawn' | 'warn' | 'click' | 'bump' | 'feather';

export class Sound {
  private ctx: AudioContext | null = null; private master: GainNode | null = null; private noise: AudioBuffer | null = null;
  private last = new Map<string, number>();
  volume = 0.7; muted = false;

  /** Must be called from a click or key press so browsers allow audio. */
  unlock() {
    if (!this.ctx) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor(); this.master = this.ctx.createGain();
      const comp = this.ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 6;
      this.master.connect(comp); comp.connect(this.ctx.destination);
      const n = this.ctx.createBuffer(1, this.ctx.sampleRate * 0.5, this.ctx.sampleRate), d = n.getChannelData(0);
      let seed = 1234567; for (let i = 0; i < d.length; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; d[i] = seed / 2 ** 31 - 1; }
      this.noise = n; this.apply();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }
  set(volume: number, muted: boolean) { this.volume = volume; this.muted = muted; this.apply(); }
  private apply() { if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume * 0.8, this.ctx.currentTime, 0.02); }
  dispose() { void this.ctx?.close(); this.ctx = null; }

  private tone(f0: number, f1: number, dur: number, type: OscillatorType, vol: number, delay = 0) {
    const c = this.ctx!, at = c.currentTime + delay, o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, at); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), at + dur);
    g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(vol, at + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g); g.connect(this.master!); o.start(at); o.stop(at + dur + 0.02);
  }
  private hiss(dur: number, vol: number, from: number, to: number, kind: BiquadFilterType = 'bandpass', delay = 0) {
    const c = this.ctx!, at = c.currentTime + delay, s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    s.buffer = this.noise; f.type = kind; f.Q.value = 1.2; f.frequency.setValueAtTime(from, at); f.frequency.exponentialRampToValueAtTime(Math.max(30, to), at + dur);
    g.gain.setValueAtTime(vol, at); g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    s.connect(f); f.connect(g); g.connect(this.master!); s.start(at); s.stop(at + dur + 0.02);
  }

  play(name: Sfx, pitch = 1) {
    if (!this.ctx || !this.master || this.muted || this.ctx.state !== 'running') return;
    // Busy sounds (cracks, landings) are rate-limited so a stampede never turns into noise.
    const gap = name === 'crack' ? 0.04 : name === 'collapse' ? 0.05 : name === 'bump' ? 0.2 : 0;
    const now = this.ctx.currentTime; if (gap && now - (this.last.get(name) ?? -1) < gap) return; this.last.set(name, now);
    switch (name) {
      case 'jump': this.tone(330 * pitch, 720 * pitch, 0.14, 'triangle', 0.12); break;
      case 'airhop': this.tone(520, 1180, 0.16, 'triangle', 0.11); this.tone(780, 1560, 0.1, 'sine', 0.05, 0.04); break;
      case 'land': this.hiss(0.07, 0.12, 900, 200, 'lowpass'); break;
      case 'landHard': this.tone(150, 60, 0.16, 'sine', 0.22); this.hiss(0.12, 0.16, 1200, 150, 'lowpass'); break;
      case 'crack': this.hiss(0.05, 0.13, 2600 * pitch, 1400 * pitch); this.tone(1900 * pitch, 900, 0.03, 'square', 0.025); break;
      case 'collapse': this.tone(120 * pitch, 45, 0.22, 'sine', 0.13); this.hiss(0.18, 0.09, 700, 120, 'lowpass'); break;
      case 'count': this.tone(660, 660, 0.12, 'square', 0.07); break;
      case 'go': this.tone(880, 1320, 0.25, 'square', 0.08); this.tone(440, 660, 0.25, 'triangle', 0.08); break;
      case 'eliminated': this.tone(900, 120, 0.7, 'sawtooth', 0.06); this.hiss(0.5, 0.08, 2000, 200); break;
      case 'roundWin': [523, 659, 784, 1047].forEach((f, i) => this.tone(f, f, 0.18, 'triangle', 0.09, i * 0.09)); break;
      case 'draw': [440, 415, 392].forEach((f, i) => this.tone(f, f * .98, 0.2, 'triangle', 0.08, i * 0.12)); break;
      case 'matchWin': [523, 659, 784, 1047, 784, 1047, 1319].forEach((f, i) => this.tone(f, f, 0.22, 'triangle', 0.09, i * 0.1)); break;
      case 'pickup': [784, 1175, 1568].forEach((f, i) => this.tone(f, f, 0.12, 'sine', 0.08, i * 0.05)); break;
      case 'spawn': this.tone(1046, 1568, 0.2, 'sine', 0.04); break;
      case 'warn': [0, 0.22].forEach(d => this.tone(740, 560, 0.18, 'square', 0.06, d)); break;
      case 'click': this.tone(900, 1100, 0.05, 'triangle', 0.06); break;
      case 'bump': this.tone(200, 140, 0.08, 'triangle', 0.1); break;
      case 'feather': this.hiss(0.25, 0.04, 3000, 1500); break;
    }
  }
}
