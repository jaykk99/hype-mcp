// Voiceover: ElevenLabs (with character timestamps → exact word-timed captions) or any OpenAI-compatible /audio/speech.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { ffmpegPath, writeTmp } from "./render";
import type { Caption } from "./spec";

export interface Voiceover {
  file: string;
  duration: number;
  provider: string;
  words: { w: string; start: number; end: number }[];
}

export function hasTts() {
  return process.env.DISABLE_LOCAL_TTS !== "1" || !!(process.env.ELEVENLABS_API_KEY || (process.env.TTS_BASE_URL && process.env.TTS_API_KEY));
}

export const LOCAL_VOICES = ["am_michael", "am_adam", "am_fenrir", "am_puck", "af_heart", "af_bella", "af_nicole", "af_sarah", "bm_george", "bf_emma"];

// Homemade TTS: Kokoro-82M (Apache-2.0) running on this server's CPU via ONNX. No key, no account.
// Weights (~90 MB) are fetched once from the public model hub on cold start and cached in /tmp.
let kokoro: Promise<any> | null = null;
async function getKokoro() {
  kokoro ||= (async () => {
    const tf = await import("@huggingface/transformers");
    tf.env.cacheDir = process.env.MODEL_CACHE_DIR || "/tmp/hype-models";
    const { KokoroTTS } = await import("kokoro-js");
    return KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "q8", device: "cpu" });
  })();
  kokoro.catch(() => (kokoro = null));
  return kokoro;
}

/** Sentence-by-sentence synthesis: real per-sentence durations make the word-timed captions line up closely. */
async function synthLocal(text: string, voice?: string): Promise<Voiceover | null> {
  if (process.env.DISABLE_LOCAL_TTS === "1") return null;
  const tts = await getKokoro();
  const v = voice && LOCAL_VOICES.includes(voice) ? voice : process.env.LOCAL_VOICE || "am_michael";
  const sentences = text.match(/[^.!?]+[.!?]*/g)?.map((x) => x.trim()).filter(Boolean) || [text];
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  mkdirSync(`${process.env.TMPDIR || "/tmp"}/hype`, { recursive: true });
  const parts: string[] = [];
  const words: Voiceover["words"] = [];
  let offset = 0;
  for (const [i, sent] of sentences.entries()) {
    const audio = await tts.generate(sent, { voice: v, speed: Number(process.env.LOCAL_VOICE_SPEED || 1.15) });
    const f = `${process.env.TMPDIR || "/tmp"}/hype/vo_${id}_${i}.wav`;
    await audio.save(f);
    const d = probeDuration(f) || audio.audio.length / audio.sampling_rate;
    for (const w of estimateWords(sent, d)) words.push({ w: w.w, start: round(w.start + offset), end: round(w.end + offset) });
    parts.push(f);
    offset += d + 0.12;
  }
  // Concatenate with short natural pauses.
  const out = `${process.env.TMPDIR || "/tmp"}/hype/vo_${id}.wav`;
  const inputs = parts.flatMap((p) => ["-i", p]);
  const filter = parts.map((_, i) => `[${i}:a]apad=pad_dur=0.12[a${i}]`).join(";") + ";" + parts.map((_, i) => `[a${i}]`).join("") + `concat=n=${parts.length}:v=0:a=1[out]`;
  spawnSync(ffmpegPath(), ["-y", "-loglevel", "error", ...inputs, "-filter_complex", filter, "-map", "[out]", out]);
  return { file: out, duration: probeDuration(out) || offset, provider: `local:kokoro-82m (${v})`, words };
}

export async function synthesize(script: string, voice?: string): Promise<Voiceover | null> {
  const text = script.replace(/\*/g, "").trim();
  if (!text) return null;
  const hasCloud = !!(process.env.ELEVENLABS_API_KEY || (process.env.TTS_BASE_URL && process.env.TTS_API_KEY));
  if (!hasCloud) return synthLocal(text, voice);
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const el = process.env.ELEVENLABS_API_KEY;
  if (el) {
    const voiceId = voice || process.env.ELEVENLABS_VOICE_ID || "pNInz6obpgDQGcFmaJgB"; // "Adam" default
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "xi-api-key": el, "Content-Type": "application/json" },
      body: JSON.stringify({ text, model_id: process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2", voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.35 } }),
      signal: AbortSignal.timeout(90_000),
    });
    if (res.ok) {
      const d = await res.json();
      const file = writeTmp(`vo_${id}.mp3`, Buffer.from(d.audio_base64, "base64"));
      const a = d.alignment || d.normalized_alignment;
      const words = a ? wordsFromChars(a.characters, a.character_start_times_seconds, a.character_end_times_seconds) : [];
      const duration = probeDuration(file) || words.at(-1)?.end || 0;
      return { file, duration, provider: "elevenlabs", words: words.length ? words : estimateWords(text, duration) };
    }
  }
  const base = process.env.TTS_BASE_URL, key = process.env.TTS_API_KEY;
  if (base && key) {
    const res = await fetch(`${base.replace(/\/$/, "")}/audio/speech`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: process.env.TTS_MODEL || "gpt-4o-mini-tts", voice: voice || process.env.TTS_VOICE || "ash", input: text, response_format: "mp3", instructions: "Energetic, friendly local business owner. Punchy social-video delivery." }),
      signal: AbortSignal.timeout(90_000),
    });
    if (res.ok) {
      const file = writeTmp(`vo_${id}.mp3`, Buffer.from(await res.arrayBuffer()));
      const duration = probeDuration(file);
      return { file, duration, provider: "openai-compatible", words: estimateWords(text, duration) };
    }
  }
  return synthLocal(text, voice).catch(() => null);
}

function wordsFromChars(chars: string[], st: number[], en: number[]) {
  const out: { w: string; start: number; end: number }[] = [];
  let cur = "", s = 0, e = 0;
  chars.forEach((c, i) => {
    if (/\s/.test(c)) {
      if (cur) out.push({ w: cur, start: s, end: e });
      cur = "";
    } else {
      if (!cur) s = st[i];
      cur += c;
      e = en[i];
    }
  });
  if (cur) out.push({ w: cur, start: s, end: e });
  return out;
}

/** No timestamps available: distribute by syllable-ish weight (characters + pause on punctuation). */
function estimateWords(text: string, duration: number) {
  const ws = text.split(/\s+/).filter(Boolean);
  const weight = ws.map((w) => Math.max(2, w.replace(/[^a-z0-9]/gi, "").length) + (/[.,!?;:]$/.test(w) ? 4 : 0));
  const total = weight.reduce((a, b) => a + b, 0);
  const lead = 0.1, usable = Math.max(0.5, duration - 0.25);
  let t = lead;
  return ws.map((w, i) => {
    const d = (weight[i] / total) * usable;
    const o = { w, start: round(t), end: round(t + d * 0.92) };
    t += d;
    return o;
  });
}

/** Group words into 2–4 word caption chunks, breaking on punctuation (how top creators caption). */
export function captionsFromWords(words: { w: string; start: number; end: number }[]): Caption[] {
  const caps: Caption[] = [];
  let chunk: typeof words = [];
  const flush = () => {
    if (!chunk.length) return;
    caps.push({ start: chunk[0].start, end: chunk.at(-1)!.end + 0.05, text: chunk.map((c) => c.w).join(" "), words: chunk });
    chunk = [];
  };
  for (const w of words) {
    chunk.push(w);
    if (chunk.length >= 4 || /[.,!?;:]$/.test(w.w) || chunk.map((c) => c.w).join(" ").length > 22) flush();
  }
  flush();
  // close gaps so captions don't flicker
  for (let i = 0; i < caps.length - 1; i++) if (caps[i + 1].start - caps[i].end < 0.25) caps[i].end = caps[i + 1].start;
  return caps;
}

export function probeDuration(file: string): number {
  const r = spawnSync(ffmpegPath(), ["-i", file], { encoding: "utf8" });
  const m = (r.stderr || "").match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0;
}

const round = (n: number) => Math.round(n * 100) / 100;
