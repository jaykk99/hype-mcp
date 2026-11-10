import { renderVideo } from "../lib/video/render";
import { normalizeSpec } from "../lib/video/spec";
import { writeFileSync } from "node:fs";
const img = "https://image.pollinations.ai/prompt/" + encodeURIComponent("close-up of a clogged white aluminium gutter full of wet brown maple seeds and leaves, overcast Manitoba November light, frost on shingles, photorealistic") + "?width=720&height=1280&seed=7&model=flux&nologo=true";
const spec = normalizeSpec({
  width: 720, height: 1280, fps: 30, brand_name: "Gutter Genie", handle: "@gutter_genie1",
  theme: { bg: "#1c1c1f", fg: "#ffffff", accent: "#e53935" },
  assets: {},
  music: "pulse",
  scenes: [
    { type: "hook", start: 0, end: 2.2, text: "Your gutters are *freezing* shut" },
    { type: "stat", start: 0, end: 2.4, value: "40 lbs", text: "of seeds in ONE downspout" },
    { type: "list", start: 0, end: 3.5, text: "3 signs", items: ["Water spills over the edge", "Plants growing up top", "Ice on the eaves"] },
    { type: "clip", start: 0, end: 2.5, video: "/tmp/clip.mp4", text: "We clear it *before* freeze-up", transition: "slide" },
    { type: "code", start: 0, end: 2.6, transition: "zoom", code: `function draw(ctx,t,p,W,H,A){ ctx.fillStyle=A.colors.bg; ctx.fillRect(0,0,W,H);
      for(let i=0;i<40;i++){ const x=A.rand(i)*W, y=((A.rand(i+99)*H)+t*300*(0.5+A.rand(i+7)))%H; ctx.globalAlpha=0.7; ctx.fillStyle="#ffffff"; ctx.beginPath(); ctx.arc(x,y,4+A.rand(i+3)*8,0,Math.PI*2); ctx.fill(); }
      ctx.globalAlpha=1; const g=ctx.createLinearGradient(0,0,W,0); g.addColorStop(0,A.colors.accent); g.addColorStop(1,"#ff9800"); ctx.fillStyle=g;
      ctx.font="120px Anton"; ctx.textAlign="center"; const s=A.ease.back(A.clamp(t/0.5,0,1)); ctx.save(); ctx.translate(W/2,H*0.45); ctx.scale(s,s); ctx.fillText("ICE DAMS",0,0); ctx.restore();
      ctx.fillStyle="#fff"; ctx.font="800 44px Inter"; const lines=A.wrap(ctx,"start with clogged gutters",W-160); lines.forEach((l,i)=>ctx.fillText(l,W/2,H*0.55+i*54)); }` },
    { type: "code", start: 0, end: 1, code: "function draw(ctx){ while(true){} }", text: "Fallback works" },
    { type: "cta", start: 0, end: 2.8, text: "Book before *freeze-up*", subtext: "Text 204-972-0325" },
  ],
});
(async () => {
  const r = await renderVideo(spec, { out: "/tmp/hype/test.mp4" });
  r.qa_frames.forEach((f, i) => writeFileSync(`/tmp/hype/qa_${i}.jpg`, f.jpeg));
  console.log(JSON.stringify({ seconds: r.seconds, frames: r.frames, code_errors: r.code_errors, blank: r.blank_frames, missing: r.missing_assets, boxes: r.text_boxes.map((b) => [b.scene, b.t, b.contrast]) }));
})().catch((e) => { console.error(e); process.exit(1); });
