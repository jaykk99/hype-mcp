import { deterministicChecks } from "../lib/judge";
const bad = deterministicChecks(
  { format: "reel", hook: "Look no further for the best gutter cleaning in the world, we are guaranteed number one", caption: "Look no further! Elevate your home. #fyp #viral #fyp", hashtags: ["#fyp", "#viral", "#fyp"], cta: "", beats: [{ t_start: 0, t_end: 5, visual: "x", on_screen_text: "", voiceover: "", broll_prompt: "" }], duration_s: 5 },
  "instagram",
  { banned_claims: ["number one"] }
);
const good = deterministicChecks(
  { format: "reel", hook: "This downspout in Steinbach was holding 40 lbs of maple seeds", caption: "This downspout in Steinbach was holding 40 lbs of maple seeds.\n\nIf water spills over your gutters when it rains, it's usually a clog like this one — and in November it freezes solid.\n\nBook before freeze-up 👇", hashtags: ["#steinbach", "#guttercleaning", "#manitobahomes", "#eavestrough"], cta: "Text us for a quote", beats: [0, 2, 6, 11, 16].map((t, i, a) => ({ t_start: t, t_end: a[i + 1] ?? 20, visual: "v", on_screen_text: "40 lbs of seeds", voiceover: "", broll_prompt: "p" })), duration_s: 20 },
  "instagram"
);
const inv = deterministicChecks({ format: "photo", hook: "Lights up!", caption: "Book now & get 10 % off plus $49 setup. Call 204-972-0325", hashtags: ["#a","#b","#c"], cta: "Call", image_prompt: "x".repeat(40), alt_text: "lights on a house" }, "facebook", { name: "GG", offers_and_ctas: ["Roof shoveling $150-350 flat"] });
const invC = inv.find((c) => c.check === "no_invented_offers")!;
console.log("invented:", invC.detail);
if (invC.pass) { console.error("FAIL invented offer not caught"); process.exit(1); }
const real = deterministicChecks({ format: "photo", hook: "Bungalow roof cleared", caption: "Flat $150-350 for most bungalows.", hashtags: ["#a","#b","#c"], cta: "Text", image_prompt: "x".repeat(40), alt_text: "roof shoveling job" }, "facebook", { name: "GG", offers_and_ctas: ["Roof shoveling flat $150-350 for a typical bungalow"] });
if (!real.find((c) => c.check === "no_invented_offers")!.pass) { console.error("FAIL false positive on real price"); process.exit(1); }
const pen = (c: typeof bad) => c.reduce((s, x) => s + x.penalty, 0);
console.log("bad penalty", pen(bad), bad.filter((c) => !c.pass).map((c) => c.check));
console.log("good penalty", pen(good), good.filter((c) => !c.pass).map((c) => c.check));
if (pen(bad) < 40 || pen(good) > 5) { console.error("FAIL"); process.exit(1); }
console.log("PASS");
