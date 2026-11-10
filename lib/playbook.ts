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
- code: {code} YOUR OWN animation, run in a sandbox every frame. Use it for what templates can't do: water backing up a gutter, ice building on eaves, snow piling on a roof, a price tag flipping, a map pin dropping on Steinbach, a chart growing, physics typography.
Per-scene: transition cut|fade|slide|zoom (vary), dim 0..1 (overlay darkness on photos).
Top level: {brand_name, handle, theme:{bg,fg,accent,accent2,display_font:"Anton"|"Inter"}, music:"pulse"|"ambient"|"none", voiceover?:{script, voice?}, assets?:{key:url}, scenes:[...]}
AI footage tip: generate_clip can animate a real photo (image_url) or a graphic you coded (image_spec) — the most reliable way to get on-brand motion.
Images: only REAL photo URLs (the owner's job photos, their website/Instagram images) or none — draw everything else in code scenes. Reference photos by URL directly in scene.image or via assets keys.
Voiceover (homemade TTS, word-highlighted captions): BEST = give each scene its own "vo" line — the scene is timed to that line so cuts land on the words (a scene without vo keeps its own length, silent). Alternative: one top-level voiceover.script (scenes get stretched evenly). ~2.6 words/sec; on-screen text should complement the line, not repeat it. Voices: am_michael (default), am_adam, am_fenrir, am_puck, af_heart, af_bella, af_nicole, af_sarah, bm_george, bf_emma.`;

export function playbook(platform: Platform, format: Format) {
  const p = PLATFORMS[platform];
  const isVideo = format === "reel" || format === "story";
  return `# ${p.label} ${format} playbook

## Bar to clear
You are writing like the best short-form creative on ${p.label}, for a real local business. Every rule below is measured by the server — breaking one costs points.

## Hook
- Stops a cold scroller in 1.5s. Concrete detail from the brand: a real service, town, number, or the exact situation the customer is in.
- ≤12 words (≤7 on screen). First caption line ≤${p.hookVisibleChars} chars (that's what shows before "…more").
- Never: "look no further", "elevate", "unlock", "game-changer", "seamless", "dive into", "whether you're", "in today's fast-paced world".

## Truth
- No price, discount, %, guarantee or promo that isn't in the brand's real facts. (Automatically detected and penalized 15 pts.)
- No fake reviews, fake stats, "#1", "best in Canada", "guaranteed".

## Copy
- Caption ${p.captionIdeal[0]}-${p.captionIdeal[1]} chars. ${p.hashtags[0]}-${p.hashtags[1]} specific hashtags (local + niche; never #fyp #viral #love #instagood).
- One idea. Give value even to people who never buy. Low-friction CTA using the real contact/offer.
- Platform notes: ${p.notes}

## Angles to try (write 3, keep the strongest)
${ANGLES.map((a) => `- ${a}`).join("\n")}

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
1) research_brand(input) — crawls the site/socials/YouTube and returns evidence. If it returns raw evidence, YOU write the brand profile from it (and add facts from your own web search or the user). Never invent offers.
2) creative_playbook(platform, format) — the exact standards your work is measured against. Read it before writing.
3) Posts: write 3 angles → check_post each (with your honest self_scores) → keep the best → fix what it flags.
   Graphics: render_post_image(spec) — coded designs or real photos + headlines → PNGs + permanent links.
   Videos: render_video(spec) — real MP4 with coded animation, voiceover + captions, music. Inspect the frames it returns, fix measured failures, re-render until ≥85.
4) Give the user the permanent links, caption and hashtags.
If the server has its own LLM configured, create_post / make_video / content_plan also run fully autonomously.`;
