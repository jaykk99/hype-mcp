// Homemade production pipeline shared by the MCP tools and the permanent-link routes.
// A video/graphic is fully described by its spec, so a link can carry the spec itself and the server
// re-renders on request (deterministic: same spec → same video). No storage service, no keys, never expires.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { gunzipSync, gzipSync } from "node:zlib";
import { publicBase, TMP } from "../storage";
import type { Platform } from "../platforms";
import { ffmpegPath, renderVideo, type RenderResult } from "./render";
import { ensureStructure, normalizeSpec, retime, type VideoSpec } from "./spec";
import { snapToBeats } from "./audio";
import { technicalChecks } from "./qa";
import { captionsFromWords, synthesize } from "./voice";
import { clipSize, parseWorker, submitClip, waitClips } from "./worker";

export const MAX_LINK_CHARS = 12_000;

export function encodeSpec(spec: Partial<VideoSpec>): string {
  const slim = { ...spec, captions: undefined };
  return gzipSync(Buffer.from(JSON.stringify(slim)), { level: 9 }).toString("base64url");
}
export function decodeSpec(token: string): Partial<VideoSpec> {
  return JSON.parse(gunzipSync(Buffer.from(token, "base64url")).toString("utf8"));
}
export function specHash(spec: Partial<VideoSpec>) {
  return createHash("sha256").update(JSON.stringify({ ...spec, captions: undefined })).digest("hex").slice(0, 16);
}

export function links(spec: Partial<VideoSpec>, kind: "v" | "i") {
  const token = encodeSpec(spec);
  const ext = kind === "v" ? "mp4" : "png";
  const permanent = token.length <= MAX_LINK_CHARS ? `${publicBase()}/api/${kind}/${token}.${ext}` : null;
  return { permanent, token_chars: token.length };
}

export interface Produced {
  file: string;
  spec: VideoSpec;
  render: RenderResult;
  voice?: string;
  checks: ReturnType<typeof technicalChecks>;
  technical: number;
  notes: string[];
}

/** spec → (homemade voiceover) → retime → captions → render → measured QA. */
export async function produceVideo(input: Partial<VideoSpec>, o: { platform?: Platform; voice?: string; brandName?: string; contact?: string; cache?: boolean; worker?: string; clipWaitMs?: number } = {}): Promise<Produced & { pending_clips?: { scene: number; id: string }[] }> {
  const notes: string[] = [];
  // AI footage: generate any clip scenes that only have an ai_prompt, using the homemade GPU worker.
  const pending: { scene: number; id: string }[] = [];
  const scenesIn: any[] = [...(input.scenes || [])];
  const want = scenesIn.map((sc, i) => ({ sc, i })).filter(({ sc }) => sc?.type === "clip" && !sc.video && sc.ai_prompt);
  if (want.length) {
    const w = parseWorker(o.worker);
    if (!w) {
      notes.push("clip scenes need a video worker link (run worker/hype_video_worker.ipynb) — showed them as text scenes");
    } else {
      const size = clipSize("9:16");
      const jobs = await Promise.all(want.map(async ({ sc, i }) => ({ i, id: await submitClip(w, { prompt: sc.ai_prompt, image_url: sc.image && /^https?:/.test(sc.image) ? sc.image : undefined, seconds: Math.min(5, Math.max(2, (sc.end - sc.start) || 4)), ...size }).catch((e) => { notes.push(`clip ${i + 1} failed to queue: ${e.message}`); return ""; }) })));
      const ok = jobs.filter((j) => j.id);
      const res = await waitClips(w, ok.map((j) => j.id), o.clipWaitMs ?? 210_000);
      for (const j of ok) {
        const r = res.get(j.id);
        if (r?.status === "done" && r.url) scenesIn[j.i] = { ...scenesIn[j.i], video: r.url };
        else { pending.push({ scene: j.i, id: j.id }); notes.push(`clip ${j.i + 1} ${r?.status === "error" ? "failed: " + r.error : "still generating (job " + j.id + ")"}`); }
      }
    }
    for (const [i, sc] of scenesIn.entries()) if (sc?.type === "clip" && !sc.video) scenesIn[i] = { ...sc, type: sc.image ? "image" : "hook", text: sc.text || sc.ai_prompt?.split(/[,.]/)[0] };
    input = { ...input, scenes: scenesIn };
  }
  let spec = normalizeSpec(input, { brand_name: o.brandName });
  const st = ensureStructure(spec, { hook: spec.scenes[0]?.text, cta: undefined, contact: o.contact, brand: spec.brand_name });
  spec = st.spec;
  notes.push(...st.notes);

  const key = specHash({ ...spec, voiceover: input.voiceover });
  mkdirSync(`${TMP}/cache`, { recursive: true });
  const out = `${TMP}/cache/${key}.mp4`;

  let voice: string | undefined;
  let voFile: string | undefined;
  if (spec.scenes.some((sc) => sc.vo)) {
    // Per-scene voiceover: each scene lasts as long as its own line, so cuts land exactly on the words.
    const parts: string[] = [];
    const words: { w: string; start: number; end: number }[] = [];
    let t = 0;
    const scenes = [];
    for (const sc of spec.scenes) {
      const own = sc.end - sc.start;
      let dur = own;
      if (sc.vo) {
        const vo = await synthesize(sc.vo, o.voice || spec.voiceover?.voice).catch(() => null);
        if (vo) {
          voice = vo.provider;
          // Long enough to hear the line AND read the on-screen text.
          const onScreen = [sc.text, sc.subtext, sc.value, ...(sc.items || []), ...(sc.items2 || [])].filter(Boolean).join(" ").split(/\s+/).filter(Boolean).length;
          dur = Math.max(sc.type === "cta" ? 2.6 : 1.2, vo.duration + 0.25, onScreen / 3.3 + 0.5);
          const lead = 0.08;
          parts.push(`-i`, vo.file);
          for (const w of vo.words) words.push({ w: w.w, start: +(w.start + t + lead).toFixed(2), end: +(w.end + t + lead).toFixed(2) });
          scenes.push({ ...sc, start: t, end: t + dur, _audio: vo.file, _lead: lead });
        } else scenes.push({ ...sc, start: t, end: t + dur });
      } else scenes.push({ ...sc, start: t, end: t + dur });
      t += dur;
    }
    // Build one track: each scene's audio placed at its start time.
    const withAudio = scenes.filter((s: any) => s._audio);
    if (withAudio.length) {
      const out = `${TMP}/cache/${key}_vo.wav`;
      const inputs = withAudio.flatMap((s: any) => ["-i", s._audio]);
      const filt = withAudio.map((s: any, i) => `[${i}:a]adelay=${Math.round((s.start + s._lead) * 1000)}|${Math.round((s.start + s._lead) * 1000)}[d${i}]`).join(";") + ";" + withAudio.map((_, i) => `[d${i}]`).join("") + `amix=inputs=${withAudio.length}:normalize=0:duration=longest,apad=whole_dur=${t.toFixed(2)}[o]`;
      spawnSync(ffmpegPath(), ["-y", "-loglevel", "error", ...inputs, "-filter_complex", filt, "-map", "[o]", "-t", t.toFixed(2), out]);
      if (existsSync(out)) voFile = out;
    }
    spec = normalizeSpec({ ...spec, scenes: scenes.map(({ _audio, _lead, ...rest }: any) => rest) }, spec);
    spec.captions = captionsFromWords(words).map((c) => {
      // never let a caption chunk spill across a scene cut
      const sc = spec.scenes.find((x) => c.start >= x.start && c.start < x.end);
      return sc && c.end > sc.end ? { ...c, end: sc.end } : c;
    });
  } else if (spec.voiceover?.script) {
    const vo = await synthesize(spec.voiceover.script, o.voice || spec.voiceover.voice).catch((e) => {
      notes.push(`voiceover failed: ${String(e?.message || e).slice(0, 120)}`);
      return null;
    });
    if (vo) {
      voice = vo.provider;
      voFile = vo.file;
      spec = retime(spec, vo.duration + 1.4);
      spec.captions = captionsFromWords(vo.words);
    }
  }
  spec = snapToBeats(spec);
  const render = await renderVideo(spec, { out, voiceoverFile: voFile });
  // Serverless responses are capped (~4.5 MB on Vercel): shrink if needed so links always play.
  if (statSync(out).size > 4.3e6) {
    const small = out.replace(".mp4", "_s.mp4");
    spawnSync(ffmpegPath(), ["-y", "-loglevel", "error", "-i", out, "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-maxrate", "1600k", "-bufsize", "3200k", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", small]);
    if (existsSync(small)) { render.file = small; notes.push("re-encoded smaller to fit link size limit"); }
  }
  const checks = technicalChecks(spec, render, o.platform || "instagram");
  const technical = Math.max(0, 100 - checks.checks.reduce((a, c) => a + c.penalty, 0));
  return { file: render.file, spec, render, voice, checks, technical, notes, pending_clips: pending };
}

/** Render a graphic (single post image or carousel) — every scene becomes one finished frame. */
export async function produceStills(input: Partial<VideoSpec>) {
  const spec = normalizeSpec({ width: 1080, height: 1350, fps: 10, progress_bar: false, ...input, music: "none" });
  spec.progress_bar = input.progress_bar ?? false;
  // Sample each scene at its end, after every animation has finished.
  const times = spec.scenes.map((s) => Math.max(s.start, s.end - 0.15));
  const r = await renderVideo(spec, { out: `${TMP}/still.mp4`, qaTimes: times, still: true });
  return { spec, render: r, images: r.qa_frames.map((f) => f.png!).filter(Boolean) };
}

export function cachedOrNull(path: string) {
  return existsSync(path) ? readFileSync(path) : null;
}
