// Image + video rendering. Providers, in priority order:
//   images: FAL_KEY (fal.ai Flux) → IMAGE_BASE_URL/IMAGE_API_KEY (OpenAI-compatible /images/generations) → Pollinations (keyless)
//   video:  FAL_KEY (image-to-video, async queue)

export interface RenderedImage {
  url: string;
  provider: string;
  prompt: string;
  width: number;
  height: number;
}

const NO_TEXT =
  " Photorealistic, natural light, shot on a full-frame camera, sharp focus, rich but true-to-life color. No text, no letters, no logos, no watermarks.";

export async function renderImage(prompt: string, size: { width: number; height: number }, seed?: number): Promise<RenderedImage> {
  const full = prompt.trim() + NO_TEXT;
  const fal = process.env.FAL_KEY;
  if (fal) {
    const model = process.env.FAL_IMAGE_MODEL || "fal-ai/flux/dev";
    const res = await fetch(`https://fal.run/${model}`, {
      method: "POST",
      headers: { Authorization: `Key ${fal}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: full, image_size: size, num_images: 1, seed, enable_safety_checker: true }),
      signal: AbortSignal.timeout(120_000),
    });
    if (res.ok) {
      const d = await res.json();
      const url = d?.images?.[0]?.url;
      if (url) return { url, provider: `fal:${model}`, prompt: full, ...size };
    }
  }
  const ib = process.env.IMAGE_BASE_URL;
  const ik = process.env.IMAGE_API_KEY;
  if (ib && ik) {
    const model = process.env.IMAGE_MODEL || "gpt-image-1";
    const sz = size.height > size.width ? "1024x1536" : size.width > size.height ? "1536x1024" : "1024x1024";
    const res = await fetch(`${ib.replace(/\/$/, "")}/images/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ik}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: full, size: sz, n: 1 }),
      signal: AbortSignal.timeout(150_000),
    });
    if (res.ok) {
      const d = await res.json();
      const item = d?.data?.[0];
      const url = item?.url || (item?.b64_json ? `data:image/png;base64,${item.b64_json}` : "");
      if (url) return { url, provider: `openai-compatible:${model}`, prompt: full, ...size };
    }
  }
  if (process.env.IMAGE_FALLBACK !== "pollinations") {
    throw new Error("No image generator configured. Homemade options: render_post_image with a coded graphic, or pass real photo URLs (your own job photos convert best).");
  }
  const s = seed ?? Math.floor(Math.random() * 1e9);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(full)}?width=${size.width}&height=${size.height}&seed=${s}&model=flux&nologo=true&enhance=true`;
  return { url, provider: "pollinations:flux (keyless)", prompt: full, ...size };
}

export interface VideoJob {
  beat: number;
  request_id?: string;
  status_url?: string;
  response_url?: string;
  error?: string;
}

export async function startVideoClip(imageUrl: string, motionPrompt: string, seconds = 5): Promise<Omit<VideoJob, "beat">> {
  const fal = process.env.FAL_KEY;
  if (!fal) return { error: "Set FAL_KEY to render video clips. Without it you still get the full shot list + keyframes." };
  const model = process.env.FAL_VIDEO_MODEL || "fal-ai/kling-video/v2.1/standard/image-to-video";
  const res = await fetch(`https://queue.fal.run/${model}`, {
    method: "POST",
    headers: { Authorization: `Key ${fal}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: motionPrompt,
      image_url: imageUrl,
      duration: seconds > 5 ? "10" : "5",
      aspect_ratio: "9:16",
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) return { error: `fal ${res.status}: ${(await res.text()).slice(0, 200)}` };
  const d = await res.json();
  return { request_id: d.request_id, status_url: d.status_url, response_url: d.response_url };
}

export async function checkVideo(status_url: string, response_url: string) {
  const fal = process.env.FAL_KEY;
  if (!fal) throw new Error("FAL_KEY not set");
  const h = { Authorization: `Key ${fal}` };
  const s = await (await fetch(status_url, { headers: h })).json();
  if (s.status !== "COMPLETED") return { status: s.status, queue_position: s.queue_position };
  const r = await (await fetch(response_url, { headers: h })).json();
  return { status: "COMPLETED", video_url: r?.video?.url };
}
