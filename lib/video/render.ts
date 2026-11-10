// Frame-by-frame video renderer: Skia canvas → raw RGBA → ffmpeg (H.264 + optional voiceover/music) → MP4.
import { createCanvas, loadImage, GlobalFonts, ImageData, type Image, type SKRSContext2D, type Canvas } from "@napi-rs/canvas";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compileScene, replay, type CompiledScene } from "./sandbox";
import type { Scene, VideoSpec } from "./spec";

// ---------- fonts ----------
let fontsReady = false;
export function ensureFonts() {
  if (fontsReady) return;
  const dirs = [path.join(process.cwd(), "assets/fonts"), path.join(__dirname, "../../assets/fonts"), path.join(__dirname, "../../../assets/fonts")];
  const dir = dirs.find((d) => existsSync(path.join(d, "Anton_400Regular.ttf")));
  if (dir) {
    GlobalFonts.registerFromPath(path.join(dir, "Anton_400Regular.ttf"), "Anton");
    GlobalFonts.registerFromPath(path.join(dir, "Inter_800ExtraBold.ttf"), "Inter");
    GlobalFonts.registerFromPath(path.join(dir, "Inter_500Medium.ttf"), "Inter");
  }
  fontsReady = true;
}

let charWidthCache: Record<string, number[]> | null = null;
function charWidths() {
  if (charWidthCache) return charWidthCache;
  ensureFonts();
  const c = createCanvas(10, 10).getContext("2d");
  const table = (font: string) => {
    c.font = font;
    return Array.from({ length: 95 }, (_, i) => Math.round(c.measureText(String.fromCharCode(32 + i)).width * 10) / 10);
  };
  charWidthCache = { Anton: table("100px Anton"), Inter: table("500 100px Inter"), InterBold: table("800 100px Inter") };
  return charWidthCache;
}

export function ffmpegPath(): string {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const p = require("ffmpeg-static") as string;
    if (p && existsSync(p)) return p;
  } catch {}
  return "ffmpeg";
}

// ---------- helpers ----------
const ease = {
  out: (x: number) => 1 - Math.pow(1 - clamp01(x), 3),
  inOut: (x: number) => ((x = clamp01(x)), x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
  back: (x: number) => {
    x = clamp01(x);
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
  },
};
function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}
function hexToRgb(h: string) {
  let s = h.replace("#", "");
  if (s.length === 3) s = s.split("").map((c) => c + c).join("");
  const n = parseInt(s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function lum([r, g, b]: number[]) {
  const f = (v: number) => ((v /= 255), v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a: number, b: number) {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}
function shade(hex: string, k: number) {
  const [r, g, b] = hexToRgb(hex).map((v) => Math.max(0, Math.min(255, Math.round(v * k))));
  return `rgb(${r},${g},${b})`;
}

type Token = { w: string; hi: boolean };
function tokens(text: string): Token[] {
  const out: Token[] = [];
  let hi = false;
  for (const raw of text.split(/\s+/).filter(Boolean)) {
    const starts = raw.startsWith("*");
    const ends = raw.endsWith("*") && raw.length > 1;
    if (starts) hi = true;
    out.push({ w: raw.replace(/\*/g, ""), hi: hi || (starts && ends) });
    if (ends) hi = false;
  }
  return out.filter((t) => t.w);
}

export interface TextBox { x: number; y: number; w: number; h: number; color: string; bgLum?: number; contrast?: number; scene: number; t: number; caption?: boolean }

// ---------- clip reader (decodes an mp4 into frames on the fly) ----------
class ClipReader {
  private buf = Buffer.alloc(0);
  private frames: Buffer[] = [];
  private done = false;
  private waiters: (() => void)[] = [];
  private last: Buffer | null = null;
  private idx = -1;
  private proc;
  constructor(url: string, private W: number, private H: number, fps: number) {
    const size = W * H * 4;
    this.proc = spawn(ffmpegPath(), [
      "-loglevel", "error", "-i", url,
      "-vf", `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${fps}`,
      "-f", "rawvideo", "-pix_fmt", "rgba", "-",
    ]);
    this.proc.stdout.on("data", (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      while (this.buf.length >= size) {
        this.frames.push(this.buf.subarray(0, size));
        this.buf = this.buf.subarray(size);
      }
      this.waiters.splice(0).forEach((w) => w());
      if (this.frames.length > 8) this.proc.stdout.pause();
    });
    const end = () => { this.done = true; this.waiters.splice(0).forEach((w) => w()); };
    this.proc.on("close", end);
    this.proc.on("error", end);
  }
  async frameAt(i: number): Promise<Buffer | null> {
    while (this.idx < i) {
      if (!this.frames.length) {
        if (this.done) return this.last;
        this.proc.stdout.resume();
        await new Promise<void>((r) => this.waiters.push(r));
        continue;
      }
      this.last = this.frames.shift()!;
      this.idx++;
      if (this.frames.length < 4) this.proc.stdout.resume();
    }
    return this.last;
  }
  close() {
    try { this.proc.kill("SIGKILL"); } catch {}
  }
}

// ---------- renderer ----------
export interface RenderResult {
  file: string;
  seconds: number;
  frames: number;
  qa_frames: { t: number; scene: number; jpeg: Buffer; png?: Buffer }[];
  text_boxes: TextBox[];
  code_errors: { scene: number; frames_failed: number; sample: string }[];
  blank_frames: number[];
  missing_assets: string[];
}

export async function renderVideo(
  spec: VideoSpec,
  opts: { out: string; voiceoverFile?: string; qaTimes?: number[]; still?: boolean }
): Promise<RenderResult> {
  ensureFonts();
  const t0 = Date.now();
  const { width: W, height: H, fps } = spec;
  const total = Math.max(1, Math.round(spec.duration * fps));

  // Load images (in parallel, with timeouts). Keys or URLs.
  const urls = new Set<string>();
  for (const s of spec.scenes) for (const k of [s.image, s.image2]) if (k) urls.add(spec.assets?.[k] || k);
  for (const v of Object.values(spec.assets || {})) urls.add(v);
  const images: Record<string, Image | undefined> = {};
  const missing: string[] = [];
  // Load with limited concurrency + retries (free image APIs rate-limit bursts).
  const list = [...urls];
  const loadOne = async (u: string) => {
    for (let a = 0; a < 3; a++) {
      try {
        if (u.startsWith("/") && existsSync(u)) { images[u] = await loadImage(u); return; }
        const res = await fetch(u, { signal: AbortSignal.timeout(60_000) });
        if (!res.ok) throw new Error(String(res.status));
        images[u] = await loadImage(Buffer.from(await res.arrayBuffer()));
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 2500 * (a + 1)));
      }
    }
    missing.push(u);
  };
  const workers = Array.from({ length: Math.min(3, list.length) }, async () => { while (list.length) await loadOne(list.shift()!); });
  await Promise.all(workers);
  const img = (k?: string) => (k ? images[spec.assets?.[k] || k] : undefined);
  const sandboxImages: Record<string, Image | undefined> = {};
  for (const [k, v] of Object.entries(spec.assets || {})) sandboxImages[k] = images[v];

  // Compile code scenes once.
  const compiled = new Map<number, CompiledScene>();
  const codeErrors = new Map<number, { n: number; sample: string }>();
  for (const [i, s] of spec.scenes.entries()) {
    if (s.type !== "code" || !s.code) continue;
    try {
      compiled.set(i, await compileScene(s.code, { W, H, colors: spec.theme as any, assets: Object.keys(spec.assets || {}), charWidths: charWidths(), textBottom: spec.captions?.length ? H * 0.64 : H * 0.78 }));
    } catch (e: any) {
      codeErrors.set(i, { n: 1e9, sample: e?.message || String(e) });
    }
  }
  const clips = new Map<number, ClipReader>();
  spec.scenes.forEach((s, i) => s.type === "clip" && s.video && clips.set(i, new ClipReader(s.video, W, H, fps)));

  const main = createCanvas(W, H);
  const mctx = main.getContext("2d");
  const off = [createCanvas(W, H), createCanvas(W, H)];
  const clipCanvas = createCanvas(W, H);

  const qaTimes = (opts.qaTimes || defaultQaTimes(spec)).map((t) => Math.min(total - 1, Math.round(t * fps)));
  const qaSet = new Set(qaTimes);
  const qa: RenderResult["qa_frames"] = [];
  const boxes: TextBox[] = [];
  const blanks: number[] = [];

  // ---- ffmpeg encoder (skipped for still images) ----
  mkdirSync(path.dirname(opts.out), { recursive: true });
  const enc = opts.still ? null : startEncoder();
  function startEncoder() {
  const args = ["-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${W}x${H}`, "-r", String(fps), "-i", "-"];
  let audioInputs = 0;
  const vo = opts.voiceoverFile && existsSync(opts.voiceoverFile);
  if (vo) { args.push("-i", opts.voiceoverFile!); audioInputs++; }
  const music = spec.music && spec.music !== "none" ? musicExpr(spec.music, spec.duration) : null;
  if (music) { args.push("-f", "lavfi", "-i", music); audioInputs++; }
  if (vo && music) {
    args.push("-filter_complex", `[2:a]volume=0.16[m];[1:a]volume=1.0[v];[v][m]amix=inputs=2:duration=longest:normalize=0,aresample=44100,aformat=channel_layouts=stereo,afade=t=out:st=${Math.max(0, spec.duration - 0.8)}:d=0.8[a]`, "-map", "0:v", "-map", "[a]");
  } else if (vo) {
    args.push("-map", "0:v", "-map", "1:a", "-ar", "44100", "-ac", "2");
  } else if (music) {
    args.push("-filter_complex", `[1:a]volume=0.5,afade=t=out:st=${Math.max(0, spec.duration - 1)}:d=1[a]`, "-map", "0:v", "-map", "[a]");
  }
  args.push("-c:v", "libx264", "-preset", process.env.X264_PRESET || "veryfast", "-crf", "21", "-pix_fmt", "yuv420p", "-r", String(fps));
  if (audioInputs) args.push("-c:a", "aac", "-b:a", "160k");
  args.push("-t", String(spec.duration), "-movflags", "+faststart", opts.out);
  const ff = spawn(ffmpegPath(), args, { stdio: ["pipe", "ignore", "pipe"] });
  let ffErr = "";
  ff.stderr.on("data", (d) => (ffErr += d.toString()));
  const ffDone = new Promise<void>((res, rej) => {
    ff.on("close", (code) => (code === 0 ? res() : rej(new Error("ffmpeg failed: " + ffErr.slice(-600)))));
    ff.on("error", rej);
  });
  const write = (buf: Buffer) => new Promise<void>((res) => (ff.stdin.write(buf) ? res() : ff.stdin.once("drain", () => res())));
  return { ff, ffDone, write };
  }

  // ---- draw one scene into a canvas ----
  const drawScene = async (c: Canvas, i: number, lt: number, frameIdx: number, isQa: boolean) => {
    const s = spec.scenes[i];
    const ctx = c.getContext("2d");
    const dur = s.end - s.start;
    const p = clamp01(lt / dur);
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.fillStyle = spec.theme.bg;
    ctx.fillRect(0, 0, W, H);
    const env: Env = { ctx, W, H, spec, s, i, lt, p, dur, isQa, boxes, frameT: frameIdx / fps };
    try {
      switch (s.type) {
        case "hook": drawHook(env, img(s.image)); break;
        case "image": drawImageScene(env, img(s.image)); break;
        case "list": drawList(env, img(s.image)); break;
        case "stat": drawStat(env, img(s.image)); break;
        case "before_after": {
          const a = img(s.image), b = img(s.image2);
          if (a && b) drawBeforeAfter(env, a, b);
          else drawImageScene(env, a || b); // never show a half-empty wipe
          break;
        }
        case "cta": drawCta(env); break;
        case "clip": {
          const reader = clips.get(i);
          const fr = reader ? await reader.frameAt(Math.floor(lt * fps)) : null;
          if (fr) {
            clipCanvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(fr.buffer, fr.byteOffset, fr.length), W, H), 0, 0);
            ctx.drawImage(clipCanvas as any, 0, 0);
            overlayGradient(ctx, W, H, s.dim ?? 0.55);
            if (s.text) lowerThird(env);
          } else drawImageScene(env, img(s.image));
          break;
        }
        case "code": {
          const sc = compiled.get(i);
          const r = sc ? sc.frame(lt, p) : { cmds: null, error: codeErrors.get(i)?.sample || "not compiled" };
          if (r.cmds) replay(ctx, r.cmds, sandboxImages, isQa ? (b) => {
            const col = /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : "#ffffff";
            recordBox(env, b, col);
          } : undefined);
          else {
            const e = codeErrors.get(i) || { n: 0, sample: r.error || "" };
            if (e.n < 1e9) e.n++;
            codeErrors.set(i, e);
            drawHook(env, img(s.image)); // safe fallback so the video never breaks
          }
          break;
        }
      }
    } finally {
      ctx.restore();
    }
  };

  let prevIdx = -1;
  for (let f = 0; f < total; f++) {
    if (opts.still && !qaSet.has(f)) continue;
    const t = f / fps;
    let i = spec.scenes.findIndex((s) => t >= s.start && t < s.end);
    if (i < 0) i = spec.scenes.length - 1;
    const s = spec.scenes[i];
    const lt = t - s.start;
    const isQa = qaSet.has(f);
    const T = 0.28;
    const tr = s.transition || (i === 0 ? "cut" : "fade");
    mctx.save();
    if (i > 0 && lt < T && tr !== "cut") {
      const k = ease.out(lt / T);
      const prev = spec.scenes[i - 1];
      await drawScene(off[1], i - 1, prev.end - prev.start + lt, f, false);
      await drawScene(off[0], i, lt, f, isQa);
      mctx.drawImage(off[1] as any, 0, 0);
      if (tr === "slide") {
        mctx.drawImage(off[0] as any, W * (1 - k), 0);
      } else if (tr === "zoom") {
        const sc = 1.18 - 0.18 * k;
        mctx.globalAlpha = k;
        mctx.drawImage(off[0] as any, (W - W * sc) / 2, (H - H * sc) / 2, W * sc, H * sc);
      } else {
        mctx.globalAlpha = k;
        mctx.drawImage(off[0] as any, 0, 0);
      }
    } else {
      await drawScene(off[0], i, lt, f, isQa);
      mctx.drawImage(off[0] as any, 0, 0);
    }
    mctx.restore();

    // Global overlays: captions + progress bar.
    if (spec.captions?.length) drawCaptions(mctx, spec, t, W, H, isQa ? boxes : null, i);
    if (spec.progress_bar) {
      mctx.fillStyle = "rgba(255,255,255,0.18)";
      mctx.fillRect(0, 0, W, Math.round(H * 0.004));
      mctx.fillStyle = spec.theme.accent;
      mctx.fillRect(0, 0, W * (t / spec.duration), Math.round(H * 0.004));
    }

    if (isQa) {
      qa.push({ t: Math.round(t * 100) / 100, scene: i, jpeg: main.encodeSync("jpeg", 82), png: opts.still ? main.encodeSync("png") : undefined });
      if (isBlank(mctx, W, H)) blanks.push(Math.round(t * 100) / 100);
    }
    if (enc) await enc.write(Buffer.from(main.data()));
    prevIdx = i;
  }
  void prevIdx;
  if (enc) { enc.ff.stdin.end(); await enc.ffDone; }
  for (const c of compiled.values()) c.dispose();
  for (const c of clips.values()) c.close();

  return {
    file: opts.out,
    seconds: Math.round((Date.now() - t0) / 100) / 10,
    frames: total,
    qa_frames: qa,
    text_boxes: boxes,
    code_errors: [...codeErrors.entries()].map(([scene, e]) => ({ scene, frames_failed: e.n >= 1e9 ? total : e.n, sample: e.sample.slice(0, 200) })),
    blank_frames: blanks,
    missing_assets: missing,
  };
}

export function defaultQaTimes(spec: VideoSpec) {
  const ts = [Math.min(0.6, spec.duration / 4)];
  for (const s of spec.scenes) ts.push(s.start + (s.end - s.start) * 0.7);
  return [...new Set(ts.map((t) => Math.round(t * 10) / 10))].slice(0, 9);
}

function isBlank(ctx: SKRSContext2D, W: number, H: number) {
  const d = ctx.getImageData(0, 0, W, H).data;
  let sum = 0, sq = 0, n = 0;
  for (let i = 0; i < d.length; i += 4 * 97) {
    const l = 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2];
    sum += l; sq += l * l; n++;
  }
  const mean = sum / n;
  return Math.sqrt(sq / n - mean * mean) < 5;
}

function musicExpr(kind: "pulse" | "ambient", dur: number) {
  const d = Math.ceil(dur + 1);
  if (kind === "pulse")
    return `aevalsrc='0.55*sin(2*PI*55*t)*exp(-9*mod(t,0.5))+0.05*(random(0)-0.5)*exp(-45*mod(t+0.25,0.5))+0.06*(sin(2*PI*220*t)+sin(2*PI*261.63*t)+sin(2*PI*329.63*t))*(0.6+0.4*sin(2*PI*0.25*t))|0.55*sin(2*PI*55*t)*exp(-9*mod(t,0.5))+0.05*(random(1)-0.5)*exp(-45*mod(t+0.25,0.5))+0.06*(sin(2*PI*220.5*t)+sin(2*PI*262.1*t)+sin(2*PI*330.2*t))*(0.6+0.4*sin(2*PI*0.25*t))':s=44100:d=${d}`;
  return `aevalsrc='0.09*(sin(2*PI*174.6*t)+sin(2*PI*220*t)+sin(2*PI*261.6*t))*(0.55+0.45*sin(2*PI*0.1*t))|0.09*(sin(2*PI*175*t)+sin(2*PI*220.4*t)+sin(2*PI*262*t))*(0.55+0.45*sin(2*PI*0.1*t+1))':s=44100:d=${d}`;
}

// ---------- scene drawers ----------
interface Env { ctx: SKRSContext2D; W: number; H: number; spec: VideoSpec; s: Scene; i: number; lt: number; p: number; dur: number; isQa: boolean; boxes: TextBox[]; frameT: number }
const caps = (e: Env) => !!e.spec.captions?.length;

function cover(ctx: SKRSContext2D, im: Image, W: number, H: number, zoom = 1, px = 0, py = 0) {
  const r = Math.max(W / im.width, H / im.height) * zoom;
  const w = im.width * r, h = im.height * r;
  ctx.drawImage(im, (W - w) / 2 + px * W, (H - h) / 2 + py * H, w, h);
}
function kenBurns(e: Env, im: Image) {
  const m = e.s.motion || "zoom_in";
  const k = ease.inOut(e.p);
  const z = m === "zoom_out" ? 1.18 - 0.14 * k : m === "none" ? 1.04 : 1.04 + 0.14 * k;
  const px = m === "pan_left" ? 0.05 - 0.1 * k : m === "pan_right" ? -0.05 + 0.1 * k : 0;
  cover(e.ctx, im, e.W, e.H, m.startsWith("pan") ? 1.16 : z, px, 0);
}
function overlayGradient(ctx: SKRSContext2D, W: number, H: number, strength: number) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, `rgba(0,0,0,${strength * 0.55})`);
  g.addColorStop(0.45, `rgba(0,0,0,${strength * 0.25})`);
  g.addColorStop(1, `rgba(0,0,0,${strength})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}
function brandBackdrop(e: Env) {
  const { ctx, W, H, spec } = e;
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, spec.theme.bg);
  g.addColorStop(1, shade(spec.theme.bg, 0.55));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // animated accent stripes
  ctx.save();
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = spec.theme.accent;
  ctx.translate(W / 2, H / 2);
  ctx.rotate(-0.35);
  const off = (e.frameT * 90) % 240;
  for (let x = -W * 1.5 - 240; x < W * 1.5; x += 240) ctx.fillRect(x + off, -H, 46, H * 2);
  ctx.restore();
  const rg = ctx.createRadialGradient(W / 2, H * 0.42, 10, W / 2, H * 0.42, W * 0.9);
  rg.addColorStop(0, "rgba(0,0,0,0)");
  rg.addColorStop(1, "rgba(0,0,0,0.55)");
  ctx.fillStyle = rg;
  ctx.fillRect(0, 0, W, H);
}

/** Fit tokens into a box: returns font size + wrapped lines. */
function fit(ctx: SKRSContext2D, toks: Token[], family: string, weight: string, maxW: number, maxH: number, maxSize: number, minSize = 34, lh = 1.08) {
  for (let size = maxSize; size >= minSize; size -= 4) {
    ctx.font = `${weight} ${size}px ${family}`;
    const space = ctx.measureText(" ").width;
    const lines: Token[][] = [];
    let line: Token[] = [], lw = 0, ok = true;
    for (const t of toks) {
      const w = ctx.measureText(t.w).width;
      if (w > maxW) { ok = false; break; }
      if (line.length && lw + space + w > maxW) { lines.push(line); line = [t]; lw = w; }
      else { lw += (line.length ? space : 0) + w; line.push(t); }
    }
    if (line.length) lines.push(line);
    if (ok && lines.length * size * lh <= maxH) return { size, lines, space };
  }
  ctx.font = `${weight} ${minSize}px ${family}`;
  const space = ctx.measureText(" ").width;
  return { size: minSize, lines: [toks], space };
}

/** Draw rich (highlighted, per-word animated) centered text; records bounding box + measured contrast for QA. */
function richText(
  e: Env,
  text: string,
  o: { cx: number; cy: number; maxW: number; maxH: number; maxSize: number; family: string; weight?: string; upper?: boolean; color?: string; stagger?: number; pop?: boolean; align?: "center" | "left"; x?: number; shadow?: boolean }
) {
  const { ctx, spec } = e;
  const toks = tokens(o.upper ? text.toUpperCase() : text);
  if (!toks.length) return { top: o.cy, bottom: o.cy };
  const weight = o.weight || (o.family === "Anton" ? "400" : "800");
  const lh = o.family === "Anton" ? 1.04 : 1.14;
  const f = fit(ctx, toks, o.family, weight, o.maxW, o.maxH, o.maxSize, 34, lh);
  const lineH = f.size * lh;
  const blockH = f.lines.length * lineH;
  const top = o.cy - blockH / 2;
  const color = o.color || spec.theme.fg;
  ctx.font = `${weight} ${f.size}px ${o.family}`;
  ctx.textBaseline = "alphabetic";
  let wi = 0;
  let minX = Infinity, maxX = -Infinity;
  const lineWidths = f.lines.map((l) => l.reduce((s, t, j) => s + ctx.measureText(t.w).width + (j ? f.space : 0), 0));
  const startXs = f.lines.map((_, li) => (o.align === "left" ? o.x ?? 60 : o.cx - lineWidths[li] / 2));
  minX = Math.min(...startXs);
  maxX = Math.max(...startXs.map((x, li) => x + lineWidths[li]));
  if (e.isQa) recordBox(e, { x: minX, y: top, w: maxX - minX, h: blockH }, color);
  for (const [li, line] of f.lines.entries()) {
    const lw = lineWidths[li];
    let x = startXs[li];
    void lw;
    const y = top + li * lineH + f.size * (o.family === "Anton" ? 0.9 : 0.82);
    for (const t of line) {
      const w = ctx.measureText(t.w).width;
      const appear = (o.stagger ?? 0) * wi;
      const k = o.pop ? ease.back((e.lt - appear) / 0.28) : ease.out((e.lt - appear) / 0.3);
      const a = clamp01((e.lt - appear) / 0.12);
      if (a > 0) {
        ctx.save();
        ctx.globalAlpha = a;
        ctx.translate(x + w / 2, y - f.size * 0.35);
        const sc = o.pop ? 1.5 - 0.5 * k : 1;
        ctx.scale(sc, sc);
        ctx.translate(0, o.pop ? 0 : (1 - k) * 30);
        if (t.hi) {
          ctx.fillStyle = spec.theme.accent;
          const pad = f.size * 0.08;
          ctx.save();
          ctx.globalAlpha = a * 0.95;
          ctx.translate(0, f.size * 0.03);
          ctx.rotate(-0.025);
          ctx.fillRect(-w / 2 - pad, -f.size * 0.58, w + pad * 2, f.size * 1.08);
          ctx.restore();
        }
        if (o.shadow !== false) { ctx.shadowColor = "rgba(0,0,0,0.55)"; ctx.shadowBlur = f.size * 0.18; ctx.shadowOffsetY = f.size * 0.04; }
        ctx.fillStyle = t.hi ? pickOn(spec.theme.accent) : color;
        ctx.fillText(t.w, -w / 2, f.size * 0.35);
        ctx.restore();
      }
      x += w + f.space;
      wi++;
    }
  }
  return { top, bottom: top + blockH };
}
function pickOn(bg: string) {
  return lum(hexToRgb(bg)) > 0.45 ? "#111111" : "#ffffff";
}
function recordBox(e: Env, b: { x: number; y: number; w: number; h: number }, color: string) {
  // Measures the real pixels behind the text area *before* glyphs are drawn. Uses the worst-case third of the
  // background (brightest for light text, darkest for dark text) so busy photos don't hide low-contrast spots.
  const x = Math.max(0, Math.floor(b.x)), y = Math.max(0, Math.floor(b.y));
  const w = Math.max(1, Math.min(e.W - x, Math.ceil(b.w))), h = Math.max(1, Math.min(e.H - y, Math.ceil(b.h)));
  const d = e.ctx.getImageData(x, y, w, h).data;
  const textL = lum(hexToRgb(color.startsWith("#") ? color : "#ffffff"));
  const ls: number[] = [];
  for (let i = 0; i < d.length; i += 4 * 13) ls.push(lum([d[i], d[i + 1], d[i + 2]]));
  ls.sort((a, b2) => a - b2);
  const q = Math.floor(ls.length / 3);
  const bgSlice = textL > 0.5 ? ls.slice(-Math.max(1, q)) : ls.slice(0, Math.max(1, q));
  const bgL = bgSlice.reduce((a, c) => a + c, 0) / bgSlice.length;
  e.boxes.push({ ...b, color, bgLum: Math.round(bgL * 1000) / 1000, contrast: Math.round(contrast(textL, bgL) * 10) / 10, scene: e.i, t: Math.round(e.frameT * 100) / 100 });
}

function drawHook(e: Env, im?: Image) {
  const { ctx, W, H, s, spec } = e;
  if (im) { kenBurns(e, im); overlayGradient(ctx, W, H, s.dim ?? 0.75); } else brandBackdrop(e);
  const cy = s.layout === "top" ? H * 0.3 : s.layout === "bottom" && !caps(e) ? H * 0.58 : caps(e) ? H * 0.36 : H * 0.42;
  const r = richText(e, s.text || "", { cx: W / 2, cy, maxW: W - 150, maxH: caps(e) ? H * 0.34 : H * 0.4, maxSize: Math.round(W * 0.17), family: spec.theme.display_font || "Anton", upper: true, stagger: 0.09, pop: true });
  if (s.subtext) {
    const sub = { ...e, lt: e.lt - 0.45 };
    richText(sub, s.subtext, { cx: W / 2, cy: r.bottom + H * 0.05, maxW: W - 200, maxH: H * 0.1, maxSize: Math.round(W * 0.05), family: "Inter", weight: "800" });
  }
}

function lowerThird(e: Env) {
  const { ctx, W, H, s, spec } = e;
  const k = ease.out(e.lt / 0.35);
  const top = s.layout === "top";
  const cy = top ? H * 0.22 : caps(e) ? H * 0.5 : H * 0.6;
  ctx.font = `800 ${Math.round(W * 0.075)}px Inter`;
  ctx.save();
  ctx.globalAlpha = k;
  ctx.translate(0, (1 - k) * 60);
  const r = richText({ ...e, lt: 10 }, s.text || "", { cx: W / 2, cy, maxW: W - 200, maxH: H * 0.2, maxSize: Math.round(W * 0.085), family: "Inter", weight: "800" });
  if (s.subtext) richText({ ...e, lt: 10 }, s.subtext, { cx: W / 2, cy: r.bottom + H * 0.04, maxW: W - 220, maxH: H * 0.08, maxSize: Math.round(W * 0.045), family: "Inter", weight: "500" });
  ctx.fillStyle = spec.theme.accent;
  ctx.fillRect(W / 2 - W * 0.08 * k, r.top - H * 0.025, W * 0.16 * k, Math.max(6, H * 0.004));
  ctx.restore();
}

function drawImageScene(e: Env, im?: Image) {
  if (im) { kenBurns(e, im); overlayGradient(e.ctx, e.W, e.H, e.s.dim ?? 0.7); } else brandBackdrop(e);
  if (e.s.text) lowerThird(e);
}

function drawList(e: Env, im?: Image) {
  const { ctx, W, H, s, spec } = e;
  if (im) { kenBurns(e, im); overlayGradient(ctx, W, H, s.dim ?? 0.85); } else brandBackdrop(e);
  const r = s.text ? richText(e, s.text, { cx: W / 2, cy: H * 0.2, maxW: W - 160, maxH: H * 0.14, maxSize: Math.round(W * 0.11), family: spec.theme.display_font || "Anton", upper: true }) : { bottom: H * 0.15 };
  const items = (s.items || []).slice(0, 6);
  const slot = (e.dur * 0.8) / Math.max(1, items.length);
  const rowH = Math.min(H * 0.11, ((caps(e) ? H * 0.64 : H * 0.74) - r.bottom) / Math.max(1, items.length));
  items.forEach((it, j) => {
    const at = 0.25 + j * slot;
    const k = ease.out((e.lt - at) / 0.35);
    if (k <= 0) return;
    const y = r.bottom + H * 0.04 + j * rowH + rowH / 2;
    ctx.save();
    ctx.globalAlpha = k;
    ctx.translate((1 - k) * -80, 0);
    ctx.fillStyle = spec.theme.accent;
    ctx.beginPath();
    ctx.arc(110, y, rowH * 0.28, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = pickOn(spec.theme.accent);
    ctx.lineWidth = rowH * 0.06;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(110 - rowH * 0.12, y);
    ctx.lineTo(110 - rowH * 0.02, y + rowH * 0.1);
    ctx.lineTo(110 + rowH * 0.14, y - rowH * 0.1);
    ctx.stroke();
    ctx.restore();
    richText({ ...e, lt: e.lt - at }, it, { cx: 0, cy: y, maxW: W - 260, maxH: rowH * 0.9, maxSize: Math.round(rowH * 0.42), family: "Inter", weight: "800", align: "left", x: 170 + (1 - k) * -80 });
  });
}

function drawStat(e: Env, im?: Image) {
  const { ctx, W, H, s, spec } = e;
  if (im) { kenBurns(e, im); overlayGradient(ctx, W, H, s.dim ?? 0.85); } else brandBackdrop(e);
  const m = (s.value || "").match(/^([^\d]*)([\d,.]+)(.*)$/);
  let shown = s.value || "";
  if (m) {
    const target = parseFloat(m[2].replace(/,/g, ""));
    const dec = (m[2].split(".")[1] || "").length;
    const v = target * ease.out(e.lt / Math.min(1.2, e.dur * 0.6));
    shown = m[1] + v.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec }) + m[3];
  }
  const pulse = 1 + 0.03 * Math.sin(e.lt * 6) * clamp01((e.lt - 1.2) / 0.3);
  ctx.save();
  const sy = caps(e) ? H * 0.34 : H * 0.4;
  ctx.translate(W / 2, sy);
  ctx.scale(pulse, pulse);
  ctx.translate(-W / 2, -sy);
  const r = richText({ ...e, lt: 10 }, shown, { cx: W / 2, cy: caps(e) ? H * 0.34 : H * 0.4, maxW: W - 120, maxH: H * 0.24, maxSize: Math.round(W * 0.3), family: "Anton", color: spec.theme.accent });
  ctx.restore();
  if (s.text) richText({ ...e, lt: e.lt - 0.3 }, s.text, { cx: W / 2, cy: r.bottom + H * 0.07, maxW: W - 180, maxH: H * 0.16, maxSize: Math.round(W * 0.075), family: "Inter", weight: "800" });
}

function drawBeforeAfter(e: Env, a?: Image, b?: Image) {
  const { ctx, W, H, spec } = e;
  if (a) cover(ctx, a, W, H, 1.06); else brandBackdrop(e);
  const k = ease.inOut((e.p - 0.12) / 0.6);
  const x = W * k;
  if (b) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, x, H);
    ctx.clip();
    cover(ctx, b, W, H, 1.06);
    ctx.restore();
  }
  overlayGradient(ctx, W, H, e.s.dim ?? 0.45);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(x - 4, 0, 8, H);
  ctx.beginPath();
  ctx.arc(x, H * 0.5, 44, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = spec.theme.accent;
  ctx.font = "800 34px Inter";
  ctx.textAlign = "center";
  ctx.fillText("⟷", x, H * 0.5 + 12);
  ctx.textAlign = "left";
  const tag = (label: string, tx: number, alpha: number) => {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `800 ${Math.round(W * 0.045)}px Inter`;
    const w = ctx.measureText(label).width + 48;
    ctx.fillStyle = label === "AFTER" ? spec.theme.accent : "rgba(0,0,0,0.7)";
    ctx.beginPath();
    ctx.roundRect(tx - w / 2, H * 0.16, w, W * 0.085, 18);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.fillText(label, tx, H * 0.16 + W * 0.06);
    ctx.restore();
  };
  tag("BEFORE", W * 0.75, clamp01(1.3 - k * 1.4));
  tag("AFTER", W * 0.25, clamp01(k * 1.6 - 0.2));
  if (e.s.text) richText({ ...e, lt: e.lt - 0.2 }, e.s.text, { cx: W / 2, cy: caps(e) ? H * 0.58 : H * 0.66, maxW: W - 180, maxH: H * 0.14, maxSize: Math.round(W * 0.08), family: "Inter", weight: "800" });
}

function drawCta(e: Env) {
  const { ctx, W, H, s, spec } = e;
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, shade(spec.theme.accent, 1));
  g.addColorStop(1, shade(spec.theme.accent, 0.45));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.globalAlpha = 0.1;
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 3;
  for (let r = 0; r < 6; r++) {
    ctx.beginPath();
    ctx.arc(W / 2, H * 0.45, ((e.lt * 220 + r * 180) % 1100), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
  const on = pickOn(spec.theme.accent);
  if (spec.brand_name) richText({ ...e, lt: e.lt + 1 }, spec.brand_name, { cx: W / 2, cy: H * 0.24, maxW: W - 200, maxH: H * 0.08, maxSize: Math.round(W * 0.07), family: "Inter", weight: "800", upper: true, color: on, shadow: false });
  const r = richText(e, s.text || "Book now", { cx: W / 2, cy: H * 0.4, maxW: W - 160, maxH: H * 0.22, maxSize: Math.round(W * 0.14), family: spec.theme.display_font || "Anton", upper: true, color: on, stagger: 0.07, pop: true });
  if (s.subtext) {
    const k = ease.back((e.lt - 0.5) / 0.4);
    if (k > 0) {
      const pulse = 1 + 0.035 * Math.sin(e.lt * 2 * Math.PI * 1.2);
      ctx.save();
      ctx.translate(W / 2, r.bottom + H * 0.09);
      ctx.scale(k * pulse, k * pulse);
      ctx.font = `800 ${Math.round(W * 0.065)}px Inter`;
      const w = Math.min(W - 140, ctx.measureText(s.subtext).width + 110);
      const h = W * 0.15;
      ctx.fillStyle = on === "#ffffff" ? "#ffffff" : "#111111";
      ctx.shadowColor = "rgba(0,0,0,0.35)";
      ctx.shadowBlur = 30;
      ctx.beginPath();
      ctx.roundRect(-w / 2, -h / 2, w, h, h / 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.restore();
      richText({ ...e, lt: 10 }, s.subtext, { cx: W / 2, cy: r.bottom + H * 0.09, maxW: w - 80, maxH: h * 0.7, maxSize: Math.round(W * 0.065 * k * pulse), family: "Inter", weight: "800", color: on === "#ffffff" ? spec.theme.accent : "#ffffff", shadow: false });
    }
  }
  if (spec.handle) richText({ ...e, lt: e.lt - 0.8 }, spec.handle, { cx: W / 2, cy: caps(e) ? H * 0.64 : H * 0.72, maxW: W - 200, maxH: H * 0.05, maxSize: Math.round(W * 0.045), family: "Inter", weight: "500", color: on, shadow: false });
}

function drawCaptions(ctx: SKRSContext2D, spec: VideoSpec, t: number, W: number, H: number, boxes: TextBox[] | null, scene: number) {
  const cap = spec.captions!.find((c) => t >= c.start && t < c.end);
  if (!cap) return;
  const words = cap.words?.length ? cap.words : cap.text.split(/\s+/).map((w, i, a) => ({ w, start: cap.start + ((cap.end - cap.start) * i) / a.length, end: cap.start + ((cap.end - cap.start) * (i + 1)) / a.length }));
  const size = Math.round(W * 0.062);
  ctx.save();
  ctx.font = `800 ${size}px Inter`;
  const space = ctx.measureText(" ").width;
  const maxW = W - 180;
  const lines: (typeof words)[] = [];
  let line: typeof words = [], lw = 0;
  for (const w of words) {
    const ww = ctx.measureText(w.w).width;
    if (line.length && lw + space + ww > maxW) { lines.push(line); line = [w]; lw = ww; } else { lw += (line.length ? space : 0) + ww; line.push(w); }
  }
  if (line.length) lines.push(line);
  const lh = size * 1.25;
  const y0 = H * 0.765 - (lines.length * lh) / 2;
  const widths = lines.map((l) => l.reduce((s, w, j) => s + ctx.measureText(w.w).width + (j ? space : 0), 0));
  const bw = Math.max(...widths) + 60;
  ctx.fillStyle = "rgba(0,0,0,0.62)";
  ctx.beginPath();
  ctx.roundRect(W / 2 - bw / 2, y0 - 18, bw, lines.length * lh + 30, 22);
  ctx.fill();
  if (boxes) {
    boxes.push({ x: W / 2 - bw / 2, y: y0 - 18, w: bw, h: lines.length * lh + 30, color: "#ffffff", bgLum: 0.02, contrast: 15, scene, t: Math.round(t * 100) / 100, caption: true });
  }
  lines.forEach((l, li) => {
    let x = W / 2 - widths[li] / 2;
    for (const w of l) {
      const active = t >= w.start && t < w.end;
      const ww = ctx.measureText(w.w).width;
      ctx.fillStyle = active ? spec.theme.accent : "#ffffff";
      if (active && lum(hexToRgb(spec.theme.accent)) < 0.08) ctx.fillStyle = "#ffd54a";
      ctx.fillText(w.w, x, y0 + li * lh + size * 0.92);
      x += ww + space;
    }
  });
  ctx.restore();
}

export function writeTmp(name: string, data: Buffer) {
  const dir = path.join(process.env.TMPDIR || "/tmp", "hype");
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  writeFileSync(p, data);
  return p;
}
