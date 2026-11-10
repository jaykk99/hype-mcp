// Video self-QA: it watches its own render. Three layers:
//  1) technical checks measured on the actual frames (contrast behind text, blank frames, code-scene crashes, missing assets)
//  2) timing/readability checks on the timeline (hook speed, words/second, scene length, platform length, CTA)
//  3) creative + visual judges (the same rubric as posts, plus a vision model looking at the real frames)
import { chatJson, models } from "../llm";
import { judgeContent, slimBrand, type Check, type Content } from "../judge";
import { PLATFORMS, type Platform } from "../platforms";
import type { BrandProfile } from "../research";
import type { RenderResult } from "./render";
import { wordsOf, type VideoSpec } from "./spec";

export interface VideoScorecard {
  score: number;
  verdict: "ship" | "revise" | "reject";
  creative: number;
  technical: number;
  visual: number | null;
  checks: Check[];
  fixes: string[];
  auto_fixable: { scene: number; fix: "dim" | "slow_down" | "rewrite_code" | "regen_image"; detail: string }[];
  vision?: { scores: Record<string, number>; issues: string[]; best_frame?: number };
}

export function technicalChecks(spec: VideoSpec, r: RenderResult, platform: Platform) {
  const checks: Check[] = [];
  const auto: VideoScorecard["auto_fixable"] = [];
  const add = (check: string, pass: boolean, detail: string, penalty: number) => checks.push({ check, pass, detail, penalty: pass ? 0 : penalty });
  const spec_ = PLATFORMS[platform];
  const [vmin, vmax] = spec_.videoSeconds;

  add("duration_fits_platform", spec.duration >= vmin && spec.duration <= vmax, `${spec.duration}s (target ${vmin}-${vmax}s)`, 8);
  const first = spec.scenes[0];
  add("hook_scene_fast", first && first.end - first.start <= 3.2, `first scene ${round(first.end - first.start)}s (≤3s keeps retention)`, 6);
  add("hook_has_text", !!first?.text && wordsOf(first.text).length <= 9, `hook text: "${first?.text || ""}"`, 8);
  add("ends_with_cta", spec.scenes.at(-1)?.type === "cta", `last scene: ${spec.scenes.at(-1)?.type}`, 6);
  add("enough_scene_changes", spec.scenes.length >= 4, `${spec.scenes.length} scenes (pattern interrupts every 2-4s)`, 5);
  const longScenes = spec.scenes.filter((s) => s.end - s.start > 5 && s.type !== "clip" && !s.vo);
  add("no_dead_air_scenes", longScenes.length === 0, longScenes.length ? `${longScenes.length} static scenes >5s` : "ok", 4);

  spec.scenes.forEach((s, i) => {
    const words = wordsOf(s.text).length + wordsOf(s.subtext).length + [...(s.items || []), ...(s.items2 || [])].reduce((n, it) => n + wordsOf(it).length, 0);
    const wps = words / Math.max(0.5, s.end - s.start - 0.3);
    if (wps > 3.6) {
      add(`readable_scene_${i + 1}`, false, `scene ${i + 1}: ${words} words in ${round(s.end - s.start)}s (${round(wps)} words/s > 3.5)`, 4);
      auto.push({ scene: i, fix: "slow_down", detail: `${round(wps)} w/s` });
    }
  });

  // Contrast measured on real pixels (WCAG large-text minimum 3:1; we want 4.5:1 for phones in daylight).
  const worst = new Map<number, number>();
  for (const b of r.text_boxes) if (b.contrast !== undefined && !b.caption) worst.set(b.scene, Math.min(worst.get(b.scene) ?? 99, b.contrast));
  for (const [scene, c] of worst) {
    if (c < 3.5) {
      add(`contrast_scene_${scene + 1}`, false, `scene ${scene + 1}: text contrast ${c}:1 (need ≥4.5:1)`, c < 2.2 ? 8 : 5);
      const sc = spec.scenes[scene];
      if (sc && ["hook", "image", "list", "stat", "clip", "before_after", "pov", "myth_fact", "steps", "quote"].includes(sc.type)) auto.push({ scene, fix: "dim", detail: `${c}:1` });
    }
  }
  if (!worst.size) add("contrast_measured", true, "no text boxes sampled", 0);
  else checks.push({ check: "contrast_worst_case", pass: true, detail: `worst ${Math.min(...worst.values())}:1 (info)`, penalty: 0 });

  // Safe zones: platform UI covers the top ~10% and bottom ~20% on vertical video.
  const unsafe = r.text_boxes.filter((b) => !b.caption && ( b.y < spec.height * 0.08 || b.y + b.h > spec.height * 0.84));
  add("text_in_safe_zone", unsafe.length === 0, unsafe.length ? `${unsafe.length} text boxes under app UI` : "ok", 4);

  // Overlap: any scene text colliding with the caption strip (or other text) in the same frame.
  const byT = new Map<number, typeof r.text_boxes>();
  for (const b of r.text_boxes) byT.set(b.t, [...(byT.get(b.t) || []), b]);
  const overlapScenes = new Set<number>();
  for (const bs of byT.values()) {
    const cap = bs.find((b) => b.caption);
    if (!cap) continue;
    for (const b of bs) {
      if (b === cap || b.w < 4) continue;
      const ix = Math.max(0, Math.min(b.x + b.w, cap.x + cap.w) - Math.max(b.x, cap.x));
      const iy = Math.max(0, Math.min(b.y + b.h, cap.y + cap.h) - Math.max(b.y, cap.y));
      if (ix * iy > 0.08 * b.w * b.h) overlapScenes.add(b.scene);
    }
  }
  add("no_text_overlap", overlapScenes.size === 0, overlapScenes.size ? `scene text collides with captions in scene(s) ${[...overlapScenes].map((x) => x + 1).join(", ")} — keep scene text above 64% height` : "ok", 8 * Math.min(3, overlapScenes.size));
  add("no_blank_frames", r.blank_frames.length === 0, r.blank_frames.length ? `blank at ${r.blank_frames.join(", ")}s` : "ok", 10);
  for (const ce of r.code_errors) {
    const bad = ce.frames_failed > 3;
    add(`code_scene_${ce.scene + 1}_runs`, !bad, `${ce.frames_failed} frames failed: ${ce.sample}`, 10);
    if (bad) auto.push({ scene: ce.scene, fix: "rewrite_code", detail: ce.sample });
  }
  if (r.missing_assets.length) {
    add("assets_loaded", false, `${r.missing_assets.length} images failed to load`, 6);
    spec.scenes.forEach((s, i) => {
      const u = s.image ? spec.assets?.[s.image] || s.image : "";
      if (u && r.missing_assets.includes(u)) auto.push({ scene: i, fix: "regen_image", detail: u.slice(0, 80) });
    });
  } else add("assets_loaded", true, "ok", 0);
  if (spec.voiceover?.script) add("captions_for_voiceover", !!spec.captions?.length, spec.captions?.length ? `${spec.captions.length} caption chunks` : "voiceover has no captions", 5);
  return { checks, auto };
}

/** Map a video spec to the post rubric so we reuse the exact same creative judges. */
export function specToContent(spec: VideoSpec, caption?: Partial<Content>): Content {
  return {
    format: "reel",
    hook: (spec.scenes[0]?.text || "").replace(/\*/g, ""),
    caption: caption?.caption || spec.scenes.map((s) => s.text).filter(Boolean).join(". ").replace(/\*/g, ""),
    hashtags: caption?.hashtags || [],
    cta: caption?.cta || spec.scenes.at(-1)?.subtext || spec.scenes.at(-1)?.text || "",
    duration_s: spec.duration,
    audio_vibe: spec.voiceover?.script ? "voiceover" : spec.music,
    beats: spec.scenes.map((s) => ({
      t_start: s.start,
      t_end: s.end,
      visual: `${s.type}${s.image_prompt ? ": " + s.image_prompt : ""}${s.code ? " (custom coded animation)" : ""}`,
      on_screen_text: [s.text, s.value, ...(s.items || [])].filter(Boolean).join(" / ").replace(/\*/g, ""),
      voiceover: "",
      broll_prompt: s.image_prompt || "",
    })),
  };
}

export async function visionReview(frames: { t: number; scene: number; jpeg: Buffer }[], spec: VideoSpec, brand: Partial<BrandProfile>) {
  const vm = models.vision();
  if (!vm || !frames.length) return null;
  const pick = frames.slice(0, 6);
  try {
    const r = await chatJson<{ scores: Record<string, number>; issues: string[]; fixes: string[]; best_frame: number }>(
      [
        {
          role: "system",
          content: `You are a ruthless short-form video creative director reviewing frames from a vertical social video before it ships.
Frames are in order (timestamps given). Score 0-10: thumb_stop (frame 1 alone would stop a scroll), readability (text size/contrast on a phone),
visual_quality (no AI artifacts, nothing broken/overlapping/cut off), brand_fit, variety (scenes look different enough to hold attention), polish (looks like a top creator, not a template).
issues = concrete problems with frame numbers. fixes = specific changes to the video spec (scene number + what to change). best_frame = index of the best cover frame.
Return JSON {"scores":{"thumb_stop":n,"readability":n,"visual_quality":n,"brand_fit":n,"variety":n,"polish":n},"issues":[],"fixes":[],"best_frame":0}`,
        },
        {
          role: "user",
          content: [
            { type: "text", text: `Brand: ${JSON.stringify(slimBrand(brand)).slice(0, 1800)}\nScenes: ${spec.scenes.map((s, i) => `${i + 1}:${s.type} "${s.text || s.value || ""}"`).join(" | ")}\nFrames at: ${pick.map((f, i) => `#${i} t=${f.t}s (scene ${f.scene + 1})`).join(", ")}` },
            ...pick.map((f) => ({ type: "image_url" as const, image_url: { url: `data:image/jpeg;base64,${f.jpeg.toString("base64")}` } })),
          ],
        },
      ],
      { model: vm, temperature: 0.1, maxTokens: 1500 }
    );
    return r;
  } catch {
    return null;
  }
}

export async function scoreVideo(
  spec: VideoSpec,
  render: RenderResult,
  platform: Platform,
  brand: Partial<BrandProfile>,
  caption?: Partial<Content>
): Promise<VideoScorecard> {
  const { checks, auto } = technicalChecks(spec, render, platform);
  const technical = Math.max(0, 100 - checks.reduce((s, c) => s + c.penalty, 0));
  const [creativeCard, vis] = await Promise.all([
    judgeContent(specToContent(spec, caption), platform, brand, { judges: 2 }).catch(() => null),
    visionReview(render.qa_frames, spec, brand),
  ]);
  const creative = creativeCard?.score ?? 60;
  let visual: number | null = null;
  if (vis?.scores) {
    const v = Object.values(vis.scores).map((x) => Math.max(0, Math.min(10, Number(x) || 0)));
    visual = Math.round((v.reduce((a, b) => a + b, 0) / Math.max(1, v.length)) * 10);
  }
  const score = Math.round(visual !== null ? 0.45 * creative + 0.35 * visual + 0.2 * technical : 0.7 * creative + 0.3 * technical);
  const fixes = [
    ...checks.filter((c) => !c.pass && c.penalty >= 4).map((c) => `[measured ${c.check}] ${c.detail}`),
    ...(vis?.fixes || []).map((f) => `[vision] ${f}`),
    ...(creativeCard?.fixes || []).filter((f) => !f.startsWith("[auto-check")).map((f) => `[creative] ${f}`),
  ].filter((f, i, a) => a.indexOf(f) === i).slice(0, 12);
  return {
    score,
    verdict: score >= 80 ? "ship" : score >= 60 ? "revise" : "reject",
    creative,
    technical,
    visual,
    checks: [...checks, ...(creativeCard?.checks || []).filter((c) => !c.pass && /cliche|banned|superlative|hashtag/.test(c.check))],
    fixes,
    auto_fixable: auto,
    vision: vis ? { scores: vis.scores, issues: vis.issues, best_frame: vis.best_frame } : undefined,
  };
}

const round = (n: number) => Math.round(n * 10) / 10;
