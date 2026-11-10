export type SceneType = "hook" | "image" | "list" | "stat" | "before_after" | "cta" | "clip" | "code" | "pov" | "myth_fact" | "compare" | "steps" | "price" | "quote" | "map";

export interface Scene {
  type: SceneType;
  start: number;
  end: number;
  /** Main on-screen text. Wrap a word in *asterisks* to highlight it in the accent color. */
  text?: string;
  subtext?: string;
  items?: string[];
  /** compare scene: right-hand column */
  items2?: string[];
  /** stat scene, e.g. "40 lbs" or "$150" — the number counts up */
  value?: string;
  /** image URL or a key in spec.assets */
  image?: string;
  /** before_after: the "after" image */
  image2?: string;
  /** clip scene: mp4 URL (e.g. an AI-generated clip) */
  video?: string;
  /** prompt used to generate the image (kept so QA can regenerate it) */
  image_prompt?: string;
  motion?: "zoom_in" | "zoom_out" | "pan_left" | "pan_right" | "none";
  layout?: "center" | "top" | "bottom";
  transition?: "cut" | "fade" | "slide" | "zoom";
  /** clip scene: prompt for the homemade AI video worker (used when `video` is empty and a worker is connected) */
  ai_prompt?: string;
  /** voiceover line spoken during this scene — the scene is timed to it (cuts land on the words) */
  vo?: string;
  /** 0..1 darkness of the overlay on photo/clip backgrounds (raise if text is hard to read) */
  dim?: number;
  /** code scene: JS defining `function draw(ctx, t, p, W, H, A) {...}` — runs in a QuickJS sandbox every frame */
  code?: string;
}

export interface Caption {
  start: number;
  end: number;
  text: string;
  words?: { w: string; start: number; end: number }[];
}

export interface VideoSpec {
  width: number;
  height: number;
  fps: number;
  duration: number;
  brand_name: string;
  handle?: string;
  theme: { bg: string; fg: string; accent: string; accent2?: string; display_font?: "Anton" | "Inter" };
  assets?: Record<string, string>;
  scenes: Scene[];
  captions?: Caption[];
  voiceover?: { script: string; voice?: string };
  music?: "none" | "upbeat" | "chill" | "hype" | "cinematic" | "pulse" | "ambient";
  /** auto sound effects (whoosh, pops, clicks, riser, impact) — default on */
  sfx?: boolean;
  caption_style?: "pop" | "box" | "karaoke" | "minimal";
  /** film finishing: grain, vignette, camera drift/shake — default on */
  finish?: boolean;
  progress_bar?: boolean;
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Make an LLM-written spec safe and renderable: clamp numbers, fix timeline, default colors. */
export function normalizeSpec(s: Partial<VideoSpec>, defaults: Partial<VideoSpec> = {}): VideoSpec {
  const width = clampInt(s.width ?? defaults.width ?? 1080, 360, 1920);
  const height = clampInt(s.height ?? defaults.height ?? 1920, 360, 1920);
  const fps = clampInt(s.fps ?? defaults.fps ?? 30, 12, 60);
  const theme = { ...(defaults.theme || {}), ...(s.theme || {}) } as VideoSpec["theme"];
  theme.bg = HEX.test(theme.bg || "") ? theme.bg : "#16161a";
  theme.fg = HEX.test(theme.fg || "") ? theme.fg : "#ffffff";
  theme.accent = HEX.test(theme.accent || "") ? theme.accent : "#ff3b3b";
  theme.accent2 = HEX.test(theme.accent2 || "") ? theme.accent2 : theme.accent;
  theme.display_font = theme.display_font === "Inter" ? "Inter" : "Anton";
  // Body text must be readable on the background no matter what colour the model picked.
  if (contrastHex(theme.fg, theme.bg) < 7) theme.fg = contrastHex("#ffffff", theme.bg) >= contrastHex("#111111", theme.bg) ? "#ffffff" : "#111111";

  const types: SceneType[] = ["hook", "image", "list", "stat", "before_after", "cta", "clip", "code", "pov", "myth_fact", "compare", "steps", "price", "quote", "map"];
  let scenes = (s.scenes || []).filter((x) => x && types.includes(x.type));
  if (!scenes.length) scenes = [{ type: "hook", start: 0, end: 3, text: s.brand_name || "Hello" }];
  // Coerce whatever shape the model returned into strings/arrays the renderer expects.
  const str = (v: any): string | undefined =>
    v === undefined || v === null ? undefined : typeof v === "string" ? v : typeof v === "number" ? String(v) : typeof v === "object" ? String(v.key ?? v.url ?? v.text ?? v.src ?? JSON.stringify(v)) : String(v);
  scenes = scenes.map((sc: any) => ({
    ...sc,
    text: str(sc.text), subtext: str(sc.subtext), value: str(sc.value), image: str(sc.image), image2: str(sc.image2),
    video: str(sc.video), code: str(sc.code), image_prompt: str(sc.image_prompt), vo: str(sc.vo), ai_prompt: str(sc.ai_prompt),
    items: Array.isArray(sc.items) ? sc.items.map((x: any) => str(x) || "").filter(Boolean).slice(0, 6) : undefined,
    items2: Array.isArray(sc.items2) ? sc.items2.map((x: any) => str(x) || "").filter(Boolean).slice(0, 6) : undefined,
    dim: typeof sc.dim === "number" ? Math.max(0, Math.min(0.97, sc.dim)) : undefined,
  }));
  const assetsIn: Record<string, string> = {};
  for (const [k, v] of Object.entries((s.assets as any) || {})) { const u = str(v); if (u) assetsIn[k] = u; }
  s = { ...s, assets: assetsIn };
  // Rebuild a continuous timeline from each scene's own duration.
  let t = 0;
  scenes = scenes.map((sc) => {
    const dur = Math.max(0.8, Math.min(12, Number(sc.end) - Number(sc.start) || 2.5));
    const out = { ...sc, start: round2(t), end: round2(t + dur) };
    t += dur;
    return out;
  });
  const duration = round2(t);
  return {
    width,
    height,
    fps,
    duration,
    brand_name: s.brand_name || defaults.brand_name || "",
    handle: s.handle || defaults.handle,
    theme,
    assets: s.assets || {},
    scenes,
    captions: s.captions,
    voiceover: s.voiceover,
    music: s.music || "none",
    sfx: s.sfx ?? true,
    caption_style: s.caption_style || "pop",
    finish: s.finish ?? true,
    progress_bar: s.progress_bar ?? true,
  };
}

/** Stretch scene timing so the video fits a voiceover of `target` seconds. */
export function retime(spec: VideoSpec, target: number): VideoSpec {
  const k = target / spec.duration;
  if (!isFinite(k) || k <= 0) return spec;
  return {
    ...spec,
    duration: round2(target),
    scenes: spec.scenes.map((s) => ({ ...s, start: round2(s.start * k), end: round2(s.end * k) })),
  };
}

export const wordsOf = (s?: string) => (s || "").replace(/\*/g, "").split(/\s+/).filter(Boolean);
const clampInt = (n: number, a: number, b: number) => Math.max(a, Math.min(b, Math.round(Number(n) || a)));
const round2 = (n: number) => Math.round(n * 100) / 100;

function lumHex(h: string) {
  let x = h.replace("#", "");
  if (x.length === 3) x = x.split("").map((c) => c + c).join("");
  const n = parseInt(x, 16);
  const f = (v: number) => ((v /= 255), v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255);
}
export function contrastHex(a: string, b: string) {
  const [x, y] = [lumHex(a), lumHex(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** Structural guarantees every video gets regardless of how good the model is. */
export function ensureStructure(spec: VideoSpec, f: { hook?: string; cta?: string; contact?: string; brand?: string }): { spec: VideoSpec; notes: string[] } {
  const s: VideoSpec = JSON.parse(JSON.stringify(spec));
  const notes: string[] = [];
  const first = s.scenes[0];
  if (!first || first.type !== "hook" || !first.text) {
    const text = (first?.text || f.hook || f.brand || "Watch this").split(/\s+/).slice(0, 7).join(" ");
    s.scenes.unshift({ type: "hook", start: 0, end: 2.2, text, image: first?.image });
    notes.push("added a hook scene");
  } else if (wordsOf(first.text).length > 8) {
    first.subtext = first.subtext || undefined;
    const w = first.text.split(/\s+/);
    first.text = w.slice(0, 7).join(" ");
    notes.push("trimmed hook to 7 words");
  }
  if (s.scenes[0].end - s.scenes[0].start > 3) s.scenes[0].end = s.scenes[0].start + 2.5;
  const last = s.scenes.at(-1)!;
  if (last.type !== "cta") {
    s.scenes.push({ type: "cta", start: 0, end: 3, text: (f.cta || "Book yours today").split(/\s+/).slice(0, 6).join(" "), subtext: f.contact, transition: "zoom" });
    notes.push("added a CTA end card");
  } else if (!last.subtext && f.contact) last.subtext = f.contact;
  return { spec: normalizeSpec(s, s), notes };
}
