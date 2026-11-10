// Render an example spec locally: npx tsx scripts/render-example.ts examples/gutter-genie-pro.json out.mp4 [quality]
import { readFileSync, copyFileSync, writeFileSync } from "node:fs";
import { produceVideo } from "../lib/video/produce";
const [file, out = "/tmp/hype/example.mp4", q = "standard"] = process.argv.slice(2);
const size = ({ draft: { width: 540, height: 960, fps: 24 }, standard: { width: 720, height: 1280, fps: 30 }, hd: { width: 1080, height: 1920, fps: 30 } } as any)[q];
(async () => {
  const p = await produceVideo({ ...JSON.parse(readFileSync(file, "utf8")), ...size });
  copyFileSync(p.file, out);
  p.render.qa_frames.forEach((f, i) => writeFileSync(`/tmp/hype/ex_${i}.jpg`, f.jpeg));
  console.log(JSON.stringify({ duration: p.spec.duration, render_s: p.render.seconds, technical: p.technical, voice: p.voice, failed: p.checks.checks.filter((c) => !c.pass).map((c) => `${c.check}: ${c.detail}`), scenes: p.spec.scenes.map((s) => `${s.type} ${(s.end - s.start).toFixed(1)}s`), notes: p.notes }, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
