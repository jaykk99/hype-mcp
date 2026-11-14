// Live smoke test for the keyless research (needs internet): npx tsx scripts/test-research.ts "gutter cleaning" "Winnipeg, Manitoba"
import { researchContent, researchBrief } from "../lib/audience";

(async () => {
  const [topic = "gutter cleaning", location = "Winnipeg, Manitoba"] = process.argv.slice(2);
  const t = Date.now();
  const r = await researchContent({ topic, location });
  console.log(`researched in ${Date.now() - t}ms: ${r.audience_questions.total} queries, ${r.youtube.top_by_velocity.length} videos, ${r.reddit.length} threads`);
  console.log(JSON.stringify(researchBrief(r), null, 2));
  console.log("ideas:\n" + r.ideas.map((i) => `  [${i.quick_video_format}] ${i.starter_hook}  <- ${i.topic}`).join("\n"));
  if (r.audience_questions.total < 5 || !r.youtube.top_by_velocity.length) {
    console.error("FAIL: research came back thin");
    process.exit(1);
  }
  console.log("PASS");
})();
