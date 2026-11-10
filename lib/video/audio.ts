// Homemade audio: a tiny synth that writes music beds + sound effects as WAV. No samples, no services.
import { writeFileSync } from "node:fs";
import type { VideoSpec } from "./spec";

export const SR = 44100;
export type MusicStyle = "upbeat" | "chill" | "hype" | "cinematic" | "pulse" | "ambient" | "none";

// ---------- DSP primitives ----------
const TAU = Math.PI * 2;
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
}
const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

class Bus {
  L: Float32Array;
  R: Float32Array;
  constructor(public len: number) {
    this.L = new Float32Array(len);
    this.R = new Float32Array(len);
  }
  add(i: number, v: number, pan = 0) {
    if (i < 0 || i >= this.len) return;
    this.L[i] += v * (1 - Math.max(0, pan));
    this.R[i] += v * (1 + Math.min(0, pan));
  }
}

function kick(bus: Bus, t: number, gain = 0.9, deep = false) {
  const start = Math.round(t * SR), n = Math.round(SR * (deep ? 0.6 : 0.32));
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const x = i / SR;
    const f = (deep ? 38 : 48) + (deep ? 90 : 120) * Math.exp(-x * 28);
    ph += (TAU * f) / SR;
    const env = Math.exp(-x * (deep ? 4.5 : 9)) * (1 - Math.exp(-x * 900));
    const v = Math.tanh(Math.sin(ph) * 1.6) * env * gain;
    bus.add(start + i, v);
  }
}
function noiseHit(bus: Bus, t: number, dur: number, decay: number, gain: number, hp: number, pan = 0, seed = 1) {
  const start = Math.round(t * SR), n = Math.round(SR * dur), r = rng(seed + start);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const w = r();
    lp += (w - lp) * hp; // one-pole; output = w - lp is a high-pass
    const env = Math.exp(-(i / SR) * decay);
    bus.add(start + i, (w - lp) * env * gain, pan);
  }
}
function snare(bus: Bus, t: number, gain = 0.35) {
  noiseHit(bus, t, 0.22, 18, gain, 0.12, 0, 7);
  const start = Math.round(t * SR);
  for (let i = 0; i < SR * 0.12; i++) bus.add(start + i, Math.sin((TAU * 185 * i) / SR) * Math.exp(-(i / SR) * 30) * gain * 0.6);
}
function hat(bus: Bus, t: number, gain = 0.09, open = false, pan = 0.2) {
  noiseHit(bus, t, open ? 0.25 : 0.05, open ? 12 : 70, gain, 0.6, pan, 3);
}
function tone(bus: Bus, t: number, dur: number, freq: number, o: { gain?: number; wave?: "saw" | "sine" | "square" | "tri"; attack?: number; release?: number; cutoff?: number; pan?: number; detune?: number; glideTo?: number } = {}) {
  const start = Math.round(t * SR), n = Math.round(SR * (dur + (o.release ?? 0.1)));
  const gain = o.gain ?? 0.1, atk = o.attack ?? 0.005, rel = o.release ?? 0.1;
  const voices = o.detune ? [-o.detune, 0, o.detune] : [0];
  const ph = voices.map(() => Math.random());
  let lp = 0;
  const a = o.cutoff ? 1 - Math.exp((-TAU * o.cutoff) / SR) : 1;
  for (let i = 0; i < n; i++) {
    const x = i / SR;
    const env = Math.min(1, x / atk) * (x > dur ? Math.exp(-(x - dur) / (rel / 4)) : 1);
    const f = o.glideTo ? freq + (o.glideTo - freq) * Math.min(1, x / dur) : freq;
    let s = 0;
    voices.forEach((d, k) => {
      ph[k] = (ph[k] + (f * Math.pow(2, d / 1200)) / SR) % 1;
      const p = ph[k];
      s += o.wave === "sine" ? Math.sin(TAU * p) : o.wave === "square" ? (p < 0.5 ? 1 : -1) * 0.6 : o.wave === "tri" ? 1 - 4 * Math.abs(p - 0.5) : 2 * p - 1;
    });
    s /= voices.length;
    lp += (s - lp) * a;
    bus.add(start + i, lp * env * gain, o.pan ?? 0);
  }
}

// ---------- music ----------
const STYLES: Record<string, { bpm: number; prog: number[][]; root: number; swing: number }> = {
  upbeat: { bpm: 122, root: 57, swing: 0, prog: [[0, 4, 7], [-4, 0, 3], [-7, -3, 0], [-2, 2, 5]] }, // A: I–vi–IV–V-ish
  chill: { bpm: 88, root: 52, swing: 0.12, prog: [[0, 3, 7, 10], [5, 8, 12, 15], [-2, 2, 5, 9], [-4, 0, 3, 7]] },
  hype: { bpm: 140, root: 50, swing: 0, prog: [[0, 3, 7], [0, 3, 7], [-4, 0, 3], [-2, 1, 5]] },
  cinematic: { bpm: 76, root: 48, swing: 0, prog: [[0, 3, 7], [-4, 0, 3], [-9, -5, -2], [-5, -2, 2]] },
};

export function beatSeconds(style: MusicStyle) {
  const st = STYLES[style === "pulse" ? "upbeat" : style === "ambient" ? "cinematic" : style] || STYLES.upbeat;
  return 60 / st.bpm;
}

export function synthMusic(style: MusicStyle, seconds: number, seed = 1): Bus | null {
  if (style === "none") return null;
  const key = style === "pulse" ? "upbeat" : style === "ambient" ? "cinematic" : style;
  const st = STYLES[key] || STYLES.upbeat;
  const beat = 60 / st.bpm;
  const len = Math.ceil((seconds + 1.5) * SR);
  const bus = new Bus(len);
  const bars = Math.ceil(seconds / (beat * 4)) + 1;
  for (let bar = 0; bar < bars; bar++) {
    const chord = st.prog[bar % st.prog.length];
    const t0 = bar * beat * 4;
    const intro = bar === 0; // first bar: drums sparse so the hook hits harder
    // pads / chords
    for (const n of chord) tone(bus, t0, beat * 4, midi(st.root + 12 + n), { wave: "saw", gain: key === "cinematic" ? 0.05 : 0.035, attack: key === "chill" ? 0.08 : 0.25, release: 0.6, cutoff: key === "cinematic" ? 900 : 1400, detune: 9, pan: (n % 2 ? 0.3 : -0.3) });
    // bass
    const bassNote = midi(st.root - 12 + chord[0]);
    if (key === "hype") tone(bus, t0, beat * 2.5, bassNote, { wave: "sine", gain: 0.32, release: 0.2, glideTo: bassNote * 0.94 });
    else for (let e = 0; e < 8; e++) if (!(key === "cinematic" && e % 4)) tone(bus, t0 + e * beat * 0.5, beat * (key === "cinematic" ? 2 : 0.42), bassNote, { wave: key === "chill" ? "tri" : "saw", gain: key === "chill" ? 0.14 : 0.11, cutoff: 320, release: 0.06 });
    // pluck arpeggio (upbeat/chill)
    if (key === "upbeat" || key === "chill")
      for (let e = 0; e < 8; e++) {
        const n = chord[e % chord.length] + (e > 3 ? 12 : 0);
        tone(bus, t0 + e * beat * 0.5 + (e % 2 ? st.swing * beat : 0), beat * 0.2, midi(st.root + 24 + n), { wave: "tri", gain: 0.035, release: 0.25, cutoff: 3000, pan: e % 2 ? 0.4 : -0.4 });
      }
    // drums
    for (let b = 0; b < 4; b++) {
      const t = t0 + b * beat;
      if (key === "cinematic") { if (b === 0) kick(bus, t, 0.8, true); continue; }
      if (key === "hype") { if (b === 0 || (b === 2 && bar % 2)) kick(bus, t, 0.9, true); if (b % 2 === 1) snare(bus, t, 0.32); for (let h = 0; h < 4; h++) hat(bus, t + h * beat * 0.25, 0.06); continue; }
      if (!intro || b === 0) kick(bus, t, key === "chill" ? 0.6 : 0.85);
      if (!intro && b % 2 === 1) snare(bus, t, key === "chill" ? 0.18 : 0.28);
      if (!intro) { hat(bus, t + beat * 0.5 + st.swing * beat, 0.07); if (key === "upbeat") hat(bus, t, 0.035, false, -0.2); }
    }
    if (key === "cinematic" && bar % 2 === 1) noiseHit(bus, t0 + beat * 3.5, 0.6, 3, 0.05, 0.02, 0, 9);
  }
  return bus;
}

// ---------- sound effects ----------
export function whoosh(bus: Bus, t: number, dur = 0.35, gain = 0.22, up = true) {
  const start = Math.round((t - dur * 0.7) * SR), n = Math.round(dur * SR), r = rng(11 + start);
  let lp = 0, bp = 0;
  for (let i = 0; i < n; i++) {
    const x = i / n;
    const cut = up ? 0.02 + 0.25 * x : 0.27 - 0.25 * x;
    const w = r();
    lp += (w - lp) * cut;
    bp += (lp - bp) * 0.5;
    const env = Math.sin(Math.PI * x) ** 2;
    bus.add(start + i, (lp - bp) * env * gain * 3, (x - 0.5) * 0.8);
  }
}
export function pop(bus: Bus, t: number, gain = 0.12, pitch = 1) {
  tone(bus, t, 0.05, 900 * pitch, { wave: "sine", gain, glideTo: 320 * pitch, release: 0.04 });
}
export function click(bus: Bus, t: number, gain = 0.1) {
  noiseHit(bus, t, 0.03, 120, gain, 0.4, 0, 21);
  tone(bus, t, 0.03, 2400, { wave: "sine", gain: gain * 0.6, release: 0.02 });
}
export function riser(bus: Bus, t: number, dur = 0.9, gain = 0.08) {
  tone(bus, t - dur, dur, 220, { wave: "saw", gain, glideTo: 880, cutoff: 2500, detune: 12, release: 0.05 });
  const start = Math.round((t - dur) * SR), n = Math.round(dur * SR), r = rng(5);
  for (let i = 0; i < n; i++) bus.add(start + i, r() * (i / n) ** 2 * gain * 0.6);
}
export function impact(bus: Bus, t: number, gain = 0.6) {
  kick(bus, t, gain, true);
  noiseHit(bus, t, 0.5, 6, gain * 0.15, 0.05, 0, 13);
}
export function tick(bus: Bus, t: number, gain = 0.05) {
  tone(bus, t, 0.012, 3200, { wave: "square", gain, release: 0.01 });
}

/** Place SFX automatically from the timeline (mirrors the renderer's animation timing). */
export function synthSfx(spec: VideoSpec): Bus {
  const bus = new Bus(Math.ceil((spec.duration + 1) * SR));
  const lvl = spec.sfx === false ? 0 : 1;
  if (!lvl) return bus;
  spec.scenes.forEach((s, i) => {
    const words = (s.text || "").replace(/\*/g, "").split(/\s+/).filter(Boolean);
    const tr = s.transition || (i === 0 ? "cut" : "fade");
    if (i > 0 && (tr === "slide" || tr === "zoom")) whoosh(bus, s.start + 0.12, 0.38, 0.2, tr === "zoom");
    if (i > 0 && tr === "cut") tick(bus, s.start, 0.05);
    if (s.type === "hook" || (s.type === "cta" && words.length)) words.forEach((_, w) => pop(bus, s.start + w * (s.type === "cta" ? 0.07 : 0.09) + 0.05, 0.07, 1 + (w % 3) * 0.12));
    if (s.type === "list" || s.type === "steps") {
      const n = Math.min(6, s.items?.length || 0);
      const slot = ((s.end - s.start) * 0.8) / Math.max(1, n);
      for (let j = 0; j < n; j++) click(bus, s.start + 0.25 + j * slot, 0.1);
    }
    if (s.type === "stat" || s.type === "price") for (let k = 0; k < 10; k++) tick(bus, s.start + k * 0.1, 0.03);
    if (s.type === "map") (s.items || []).slice(0, 5).forEach((_, k) => pop(bus, s.start + k * 0.35 + 0.35, 0.09, 0.8 + k * 0.1));
    if (s.type === "compare") {
      const n = Math.max(s.items?.length || 0, s.items2?.length || 0);
      for (let j = 0; j < n * 2; j++) click(bus, s.start + 0.4 + j * (((s.end - s.start) * 0.6) / Math.max(1, n * 2)), 0.08);
    }
    if (s.type === "myth_fact") { impact(bus, s.start + (s.end - s.start) * 0.45, 0.35); }
    if (s.type === "cta") { riser(bus, s.start, 0.8, 0.06); impact(bus, s.start, 0.55); }
  });
  if (spec.scenes[0]) impact(bus, 0.02, 0.4);
  return bus;
}

/** Normalize and write a stereo 16-bit WAV. */
export function writeWav(path: string, bus: Bus, peak = 0.9) {
  let max = 1e-6;
  for (let i = 0; i < bus.len; i++) max = Math.max(max, Math.abs(bus.L[i]), Math.abs(bus.R[i]));
  const g = max > peak ? peak / max : 1;
  const buf = Buffer.alloc(44 + bus.len * 4);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + bus.len * 4, 4); buf.write("WAVE", 8); buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(bus.len * 4, 40);
  for (let i = 0; i < bus.len; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, bus.L[i] * g)) * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, bus.R[i] * g)) * 32767), 46 + i * 4);
  }
  writeFileSync(path, buf);
  return path;
}

/** Snap scene durations to whole beats so cuts land on the music (only when there's no voiceover driving timing). */
export function snapToBeats(spec: VideoSpec): VideoSpec {
  if (!spec.music || spec.music === "none" || spec.captions?.length || spec.scenes.some((s) => s.vo)) return spec;
  const b = beatSeconds(spec.music);
  let t = 0;
  const scenes = spec.scenes.map((s) => {
    const beats = Math.max(2, Math.round((s.end - s.start) / b));
    const o = { ...s, start: +t.toFixed(3), end: +(t + beats * b).toFixed(3) };
    t += beats * b;
    return o;
  });
  return { ...spec, scenes, duration: +t.toFixed(3) };
}
