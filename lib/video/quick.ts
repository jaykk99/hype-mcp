// quick_video: a finished video from a handful of plain fields, no spec writing.
// Each of the playbook's proven formats is a fixed scene order; the caller supplies the words
// and (optionally) real photos, and this builds the same kind of spec render_video takes:
// per-scene voiceover lines, varied transitions, brand colours. Nothing here invents a fact:
// every on-screen word comes from the caller's input.
import type { Scene, VideoSpec } from "./spec";

export const QUICK_FORMATS = ["problem_fix", "three_signs", "myth_fact", "pov", "before_after", "price", "service_area"] as const;
export type QuickFormat = (typeof QUICK_FORMATS)[number];

export interface QuickInput {
  format: QuickFormat;
  brand_name: string;
  handle?: string;
  hook: string;
  cta?: string;
  contact?: string;
  problem?: string;
  points?: string[];
  points_title?: string;
  myth?: string;
  fact?: string;
  stat_value?: string;
  stat_label?: string;
  price_service?: string;
  price_value?: string;
  price_includes?: string[];
  towns?: string[];
  photo?: string;
  before_image?: string;
  after_image?: string;
  colors?: { bg?: string; accent?: string; accent2?: string };
  voiceover?: boolean;
  music?: VideoSpec["music"];
  caption_style?: VideoSpec["caption_style"];
}

// Which optional blocks each format uses, in playing order (hook is always first, cta always last).
const ORDER: Record<QuickFormat, string[]> = {
  problem_fix: ["problem", "myth", "stat", "points", "before_after"],
  three_signs: ["points", "stat", "problem", "before_after"],
  myth_fact: ["myth", "problem", "stat", "points"],
  pov: ["problem", "stat", "myth", "points"],
  before_after: ["before_after", "stat", "price", "points"],
  price: ["price", "points", "stat", "map"],
  service_area: ["map", "points", "stat", "price"],
};
// The block a format cannot be made without, and how to say so.
const REQUIRED: Record<QuickFormat, [string, string][]> = {
  problem_fix: [["points", "points (3-5 short steps of the fix)"]],
  three_signs: [["points", "points (the 3 signs)"]],
  myth_fact: [["myth", "myth and fact"]],
  pov: [["problem", "problem (what happens next, one short line)"]],
  before_after: [["before_after", "before_image and after_image (real photo URLs)"]],
  price: [["price", "price_service and price_value (the real price)"]],
  service_area: [["map", "towns (2-6 place names)"]],
};

const plain = (s?: string) => (s || "").replace(/\*/g, "").replace(/\s+/g, " ").trim();
const sentence = (s: string) => (/[.!?]$/.test(s) ? s : s + ".");
const listSpeech = (a: string[]) => (a.length > 1 ? a.slice(0, -1).join(", ") + " and " + a[a.length - 1] : a[0] || "");
// Phone numbers read digit by digit sound robotic, so a contact that is mostly digits is shown, not spoken.
const speakable = (s?: string) => !!s && (s.match(/\d/g) || []).length < 5;

export function buildQuickSpec(q: QuickInput): { spec: Partial<VideoSpec>; missing: string[]; used: string[] } {
  const points = (q.points || []).map(plain).filter(Boolean).slice(0, 5);
  const towns = (q.towns || []).map(plain).filter(Boolean).slice(0, 6);
  const has: Record<string, boolean> = {
    problem: !!plain(q.problem),
    myth: !!plain(q.myth) && !!plain(q.fact),
    stat: !!plain(q.stat_value) && !!plain(q.stat_label),
    points: points.length >= 2,
    before_after: !!q.before_image && !!q.after_image,
    price: !!plain(q.price_service) && !!plain(q.price_value),
    map: towns.length >= 2,
  };
  const missing = REQUIRED[q.format].filter(([k]) => !has[k]).map(([, say]) => say);
  if (!plain(q.hook)) missing.unshift("hook");

  const vo = q.voiceover !== false;
  const say = (line: string) => (vo ? { vo: sentence(plain(line)) } : {});
  const scenes: Partial<Scene>[] = [];
  const hookText = q.format === "pov" && !/^pov\b/i.test(plain(q.hook)) ? `POV: ${q.hook}` : q.hook;
  scenes.push({ type: q.format === "pov" ? "pov" : "hook", end: 2.4, text: hookText, image: q.photo, ...say(hookText) });

  const tx: Scene["transition"][] = ["zoom", "slide", "fade", "slide", "zoom"];
  const used: string[] = [];
  for (const block of ORDER[q.format]) {
    if (!has[block]) continue;
    const transition = tx[used.length % tx.length];
    used.push(block);
    if (block === "problem") scenes.push({ type: q.photo ? "image" : "hook", end: 3, text: q.problem, image: q.photo, motion: "zoom_in", dim: 0.6, transition, ...say(q.problem!) });
    if (block === "myth") scenes.push({ type: "myth_fact", end: 4, text: plain(q.myth), subtext: q.fact, transition, ...say(`You've heard ${plain(q.myth)}. Actually, ${plain(q.fact)}`) });
    if (block === "stat") scenes.push({ type: "stat", end: 2.8, value: plain(q.stat_value), text: plain(q.stat_label), transition, ...say(`${plain(q.stat_value)} ${plain(q.stat_label)}`) });
    if (block === "points") {
      const signs = q.format === "three_signs";
      const title = plain(q.points_title) || (signs ? `${points.length} signs` : "How it works");
      scenes.push({ type: signs ? "list" : "steps", end: 2 + points.length * 0.9, text: title, items: points, transition, ...say(`${signs ? "Watch for" : "Here's how"}: ${listSpeech(points)}`) });
    }
    if (block === "before_after") scenes.push({ type: "before_after", end: 3.6, image: q.before_image, image2: q.after_image, text: "Before → After", transition, ...say("Here's the before, and the after") });
    if (block === "price") scenes.push({ type: "price", end: 3.6, text: plain(q.price_service), value: plain(q.price_value), items: (q.price_includes || []).map(plain).filter(Boolean).slice(0, 4), transition, ...say(`${plain(q.price_service)}: ${plain(q.price_value)}`) });
    if (block === "map") scenes.push({ type: "map", end: 3.4, text: "Where we work", items: towns, transition, ...say(`We serve ${listSpeech(towns)}`) });
  }
  const cta = plain(q.cta) || "Book yours today";
  scenes.push({ type: "cta", end: 3, text: cta, subtext: q.contact, transition: "zoom", ...say(speakable(q.contact) ? `${cta}. ${q.contact}` : cta) });
  if (scenes.length < 4 && !missing.length) missing.push("one more block so the video has at least 4 scenes: stat_value + stat_label, problem, myth + fact, or points");

  const spec: Partial<VideoSpec> = {
    brand_name: q.brand_name,
    handle: q.handle,
    theme: { bg: q.colors?.bg || "#16161a", fg: "#ffffff", accent: q.colors?.accent || "#ff3b3b", accent2: q.colors?.accent2, display_font: "Anton" },
    music: q.music || "upbeat",
    sfx: true,
    caption_style: q.caption_style || "pop",
    finish: true,
    scenes: scenes.map((s) => ({ start: 0, ...s })) as Scene[],
  };
  return { spec, missing, used };
}
