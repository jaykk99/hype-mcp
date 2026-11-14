// The creative playbook: the same standards the server's judges enforce, handed to the client model (Claude)
// when it is the brain. Keeping one source of truth means "what Claude writes to" == "what gets measured".
import { RUBRIC } from "./judge";
import { ANGLES, PLATFORMS, type Format, type Platform } from "./platforms";
import { SANDBOX_API_DOC } from "./video/sandbox";

export const SCENES_DOC = `Scene types (scenes play back-to-back; durations 1.5-4s; {type,start,end,...} — start/end only need the right length, the server rebuilds the timeline):
- hook: {text, subtext?, image?} giant kinetic words popping in. FIRST scene, ≤2.5s, ≤7 words. *asterisks* mark 1-2 power words (accent highlight).
- image: {image, text?, subtext?, motion: zoom_in|zoom_out|pan_left|pan_right, dim?} photo with Ken Burns + lower-third.
- list: {text (title), items[3-5], image?} animated checklist.
- stat: {value "40 lbs"/"$150", text (label), image?} number counts up.
- before_after: {image (before), image2 (after), text?} wipe reveal — needs BOTH images.
- cta: {text, subtext (phone/offer)} end card. LAST scene.
- clip: {video (mp4 URL) OR ai_prompt, text?, dim?} real AI footage. With a video worker connected, ai_prompt generates it (open model on the user's free GPU). Best uses: the problem in motion (water pouring over a clogged gutter), the satisfying payoff (clean gutter, water flowing). One continuous 2-5s shot; describe subject, action, camera move, light, lens.
- pov: {text, subtext?, image?} TikTok-style "POV:" top plate over a photo/backdrop.
- myth_fact: {text (myth), subtext (fact), image?} myth gets struck through, fact slams in. Great hook #2.
- compare: {text (title), subtext "Left|Right" headers, items (left ✕), items2 (right ✓)} side-by-side.
- steps: {text (title), items[3-5]} numbered process with a growing line.
- price: {text (service), value (REAL price only), subtext?, items (what's included)} price card with shine.
- quote: {text, subtext (who said it — owner/tip only, NEVER an invented customer review)} big quote card.
- map: {text (tagline), items (place names)} pins drop on a stylized map with a route.
- code: {code} YOUR OWN animation, run in a sandbox every frame. Use it for what templates can't do: water backing up a gutter, ice building on eaves, snow piling on a roof, a price tag flipping, a map pin dropping on Steinbach, a chart growing, physics typography.
Per-scene: transition cut|fade|slide|zoom (vary), dim 0..1 (overlay darkness on photos).
Top level: {brand_name, handle, theme:{bg,fg,accent,accent2,display_font:"Anton"|"Inter"}, music:"upbeat"|"chill"|"hype"|"cinematic"|"none", sfx:true, caption_style:"pop"|"box"|"karaoke"|"minimal", finish:true, voiceover?:{script, voice?}, assets?:{key:url}, scenes:[...]}
Music is homemade (synthesized chords, drums, bass), ducked under the voice automatically; without voiceover, cuts snap to the beat. SFX (whoosh on slide/zoom, pops on hook words, clicks on list/steps items, riser + impact into the CTA) are placed automatically. finish adds grain, vignette and handheld drift/shake.
Tip: for maximum reach on IG/TikTok you can set music:"none" and add a trending sound in-app; keep sfx on.
AI footage tip: generate_clip can animate a real photo (image_url) or a graphic you coded (image_spec) — the most reliable way to get on-brand motion.
Images: only REAL photo URLs (the owner's job photos, their website/Instagram images) or none — draw everything else in code scenes. Reference photos by URL directly in scene.image or via assets keys.
Voiceover (homemade TTS, word-highlighted captions): BEST = give each scene its own "vo" line — the scene is timed to that line so cuts land on the words (a scene without vo keeps its own length, silent). Alternative: one top-level voiceover.script (scenes get stretched evenly). ~2.6 words/sec; on-screen text should complement the line, not repeat it. Voices: am_michael (default), am_adam, am_fenrir, am_puck, af_heart, af_bella, af_nicole, af_sarah, bm_george, bf_emma.`;

/** The writing craft both the server's writer and the assistant follow. One source of truth. */
export const HOOK_FORMULAS = [
  "Specific scene + number: \"This downspout in Steinbach was holding 40 lbs of maple seeds\"",
  "Consequence first: \"One clogged gutter = a $4,000 basement in March\"",
  "Real customer question, answered: \"How often should you clean gutters in Winnipeg? (Not twice a year)\"",
  "Stop / don't (loss aversion): \"Don't put gutter guards on until you see this\"",
  "Price reveal: \"What $150 gets you from a gutter crew in Winnipeg\"",
  "Signs listicle: \"3 signs your eavestroughs will freeze this week\"",
  "Myth flip: \"Gutter guards don't mean no cleaning. Here's why\"",
  "POV: \"POV: you skipped gutter cleaning in October\"",
  "Behind the scenes: \"What we find in 9 of 10 Winnipeg gutters\"",
  "Test / experiment: \"Leaf blower vs gutter scoop: we timed it\"",
  "Mistake you're making: \"You're cleaning your gutters in the wrong month\"",
  "Before/after tease: \"Wait for the downspout at the end\"",
];

export const CRAFT = `## Research first (what to say)
- Topics come from evidence, not imagination: real customer questions (research_content / customer_questions), questions the site answers, the brand's real jobs and photos, the season, and titles that already pull views. Name the question or proof your post is built on.
- If a high-view title exists for the topic, keep its *promise* and remake it with the brand's own town, job, number and photos. Never copy wording.

## Hook formulas (pick the one that fits the evidence, then make it specific)
${HOOK_FORMULAS.map((h) => `- ${h}`).join("\n")}
These examples are illustrations: every number, price and town you write must come from the brand's real facts or research.
Write 5 hooks, keep the most specific one. Test: could a competitor post the same hook unchanged? Then it's not done.
Specificity ladder: "clean gutters" (generic) → "fall gutter cleaning" (category) → "40 lbs of maple seeds from one Steinbach downspout" (concrete). Always climb to the top rung.

## Caption structure
1. Hook line (the first line is the only one most people read).
2. Tension: the situation or cost in the reader's own words (one line).
3. Value: 2-4 short lines — the tip, the reason, the steps, the proof. Line breaks between them.
4. Proof: a real detail (job, photo, years, rating) — never invented.
5. CTA with a friction-reducer: "Text a photo of your roofline for a quote", "Save this for October".
Write to "you", not about "we". Sentences under ~20 words. One idea per post.

## Value types (every post delivers at least one)
Teach (a tip they can use today) · Prove (a real result) · Warn (a cost they can avoid) · Entertain (a relatable moment) · Decide (help them choose: price, DIY vs pro, timing).

## Retention (video)
- Open a loop in the hook and close it at the end ("wait for the downspout").
- Re-hook at ~40%: a number, a reveal, a sound hit or a "but here's the thing".
- Payoff before the CTA; a loopable last frame beats a long goodbye.

## Carousels
Slide 1 = the hook + promise ("5 signs…"). Slide 2 = why it matters (re-hook). One point per slide, ≤8-word headline, ≤25-word body. Last slide = recap + CTA + "save this". Saves are the metric.`;

export function playbook(platform: Platform, format: Format) {
  const p = PLATFORMS[platform];
  const isVideo = format === "reel" || format === "story";
  return `# ${p.label} ${format} playbook

## Bar to clear
You are writing like the best short-form creative on ${p.label}, for a real local business. Every rule below is measured by the server — breaking one costs points.

${CRAFT}

## Hook rules
- Stops a cold scroller in 1.5s. Concrete detail from the brand: a real service, town, number, or the exact situation the customer is in.
- ≤12 words (≤7 on screen). First caption line ≤${p.hookVisibleChars} chars (that's what shows before "…more").
- Never: "look no further", "elevate", "unlock", "game-changer", "seamless", "dive into", "whether you're", "in today's fast-paced world".
- Never open with: "Are you…", "Did you know…", "Looking for…", "Introducing…", "We're excited…", "Welcome to…", "At <Brand>, we…" (measured: −5).
- The hook needs a concrete anchor (number, town, named thing, season, brand detail) and the post must use at least one real brand specific (measured).

## Truth
- No price, discount, %, guarantee or promo that isn't in the brand's real facts. (Automatically detected and penalized 15 pts.)
- No fake reviews, fake stats, "#1", "best in Canada", "guaranteed".

## Copy
- Caption ${p.captionIdeal[0]}-${p.captionIdeal[1]} chars. ${p.hashtags[0]}-${p.hashtags[1]} specific hashtags (local + niche; never #fyp #viral #love #instagood).
- One idea. Give value even to people who never buy. Low-friction CTA using the real contact/offer.
- Platform notes: ${p.notes}

## Angles to try (write 3, keep the strongest)
${ANGLES.map((a) => `- ${a}`).join("\n")}

## Proven formats (pick one, don't invent structure)
- **Problem → Agitate → Fix**: hook (the problem) → code/clip (show it happening) → myth_fact or stat (why it's worse than they think) → steps or image (the fix) → cta.
- **3 Signs**: hook ("3 signs your … ") → list or 3 quick image scenes → cta. Saves + shares.
- **Myth vs Fact**: myth_fact as scene 1–2 → explain in code/image → cta.
- **POV**: pov ("POV: you skipped gutter cleaning in October") → consequence clip/code → fix → cta. Relatable, comment bait.
- **Before → After**: hook → before_after (real photos) → stat/price → cta. Strongest proof for service businesses.
- **Price transparency**: hook ("What gutter cleaning actually costs in Winnipeg") → price (real numbers) → compare (DIY vs pro) → cta.
- **Service area**: hook → map (towns) → steps (how booking works) → cta.

## Rubric (score yourself 0-10 per line, harshly: 5 average, 7 solid, 8 strong, 9 top 5%)
${RUBRIC.map((r) => `- ${r.key} (${Math.round(r.weight * 100)}%): ${r.desc}`).join("\n")}
Then call check_post with your draft + self_scores — it adds ~25 measured checks and returns the final 0-100.
${isVideo ? `
## Video rules (measured on the rendered pixels)
- Length ${p.videoSeconds[0]}-${p.videoSeconds[1]}s. First scene ≤3s. ≥4 scenes (pattern interrupt every 2-3s). Last scene = cta.
- ≤3.5 on-screen words per second per scene. Text contrast ≥4.5:1 against the real background (raise dim on photo scenes).
- Text stays in y 12%–78% (app UI covers the rest). No blank frames. Code scenes must not throw.

## Video spec format
${SCENES_DOC}

## Code scene API
${SANDBOX_API_DOC}

## Loop
1. Write the spec → render_video. 2. Look at the returned frames like a ruthless creative director (thumb-stop, readability, polish, variety, brand fit) and read the measured failures. 3. Fix and re-render. Ship at ≥85.` : `
## Graphics
For a photo/post/carousel graphic, write a spec (same format as video; one scene per image/slide; width 1080 height 1350) and call render_post_image. Use code scenes for illustrated graphics, image scenes for real photos with headlines.
${SCENES_DOC}

## Code scene API (p = 1 for stills; draw the finished state)
${SANDBOX_API_DOC}`}`;
}

export const SERVER_INSTRUCTIONS = `Hype MCP — a homemade marketing studio. No API keys needed: YOU (the assistant) are the creative brain; this server is the crawler, renderer, voice and measuring lab.
Workflow:
1) research_brand(input) — crawls the site (inner pages, schema.org facts, real photos, prices, FAQ), socials, YouTube, branded searches. If it returns raw evidence, YOU write the brand profile from it (and add facts from your own web search or the user). Never invent offers.
2) research_content(topic, location) — what real people search and ask about the topic, which YouTube titles pull views (and the patterns behind them), the season and upcoming dates, and starter ideas mapped to quick_video formats. Build every post on one real question or proven topic from it.
3) creative_playbook(platform, format) — the exact standards your work is measured against. Read it before writing.
4) Posts: write 3 angles → check_post each (with your honest self_scores) → keep the best → fix what it flags.
   Graphics: render_post_image(spec) — coded designs or real photos + headlines → PNGs + permanent links.
   Videos: start with quick_video(format, brand_name, hook, …) — one call, a proven format, finished MP4. Use render_video(spec) when you need custom coded animation.
   render_video(spec) — real MP4 with coded animation, voiceover + captions, music. Inspect the frames it returns, fix measured failures, re-render until ≥85.
5) Give the user the permanent links, caption and hashtags, and say which real question/evidence each piece is built on.
If the server has its own LLM configured, create_post / make_video / content_plan also run fully autonomously.`;
