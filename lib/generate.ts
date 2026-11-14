import { chatJson, models } from "./llm";
import { ANGLES, PLATFORMS, type Format, type Platform } from "./platforms";
import { judgeContent, judgeImage, slimBrand, type Content, type Scorecard } from "./judge";
import { renderImage, type RenderedImage } from "./media";
import type { BrandProfile } from "./research";
import { researchBrief, type ContentResearch } from "./audience";
import { CRAFT } from "./playbook";

function formatSchema(format: Format): string {
  const common = `"built_on": "the real customer question, proven title, brand proof or season this post is built on",
"hook_options": ["5 different hooks using different formulas — all specific"],
"hook": "the first line / first spoken words — max 12 words, specific",
"caption": "full caption, line breaks with \\n, hook as first line",
"hashtags": ["#..."],
"cta": "...",
"alt_text": "..."`;
  switch (format) {
    case "photo":
    case "post":
      return `{${common},
"image_prompt": "detailed photographic brief: subject, setting, lighting, lens, mood, color palette from brand. NO text in image",
"on_image_text": "max 6 words to overlay in Canva/CapCut, or empty"}`;
    case "carousel":
      return `{${common},
"slides": [{"headline":"≤8 words","body":"≤25 words","image_prompt":"visual for this slide, no text"}]  // 5-8 slides: slide 1 = hook, last = CTA
}`;
    case "reel":
    case "story":
      return `{${common},
"title": "≤60 chars (for YouTube/reel cover)",
"duration_s": number,
"audio_vibe": "music/sound direction (trending-style description, not a copyrighted track name)",
"cover_prompt": "thumbnail/cover visual, no text",
"beats": [{"t_start":0,"t_end":2,"visual":"what's on screen + camera move","on_screen_text":"≤8 words","voiceover":"spoken line or empty","broll_prompt":"photographic keyframe prompt for this beat, no text"}]
}`;
  }
}

async function writeVariant(
  brand: Partial<BrandProfile>,
  platform: Platform,
  format: Format,
  angle: string,
  topic: string | undefined,
  temperature: number,
  research?: ContentResearch | null
): Promise<Content> {
  const spec = PLATFORMS[platform];
  const c = await chatJson<Content>(
    [
      {
        role: "system",
        content: `You are the best short-form social creative in the world — you write for brands that go viral without looking like ads.
Write ONE ${spec.label} ${format} for the brand. Angle: ${angle}.
Hard rules:
- Hook must stop a cold scroller in 1.5s. Use a concrete detail from the brand (real service, town, number, situation). No generic openers.
- Write in the brand's voice. Never use these: "elevate", "unlock", "game-changer", "look no further", "seamless", "dive into", "whether you're".
- Never make claims in banned_claims or claims the brand profile doesn't support. No fake reviews/testimonials or invented stats.
- Caption ${spec.captionIdeal[0]}-${spec.captionIdeal[1]} chars, first line ≤${spec.hookVisibleChars} chars. ${spec.hashtags[0]}-${spec.hashtags[1]} specific hashtags (niche + local, no #fyp/#viral).
- ${format === "reel" || format === "story" ? `Length ${spec.videoSeconds[0]}-${spec.videoSeconds[1]}s. First beat ≤2s. On-screen text on every beat (people watch muted). End with a loop or payoff.` : ""}
- Platform notes: ${spec.notes}
- Write 5 hook_options first (different formulas), then set "hook" to the most specific one. Every number/price/town must come from the brand profile or research.

${CRAFT}

Return ONLY JSON in this shape:
${formatSchema(format)}`,
      },
      {
        role: "user",
        content: `BRAND PROFILE:\n${JSON.stringify(slimBrand(brand))}\n\n${research ? `AUDIENCE RESEARCH (real searches, questions and proven titles — build on these):\n${JSON.stringify(researchBrief(research))}\n\n` : ""}${topic ? `TOPIC / BRIEF FROM OWNER: ${topic}` : "Pick the strongest topic: a real customer question from the research that this brand can answer with its own proof, timed to the season."}`,
      },
    ],
    { model: models.writer(), temperature, maxTokens: 2500 }
  );
  c.format = format;
  c.angle = angle;
  c.hashtags = (c.hashtags || []).map((h) => "#" + String(h).replace(/^#+/, "").replace(/\s+/g, ""));
  return c;
}

/** Angles matched to what the research says people want (cost questions → price transparency, problems → signs…), then varied. */
export function pickAngles(n: number, research?: ContentResearch | null, topic?: string): string[] {
  const want: string[] = [];
  const by = research?.audience_questions.by_intent || {};
  const t = (topic || "").toLowerCase();
  const find = (k: string) => ANGLES.find((a) => a.startsWith(k));
  if (/cost|price|\$|how much/.test(t) || (by.cost?.length || 0) >= 3) want.push(find("myth-bust")!, find("quick how-to")!);
  if ((by.problem?.length || 0) >= 3) want.push(find("listicle")!, find("pain point")!);
  if ((by.timing?.length || 0) >= 2 || research?.season.upcoming_events.length) want.push(find("urgency")!);
  if ((by.how_to?.length || 0) >= 3) want.push(find("quick how-to")!);
  if (research?.youtube.title_patterns.some((p) => /Before\/after/.test(p.pattern) && (p.lift ?? 0) >= 1)) want.push(find("before/after")!);
  const rest = [...ANGLES].sort(() => Math.random() - 0.5);
  return [...new Set([...want.filter(Boolean), ...rest])].slice(0, n);
}

async function revise(
  c: Content,
  card: Scorecard,
  brand: Partial<BrandProfile>,
  platform: Platform
): Promise<Content> {
  const spec = PLATFORMS[platform];
  const r = await chatJson<Content>(
    [
      {
        role: "system",
        content: `You are rewriting a ${spec.label} ${c.format} that a strict reviewer scored ${card.score}/100.
Apply EVERY fix below. Keep what the reviewer called strengths. Make the hook sharper and more specific. Same JSON shape as the input, return ONLY JSON.
Fixes:
${card.fixes.map((f, i) => `${i + 1}. ${f}`).join("\n")}
Weakest rubric areas: ${Object.entries(card.rubric)
          .sort((a, b) => a[1] - b[1])
          .slice(0, 3)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")}`,
      },
      { role: "user", content: `BRAND:\n${JSON.stringify(slimBrand(brand))}\n\nCURRENT CONTENT:\n${JSON.stringify(c)}` },
    ],
    { model: models.writer(), temperature: 0.7, maxTokens: 2500 }
  );
  r.format = c.format;
  r.angle = c.angle;
  r.hashtags = (r.hashtags || []).map((h) => "#" + String(h).replace(/^#+/, "").replace(/\s+/g, ""));
  return r;
}

export interface CreateResult {
  best: Content;
  scorecard: Scorecard;
  images: (RenderedImage & { role: string; review?: Awaited<ReturnType<typeof judgeImage>> })[];
  leaderboard: { rank: number; angle: string; hook: string; score: number; verdict: string }[];
  rounds: { round: number; best_score: number; note: string }[];
  passed_threshold: boolean;
}

export async function createPost(params: {
  brand: Partial<BrandProfile>;
  platform: Platform;
  format: Format;
  topic?: string;
  variants?: number;
  min_score?: number;
  max_rounds?: number;
  render?: boolean;
  judges?: number;
  research?: ContentResearch | null;
}): Promise<CreateResult> {
  const { brand, platform, format, topic } = params;
  const variants = Math.max(1, Math.min(5, params.variants ?? 3));
  const minScore = params.min_score ?? 82;
  const maxRounds = Math.max(0, Math.min(3, params.max_rounds ?? 2));
  const judges = params.judges ?? 2;

  // 1) Write K variants with different angles in parallel.
  const shuffled = pickAngles(variants, params.research, topic);
  const errors: string[] = [];
  const drafts = (
    await Promise.all(
      shuffled.map((a, i) =>
        writeVariant(brand, platform, format, a, topic, 0.85 + i * 0.05, params.research).catch((e) => {
          errors.push(String(e?.message || e).slice(0, 300));
          return null;
        })
      )
    )
  ).filter((d): d is Content => !!d && typeof d.caption === "string" && typeof d.hook === "string");
  if (!drafts.length) throw new Error("Could not generate any drafts: " + (errors[0] || "model returned the wrong shape"));

  // 2) Benchmark every draft.
  const scored = await Promise.all(
    drafts.map(async (d) => ({ content: d, card: await judgeContent(d, platform, brand, { judges }) }))
  );
  scored.sort((a, b) => b.card.score - a.card.score);
  const leaderboard = scored.map((s, i) => ({
    rank: i + 1,
    angle: s.content.angle || "",
    hook: s.content.hook,
    score: s.card.score,
    verdict: s.card.verdict,
  }));

  // 3) Self-improve the winner until it clears the bar (keep the best version seen — never regress).
  let best = scored[0];
  const rounds = [{ round: 0, best_score: best.card.score, note: `picked best of ${scored.length} angles` }];
  for (let r = 1; r <= maxRounds && best.card.score < minScore; r++) {
    try {
      const next = await revise(best.content, best.card, brand, platform);
      const card = await judgeContent(next, platform, brand, { judges });
      const improved = card.score > best.card.score;
      rounds.push({ round: r, best_score: Math.max(card.score, best.card.score), note: improved ? `revised ${best.card.score}→${card.score}` : `revision scored ${card.score}, kept previous` });
      if (improved) best = { content: next, card };
    } catch (e: any) {
      rounds.push({ round: r, best_score: best.card.score, note: `revision failed: ${e?.message || e}` });
      break;
    }
  }

  // 4) Render visuals for the winner, then visually verify + re-render once if weak.
  const images: CreateResult["images"] = [];
  if (params.render !== false) {
    const spec = PLATFORMS[platform];
    const vertical = format === "reel" || format === "story";
    const size = vertical ? spec.verticalSize : spec.imageSize;
    const jobs: { role: string; prompt: string }[] = [];
    const c = best.content;
    if ((format === "photo" || format === "post") && c.image_prompt) jobs.push({ role: "main", prompt: c.image_prompt });
    if (format === "carousel") (c.slides || []).forEach((s, i) => jobs.push({ role: `slide_${i + 1}`, prompt: s.image_prompt }));
    if (vertical) {
      if (c.cover_prompt) jobs.push({ role: "cover", prompt: c.cover_prompt });
      (c.beats || []).slice(0, 6).forEach((b, i) => b.broll_prompt && jobs.push({ role: `beat_${i + 1}`, prompt: b.broll_prompt }));
    }
    const style = brand.visual_identity
      ? ` Brand look: ${brand.visual_identity.style || ""}; palette ${(brand.visual_identity.colors || []).join(", ")}.`
      : "";
    const rendered = await Promise.all(
      jobs.map(async (j) => {
        let img = await renderImage(j.prompt + style, size);
        // Only vision-check hero images (main, cover, slide 1) to keep it fast.
        const hero = ["main", "cover", "slide_1"].includes(j.role);
        let review = hero ? await judgeImage(img.url, j.prompt, brand) : undefined;
        if (review?.reviewed && review.score < 70 && review.improved_prompt) {
          const retry = await renderImage(review.improved_prompt + style, size);
          const r2 = await judgeImage(retry.url, j.prompt, brand);
          if (!r2.reviewed || r2.score >= review.score) {
            img = retry;
            review = r2;
          }
        }
        return { ...img, role: j.role, review };
      })
    );
    images.push(...rendered);
    const heroReview = images.find((i) => i.review?.reviewed)?.review;
    if (heroReview) best.card.image_review = heroReview;
  }

  return {
    best: best.content,
    scorecard: best.card,
    images,
    leaderboard,
    rounds,
    passed_threshold: best.card.score >= minScore,
  };
}

export async function contentPlan(brand: Partial<BrandProfile>, platform: Platform, days: number, postsPerWeek: number, research?: ContentResearch | null) {
  return chatJson<{ plan: { day: number; format: Format; pillar: string; angle: string; topic: string; built_on: string; hook: string; why_it_will_work: string }[]; strategy_notes: string[] }>(
    [
      {
        role: "system",
        content: `You are a head of social planning a ${days}-day ${PLATFORMS[platform].label} calendar (${postsPerWeek} posts/week).
Mix formats (reels should be ~50%+ on IG/TikTok/Shorts), rotate pillars, every idea must be SPECIFIC to this brand and market (real services, local towns, seasons — current month is ${new Date().toLocaleString("en", { month: "long" })}).
Every idea is built on evidence: a real customer question or search from the research, a proven high-view title remade locally, a real brand proof/photo, or an upcoming date/season moment. Put that in "built_on". Schedule seasonal ideas 2-3 weeks before the moment.
Spread across intents: cost, problems/signs, how-to, timing, comparison/myth, proof/behind-the-scenes.
Hooks: specific (number, town, named thing), no weak openers ("Are you", "Did you know", "Looking for").
Return JSON {"plan":[{"day":n,"format":"reel|photo|carousel|story|post","pillar":"","angle":"","topic":"","built_on":"","hook":"≤12 words","why_it_will_work":""}],"strategy_notes":[...]}`,
      },
      { role: "user", content: `BRAND:\n${JSON.stringify(slimBrand(brand))}${research ? `\n\nAUDIENCE RESEARCH:\n${JSON.stringify({ ...researchBrief(research), more_questions: research.audience_questions.by_intent, upcoming: research.season.upcoming_events })}` : ""}` },
    ],
    { model: models.writer(), temperature: 0.8, maxTokens: 3500 }
  );
}
