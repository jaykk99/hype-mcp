import { jsonrepair } from "jsonrepair";
// OpenAI-compatible chat client. Works with OmniRoute, OpenRouter, OpenAI, Groq, Together, etc.
// Configure with LLM_BASE_URL + LLM_API_KEY. Separate JUDGE_MODEL so the grader isn't the writer.

export type Msg =
  | { role: "system" | "user" | "assistant"; content: string }
  | { role: "user"; content: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> };

const env = (k: string, d = "") => process.env[k] || d;

export const models = {
  writer: () => env("LLM_MODEL", "gpt-4o-mini"),
  judge: () => env("JUDGE_MODEL") || env("LLM_MODEL", "gpt-4o-mini"),
  vision: () => env("VISION_MODEL"),
};

// Global concurrency limiter (LLM_CONCURRENCY, default 4) — free/cheap tiers rate-limit parallel calls.
let active = 0;
const waiters: (() => void)[] = [];
async function acquire() {
  const max = Number(process.env.LLM_CONCURRENCY || 4);
  if (active < max) { active++; return; }
  await new Promise<void>((r) => waiters.push(r));
  active++;
}
let lastStart = 0;
async function pace() {
  // Optional spacing for strict free tiers (e.g. LLM_MIN_INTERVAL_MS=46000 for keyless Pollinations).
  const gap = Number(process.env.LLM_MIN_INTERVAL_MS || 0);
  const wait = lastStart + gap - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastStart = Date.now();
}
function release() {
  active--;
  waiters.shift()?.();
}

export async function chat(
  messages: Msg[],
  opts: { model?: string; temperature?: number; json?: boolean; maxTokens?: number } = {}
): Promise<string> {
  await acquire();
  try {
    await pace();
    return await chatInner(messages, opts);
  } finally {
    release();
  }
}

async function chatInner(
  messages: Msg[],
  opts: { model?: string; temperature?: number; json?: boolean; maxTokens?: number } = {}
): Promise<string> {
  const base = env("LLM_BASE_URL", "https://api.openai.com/v1").replace(/\/$/, "");
  const key = env("LLM_API_KEY");
  if (!key) throw new Error("LLM_API_KEY is not set on the server.");
  const body: Record<string, unknown> = {
    model: opts.model || models.writer(),
    messages,
    temperature: opts.temperature ?? 0.8,
    max_tokens: Math.max(opts.maxTokens ?? 4000, Number(process.env.LLM_MIN_MAX_TOKENS || 0)),
  };
  if (opts.json) body.response_format = { type: "json_object" };

  let lastErr: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) {
        const t = await res.text();
        // Some providers reject response_format; retry once without it.
        if (res.status === 400 && /token limit|max_tokens|length/i.test(t) && Number(body.max_tokens) < 16000) {
          body.max_tokens = Math.min(16000, Number(body.max_tokens) * 2);
          continue;
        }
        if (res.status === 400 && body.response_format) {
          delete body.response_format;
          continue;
        }
        if (res.status === 429 || res.status === 402 || res.status >= 500) {
          lastErr = new Error(`LLM ${res.status}: ${t.slice(0, 200)}`);
          const ra = Number(t.match(/retry after (\d+)s/i)?.[1] || 0);
          await new Promise((r) => setTimeout(r, Math.max(ra * 1000 + 1000, 3000 * (attempt + 1))));
          continue;
        }
        throw new Error(`LLM ${res.status}: ${t.slice(0, 300)}`);
      }
      const data = await res.json();
      const out = data?.choices?.[0]?.message?.content;
      if (typeof out !== "string" || !out.trim()) throw new Error("LLM returned empty content");
      return out;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Pull the first JSON object out of a model reply (handles ```json fences and chatter). */
export function parseJson<T = any>(text: string): T {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {}
  const start = cleaned.indexOf("{");
  const body = start >= 0 ? cleaned.slice(start) : cleaned;
  try {
    return JSON.parse(body.slice(0, body.lastIndexOf("}") + 1));
  } catch {}
  try {
    // Handles truncated output, trailing commas, single quotes, unescaped newlines, comments.
    return JSON.parse(jsonrepair(body));
  } catch {
    throw new Error("Model did not return valid JSON: " + cleaned.slice(0, 200));
  }
}

export async function chatJson<T = any>(messages: Msg[], opts: Parameters<typeof chat>[1] = {}): Promise<T> {
  const raw = await chat(messages, { ...opts, json: true });
  try {
    return parseJson<T>(raw);
  } catch {}
  // Regenerate once from scratch (cheaper and more reliable than asking a model to fix broken JSON).
  const raw2 = await chat(messages, { ...opts, json: true, temperature: Math.min(opts.temperature ?? 0.8, 0.4) });
  try {
    return parseJson<T>(raw2);
  } catch {
    const fixed = await chat(
      [
        { role: "system", content: "Return ONLY valid minified JSON. No prose." },
        { role: "user", content: `Fix this into valid JSON:\n${raw.slice(0, 6000)}` },
      ],
      { ...opts, temperature: 0, json: true }
    );
    return parseJson<T>(fixed);
  }
}
