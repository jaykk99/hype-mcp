import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { researchBrand, gatherEvidence, type BrandProfile } from "./research";
import { playbook, SERVER_INSTRUCTIONS } from "./playbook";
import { produceVideo, produceStills, links } from "./video/produce";
import { parseWorker, workerHealth, submitClip, clipStatus, waitClips, clipSize } from "./video/worker";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { RUBRIC, deterministicChecks } from "./judge";
import { createPost, contentPlan } from "./generate";
import { judgeContent, judgeImage, type Content } from "./judge";
import { startVideoClip, checkVideo } from "./media";
import { publish } from "./storage";
import { PLATFORMS, type Platform } from "./platforms";
import { makeVideo } from "./video/director";
import { SANDBOX_API_DOC } from "./video/sandbox";

const platformEnum = z.enum(["instagram", "tiktok", "facebook", "linkedin", "x", "youtube_shorts", "threads"]);
const formatEnum = z.enum(["post", "photo", "carousel", "reel", "story"]);
const brandArg = z
  .union([z.string(), z.record(z.any())])
  .describe(
    "Company name, website URL, or channel (e.g. 'Gutter Genie Winnipeg', 'guttergenie.ca', '@mychannel', 'https://youtube.com/@x'). Or pass the brand_profile object returned by research_brand to skip re-research."
  );

async function resolveBrand(b: string | Record<string, any>, extra?: string): Promise<Partial<BrandProfile>> {
  if (typeof b === "string") return researchBrand(b, { extra_context: extra });
  return b as Partial<BrandProfile>;
}

const json = (data: unknown, summary?: string) => ({
  content: [
    ...(summary ? [{ type: "text" as const, text: summary }] : []),
    { type: "text" as const, text: JSON.stringify(data, null, 2) },
  ],
});
const fail = (e: any) => ({ isError: true, content: [{ type: "text" as const, text: `Error: ${e?.message || e}` }] });

function renderSummary(r: Awaited<ReturnType<typeof createPost>>, platform: Platform) {
  const c = r.best;
  const lines = [
    `## ${PLATFORMS[platform].label} ${c.format} — score ${r.scorecard.score}/100 (${r.scorecard.verdict})${r.passed_threshold ? " ✅ passed" : " ⚠️ below target"}`,
    `**Hook:** ${c.hook}`,
    `**Caption:**\n${c.caption}\n\n${(c.hashtags || []).join(" ")}`,
    `**CTA:** ${c.cta}`,
  ];
  if (c.on_image_text) lines.push(`**On-image text:** ${c.on_image_text}`);
  if (c.slides?.length) lines.push("**Slides:**\n" + c.slides.map((s, i) => `${i + 1}. **${s.headline}** — ${s.body}`).join("\n"));
  if (c.beats?.length)
    lines.push(
      `**Reel (${c.duration_s}s, audio: ${c.audio_vibe}):**\n` +
        c.beats
          .map((b) => `- ${b.t_start}-${b.t_end}s | ${b.visual} | TEXT: "${b.on_screen_text}"${b.voiceover ? ` | VO: "${b.voiceover}"` : ""}`)
          .join("\n")
    );
  if (r.images.length)
    lines.push(
      "**Visuals:**\n" +
        r.images.map((i) => `- ${i.role}: ${i.url}${i.review?.reviewed ? ` (visual QA ${i.review.score}/100)` : ""}`).join("\n")
    );
  lines.push(
    `**Rubric:** ${Object.entries(r.scorecard.rubric).map(([k, v]) => `${k} ${v}`).join(" · ")}`,
    `**Self-improvement:** ${r.rounds.map((x) => x.note).join(" → ")}`,
    `**Variant leaderboard:**\n${r.leaderboard.map((l) => `${l.rank}. ${l.score} — ${l.angle.split("(")[0].trim()}: "${l.hook}"`).join("\n")}`
  );
  if (c.format === "reel" || c.format === "story") lines.push("_Next: call make_video with this `best` as `post` to get the finished MP4._");
  if (!r.passed_threshold && r.scorecard.fixes.length) lines.push(`**Remaining fixes:**\n- ${r.scorecard.fixes.slice(0, 4).join("\n- ")}`);
  return lines.join("\n\n");
}

export function buildServer() {
  const server = new McpServer({ name: "hype-mcp", version: "3.0.0" }, { instructions: SERVER_INSTRUCTIONS });
  const serverLLM = !!process.env.LLM_API_KEY;
  const needBrain = (tool: string) => ({
    isError: true,
    content: [{ type: "text" as const, text: `${tool} runs autonomously only when the server has its own LLM. No keys needed though — you are the brain: call creative_playbook, write the work yourself, then use ${tool === "make_video" ? "render_video" : "check_post / render_post_image"}.` }],
  });

  server.registerTool(
    "research_brand",
    {
      title: "Research a brand or channel",
      description:
        "Studies a company/channel: crawls the website + key inner pages, public social profiles, YouTube uploads, and web search. Returns a brand profile (offer, audience pains, voice, visual identity, content pillars, gaps, banned claims). Pass the result into the other tools to skip re-research.",
      inputSchema: {
        input: z.string().describe("Company name, website, @handle, or channel URL"),
        extra_context: z.string().optional().describe("Anything the owner wants factored in (services, prices, towns, current promo)"),
        refresh: z.boolean().optional(),
      },
    },
    async ({ input, extra_context, refresh }) => {
      try {
        if (!serverLLM) {
          const { evidence, sources } = await gatherEvidence(input, extra_context);
          return json(
            { evidence, sources, profile_fields: ["name", "one_liner", "what_they_sell[]", "location_or_market", "target_audience[{segment,pains[],desires[]}]", "brand_voice{tone[],do[],dont[],sample_line}", "visual_identity{colors[],style,imagery_subjects[]}", "content_pillars[{name,why}]", "proof_points[]", "offers_and_ctas[]", "competitors_or_peers[]", "content_gaps_and_opportunities[]", "banned_claims[]", "real_photo_urls[]"] },
            `Crawled ${sources.length} sources for "${input}". You are the strategist: write the brand profile from this evidence (only facts it supports; add your own web research or what the user told you). List real photo URLs found (og:image, site images) for use in graphics/videos. Pass the profile object as \`brand\` to check_post.`
          );
        }
        const p = await researchBrand(input, { extra_context, refresh });
        return json(
          p,
          `Researched **${p.name}** (confidence: ${p.confidence}) — ${p.one_liner}\nPillars: ${p.content_pillars?.map((x) => x.name).join(", ")}\nTop opportunity: ${p.content_gaps_and_opportunities?.[0] || "-"}`
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "create_post",
    {
      title: "Create + self-benchmark a post, photo, carousel, or reel",
      description:
        "Writes several variants from different creative angles, benchmarks each with a multi-judge rubric + automatic platform checks, rewrites the winner until it clears min_score, renders images/keyframes and visually QA's them. Returns the best version, its scorecard, the leaderboard, and image URLs.",
      inputSchema: {
        brand: brandArg,
        platform: platformEnum.default("instagram"),
        format: formatEnum.default("reel"),
        topic: z.string().optional().describe("Optional brief, e.g. 'fall gutter cleaning before freeze-up, $20 off this week'"),
        variants: z.number().int().min(1).max(5).optional().describe("Angles to try (default 3)"),
        min_score: z.number().min(0).max(100).optional().describe("Quality bar 0-100 (default 82)"),
        max_rounds: z.number().int().min(0).max(3).optional().describe("Self-revision rounds (default 2)"),
        judges: z.number().int().min(1).max(3).optional().describe("Independent judge personas (default 2)"),
        render: z.boolean().optional().describe("Render images/keyframes (default true)"),
        effort: z.enum(["fast", "standard", "max"]).optional().describe("max = 5 angles, 3 judges, 3 rewrite rounds, bar 88 (slower, best output)"),
        extra_context: z.string().optional(),
      },
    },
    async (a) => {
      if (!serverLLM) return needBrain("create_post");
      try {
        const brand = await resolveBrand(a.brand, a.extra_context);
        const preset = a.effort === "max" ? { variants: 5, judges: 3, max_rounds: 3, min_score: 88 } : a.effort === "fast" ? { variants: 2, judges: 1, max_rounds: 1, min_score: 75 } : {};
        const r = await createPost({ ...preset, ...Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)), brand, platform: a.platform as Platform } as any);
        return json({ brand_name: brand.name, ...r }, renderSummary(r, a.platform as Platform));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "benchmark_content",
    {
      title: "Benchmark any post",
      description:
        "Scores an existing post/caption/reel script (yours or a competitor's) 0-100 with the same rubric + automatic checks used internally, and returns concrete fixes. Optionally visually QA's an image URL.",
      inputSchema: {
        brand: brandArg,
        platform: platformEnum.default("instagram"),
        format: formatEnum.default("post"),
        caption: z.string().describe("Caption / post text"),
        hook: z.string().optional().describe("First line or first spoken line (defaults to caption's first line)"),
        hashtags: z.array(z.string()).optional(),
        cta: z.string().optional(),
        reel_script: z.string().optional().describe("For reels: beat-by-beat script as plain text"),
        image_url: z.string().optional(),
        judges: z.number().int().min(1).max(3).optional(),
      },
    },
    async (a) => {
      if (!serverLLM) return needBrain("benchmark_content");
      try {
        const brand = await resolveBrand(a.brand);
        const tagsInCaption = a.caption.match(/#[\p{L}\p{N}_]+/gu) || [];
        const content: Content = {
          format: a.format,
          hook: a.hook || a.caption.split("\n")[0],
          caption: a.caption.replace(/#[\p{L}\p{N}_]+/gu, "").trim(),
          hashtags: a.hashtags || tagsInCaption,
          cta: a.cta || "",
          image_prompt: a.image_url ? "provided image" : undefined,
          alt_text: a.image_url ? "provided" : undefined,
        };
        if (a.reel_script) (content as any).reel_script = a.reel_script;
        const card = await judgeContent(content, a.platform as Platform, brand, { judges: a.judges ?? 2 });
        if (a.image_url) card.image_review = await judgeImage(a.image_url, a.caption, brand);
        const failing = card.checks.filter((c) => !c.pass);
        return json(
          card,
          `**Score ${card.score}/100 — ${card.verdict}** (rubric ${card.llm_score}, auto-check penalty −${card.penalty})\n${Object.entries(card.rubric).map(([k, v]) => `${k} ${v}`).join(" · ")}\n\n**Top fixes:**\n- ${card.fixes.slice(0, 5).join("\n- ")}${failing.length ? `\n\n**Failed checks:** ${failing.map((f) => f.check).join(", ")}` : ""}`
        );
      } catch (e) {
        return fail(e);
      }
    }
  );


  // ================= Homemade / keyless tools (the client model is the brain) =================

  server.registerTool(
    "creative_playbook",
    {
      title: "Get the creative playbook",
      description: "Returns the exact standards, rubric, angles, video spec format and code-animation API that this studio measures work against. Read before writing posts, graphics or videos.",
      inputSchema: { platform: platformEnum.default("instagram"), format: formatEnum.default("reel") },
    },
    async ({ platform, format }) => ({ content: [{ type: "text" as const, text: playbook(platform as Platform, format) }] })
  );

  server.registerTool(
    "check_post",
    {
      title: "Measure a post (homemade judge)",
      description: "Runs ~25 measured checks (hook length, truncation, hashtags, clichés, invented offers vs. brand facts, superlatives, reel timing, carousel rules...) and combines them with your rubric self_scores into a 0-100 score with fixes. Be honest with self_scores — 5 is average.",
      inputSchema: {
        brand: z.record(z.any()).describe("Brand profile object (facts used to detect invented offers)"),
        platform: platformEnum.default("instagram"),
        post: z.object({
          format: formatEnum, hook: z.string(), caption: z.string(), hashtags: z.array(z.string()), cta: z.string(),
          alt_text: z.string().optional(), image_prompt: z.string().optional(), on_image_text: z.string().optional(),
          slides: z.array(z.object({ headline: z.string(), body: z.string(), image_prompt: z.string().optional().default("") })).optional(),
          duration_s: z.number().optional(),
          beats: z.array(z.object({ t_start: z.number(), t_end: z.number(), visual: z.string(), on_screen_text: z.string(), voiceover: z.string().optional().default(""), broll_prompt: z.string().optional().default("") })).optional(),
        }),
        self_scores: z.record(z.number()).optional().describe(`Your 0-10 scores for: ${RUBRIC.map((r) => r.key).join(", ")}`),
      },
    },
    async ({ brand, platform, post, self_scores }) => {
      const c = { ...post, image_prompt: post.image_prompt || (post.format === "photo" || post.format === "post" ? "graphic rendered separately via render_post_image" : undefined) } as any;
      const checks = deterministicChecks(c, platform as Platform, brand as any);
      const penalty = checks.reduce((a, x) => a + x.penalty, 0);
      const hasSelf = self_scores && Object.keys(self_scores).length;
      const rubricScore = hasSelf ? Math.round(RUBRIC.reduce((a, r) => a + Math.max(0, Math.min(10, Number(self_scores![r.key] ?? 5))) * r.weight, 0) * 10) : null;
      const score = rubricScore !== null ? Math.max(0, rubricScore - penalty) : Math.max(0, 100 - penalty * 2);
      const failed = checks.filter((x) => !x.pass);
      const weakest = hasSelf ? RUBRIC.map((r) => [r.key, Number(self_scores![r.key] ?? 5)] as const).sort((a, b) => a[1] - b[1]).slice(0, 2) : [];
      return json(
        { score, rubric_score: rubricScore, penalty, verdict: score >= 85 ? "ship" : score >= 65 ? "revise" : "reject", checks },
        `**${score}/100 — ${score >= 85 ? "ship" : score >= 65 ? "revise" : "reject"}**${rubricScore !== null ? ` (your rubric ${rubricScore} − measured penalties ${penalty})` : ` (measured checks only — add self_scores for the full score)`}\n${failed.length ? "**Fix:**\n- " + failed.map((f) => `${f.check}: ${f.detail} (−${f.penalty})`).join("\n- ") : "All measured checks pass."}${weakest.length ? `\n**Weakest rubric areas:** ${weakest.map(([k, v]) => `${k} ${v}`).join(", ")} — rewrite to lift these.` : ""}`
      );
    }
  );

  const thumb = async (buf: Buffer, w = 360) => {
    const im = await loadImage(buf);
    const h = Math.round((im.height / im.width) * w);
    const c = createCanvas(w, h);
    c.getContext("2d").drawImage(im, 0, 0, w, h);
    return c.encodeSync("jpeg", 78).toString("base64");
  };

  server.registerTool(
    "render_video",
    {
      title: "Render a real MP4 from a spec (homemade engine) and measure it",
      description:
        "Renders your video spec into an MP4: coded animation scenes (sandboxed), templates, real photos, transitions, homemade voiceover (local Kokoro TTS) with word-highlighted captions, generated music. Then measures it (contrast on real pixels, safe zones, reading speed, pacing, blank frames, code crashes) and returns frames for YOU to review, plus a permanent link. Call creative_playbook(format='reel') first for the spec format.",
      inputSchema: {
        spec: z.record(z.any()).describe("Video spec (see creative_playbook)"),
        platform: platformEnum.default("instagram"),
        quality: z.enum(["draft", "standard", "hd"]).optional().describe("draft 540p, standard 720p (default), hd 1080p"),
        voice: z.string().optional(),
        contact: z.string().optional().describe("Phone/offer for the auto CTA if the spec lacks one"),
        worker: z.string().optional().describe("Video worker link (for clip scenes with ai_prompt)"),
      },
    },
    async ({ spec, platform, quality, voice, contact, worker }) => {
      try {
        const q = { draft: { width: 540, height: 960, fps: 24 }, standard: { width: 720, height: 1280, fps: 30 }, hd: { width: 1080, height: 1920, fps: 30 } }[quality || "standard"];
        const input = { ...(spec as any), ...q };
        const p = await produceVideo(input, { platform: platform as Platform, voice, contact, worker, clipWaitMs: 150_000 });
        const { permanent, token_chars } = links(input, "v");
        const temp = await publish(`${Date.now().toString(36)}.mp4`, p.file, "video/mp4");
        const failed = p.checks.checks.filter((c) => !c.pass);
        const frames = p.render.qa_frames.slice(0, 6);
        const images = await Promise.all(frames.map(async (f) => ({ type: "image" as const, data: await thumb(f.jpeg), mimeType: "image/jpeg" })));
        const text = [
          `## 🎬 Rendered ${p.spec.duration}s ${p.spec.width}x${p.spec.height} in ${p.render.seconds}s — technical ${p.technical}/100`,
          permanent ? `**Permanent link:** ${permanent}` : `Spec too large for a permanent link (${token_chars} chars) — shorten code scenes.`,
          `**Direct file (temporary):** ${temp.url}`,
          p.voice ? `**Voiceover:** ${p.voice}, ${p.spec.captions?.length || 0} caption chunks` : "",
          p.notes.length ? `**Auto-adjusted:** ${p.notes.join("; ")}` : "",
          p.pending_clips?.length ? `**AI clips still generating:** ${p.pending_clips.map((c) => `scene ${c.scene + 1} → job ${c.id}`).join(", ")} — poll check_clip, put the returned url in that scene's "video", and re-render.` : "",
          failed.length ? `**Measured failures:**\n- ${failed.map((f) => `${f.check}: ${f.detail}`).join("\n- ")}` : "**All measured checks pass.**",
          p.checks.auto.length ? `**Suggested fixes:** ${p.checks.auto.map((a) => `scene ${a.scene + 1} → ${a.fix === "dim" ? "raise dim to ~0.9" : a.fix === "slow_down" ? "make it ~30% longer or cut words" : a.fix === "rewrite_code" ? `fix code (${a.detail})` : "replace image"}`).join("; ")}` : "",
          `**Frames below** at ${frames.map((f) => `${f.t}s (scene ${f.scene + 1})`).join(", ")}. Review them like a ruthless creative director (thumb-stop, readability, polish, variety, brand fit), fix, and re-render until it's ≥85.`,
        ].filter(Boolean).join("\n\n");
        return { content: [{ type: "text" as const, text }, ...images, { type: "text" as const, text: JSON.stringify({ spec: { ...p.spec, captions: undefined }, checks: p.checks.checks }) }] };
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "render_post_image",
    {
      title: "Render post graphics / carousel slides (homemade designer)",
      description:
        "Renders a graphic spec into PNGs — one per scene (a single post = 1 scene, a carousel = up to 10). Use code scenes for fully custom designs (illustrations, infographics, typography) or image scenes for real photos with headlines. Returns the images for you to review, measured contrast, and permanent links.",
      inputSchema: { spec: z.record(z.any()).describe("Same format as video spec; width/height default 1080x1350") },
    },
    async ({ spec }) => {
      try {
        const r = await produceStills(spec as any);
        const { permanent } = links({ width: 1080, height: 1350, ...(spec as any) }, "i");
        const low = r.render.text_boxes.filter((b) => (b.contrast ?? 99) < 4.5);
        const imgs = await Promise.all(r.images.slice(0, 10).map(async (png) => ({ type: "image" as const, data: await thumb(png, 432), mimeType: "image/jpeg" })));
        const urls = permanent ? r.images.map((_, i) => `${permanent}?n=${i + 1}`) : [];
        return {
          content: [
            { type: "text" as const, text: [`## 🖼️ ${r.images.length} graphic(s) at ${r.spec.width}x${r.spec.height}`, urls.length ? `**Permanent PNG links:**\n${urls.map((u, i) => `${i + 1}. ${u}`).join("\n")}` : "", r.render.code_errors.length ? `**Code errors:** ${r.render.code_errors.map((c) => `scene ${c.scene + 1}: ${c.sample}`).join("; ")}` : "", low.length ? `**Low contrast:** ${low.map((b) => `slide ${b.scene + 1} ${b.contrast}:1`).join(", ")} — raise dim or change colors.` : "**Contrast OK on all text.**", r.render.missing_assets.length ? `**Images failed to load:** ${r.render.missing_assets.join(", ")}` : ""].filter(Boolean).join("\n\n") },
            ...imgs,
          ],
        };
      } catch (e) {
        return fail(e);
      }
    }
  );


  // ================= Homemade AI video generation (open models on your own free GPU worker) =================
  const workerArg = z.string().optional().describe("Worker link printed by worker/hype_video_worker.ipynb, e.g. https://abc.trycloudflare.com?token=… (or set VIDEO_WORKER_URL)");
  const noWorker = () => ({ isError: true, content: [{ type: "text" as const, text: "No video worker connected. Open worker/hype_video_worker.ipynb on Kaggle (GPU T4 x2, Internet on) or Colab (T4), Run all, and paste the printed link here as `worker`." }] });

  server.registerTool(
    "video_worker_status",
    { title: "Check the AI video worker", description: "Checks the homemade GPU worker (open video model on free Kaggle/Colab): GPU, model, queue.", inputSchema: { worker: workerArg } },
    async ({ worker }) => {
      const w = parseWorker(worker);
      if (!w) return noWorker();
      try { const h = await workerHealth(w); return json(h, `✅ Worker online — ${h.model} on ${h.gpu || "CPU"}${h.vram_gb ? ` (${h.vram_gb} GB)` : ""}, ${h.queued} queued.`); }
      catch (e: any) { return { isError: true, content: [{ type: "text" as const, text: `Worker unreachable (${e?.message}). Is the notebook tab still running? Quick-tunnel links change every session.` }] }; }
    }
  );

  server.registerTool(
    "generate_clip",
    {
      title: "Generate AI video footage (homemade, open model)",
      description:
        "Text→video or image→video on your own GPU worker (LTX-Video or Wan 2.1, open source). Animate a real job photo (image_url), a graphic you coded (image_spec — rendered first, then animated), or generate from the prompt alone. Waits up to wait_s, then returns the clip URL (use it as a clip scene's `video` in render_video) or a job id for check_clip. Prompt like a cinematographer: subject, action, camera move, lighting, lens, mood — one continuous shot, 2-5s.",
      inputSchema: {
        worker: workerArg,
        prompt: z.string(),
        negative_prompt: z.string().optional(),
        image_url: z.string().optional().describe("Real photo to animate"),
        image_spec: z.record(z.any()).optional().describe("Graphic spec (render_post_image format, 1 scene) to render and then animate"),
        seconds: z.number().min(1).max(8).optional().describe("Default 4"),
        aspect: z.enum(["9:16", "4:5", "1:1", "16:9"]).optional(),
        steps: z.number().int().min(4).max(60).optional(),
        seed: z.number().int().optional(),
        wait_s: z.number().min(0).max(240).optional().describe("How long to wait for it (default 200)"),
      },
    },
    async (a) => {
      const w = parseWorker(a.worker);
      if (!w) return noWorker();
      try {
        const size = clipSize(a.aspect || "9:16");
        let image_b64: string | undefined;
        if (a.image_spec) {
          const st = await produceStills({ ...(a.image_spec as any), width: size.width * 2, height: size.height * 2 });
          image_b64 = st.images[0]?.toString("base64");
        }
        const id = await submitClip(w, { prompt: a.prompt, negative_prompt: a.negative_prompt, image_url: a.image_url, image_b64, seconds: a.seconds ?? 4, steps: a.steps, seed: a.seed, ...size });
        const res = (await waitClips(w, [id], (a.wait_s ?? 200) * 1000)).get(id);
        if (res?.status === "done") return json({ id, ...res }, `🎞️ Clip ready in ${res.seconds}s: ${res.url}\nUse it in render_video as {"type":"clip","video":"${res.url}","text":"..."} (the worker serves it while the notebook runs — render the final MP4 before closing it).`);
        if (res?.status === "error") return { isError: true, content: [{ type: "text" as const, text: `Generation failed: ${res.error}` }] };
        return json({ id, ...res }, `⏳ Still generating (${Math.round((res?.progress || 0) * 100)}%). Job ${id} — call check_clip.`);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "check_clip",
    { title: "Check an AI clip job", description: "Polls a generate_clip job; returns the clip URL when done.", inputSchema: { worker: workerArg, id: z.string(), wait_s: z.number().min(0).max(240).optional() } },
    async ({ worker, id, wait_s }) => {
      const w = parseWorker(worker);
      if (!w) return noWorker();
      try {
        const r = (await waitClips(w, [id], (wait_s ?? 120) * 1000)).get(id)!;
        return json({ id, ...r }, r.status === "done" ? `🎞️ Ready: ${r.url}` : r.status === "error" ? `❌ ${r.error}` : `⏳ ${r.status} ${Math.round((r.progress || 0) * 100)}%`);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "content_plan",
    {
      title: "Build a content calendar",
      description: "Creates a brand-specific posting calendar (formats, pillars, angles, hooks). Feed any row's topic into create_post.",
      inputSchema: {
        brand: brandArg,
        platform: platformEnum.default("instagram"),
        days: z.number().int().min(3).max(31).default(14),
        posts_per_week: z.number().int().min(1).max(14).default(4),
      },
    },
    async (a) => {
      if (!serverLLM) return needBrain("content_plan");
      try {
        const brand = await resolveBrand(a.brand);
        const plan = await contentPlan(brand, a.platform as Platform, a.days, a.posts_per_week);
        return json(
          plan,
          plan.plan.map((p) => `Day ${p.day} · ${p.format} · ${p.pillar} — "${p.hook}"`).join("\n")
        );
      } catch (e) {
        return fail(e);
      }
    }
  );


  server.registerTool(
    "make_video",
    {
      title: "Make a real MP4 video (coded motion graphics + AI footage + voiceover), then watch it and fix it",
      description:
        "Directs, codes, renders and QA's an actual vertical video. The agent writes a scene timeline and programs custom animations (canvas code run in a sandbox), generates photos, optionally animates them into AI footage (FAL_KEY), adds voiceover with word-by-word captions (ELEVENLABS_API_KEY or TTS_*), music, transitions and a CTA end card, and renders MP4 with ffmpeg. Then it watches its own render: measures text contrast on real pixels, safe zones, reading speed, blank frames, code crashes, has a vision model review frames, scores the creative, auto-fixes and re-renders until it passes. Returns the MP4 URL, cover, frame contact sheet, scorecard and the editable spec (pass it to render_video_spec to tweak).",
      inputSchema: {
        brand: brandArg,
        platform: platformEnum.default("instagram"),
        topic: z.string().optional().describe("What the video is about / the offer"),
        style: z.enum(["motion", "code", "mixed"]).optional().describe("motion = pro templates, code = mostly custom-coded animations, mixed (default) = both"),
        seconds: z.number().min(6).max(90).optional(),
        quality: z.enum(["draft", "standard", "hd"]).optional().describe("draft 540p (fast), standard 720p (default), hd 1080p"),
        voiceover: z.boolean().optional().describe("Default: on if a TTS key is configured"),
        voice: z.string().optional().describe("ElevenLabs voice id or OpenAI voice name"),
        ai_clips: z.number().int().min(0).max(4).optional().describe("How many scenes to turn into AI-generated footage (needs FAL_KEY)"),
        music: z.enum(["pulse", "ambient", "none"]).optional().describe("Generated royalty-free bed. Tip: 'none' and add trending audio in-app for reach"),
        min_score: z.number().min(0).max(100).optional(),
        max_rounds: z.number().int().min(0).max(3).optional().describe("Watch-and-fix rounds (default 2)"),
        post: z.record(z.any()).optional().describe("Optional: the `best` object from create_post to adapt into the video"),
        effort: z.enum(["fast", "standard", "max"]).optional().describe("max = HD, 3 watch-and-fix rounds, bar 88"),
        extra_context: z.string().optional(),
      },
    },
    async (a) => {
      if (!serverLLM) return needBrain("make_video");
      try {
        const brand = await resolveBrand(a.brand, a.extra_context);
        const preset = a.effort === "max" ? { quality: "hd", max_rounds: 3, min_score: 88 } : a.effort === "fast" ? { quality: "draft", max_rounds: 0 } : {};
        const r = await makeVideo({ ...preset, ...Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)), brand, platform: a.platform as Platform } as any);
        const sc = r.scorecard;
        const summary = [
          `## 🎬 ${r.duration}s ${PLATFORMS[a.platform as Platform].label} video — ${sc.score}/100 (${sc.verdict})${r.passed_threshold ? " ✅" : " ⚠️"}`,
          `**Video:** ${r.video_url}`,
          r.cover_url ? `**Cover:** ${r.cover_url}` : "",
          r.contact_sheet_url ? `**Frames it reviewed:** ${r.contact_sheet_url}` : "",
          `**Scores:** creative ${sc.creative} · technical ${sc.technical} · visual ${sc.visual ?? "n/a"}`,
          `**Self-QA rounds:** ${r.rounds.map((x) => `#${x.round} ${x.score}${x.notes.length ? ` (${x.notes.join("; ")})` : ""}`).join(" → ")}`,
          r.caption ? `**Caption:** ${r.caption}\n${(r.hashtags || []).join(" ")}` : "",
          `**Scenes:** ${r.spec.scenes.map((s, i) => `${i + 1}.${s.type}${s.code ? "(coded)" : ""} ${s.text ? `"${s.text}"` : s.value || ""}`).join(" | ")}`,
          sc.fixes.length && !r.passed_threshold ? `**Open issues:**\n- ${sc.fixes.slice(0, 5).join("\n- ")}` : "",
          r.warnings.length ? `**Notes:**\n- ${r.warnings.join("\n- ")}` : "",
        ].filter(Boolean).join("\n\n");
        return json(r, summary);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "render_video_spec",
    {
      title: "Re-render an edited video spec",
      description:
        "Takes a spec (from make_video) that you or Claude edited — change text, timing, colors, transitions, or write/modify `code` scenes — and renders + QA's it again. Code scenes API:\n" + SANDBOX_API_DOC,
      inputSchema: {
        spec: z.record(z.any()),
        brand: brandArg.optional(),
        platform: platformEnum.default("instagram"),
        quality: z.enum(["draft", "standard", "hd"]).optional(),
        max_rounds: z.number().int().min(0).max(3).optional().describe("Default 0 = render exactly as given"),
      },
    },
    async (a) => {
      try {
        const brand = a.brand ? await resolveBrand(a.brand) : { name: (a.spec as any).brand_name };
        const r = await makeVideo({ brand, platform: a.platform as Platform, spec: a.spec as any, quality: a.quality, max_rounds: a.max_rounds ?? 0, voiceover: false });
        return json(r, `🎬 ${r.video_url}\nScore ${r.scorecard.score}/100 · frames: ${r.contact_sheet_url || "-"}`);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "render_reel",
    {
      title: "Animate reel keyframes into video clips",
      description:
        "Low-level: start fal image-to-video jobs for individual keyframes (needs FAL_KEY). Prefer make_video, which does this automatically and assembles the finished MP4.",
      inputSchema: {
        clips: z
          .array(z.object({ image_url: z.string(), motion: z.string().describe("camera/subject motion, e.g. 'slow push-in as water gushes from downspout'"), seconds: z.number().optional() }))
          .min(1)
          .max(8),
      },
    },
    async ({ clips }) => {
      try {
        const jobs = await Promise.all(clips.map(async (c, i) => ({ beat: i + 1, ...(await startVideoClip(c.image_url, c.motion, c.seconds)) })));
        return json({ jobs }, `Started ${jobs.filter((j) => j.request_id).length}/${jobs.length} clip renders. Poll each with check_render.`);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "check_render",
    {
      title: "Check a video clip render",
      description: "Polls a render_reel job. Returns status and the video URL when done.",
      inputSchema: { status_url: z.string(), response_url: z.string() },
    },
    async ({ status_url, response_url }) => {
      try {
        return json(await checkVideo(status_url, response_url));
      } catch (e) {
        return fail(e);
      }
    }
  );

  return server;
}
