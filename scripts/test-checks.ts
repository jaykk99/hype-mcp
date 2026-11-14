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

// quick_video spec builder: every format builds, missing fields are named, nothing is invented.
import { buildQuickSpec, QUICK_FORMATS } from "../lib/video/quick";
const full = { brand_name: "B", hook: "Hook *here*", problem: "It breaks", myth: "M", fact: "F", stat_value: "40 lbs", stat_label: "of leaves", points: ["a", "b", "c"], price_service: "Clean", price_value: "$150", towns: ["Winnipeg", "Steinbach"], before_image: "https://x/b.jpg", after_image: "https://x/a.jpg", contact: "204-972-0325" };
for (const format of QUICK_FORMATS) {
  const r = buildQuickSpec({ ...full, format } as any);
  if (r.missing.length || r.spec.scenes!.length < 4 || r.spec.scenes!.at(-1)!.type !== "cta") { console.error("quick FAIL", format, r.missing); process.exit(1); }
  if (r.spec.scenes!.some((sc) => /204/.test(sc.vo || ""))) { console.error("quick FAIL: phone number in voiceover", format); process.exit(1); }
}
if (!buildQuickSpec({ format: "price", brand_name: "B", hook: "h" } as any).missing.length) { console.error("quick FAIL: missing price not reported"); process.exit(1); }
console.log("quick_video PASS");

// ---------- research parsers (offline fixtures) ----------
import { parseJsonLd, extractImages, extractFaqs, extractPrices } from "../lib/research";
import { parseYouTubeResults, parseCount, parseAgeYears, classifyIntent, seasonalContext, titlePatterns, extractJsonAfter } from "../lib/audience";
import { brandSpecifics } from "../lib/judge";
import { pickAngles } from "../lib/generate";
const must = (ok: boolean, msg: string) => { if (!ok) { console.error("research FAIL:", msg); process.exit(1); } };

const site = `<html><head><meta property="og:image" content="/img/hero-job.jpg">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"HomeAndConstructionBusiness","name":"Gutter Genie","telephone":"204-972-0325","priceRange":"$$","address":{"streetAddress":"1 Main St","addressLocality":"Winnipeg","addressRegion":"MB"},"areaServed":["Winnipeg","Steinbach",{"@type":"City","name":"Niverville"}],"aggregateRating":{"ratingValue":"4.9","reviewCount":"87"},"openingHoursSpecification":[{"dayOfWeek":"https://schema.org/Monday","opens":"08:00","closes":"18:00"}],"makesOffer":[{"@type":"Offer","itemOffered":{"@type":"Service","name":"Gutter cleaning"}}]},{"@type":"FAQPage","mainEntity":[{"@type":"Question","name":"How often should I clean my gutters?","acceptedAnswer":{"@type":"Answer","text":"<p>Twice a year in Manitoba.</p>"}}]}]}</script></head>
<body><img src="/logo.png" width="200"><img src="/icons/phone.svg"><img data-src="/uploads/before-after-1.jpg" alt="before and after gutter job" width="1200">
<img srcset="/a-400.jpg 400w, /a-1600.jpg 1600w" src="/a-400.jpg"><h3>Do you clear downspouts?</h3><summary>What areas do you serve?</summary>
<p>Gutter cleaning starts at $150 for most bungalows. Roof shoveling $150-350 flat.</p></body></html>`;
const f = parseJsonLd(site);
must(f.name === "Gutter Genie" && f.telephone === "204-972-0325", "json-ld name/phone");
must(f.area_served.includes("Niverville") && f.area_served.length === 3, "json-ld areaServed " + f.area_served);
must(f.rating?.value === 4.9 && f.rating.count === 87, "json-ld rating");
must(f.services.includes("Gutter cleaning"), "json-ld services " + f.services);
must(f.faqs[0]?.a === "Twice a year in Manitoba.", "json-ld faq answer " + JSON.stringify(f.faqs));
must(f.address === "1 Main St, Winnipeg, MB", "address " + f.address);
const imgs = extractImages(site, "https://gg.ca/");
must(imgs[0] === "https://gg.ca/img/hero-job.jpg", "og image first " + imgs);
must(imgs.includes("https://gg.ca/uploads/before-after-1.jpg") && imgs.includes("https://gg.ca/a-1600.jpg"), "lazy + srcset images " + imgs);
must(!imgs.some((u) => /logo|svg/.test(u)), "logos/icons filtered " + imgs);
must(extractFaqs(site).length === 2, "faqs " + extractFaqs(site));
const prices = extractPrices("Gutter cleaning starts at $150 for most bungalows. Roof shoveling $150-350 flat. Call us.");
must(prices.length === 2 && prices[1].includes("$150-350"), "prices " + JSON.stringify(prices));

must(parseCount("2.3M views") === 2_300_000 && parseCount("1,234 views") === 1234 && parseCount("12K") === 12000, "parseCount");
must(parseAgeYears("5 years ago") === 5 && parseAgeYears("5y ago") === 5 && Math.abs(parseAgeYears("6 months ago")! - 0.5) < 1e-9, "parseAgeYears");
const yt = parseYouTubeResults({ contents: [
  { videoRenderer: { videoId: "a1", title: { runs: [{ text: "3 Gutter Mistakes That Flood Basements" }] }, viewCountText: { simpleText: "900,000 views" }, publishedTimeText: { simpleText: "1 year ago" }, ownerText: { runs: [{ text: "Pro" }] } } },
  { lockupViewModel: { contentId: "b2", contentType: "LOCKUP_CONTENT_TYPE_VIDEO", metadata: { lockupMetadataViewModel: { title: { content: "How Clogged Gutters Are Deep Cleaned" }, image: { decoratedAvatarViewModel: { a11yLabel: "Go to channel Insider" } }, metadata: { contentMetadataViewModel: { metadataRows: [{ metadataParts: [{ text: { content: "Insider" } }] }, { metadataParts: [{ text: { content: "2.3M views" } }, { text: { content: "5 years ago" } }] }] } } } } } },
] });
must(yt.length === 2 && yt[1].views === 2_300_000 && yt[1].channel === "Insider" && yt[1].views_per_year === 460_000 && yt[0].views_per_year === 900_000, "youtube parse " + JSON.stringify(yt));
must(extractJsonAfter(`var ytInitialData = {"a":"}{","b":{"c":1}};</script>`, "ytInitialData")?.b?.c === 1, "json extraction with braces in strings");
must(titlePatterns(yt).some((p) => /Warning/.test(p.pattern)), "title patterns");
must(classifyIntent("gutter cleaning how much does it cost") === "cost" && classifyIntent("signs of clogged gutters") === "problem" && classifyIntent("when to clean gutters") === "timing" && classifyIntent("gutter guards vs cleaning") === "comparison" && classifyIntent("gutter cleaning steinbach", "Steinbach, MB") === "local" && classifyIntent("how to start gutter cleaning business") === "industry", "intents");
const sc = seasonalContext("Winnipeg, Manitoba", new Date(2026, 10, 14));
must(sc.season === "fall" && sc.upcoming_events.some((e) => e.name === "Black Friday") && sc.upcoming_events.some((e) => e.name === "Christmas"), "season " + JSON.stringify(sc));
must(seasonalContext("Sydney, Australia", new Date(2026, 0, 10)).season === "summer", "southern hemisphere");
const terms = brandSpecifics({ name: "Gutter Genie", location_or_market: "Winnipeg & Steinbach, Manitoba", what_they_sell: ["Eavestrough cleaning", "Roof snow removal"] });
must(terms.includes("eavestrough cleaning") && terms.some((t) => t.includes("steinbach")), "brand specifics " + terms);
const generic = deterministicChecks({ format: "photo", hook: "Are you ready for a cleaner home?", caption: "Are you ready for a cleaner home? We are a team that cares and we believe our service is what our customers love and we always do our best for our community every single day of the year no matter what the weather is doing outside or how busy we get.", hashtags: ["#a", "#b", "#c"], cta: "Call", image_prompt: "x".repeat(40), alt_text: "a house photo" }, "instagram", { name: "Gutter Genie", location_or_market: "Winnipeg", what_they_sell: ["Eavestrough cleaning"] });
for (const k of ["no_weak_opener", "hook_concrete", "uses_brand_specifics", "reader_focused", "readable_sentences"]) must(!generic.find((c) => c.check === k)!.pass, `generic post should fail ${k}`);
const specific = deterministicChecks({ format: "photo", hook: "This Steinbach downspout held 40 lbs of seeds", caption: "This Steinbach downspout held 40 lbs of seeds.\n\nIf your eavestrough spills when it rains, a clog like this is why.\n\nText us a photo for a quote.", hashtags: ["#steinbach", "#eavestrough", "#manitoba"], cta: "Text a photo", image_prompt: "x".repeat(40), alt_text: "downspout full of seeds" }, "instagram", { name: "Gutter Genie", location_or_market: "Winnipeg & Steinbach", what_they_sell: ["Eavestrough cleaning"] });
const sf = specific.filter((c) => !c.pass);
must(sf.length === 0, "specific post should pass everything, failed: " + sf.map((c) => c.check + " " + c.detail));
must(pickAngles(3, { audience_questions: { by_intent: { cost: ["a", "b", "c"] } }, season: { upcoming_events: [] }, youtube: { title_patterns: [] } } as any, "").length === 3, "pickAngles");
console.log("research PASS");
