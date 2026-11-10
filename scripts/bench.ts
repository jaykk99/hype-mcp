// Bench test: research quality, judge discrimination + consistency, single-shot vs self-improving loop.
// Run: LLM_BASE_URL=... LLM_API_KEY=... npx tsx scripts/bench.ts "<brand input>" "<owner context>"
import { writeFileSync } from "node:fs";
import { researchBrand } from "../lib/research";
import { createPost } from "../lib/generate";
import { judgeContent, type Content } from "../lib/judge";
import type { Format, Platform } from "../lib/platforms";

const input = process.argv[2] || "guttergenie.vercel.app";
const extra = process.argv[3] || "";
const t = () => performance.now();
const secs = (a: number) => Math.round((performance.now() - a) / 100) / 10;
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const out: Record<string, any> = { input, started: new Date().toISOString() };
const save = () => writeFileSync(process.env.BENCH_OUT || "bench-results.json", JSON.stringify(out, null, 2));

async function fresh(c: Content, p: Platform, brand: any) {
  // Independent re-score with 3 judges — removes "winner's curse" from picking the max of noisy scores.
  const card = await judgeContent(c, p, brand, { judges: 2 });
  return card.score;
}

(async () => {
  // A) Research
  let s = t();
  const brand = await researchBrand(input, { extra_context: extra });
  out.research = { seconds: secs(s), confidence: brand.confidence, name: brand.name, one_liner: brand.one_liner, pillars: brand.content_pillars?.map((p) => p.name), banned_claims: brand.banned_claims, gaps: brand.content_gaps_and_opportunities, sources: brand.sources };
  log("research", out.research.seconds + "s", brand.name, brand.confidence);
  save();

  if (!process.env.SKIP_JUDGE) {
  // B) Judge discrimination + C) consistency
  const bad: Content = {
    format: "photo",
    hook: "Look no further for the best gutter cleaning!",
    caption: "Look no further for the best gutter cleaning! We are the #1 gutter company and guaranteed to elevate your home. Whether you're a homeowner or business, we've got you covered! Call today!",
    hashtags: ["#fyp", "#viral", "#love", "#guttercleaning"],
    cta: "Call today!",
    image_prompt: "a house with gutters, nice day, professional photo of a home exterior",
    alt_text: "house",
  };
  const good: Content = {
    format: "photo",
    hook: "This Steinbach downspout was packed solid with maple seeds.",
    caption:
      "This Steinbach downspout was packed solid with maple seeds.\n\nIf water sheets over your eavestroughs when it rains, a clog like this is usually why — and once it freezes, it stays there till April and backs ice under your shingles.\n\nWe clear gutters + downspouts across Winnipeg, Steinbach and Grunthal. Text 204-972-0325 for a quote before freeze-up.",
    hashtags: ["#steinbach", "#winnipeghomes", "#eavestrough", "#guttercleaning", "#manitoba"],
    cta: "Text 204-972-0325 for a quote before freeze-up",
    image_prompt: "close-up of a gloved hand pulling a thick wad of wet brown maple seeds out of a white aluminum downspout, overcast Manitoba November light, frost on the shingles, shallow depth of field",
    alt_text: "Gloved hand pulling a clump of maple seeds out of a clogged downspout",
  };
  s = t();
  const badScores: number[] = [];
  const goodScores: number[] = [];
  for (let i = 0; i < 2; i++) {
    const [b, g] = await Promise.all([judgeContent(bad, "facebook", brand, { judges: 1 }), judgeContent(good, "facebook", brand, { judges: 1 })]);
    badScores.push(b.score);
    goodScores.push(g.score);
  }
  out.judge = {
    seconds: secs(s),
    bad_generic_post: badScores,
    good_specific_post: goodScores,
    gap: Math.round(avg(goodScores) - avg(badScores)),
    good_spread: Math.max(...goodScores) - Math.min(...goodScores),
    bad_spread: Math.max(...badScores) - Math.min(...badScores),
  };
  log("judge", out.judge);
  save();

  }
  // D) Baseline single-shot vs full loop, per format
  const cases: { platform: Platform; format: Format; topic: string }[] = [
    { platform: "instagram", format: "reel", topic: "clear gutters before freeze-up; frozen clogs cause ice dams" },
    { platform: "facebook", format: "photo", topic: "new service: Christmas light hanging this month" },
  ];
  out.cases = [];
  for (const c of cases) {
    log("case", c.platform, c.format);
    s = t();
    const base = await createPost({ brand, ...c, variants: 1, max_rounds: 0, render: false, judges: 1 });
    const baseSec = secs(s);
    s = t();
    const loop = await createPost({ brand, ...c, variants: 3, max_rounds: 1, min_score: 85, render: true, judges: 1 });
    const loopSec = secs(s);
    const [baseFresh, loopFresh] = await Promise.all([fresh(base.best, c.platform, brand), fresh(loop.best, c.platform, brand)]);
    const r = {
      ...c,
      baseline: { internal_score: base.scorecard.score, fresh_score: baseFresh, seconds: baseSec, hook: base.best.hook, failed_checks: base.scorecard.checks.filter((x) => !x.pass).map((x) => x.check) },
      loop: {
        internal_score: loop.scorecard.score,
        fresh_score: loopFresh,
        seconds: loopSec,
        hook: loop.best.hook,
        leaderboard: loop.leaderboard.map((l) => l.score),
        rounds: loop.rounds.map((x) => x.note),
        failed_checks: loop.scorecard.checks.filter((x) => !x.pass).map((x) => x.check),
        images: loop.images.map((i) => i.url),
        rubric: loop.scorecard.rubric,
      },
      best_content: loop.best,
      lift: loopFresh - baseFresh,
    };
    out.cases.push(r);
    log("  baseline", base.scorecard.score, "→ fresh", baseFresh, `(${baseSec}s)`, "| loop", loop.scorecard.score, "→ fresh", loopFresh, `(${loopSec}s)`, loop.rounds.map((x) => x.note).join(" > "));
    save();
  }
  out.summary = {
    avg_baseline_fresh: Math.round(avg(out.cases.map((c: any) => c.baseline.fresh_score))),
    avg_loop_fresh: Math.round(avg(out.cases.map((c: any) => c.loop.fresh_score))),
    avg_lift: Math.round(avg(out.cases.map((c: any) => c.lift))),
    max_loop_seconds: Math.max(...out.cases.map((c: any) => c.loop.seconds)),
  };
  out.finished = new Date().toISOString();
  save();
  log("SUMMARY", out.summary);
})().catch((e) => {
  out.error = String(e?.stack || e);
  save();
  console.error(e);
  process.exit(1);
});

function avg(a: number[]) {
  return a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
}
