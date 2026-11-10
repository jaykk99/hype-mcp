# Hype MCP v3: a homemade marketing studio with no keys needed

Plug it into Claude. Give it a company name, website or channel, and it researches the brand, writes posts, **codes and renders real MP4 videos and graphics**, then measures its own work and fixes it.

**No API keys. No third-party services.** Everything is homemade:

| Usually a 3rd-party service | Homemade here |
|---|---|
| LLM API (writer/judge) | **Claude itself** is the brain. The server hands it the playbook and measurements (`creative_playbook`, `check_post`) |
| Firecrawl / search APIs | Own crawler: site + inner pages, social OG metadata, YouTube RSS, DuckDuckGo HTML |
| Image generator | Graphics **Claude codes** in a sandbox, plus your real job photos |
| Runway / Kling / Sora (AI footage) | **Hype Video Worker**: open models (LTX-Video, Wan 2.1) on *your own* free Kaggle/Colab GPU → `generate_clip` |
| Music library / SFX packs (Epidemic, Artlist) | **Own synth**: chord progressions, drums, bass in 4 styles; auto SFX (whoosh, pops, clicks, riser, impact); voice ducking; −14 LUFS loudness; beat-snapped cuts |
| Video editor / renderer | Own renderer: Skia canvas + sandboxed animation code + ffmpeg → MP4 |
| ElevenLabs | **Kokoro-82M** (Apache-2.0) TTS running on the server's CPU, with word-highlighted captions |
| Vision QA model | Pixel measurements (real contrast, overlap, safe zones, blank frames), plus Claude reviewing the returned frames |
| S3 / Blob storage | **Spec-in-the-link:** the URL carries the recipe, the server re-renders on request (deterministic, cached). Links never expire |

The only download is Kokoro's open model weights (~90 MB) from the public model hub on first use. Keys in `.env.example` are optional upgrades that let the server run fully autonomously without Claude.

### Finishing
Film grain, vignette, handheld camera drift and a shake on hook hits. Captions come in 4 styles: `pop` (default, bold creator style), `box`, `karaoke` and `minimal`. The playbook has 7 proven formats (Problem→Agitate→Fix, 3 Signs, Myth vs Fact, POV, Before→After, Price transparency, Service area).

### AI video generator (homemade)
`worker/hype_video_worker.ipynb` turns a free Kaggle (GPU T4 x2, Internet on) or Colab (T4) session into your own text→video / image→video generator:
1. Open the notebook, pick `HYPE_MODEL` (`ltx` fast, `wan` higher quality), Run all.
2. It loads the open model, starts a free Cloudflare quick tunnel (no account), and prints a private link with a token.
3. Give Claude the link. `generate_clip` makes footage (from a prompt, a real photo, or a graphic Claude coded), and `render_video` drops clips into the edit (`{"type":"clip","ai_prompt":"..."}` generates automatically).
Clip links last while the notebook runs, so render the final MP4 before closing it. `HYPE_MODEL=mock` tests everything without a GPU.

### Keyless workflow (what Claude does through the connector)
1. `research_brand` → crawl evidence → Claude writes the brand profile
2. `creative_playbook(platform, format)` → the standards it will be measured on
3. Posts: write 3 angles → `check_post` (measured checks + honest self-scores) → keep the best
4. Graphics: `render_post_image(spec)` → PNGs + permanent links
5. Video: `render_video(spec)` → MP4 + frames + measured failures → fix → re-render until 100/100 technical and ≥85 overall

See `examples/` for real specs (the Gutter Genie freeze-up reel with two coded animations and per-scene voiceover).

## Tools (autonomous mode, when a server LLM key is set)

| Tool | What it does |
|---|---|
| `research_brand` | Website + inner pages, social profiles, YouTube uploads with view counts, web search → brand profile (offer, audience pains, voice, colours, pillars, gaps, **banned claims**) |
| `create_post` | 3–5 variants from different angles → multi-judge rubric + ~25 automatic checks → rewrites the winner until it passes → renders and visually checks images |
| `make_video` | **Writes, codes, renders and QA's a real vertical MP4** (see below) |
| `render_video_spec` | Edit any scene/timing/colour/animation code and re-render |
| `benchmark_content` | Score any post (yours or a competitor's) 0–100 with fixes |
| `content_plan` | Brand-specific calendar of hooks and formats |
| `render_reel` / `check_render` | Low-level fal.ai image-to-video jobs |

## How `make_video` works

1. **Direct:** the model writes a scene timeline: hook → proof → value → CTA, a pattern interrupt every 2–3s, and on-screen text written for people watching muted.
2. **Code:** for moments templates can't do (water backing up a gutter, ice building, a price spinning, a chart), it **writes its own canvas animation code**. That code runs inside a **QuickJS WebAssembly sandbox** with no access to files, network or process. It only produces a list of drawing commands, which are replayed through a whitelist. A crash or infinite loop is cut off after 250 ms per frame and the scene falls back to a template.
3. **Templates:** POV, myth vs fact, compare, numbered steps, price card, quote, service-area map, kinetic hook type with highlighted words, Ken Burns photos, animated checklists, counting stats, before/after wipe, pulsing CTA card, plus fade/slide/zoom/cut transitions and a progress bar.
4. **Footage:** generates photos per scene. With `FAL_KEY`, it can animate chosen scenes into real AI video clips, which are decoded and composited frame by frame.
5. **Sound:** voiceover (ElevenLabs with character timestamps for **exact word-highlighted captions**, or any OpenAI-compatible TTS), scenes retimed to the voice, and a generated royalty-free music bed.
6. **Render:** Skia canvas → raw frames → ffmpeg H.264/AAC MP4 (540p / 720p / 1080p).
7. **Watch itself:**
   - *Measured on real pixels:* text contrast against the actual background, platform safe zones, blank frames, code-scene crashes, missing images.
   - *Timeline:* hook length, words per second per scene, scene pacing, platform length, CTA present.
   - *Creative:* same multi-judge rubric as posts.
   - *Visual:* a vision model reviews the frames.
8. **Fix:** deterministic fixes first (darker overlay where contrast fails, more time where text is too fast, rewrite crashing code, regenerate failed images), which are **locked so a later AI rewrite can't undo them**. Then an AI revision for creative fixes, a re-render, and the best version is kept. Stops early to stay within Vercel's 300s limit.

Returns the MP4 URL, cover frame, a contact sheet of the frames it reviewed, the scorecard, caption and hashtags, and the editable spec.

## Benchmark (free GPT-OSS 20B as writer and judge, Gutter Genie)

See `bench-*.json`. Highlights:
- The judge separates a generic AI post (19/100) from a specific local one (76/100), and gives the same score on repeat runs.
- The self-improvement loop raised a single-shot post from 42 to 68–71 on an independent re-score.
- Video: an 18s 720p video with music renders in about 15–28s. The sandbox survived an infinite loop and fell back cleanly.
- Bugs it found and fixed: reasoning models running out of output budget, broken or cut-off JSON, a hidden draft error, and AI rewrites undoing measured fixes.

## Deploy (Vercel)

1. Import the repo. `vercel.json` sets 300s and 3 GB memory for `/api/mcp` (video rendering needs it; requires Vercel Pro for more than 60s).
2. Set env vars from `.env.example`. Minimum: `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`, `MCP_API_KEY`. For great results: a strong `LLM_MODEL`, a different `JUDGE_MODEL`, a `VISION_MODEL`, `BLOB_READ_WRITE_TOKEN`, `ELEVENLABS_API_KEY`, `FAL_KEY`, `FIRECRAWL_API_KEY`.
3. In Claude: **Settings → Connectors → Add custom connector** → `https://<app>.vercel.app/api/mcp?key=<MCP_API_KEY>`

## Example prompts

- "Research Gutter Genie Winnipeg and make me a 20s Instagram reel about clearing gutters before freeze-up, with voiceover."
- "Make a TikTok in code style showing water backing up under shingles from a clogged gutter."
- "Take that video's spec, change the CTA to the $20-off promo and re-render in HD."

## Local

```bash
npm install
cp .env.example .env.local
npm run dev            # MCP at http://localhost:3000/api/mcp
npm test               # deterministic checks
npx tsx scripts/test-render.ts   # renders a sample video to /tmp/hype/test.mp4
npx tsx scripts/bench.ts "<brand>" "<owner notes>"
```
