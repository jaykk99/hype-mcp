// Client for the homemade Hype Video Worker (free Kaggle/Colab GPU running open video models).
export interface Worker { base: string; token: string }

export function parseWorker(input?: string): Worker | null {
  const raw = (input || process.env.VIDEO_WORKER_URL || "").trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const token = u.searchParams.get("token") || process.env.VIDEO_WORKER_TOKEN || "";
    return { base: `${u.protocol}//${u.host}`, token };
  } catch {
    return null;
  }
}

const q = (w: Worker) => `token=${encodeURIComponent(w.token)}`;

export async function workerHealth(w: Worker) {
  const r = await fetch(`${w.base}/health?${q(w)}`, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`worker ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

export interface ClipRequest {
  prompt: string;
  negative_prompt?: string;
  image_url?: string;
  image_b64?: string;
  width?: number;
  height?: number;
  seconds?: number;
  fps?: number;
  steps?: number;
  seed?: number;
}

export async function submitClip(w: Worker, req: ClipRequest): Promise<string> {
  const r = await fetch(`${w.base}/jobs?${q(w)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) throw new Error(`worker ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).id;
}

export async function clipStatus(w: Worker, id: string): Promise<{ status: string; progress?: number; error?: string; seconds?: number; url?: string }> {
  const r = await fetch(`${w.base}/jobs/${id}?${q(w)}`, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`worker ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const s = await r.json();
  return { ...s, url: s.status === "done" ? clipUrl(w, id) : undefined };
}

export const clipUrl = (w: Worker, id: string) => `${w.base}/jobs/${id}/video?${q(w)}`;

/** Poll until done/error or the wait budget runs out. */
export async function waitClips(w: Worker, ids: string[], maxMs: number) {
  const deadline = Date.now() + maxMs;
  const out = new Map<string, Awaited<ReturnType<typeof clipStatus>>>();
  while (Date.now() < deadline) {
    await Promise.all(
      ids.filter((id) => !out.has(id) || !["done", "error"].includes(out.get(id)!.status)).map(async (id) => {
        try { out.set(id, await clipStatus(w, id)); } catch (e: any) { out.set(id, { status: "unreachable", error: e?.message }); }
      })
    );
    if (ids.every((id) => ["done", "error"].includes(out.get(id)?.status || ""))) break;
    await new Promise((r) => setTimeout(r, 4000));
  }
  return out;
}

/** 9:16 sizes the open models handle well on a T4. */
export function clipSize(aspect: "9:16" | "4:5" | "1:1" | "16:9" = "9:16") {
  return { "9:16": { width: 480, height: 864 }, "4:5": { width: 576, height: 704 }, "1:1": { width: 640, height: 640 }, "16:9": { width: 864, height: 480 } }[aspect];
}
