// The video agent: writes a video (scenes + its own animation code), renders it, watches it, fixes it.
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chatJson, models } from "../llm";
import { slimBrand, type Content } from "../judge";
import { PLATFORMS, type Platform } from "../platforms";
import { renderImage, startVideoClip, checkVideo } from "../media";
import type { BrandProfile } from "../research";
import { publish, TMP } from "../storage";
import { SANDBOX_API_DOC } from "./sandbox";
import { ffmpegPath, renderVideo, type RenderResult } from "./render";
import { ensureStructure, normalizeSpec, retime, type VideoSpec } from "./spec";
import { scoreVideo, type VideoScorecard } from "./qa";
import { captionsFromWords, hasTts, synthesize } from "./voice";

export type VideoStyle = "motion" | "code" | "mixed";
export const QUALITY = { draft: { width: 540, height: 960, fps: 24 }, standard: { width: 720, height: 1280, fps: 30 }, hd: { width: 1080, height: 1920, fps: 30 } };

const SCENE_DOC = `Scene types (each scene: {type, start, end, ...}; scenes play back-to-back, use durations 1.5-4s):
- hook: {text, subtext?, image?} giant kinetic words that pop in one by one. FIRST scene, ≤2.5s, ≤7 words. Mark 1-2 power words with *asterisks* (accent highlight).
- image: {image, text?, subtext?, motion: zoom_in|zoom_out|pan_left|pan_right} photo with Ken Burns + lower-third text.
- list: {text (title), items[3-5 short], image?} animated checklist.
- stat: {value e.g. "40 lbs" or "$150", text (label), image?} number counts up.
- before_after: {image (before), image2 (after), text?} wipe reveal.
- cta: {text, subtext (phone/offer)} end card. LAST scene, 2.5-3.5s.
- code: {code} a fully custom animation YOU program (see API). Use for things templates can't do: animated diagrams, water flowing through a gutter, snow/ice building up, a price tag spinning, a map pin drop, a counter + chart, kinetic typography with physics.
transition per scene: cut | fade | slide | zoom (vary them; cut for hard beats).
Images: put a key in "image" and define an image prompt for that key in "image_prompts" — photographic, vertical, no text in the image.`;

export async function writeVideoSpec(p: {
  brand: Partial<BrandProfile>;
  platform: Platform;
  style: VideoStyle;
  topic?: string;
  post?: Partial<Content>;
  seconds?: number;
  voiceover: boolean;
}) {
  const spec_ = PLATFORMS[p.platform];
  const target = p.seconds || Math.min(spec_.videoSeconds[1], Math.max(spec_.videoSeconds[0], 18));
  const codeRule =
    p.style === "code"
      ? "Make at least 3 scenes type \"code\" with original animations (the hook can be code too). Templates only for the CTA if you want."
      : p.style === "mixed"
        ? "Use 1-2 \"code\" scenes for the moments that most need custom motion; templates for the rest."
        : "Use template scene types only (no code scenes).";
  return chatJson<Partial<VideoSpec> & { image_prompts?: Record<string, string>; caption?: string; hashtags?: string[]; cta?: string }>(
    [
      {
        role: "system",
        content: `You are an elite short-form video director AND creative coder. You make ${spec_.label} videos that stop the scroll and get saved/shared.
Write a complete video spec as JSON for ~${target}s vertical video.
Rules: hook in the first 1.5s with a specific, concrete claim (real service, town, number); a pattern interrupt every 2-3s; one idea per scene; ≤10 words of on-screen text per scene; show proof (before/after, numbers, the real problem); end with a clear, low-friction CTA using the brand's real contact/offer. No claims the brand can't back up (see banned_claims). No fake reviews/stats.
${codeRule}
${SCENE_DOC}
${p.style !== "motion" ? `\nCODE SCENE API:\n${SANDBOX_API_DOC}\nCode must be a single string containing function draw(ctx,t,p,W,H,A){...}. Draw a full background every frame. Make it beautiful: layered shapes, gradients, eased motion, brand colors from A.colors, big readable type (font sizes relative to W, e.g. W*0.14+"px Anton").` : ""}
${p.voiceover ? `\nInclude "voiceover": {"script": "..."} — spoken words, conversational, ~2.5 words/sec × duration, first sentence = the hook. On-screen text should complement, not duplicate, the VO.` : ""}
Return JSON: {"brand_name":"","handle":"","theme":{"bg":"#hex","fg":"#hex","accent":"#hex","accent2":"#hex","display_font":"Anton|Inter"},"music":"pulse|ambient|none","scenes":[...],"image_prompts":{"key":"prompt"},${p.voiceover ? '"voiceover":{"script":""},' : ""}"caption":"post caption","hashtags":["#..."],"cta":""}`,
      },
      {
        role: "user",
        content: `BRAND:\n${JSON.stringify(slimBrand(p.brand))}\n${p.topic ? `\nBRIEF: ${p.topic}` : ""}${p.post ? `\nAPPROVED POST/SCRIPT TO ADAPT:\n${JSON.stringify({ hook: p.post.hook, caption: p.post.caption, beats: p.post.beats, cta: p.post.cta })}` : ""}`,
      },
    ],
    { model: models.writer(), temperature: 0.8, maxTokens: 7000 }
  );
}

async function rewriteCode(code: string, error: string, intent: string) {
  const r = await chatJson<{ code: string }>(
    [
      { role: "system", content: `You fix sandboxed canvas animation code. ${SANDBOX_API_DOC}\nReturn JSON {"code":"function draw(ctx,t,p,W,H,A){...}"}. Keep the same visual idea; make it robust and fast (no infinite loops, bounded iterations).` },
      { role: "user", content: `Intent: ${intent}\nError: ${error}\nCode:\n${code}` },
    ],
    { model: models.writer(), temperature: 0.3, maxTokens: 5000 }
  );
  return r.code;
}

/** Deterministic fixes from measured QA — cheap and reliable, applied before any LLM revision. */
async function applyAutoFixes(spec: VideoSpec, card: VideoScorecard, regen: (prompt: string) => Promise<string>) {
  const s: VideoSpec = JSON.parse(JSON.stringify(spec));
  const notes: string[] = [];
  const locks: Record<number, { dim?: number; minDur?: number }> = {};
  for (const f of card.auto_fixable) {
    const sc = s.scenes[f.scene];
    if (!sc) continue;
    if (f.fix === "dim") { sc.dim = Math.min(0.95, (sc.dim ?? 0.72) + 0.18); (locks[f.scene] ||= {}).dim = sc.dim; notes.push(`scene ${f.scene + 1}: darker overlay for contrast`); }
    if (f.fix === "slow_down") { sc.end = sc.start + (sc.end - sc.start) * 1.3; (locks[f.scene] ||= {}).minDur = sc.end - sc.start; notes.push(`scene ${f.scene + 1}: +30% time to read`); }
    if (f.fix === "rewrite_code" && sc.code) {
      try { sc.code = await rewriteCode(sc.code, f.detail, sc.text || "custom animation"); notes.push(`scene ${f.scene + 1}: rewrote crashing animation code`); }
      catch { sc.type = "hook"; sc.code = undefined; notes.push(`scene ${f.scene + 1}: code unfixable → template`); }
    }
    if (f.fix === "regen_image" && sc.image_prompt) {
      const key = sc.image && s.assets?.[sc.image] ? sc.image : `regen_${f.scene}`;
      s.assets = { ...(s.assets || {}), [key]: await regen(sc.image_prompt) };
      sc.image = key;
      notes.push(`scene ${f.scene + 1}: regenerated image`);
    }
  }
  return { spec: normalizeSpec(s), notes, locks };
}

/** Re-apply measured fixes after an LLM rewrite (models tend to silently drop numeric tweaks). */
function enforceLocks(spec: VideoSpec, locks: Record<number, { dim?: number; minDur?: number }>) {
  const s: VideoSpec = JSON.parse(JSON.stringify(spec));
  for (const [k, l] of Object.entries(locks)) {
    const sc = s.scenes[Number(k)];
    if (!sc) continue;
    if (l.dim !== undefined) sc.dim = Math.max(sc.dim ?? 0, l.dim);
    if (l.minDur !== undefined && sc.end - sc.start < l.minDur) sc.end = sc.start + l.minDur;
  }
  return normalizeSpec(s);
}

async function reviseSpec(spec: VideoSpec, card: VideoScorecard, brand: Partial<BrandProfile>, style: VideoStyle) {
  const r = await chatJson<Partial<VideoSpec>>(
    [
      {
        role: "system",
        content: `You are revising a short-form video spec that scored ${card.score}/100 (creative ${card.creative}, technical ${card.technical}${card.visual !== null ? `, visual ${card.visual}` : ""}).
Apply every fix. Sharpen the hook. Keep image keys and assets as they are (you may reorder/reuse them). Keep scene types valid.
${style !== "motion" ? `Code scenes follow this API:\n${SANDBOX_API_DOC}` : "No code scenes."}
${SCENE_DOC}
Fixes:\n${card.fixes.map((f, i) => `${i + 1}. ${f}`).join("\n")}
Return the FULL revised spec JSON (same shape).`,
      },
      { role: "user", content: `BRAND:${JSON.stringify(slimBrand(brand)).slice(0, 3000)}\nSPEC:${JSON.stringify({ ...spec, captions: undefined })}` },
    ],
    { model: models.writer(), temperature: 0.6, maxTokens: 7000 }
  );
  return normalizeSpec({ ...r, assets: { ...(spec.assets || {}), ...(r.assets || {}) }, width: spec.width, height: spec.height, fps: spec.fps }, spec);
}

async function contactSheet(r: RenderResult, id: string) {
  if (!r.qa_frames.length) return null;
  const files = r.qa_frames.map((f, i) => {
    const p = `${TMP}/${id}_qa_${i}.jpg`;
    require("node:fs").writeFileSync(p, f.jpeg);
    return p;
  });
  const out = `${TMP}/${id}_sheet.jpg`;
  const n = files.length;
  spawnSync(ffmpegPath(), ["-y", "-loglevel", "error", "-i", `${TMP}/${id}_qa_%d.jpg`, "-vf", `scale=270:-1,tile=${n}x1:padding=6:color=black`, "-frames:v", "1", out]);
  return require("node:fs").existsSync(out) ? out : null;
}

export interface MakeVideoResult {
  video_url: string;
  cover_url?: string;
  contact_sheet_url?: string;
  storage: string;
  duration: number;
  resolution: string;
  scorecard: VideoScorecard;
  rounds: { round: number; score: number; render_seconds: number; notes: string[] }[];
  passed_threshold: boolean;
  caption?: string;
  hashtags?: string[];
  voiceover?: { provider: string; script: string } | null;
  spec: VideoSpec;
  timings: Record<string, number>;
  warnings: string[];
}

export async function makeVideo(p: {
  brand: Partial<BrandProfile>;
  platform: Platform;
  style?: VideoStyle;
  topic?: string;
  post?: Partial<Content>;
  seconds?: number;
  quality?: keyof typeof QUALITY;
  voiceover?: boolean;
  voice?: string;
  ai_clips?: number;
  music?: "pulse" | "ambient" | "none";
  min_score?: number;
  max_rounds?: number;
  spec?: Partial<VideoSpec>; // render an existing/edited spec instead of writing a new one
  time_budget_s?: number;
}): Promise<MakeVideoResult> {
  const T0 = Date.now();
  const el = () => (Date.now() - T0) / 1000;
  const budget = p.time_budget_s ?? 270;
  const style = p.style || "mixed";
  const q = QUALITY[p.quality || "standard"];
  const id = randomUUID().slice(0, 8);
  const timings: Record<string, number> = {};
  const warnings: string[] = [];
  const wantVO = p.voiceover ?? hasTts();
  if (p.voiceover && !hasTts()) warnings.push("Voiceover requested but no TTS key set (ELEVENLABS_API_KEY or TTS_BASE_URL+TTS_API_KEY) — rendered with on-screen text + music.");

  // 1) Direct: write the video (or take a provided spec)
  let draft: any = p.spec;
  if (!draft) {
    const args = { brand: p.brand, platform: p.platform, topic: p.topic, post: p.post, seconds: p.seconds, voiceover: wantVO && hasTts() };
    try {
      draft = await writeVideoSpec({ ...args, style });
    } catch (e: any) {
      if (style === "motion") throw e;
      warnings.push(`The writer model couldn't produce coded scenes (${String(e?.message || e).slice(0, 80)}) — fell back to motion templates. Use a stronger LLM_MODEL for custom-coded animation.`);
      draft = await writeVideoSpec({ ...args, style: "motion" });
    }
    timings.write_spec = el();
  }
  const vis = p.brand.visual_identity?.colors || [];
  let spec = normalizeSpec(
    { ...draft, ...q, music: p.music || draft.music || (wantVO ? "ambient" : "pulse") },
    { brand_name: p.brand.name, theme: { bg: "#16161a", fg: "#ffffff", accent: vis.find((c) => /^#/.test(c)) || "#ff3b3b" } }
  );

  const contact = [...(p.brand.offers_and_ctas || []), ...(p.brand.what_they_sell || [])].join(" ").match(/\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/)?.[0];
  const structure = ensureStructure(spec, { hook: draft.caption?.split(/[.!?\n]/)[0], cta: draft.cta, contact: contact ? `Text ${contact}` : undefined, brand: p.brand.name });
  spec = structure.spec;
  if (structure.notes.length) warnings.push("Structure enforced: " + structure.notes.join(", "));

  // 2) Generate images for every prompt (parallel)
  const regen = async (prompt: string) => (await renderImage(prompt, { width: q.width, height: q.height }, Math.floor(Math.random() * 1e9))).url;
  const prompts: Record<string, string> = Object.fromEntries(
    Object.entries(draft.image_prompts && typeof draft.image_prompts === "object" ? draft.image_prompts : {}).map(([k, v]: [string, any]) => [k, typeof v === "string" ? v : v?.prompt || JSON.stringify(v)])
  );
  // Scenes may carry their own prompt instead of a key.
  spec.scenes.forEach((s, i) => {
    if (s.image && !prompts[s.image] && !spec.assets?.[s.image] && !/^https?:|^data:|^\//.test(s.image)) {
      prompts[s.image] = s.image_prompt || s.image;
    }
    if (!s.image && s.image_prompt) { s.image = `scene_${i}`; prompts[s.image] = s.image_prompt; }
  });
  const assets: Record<string, string> = { ...(spec.assets || {}) };
  await Promise.all(Object.entries(prompts).filter(([k]) => !assets[k]).slice(0, 8).map(async ([k, pr]) => { assets[k] = await regen(String(pr)); }));
  spec.assets = assets;
  spec.scenes.forEach((s) => { if (s.image && prompts[s.image]) s.image_prompt = prompts[s.image]; });
  timings.images = el();

  // 3) Optional: animate the best stills into real AI footage (fal image-to-video), within the time budget
  if (p.ai_clips && process.env.FAL_KEY) {
    const cands = spec.scenes.map((s, i) => ({ s, i })).filter(({ s }) => (s.type === "image" || s.type === "hook") && s.image).slice(0, p.ai_clips);
    const jobs = await Promise.all(cands.map(async ({ s, i }) => ({ i, job: await startVideoClip(assets[s.image!] || s.image!, s.image_prompt || s.text || "subtle cinematic camera push-in", 5) })));
    const deadline = Date.now() + Math.max(30, budget * 0.45 - el()) * 1000;
    for (const { i, job } of jobs) {
      if (!job.status_url || !job.response_url) { warnings.push(`AI clip for scene ${i + 1} failed to start: ${job.error}`); continue; }
      while (Date.now() < deadline) {
        const st = await checkVideo(job.status_url, job.response_url).catch(() => ({ status: "ERROR" } as any));
        if (st.status === "COMPLETED" && st.video_url) { spec.scenes[i] = { ...spec.scenes[i], type: "clip", video: st.video_url }; break; }
        if (st.status === "ERROR" || st.status === "FAILED") break;
        await new Promise((r) => setTimeout(r, 5000));
      }
      if (spec.scenes[i].type !== "clip") warnings.push(`AI clip for scene ${i + 1} not ready in time — used the animated still.`);
    }
    timings.ai_clips = el();
  } else if (p.ai_clips) warnings.push("ai_clips needs FAL_KEY — used animated stills instead.");

  // 4) Voiceover → retime → word-timed captions
  let voFile: string | undefined;
  let voInfo: MakeVideoResult["voiceover"] = null;
  const doVO = async (s: VideoSpec) => {
    if (!wantVO || !s.voiceover?.script) return s;
    const vo = await synthesize(s.voiceover.script, p.voice).catch(() => null);
    if (!vo) { warnings.push("TTS failed — continuing without voiceover."); return s; }
    voFile = vo.file;
    voInfo = { provider: vo.provider, script: s.voiceover.script };
    const ctaHold = 1.4;
    const r = retime(s, vo.duration + ctaHold);
    r.captions = captionsFromWords(vo.words);
    return r;
  };
  spec = await doVO(spec);
  timings.voiceover = el();

  // 5) Render → watch → fix loop
  const minScore = p.min_score ?? 82;
  const maxRounds = p.max_rounds ?? 2;
  const rounds: MakeVideoResult["rounds"] = [];
  let best: { spec: VideoSpec; render: RenderResult; card: VideoScorecard } | null = null;
  let current = spec;
  for (let round = 0; round <= maxRounds; round++) {
    const out = `${TMP}/${id}_r${round}.mp4`;
    const render = await renderVideo(current, { out, voiceoverFile: voFile });
    const card = await scoreVideo(current, render, p.platform, p.brand, { caption: draft.caption, hashtags: draft.hashtags, cta: draft.cta });
    rounds.push({ round, score: card.score, render_seconds: render.seconds, notes: [] });
    if (!best || card.score > best.card.score) best = { spec: current, render, card };
    else rounds[rounds.length - 1].notes.push("scored lower than previous — kept previous");
    // Stop if good enough, out of rounds, or a re-render would blow the serverless time budget.
    const projected = el() + render.seconds * 1.3 + 25;
    if (card.score >= minScore || round === maxRounds || projected > budget) {
      if (projected > budget && card.score < minScore && round < maxRounds) warnings.push(`Stopped revising at ${Math.round(el())}s to stay inside the time budget.`);
      break;
    }
    const auto = await applyAutoFixes(current, card, regen);
    let next = auto.spec;
    const creativeGap = card.fixes.some((f) => f.startsWith("[creative]") || f.startsWith("[vision]"));
    if (creativeGap && el() + 60 < budget) {
      try {
        const revised = enforceLocks(await reviseSpec(next, card, p.brand, style), auto.locks);
        const scriptChanged = revised.voiceover?.script && revised.voiceover.script !== current.voiceover?.script;
        next = scriptChanged ? await doVO(revised) : { ...revised, captions: current.captions };
        if (!scriptChanged && current.captions) next = retime(next, current.duration);
        rounds[rounds.length - 1].notes.push("LLM revision applied");
      } catch (e: any) {
        rounds[rounds.length - 1].notes.push(`LLM revision failed: ${e?.message || e}`);
      }
    }
    rounds[rounds.length - 1].notes.push(...auto.notes);
    current = next;
  }
  timings.render_and_qa = el();

  // 6) Publish best version + cover + contact sheet
  const b = best!;
  const vid = await publish(`${id}.mp4`, b.render.file, "video/mp4");
  const coverIdx = Math.max(0, Math.min(b.render.qa_frames.length - 1, b.card.vision?.best_frame ?? 0));
  const cover = b.render.qa_frames[coverIdx] ? await publish(`${id}_cover.jpg`, b.render.qa_frames[coverIdx].jpeg, "image/jpeg") : null;
  const sheetPath = await contactSheet(b.render, id);
  const sheet = sheetPath ? await publish(`${id}_frames.jpg`, sheetPath, "image/jpeg") : null;
  if (vid.storage.startsWith("temporary")) warnings.push("Video is on temporary storage. Set BLOB_READ_WRITE_TOKEN (Vercel Blob) or SUPABASE_URL+SUPABASE_SERVICE_ROLE_KEY so links last.");
  if (b.card.visual === null) warnings.push("VISION_MODEL not set — frames were measured technically but not reviewed by a vision model.");
  timings.total = el();

  return {
    video_url: vid.url,
    cover_url: cover?.url,
    contact_sheet_url: sheet?.url,
    storage: vid.storage,
    duration: b.spec.duration,
    resolution: `${b.spec.width}x${b.spec.height}@${b.spec.fps}`,
    scorecard: b.card,
    rounds,
    passed_threshold: b.card.score >= minScore,
    caption: draft.caption,
    hashtags: draft.hashtags,
    voiceover: voInfo,
    spec: { ...b.spec, captions: undefined },
    timings,
    warnings,
  };
}
