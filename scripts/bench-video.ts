// Real-model video bench: make_video end to end, then report scores, rounds, timings.
import { writeFileSync, copyFileSync } from "node:fs";
import { makeVideo } from "../lib/video/director";
const brand = {
  name: "Gutter Genie", location_or_market: "Winnipeg, Steinbach and Grunthal, Manitoba",
  one_liner: "Owner-operated gutter & eavestrough cleaning, launched Aug 2026",
  what_they_sell: ["gutter/eavestrough cleaning", "downspout clearing", "gutter guard install", "hanger/clip repair", "gutter replacement", "free inspections", "winter roof snow shoveling ($75-100/hr, 1hr min; bungalow flat $150-350)", "Christmas light hanging (new Nov 2026)"],
  offers_and_ctas: ["Text/call 204-972-0325", "free inspections"],
  visual_identity: { colors: ["#e53935", "#1f1f23"], style: "dark charcoal and red, bold", imagery_subjects: ["gutters", "downspouts", "Manitoba houses in fall/winter"] },
  brand_voice: { tone: ["friendly", "local", "straight-talking"], do: [], dont: [], sample_line: "" },
  banned_claims: ["#1", "guaranteed", "fake reviews"],
};
(async () => {
  const style = (process.argv[2] as any) || "mixed";
  const r = await makeVideo({ brand, platform: "instagram", style, topic: "Clear gutters before freeze-up — frozen clogs cause ice dams under shingles", quality: "standard", max_rounds: 1, time_budget_s: 3000 });
  writeFileSync(`bench-video-${style}.json`, JSON.stringify(r, null, 2));
  const local = r.video_url.split("/api/files/")[1];
  if (local) { copyFileSync(`/tmp/hype/${local}`, `/tmp/hype/bench-${style}.mp4`); copyFileSync(`/tmp/hype/${local.replace(".mp4", "_sheet.jpg")}`, `/tmp/hype/bench-${style}-sheet.jpg`); }
  console.log(JSON.stringify({ score: r.scorecard.score, creative: r.scorecard.creative, technical: r.scorecard.technical, rounds: r.rounds, timings: r.timings, scenes: r.spec.scenes.map((s) => s.type + (s.code ? "*" : "")), failed: r.scorecard.checks.filter((c) => !c.pass).map((c) => c.check), warnings: r.warnings }, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
