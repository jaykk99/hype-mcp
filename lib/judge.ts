import { chatJson, models } from "./llm";
import { PLATFORMS, type Format, type Platform } from "./platforms";
import type { BrandProfile } from "./research";

export interface Content {
  format: Format;
  built_on?: string;
  hook_options?: string[];
  angle?: string;
  hook: string;
  caption: string;
  hashtags: string[];
  cta: string;
  alt_text?: string;
  title?: string;
  image_prompt?: string;
  on_image_text?: string;
  slides?: { headline: string; body: string; image_prompt: string }[];
  duration_s?: number;
  audio_vibe?: string;
  cover_prompt?: string;
  beats?: { t_start: number; t_end: number; visual: string; on_screen_text: string; voiceover: string; broll_prompt: string }[];
}

export interface Check {
  check: string;
  pass: boolean;
  detail: string;
  penalty: number;
}

export const RUBRIC: { key: string; weight: number; desc: string }[] = [
  { key: "hook", weight: 0.22, desc: "Would a cold viewer stop scrolling in the first 1.5s / first line? Specific, curiosity or pain, not generic." },
  { key: "brand_fit", weight: 0.14, desc: "Sounds like THIS brand (voice, offer, market) — not interchangeable with any competitor." },
  { key: "value", weight: 0.14, desc: "Viewer gets something (tip, proof, entertainment, emotion) even if they never buy." },
  { key: "clarity", weight: 0.1, desc: "One idea, instantly understood. No jargon, no clutter." },
  { key: "cta", weight: 0.1, desc: "Clear, low-friction, matches the offer and platform." },
  { key: "platform_fit", weight: 0.12, desc: "Native to the platform's format, length, culture and specs." },
  { key: "originality", weight: 0.1, desc: "Fresh angle/visual; avoids clichés and AI-sounding phrases." },
  { key: "shareability", weight: 0.08, desc: "Would someone save, share, or tag a friend?" },
];

const CLICHES = [
  "look no further",
  "in today's fast-paced world",
  "elevate your",
  "unlock the",
  "game-changer",
  "game changer",
  "we've got you covered",
  "take it to the next level",
  "seamless",
  "dive into",
  "delve",
  "embark on",
  "say goodbye to",
  "revolutionize",
  "cutting-edge",
  "whether you're",
  "in the world of",
  "tapestry",
  "unleash",
];

const countEmoji = (s: string) => (s.match(/\p{Extended_Pictographic}/gu) || []).length;

/** Fast, deterministic, free checks. These catch what LLM judges are bad at noticing. */
export function deterministicChecks(c: Content, platform: Platform, brand?: Partial<BrandProfile>): Check[] {
  const spec = PLATFORMS[platform];
  const checks: Check[] = [];
  const add = (check: string, pass: boolean, detail: string, penalty: number) =>
    checks.push({ check, pass, detail, penalty: pass ? 0 : penalty });

  const caption = c.caption || "";
  const tags = (c.hashtags || []).map((h) => h.replace(/^#?/, "#"));
  const full = `${caption} ${tags.join(" ")}`.trim();

  add("caption_under_platform_max", full.length <= spec.captionMax, `${full.length}/${spec.captionMax} chars`, 25);
  const [lo, hi] = spec.captionIdeal;
  add(
    "caption_in_ideal_range",
    caption.length >= lo && caption.length <= hi * 1.5,
    `${caption.length} chars (ideal ${lo}-${hi})`,
    4
  );
  const firstLine = caption.split("\n")[0] || "";
  add(
    "hook_visible_before_more",
    firstLine.length > 0 && firstLine.length <= spec.hookVisibleChars,
    `first line ${firstLine.length} chars (truncates at ~${spec.hookVisibleChars})`,
    6
  );
  add("hook_present", (c.hook || "").trim().length >= 8, `hook: "${(c.hook || "").slice(0, 80)}"`, 10);
  add("hook_short", (c.hook || "").split(/\s+/).length <= 14, `${(c.hook || "").split(/\s+/).length} words (≤14 lands in 1.5s)`, 5);

  const [hmin, hmax] = spec.hashtags;
  add("hashtag_count", tags.length >= hmin && tags.length <= hmax, `${tags.length} hashtags (target ${hmin}-${hmax})`, 3);
  const dupes = tags.filter((t, i) => tags.findIndex((x) => x.toLowerCase() === t.toLowerCase()) !== i);
  add("no_duplicate_hashtags", dupes.length === 0, dupes.length ? `dupes: ${dupes.join(", ")}` : "ok", 2);
  const generic = tags.filter((t) => /^#(love|instagood|photooftheday|fyp|foryou|viral|follow|like4like|explore)$/i.test(t));
  add("no_spammy_hashtags", generic.length === 0, generic.length ? `low-value: ${generic.join(", ")}` : "ok", 3);

  add("cta_present", (c.cta || "").trim().length >= 4, `cta: "${(c.cta || "").slice(0, 80)}"`, 8);

  const lower = `${c.hook} ${caption}`.toLowerCase();
  const cl = CLICHES.filter((p) => lower.includes(p));
  add("no_ai_cliches", cl.length === 0, cl.length ? `found: ${cl.join(", ")}` : "ok", Math.min(12, cl.length * 4));

  // Weak openers: the first words most scrollers skip.
  const opener = `${c.hook || firstLine}`.trim();
  const weak = opener.match(/^(are you (looking|tired|ready)|do you (want|need)|did you know|looking for|hey (guys|everyone|there|friends)|attention|introducing|we are|we're (excited|proud|happy)|at [a-z0-9 &']+,? we\b|welcome to|check out|happy [a-z]+day|meet (the|our)|it'?s time to|are you|have you ever)/i);
  add("no_weak_opener", !weak, weak ? `opens with "${weak[0]}" — lead with the specific situation, result or number instead` : "ok", 5);

  // Specificity: a hook needs at least one concrete anchor (number, price, place, named thing, time).
  const brandTerms = brandSpecifics(brand);
  const hookL = (c.hook || "").toLowerCase();
  const concrete =
    /\d/.test(c.hook || "") ||
    /\s[A-Z][a-z]{2,}/.test((c.hook || "").replace(/^\S+/, "")) ||
    /\b(january|february|march|april|may|june|july|august|september|october|november|december|winter|spring|summer|fall|autumn|tonight|today|this week|weekend)\b/.test(hookL) ||
    brandTerms.some((t) => hookL.includes(t));
  add("hook_concrete", concrete, concrete ? "ok" : "hook has no concrete anchor (a number, town, named thing, season or brand detail) — generic hooks get scrolled past", 4);

  if (brandTerms.length) {
    const used = brandTerms.filter((t) => lower.includes(t));
    add("uses_brand_specifics", used.length > 0, used.length ? `mentions: ${used.slice(0, 4).join(", ")}` : `no real service, town or proof from the brand — this could be any company's post. Use one of: ${brandTerms.slice(0, 6).join(", ")}`, 5);
  }

  // Reader focus: talk about their problem, not about "we".
  const words = caption.toLowerCase().match(/[a-z']+/g) || [];
  const you = words.filter((w) => /^(you|your|you're|yours|you'll|you've)$/.test(w)).length;
  const we = words.filter((w) => /^(we|our|us|we're|we've|we'll|i|i'm|my)$/.test(w)).length;
  add("reader_focused", !(we >= 3 && we > you * 1.5), `you/your ×${you} vs we/our/I ×${we}`, 3);

  // Readability: short sentences read on a phone.
  const sentences = caption.replace(/#\S+/g, "").split(/[.!?\n]+/).map((x) => x.trim()).filter((x) => x.split(/\s+/).length >= 3);
  const lens = sentences.map((x) => x.split(/\s+/).length);
  const avg = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
  const longest = lens.length ? Math.max(...lens) : 0;
  add("readable_sentences", avg <= 20 && longest <= 35, `avg ${avg.toFixed(1)} words/sentence, longest ${longest} (aim ≤20 avg, ≤35 max)`, 3);
  add("scannable_layout", caption.length < 220 || caption.includes("\n"), caption.length < 220 ? "ok" : "long caption with no line breaks — split into short lines", 2);

  const em = countEmoji(caption);
  add("emoji_moderation", em <= Math.max(6, caption.length / 60), `${em} emoji`, 3);
  add("not_all_caps_shouting", !/[A-Z]{12,}/.test(caption.replace(/#\S+/g, "")), "ok", 3);

  if (brand?.banned_claims?.length) {
    const hits = brand.banned_claims.filter((b) => {
      const k = b.toLowerCase().replace(/[^a-z0-9# ]/g, "").trim();
      return k.length > 3 && lower.includes(k);
    });
    add("no_banned_claims", hits.length === 0, hits.length ? `contains: ${hits.join("; ")}` : "ok", 20);
  }
  // Invented offers: any % / $ figure or "X off" deal in the copy must exist in the brand's own facts.
  if (brand && Object.keys(brand).length) {
    const facts = JSON.stringify(brand).toLowerCase().replace(/\s+/g, " ");
    const norm = (x: string) => x.replace(/[\u2010-\u2015\u00a0\u202f]/g, "-").replace(/\s+/g, "");
    const factsN = norm(facts);
    const offers = [
      ...new Set(
        [...`${c.hook} ${caption} ${c.cta} ${c.on_image_text || ""} ${(c.slides || []).map((s) => s.headline + " " + s.body).join(" ")} ${(c.beats || []).map((b) => b.on_screen_text + " " + b.voiceover).join(" ")}`
          .toLowerCase()
          .matchAll(/(\$\s?\d[\d,.]*|\d+(?:\.\d+)?\s?%(?:\s?off)?|\d+\s?(?:percent)\b|buy one get one|bogo)/g)].map((m) => m[0].trim())
      ),
    ];
    const invented = offers.filter((o) => !factsN.includes(norm(o).replace(/off$/, "")));
    add("no_invented_offers", invented.length === 0, invented.length ? `prices/discounts not in brand facts: ${invented.join(", ")} — remove or replace with a real offer` : "ok", 15);
  }
  const risky = lower.match(/\b(guaranteed|100% guarantee|#1|number one|best in (the )?(world|canada|country)|cheapest|lowest price ever)\b/g);
  add("no_unverifiable_superlatives", !risky, risky ? `risky: ${[...new Set(risky)].join(", ")}` : "ok", 6);

  if (c.format === "reel" || c.format === "story") {
    const beats = c.beats || [];
    const dur = c.duration_s || beats.at(-1)?.t_end || 0;
    const [vmin, vmax] = spec.videoSeconds;
    add("video_length", dur >= vmin && dur <= vmax, `${dur}s (target ${vmin}-${vmax}s)`, 6);
    add("has_beats", beats.length >= 3, `${beats.length} beats`, 10);
    add("hook_beat_fast", beats.length > 0 && beats[0].t_end <= 3, `first beat ends at ${beats[0]?.t_end ?? "?"}s (≤3s)`, 6);
    const missingText = beats.filter((b) => !b.on_screen_text?.trim()).length;
    add("on_screen_text_every_beat", missingText === 0, `${missingText} beats without on-screen text (most watch muted)`, 4);
    const longText = beats.filter((b) => (b.on_screen_text || "").split(/\s+/).length > 9).length;
    add("on_screen_text_readable", longText === 0, `${longText} beats with >9 words on screen`, 4);
    const gaps = beats.some((b, i) => i > 0 && Math.abs(b.t_start - beats[i - 1].t_end) > 0.6);
    add("timeline_continuous", !gaps, gaps ? "gaps/overlaps in beat timing" : "ok", 3);
  }
  if (c.format === "carousel") {
    const n = c.slides?.length || 0;
    add("carousel_slide_count", n >= 4 && n <= 10, `${n} slides (4-10)`, 8);
    const heavy = (c.slides || []).filter((s) => (s.headline || "").split(/\s+/).length > 10).length;
    add("carousel_headlines_tight", heavy === 0, `${heavy} slides with >10-word headline`, 4);
  }
  if (c.format === "photo" || c.format === "post") {
    add("has_image_prompt", (c.image_prompt || "").length > 30, "image prompt present", 8);
    add("alt_text_present", (c.alt_text || "").length > 10, "accessibility alt text", 2);
  }
  return checks;
}

const STOP = new Set("the and for with your our you that this from are was have has will can all any more most best into about just only also very their they them what when where which while who why how service services company business local quality professional free cleaning removal repair repairs installation install maintenance design washing painting residential commercial delivery products product solutions".split(" "));

/** Concrete words from the brand (towns, service names, proof numbers) that show a post is about THIS business. */
export function brandSpecifics(brand?: Partial<BrandProfile>): string[] {
  if (!brand) return [];
  const terms = new Set<string>();
  const addPhrase = (s?: string) => {
    if (!s) return;
    for (const part of String(s).toLowerCase().split(/[,;/()|•·–—-]+/)) {
      const t = part.trim();
      if (t.length >= 4 && t.length <= 30 && t.split(/\s+/).length <= 3 && !STOP.has(t)) terms.add(t);
    }
  };
  addPhrase(brand.location_or_market);
  (brand.facts?.area_served || []).forEach(addPhrase);
  (brand.what_they_sell || []).forEach((x) => {
    addPhrase(x);
    String(x).toLowerCase().split(/\s+/).map((w) => w.replace(/[^a-z]/g, "")).filter((w) => w.length >= 6 && !STOP.has(w)).forEach((w) => terms.add(w.replace(/[^a-z]/g, "")));
  });
  (brand.proof_points || []).forEach((p) => (String(p).match(/\d[\d,.]*\+?\s?(years?|jobs|homes|reviews|stars?|customers)/gi) || []).forEach((m) => terms.add(m.toLowerCase())));
  if (brand.name) terms.add(String(brand.name).toLowerCase());
  return [...terms].filter((t) => t.length >= 4).slice(0, 40);
}

export interface Scorecard {
  score: number; // 0-100 final
  llm_score: number; // 0-100 from rubric
  penalty: number;
  rubric: Record<string, number>;
  verdict: "ship" | "revise" | "reject";
  strengths: string[];
  fixes: string[];
  predicted_performance: string;
  checks: Check[];
  image_review?: ImageReview;
}

export async function judgeContent(
  c: Content,
  platform: Platform,
  brand: Partial<BrandProfile>,
  opts: { judges?: number } = {}
): Promise<Scorecard> {
  const checks = deterministicChecks(c, platform, brand);
  const penalty = checks.reduce((s, x) => s + x.penalty, 0);
  const judges = Math.max(1, Math.min(3, opts.judges ?? 1));
  const personas = [
    "Head of Social at a top agency who has run 500+ viral campaigns. Ruthless, allergic to generic AI copy.",
    "A cold, distracted target customer scrolling at 11pm. You only care if it's useful, funny, or relevant to YOU.",
    "Performance marketer who only cares about saves, shares and conversions.",
  ];

  const runs = await Promise.all(
    Array.from({ length: judges }, (_, i) =>
      chatJson<{ rubric: Record<string, number>; strengths: string[]; fixes: string[]; predicted_performance: string }>(
        [
          {
            role: "system",
            content: `You are ${personas[i]}
Score this ${PLATFORMS[platform].label} ${c.format} for the brand below. Be HARSH and calibrated:
5 = forgettable/average, 7 = solid, 8 = genuinely strong, 9 = top 5% of the platform, 10 = almost never.
Generic copy that could fit any business caps hook/brand_fit/originality at 5.
Any price, discount, guarantee or promo NOT present in the brand profile is a fabrication: brand_fit ≤3 and list "remove invented offer" as the first fix.
Rubric:
${RUBRIC.map((r) => `- ${r.key}: ${r.desc}`).join("\n")}
"fixes" must be concrete rewrites or instructions (e.g. "Change hook to: '...'"), max 5, most impactful first.
Return JSON: {"rubric":{${RUBRIC.map((r) => `"${r.key}":n`).join(",")}},"strengths":[...],"fixes":[...],"predicted_performance":"one sentence on likely reach/saves vs the brand's typical post"}`,
          },
          {
            role: "user",
            content: `BRAND:\n${JSON.stringify(slimBrand(brand))}\n\nPLATFORM NOTES: ${PLATFORMS[platform].notes}\n\nCONTENT:\n${JSON.stringify(c)}`,
          },
        ],
        { model: models.judge(), temperature: 0.1, maxTokens: 1200 }
      ).catch(() => null)
    )
  );
  const ok = runs.filter(Boolean) as NonNullable<(typeof runs)[number]>[];
  if (!ok.length) throw new Error("All judge calls failed");

  const rubric: Record<string, number> = {};
  for (const r of RUBRIC) {
    const vals = ok.map((o) => clamp(Number(o.rubric?.[r.key]) || 0, 0, 10));
    rubric[r.key] = round1(vals.reduce((a, b) => a + b, 0) / vals.length);
  }
  const llm_score = Math.round(RUBRIC.reduce((s, r) => s + rubric[r.key] * r.weight, 0) * 10);
  const score = clamp(llm_score - penalty, 0, 100);
  const fixes = [
    ...checks.filter((x) => !x.pass && x.penalty >= 3).map((x) => `[auto-check ${x.check}] ${x.detail}`),
    ...ok.flatMap((o) => o.fixes || []),
  ].slice(0, 8);
  return {
    score,
    llm_score,
    penalty,
    rubric,
    verdict: score >= 80 ? "ship" : score >= 60 ? "revise" : "reject",
    strengths: [...new Set(ok.flatMap((o) => o.strengths || []))].slice(0, 5),
    fixes,
    predicted_performance: ok[0].predicted_performance || "",
    checks,
  };
}

export interface ImageReview {
  score: number; // 0-100
  scores: Record<string, number>;
  issues: string[];
  improved_prompt?: string;
  reviewed: boolean;
}

/** Vision QA on a rendered image. Requires VISION_MODEL (any OpenAI-compatible vision model). */
export async function judgeImage(
  imageUrl: string,
  intent: string,
  brand: Partial<BrandProfile>
): Promise<ImageReview> {
  const vm = models.vision();
  if (!vm) return { score: -1, scores: {}, issues: ["VISION_MODEL not set — image not visually verified"], reviewed: false };
  try {
    const r = await chatJson<{ scores: Record<string, number>; issues: string[]; improved_prompt: string }>(
      [
        {
          role: "system",
          content: `You are a strict creative director doing QA on an AI-generated social image. Score 0-10:
scroll_stop (would it stop a thumb), brand_fit (matches brand visual identity + offer), realism (no AI artifacts: warped hands, melted objects, gibberish text, wrong physics), composition (clear subject, room for text overlay, works cropped to the feed ratio), intent_match (shows what the brief asked).
List concrete issues. Write an improved_prompt that fixes them.
Return JSON {"scores":{"scroll_stop":n,"brand_fit":n,"realism":n,"composition":n,"intent_match":n},"issues":[...],"improved_prompt":"..."}`,
        },
        {
          role: "user",
          content: [
            { type: "text", text: `Brand: ${JSON.stringify(slimBrand(brand)).slice(0, 2500)}\nBrief/intent: ${intent}` },
            { type: "image_url", image_url: { url: imageUrl } },
          ],
        },
      ],
      { model: vm, temperature: 0.1, maxTokens: 800 }
    );
    const vals = Object.values(r.scores || {}).map((v) => clamp(Number(v) || 0, 0, 10));
    const realism = clamp(Number(r.scores?.realism) || 0, 0, 10);
    // Realism is a gate: an image with obvious AI artifacts can't score well.
    const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    const score = Math.round(Math.min(avg, realism + 2) * 10);
    return { score, scores: r.scores || {}, issues: r.issues || [], improved_prompt: r.improved_prompt, reviewed: true };
  } catch (e: any) {
    return { score: -1, scores: {}, issues: [`vision review failed: ${e?.message || e}`], reviewed: false };
  }
}

export function slimBrand(b: Partial<BrandProfile>) {
  return {
    name: b.name,
    one_liner: b.one_liner,
    what_they_sell: b.what_they_sell,
    location_or_market: b.location_or_market,
    target_audience: b.target_audience,
    brand_voice: b.brand_voice,
    visual_identity: b.visual_identity,
    content_pillars: b.content_pillars,
    proof_points: b.proof_points,
    offers_and_ctas: b.offers_and_ctas,
    banned_claims: b.banned_claims,
    content_gaps_and_opportunities: b.content_gaps_and_opportunities,
    customer_questions: b.customer_questions?.slice(0, 12),
    facts: b.facts ? { rating: b.facts.rating, area_served: b.facts.area_served?.slice(0, 10), services: b.facts.services?.slice(0, 10), price_range: b.facts.price_range, opening_hours: b.facts.opening_hours } : undefined,
    real_photo_urls: b.real_photo_urls?.slice(0, 6),
    verified_prices: b.verified_prices?.slice(0, 8),
  };
}

const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));
const round1 = (n: number) => Math.round(n * 10) / 10;
