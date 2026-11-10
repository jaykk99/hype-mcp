import { chatJson, models } from "./llm";

const UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";

export interface BrandProfile {
  name: string;
  source_input: string;
  one_liner: string;
  what_they_sell: string[];
  location_or_market: string;
  target_audience: { segment: string; pains: string[]; desires: string[] }[];
  brand_voice: { tone: string[]; do: string[]; dont: string[]; sample_line: string };
  visual_identity: { colors: string[]; style: string; imagery_subjects: string[] };
  content_pillars: { name: string; why: string }[];
  proof_points: string[];
  offers_and_ctas: string[];
  competitors_or_peers: string[];
  existing_content_observations: string[];
  content_gaps_and_opportunities: string[];
  banned_claims: string[];
  confidence: "low" | "medium" | "high";
  sources: string[];
}

const cache = new Map<string, { at: number; profile: BrandProfile }>();

// ---------- fetch helpers ----------

async function getText(url: string, timeoutMs = 12_000): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,application/xml,*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return (await res.text()).slice(0, 600_000);
  } catch {
    return null;
  }
}

const decode = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");

function meta(html: string, name: string): string {
  const re = new RegExp(
    `<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["']`,
    "i"
  );
  const m = html.match(re);
  return decode((m?.[1] || m?.[2] || "").trim());
}

export function extractPage(html: string, url: string) {
  const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() || "");
  const headings = [...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)]
    .map((m) => decode(m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()))
    .filter((h) => h && h.length < 160)
    .slice(0, 25);
  const text = decode(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 7000);
  const socials = [
    ...new Set(
      [...html.matchAll(/https?:\/\/(?:www\.)?(instagram\.com|tiktok\.com|facebook\.com|youtube\.com|linkedin\.com|x\.com|twitter\.com|threads\.net)\/[^"'\s<>)]+/gi)].map(
        (m) => m[0].replace(/[\\]+$/, "")
      )
    ),
  ].slice(0, 12);
  const hexCounts = new Map<string, number>();
  for (const m of html.matchAll(/#([0-9a-f]{6})\b/gi)) {
    const h = "#" + m[1].toLowerCase();
    if (["#ffffff", "#000000"].includes(h)) continue;
    hexCounts.set(h, (hexCounts.get(h) || 0) + 1);
  }
  const colors = [meta(html, "theme-color"), ...[...hexCounts.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0])]
    .filter(Boolean)
    .slice(0, 6);
  const phones = [...new Set([...text.matchAll(/\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/g)].map((m) => m[0]))].slice(0, 3);
  return {
    url,
    title,
    description: meta(html, "description") || meta(html, "og:description"),
    og_title: meta(html, "og:title"),
    og_image: meta(html, "og:image"),
    site_name: meta(html, "og:site_name"),
    headings,
    text,
    socials,
    colors,
    phones,
  };
}

export async function webSearch(q: string, limit = 6): Promise<{ title: string; url: string; snippet: string }[]> {
  const fc = process.env.FIRECRAWL_API_KEY;
  if (fc) {
    try {
      const res = await fetch("https://api.firecrawl.dev/v1/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${fc}` },
        body: JSON.stringify({ query: q, limit }),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) {
        const d = await res.json();
        return (d.data || []).map((r: any) => ({ title: r.title || "", url: r.url || "", snippet: r.description || "" }));
      }
    } catch {}
  }
  const tav = process.env.TAVILY_API_KEY;
  if (tav) {
    try {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: tav, query: q, max_results: limit }),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) {
        const d = await res.json();
        return (d.results || []).map((r: any) => ({ title: r.title, url: r.url, snippet: r.content?.slice(0, 300) || "" }));
      }
    } catch {}
  }
  // Keyless fallback: DuckDuckGo HTML endpoint.
  const html = await getText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`);
  if (!html) return [];
  const out: { title: string; url: string; snippet: string }[] = [];
  const blocks = html.split(/class="result__body"/).slice(1);
  for (const b of blocks) {
    const a = b.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    let href = decode(a[1]);
    const uddg = href.match(/uddg=([^&]+)/);
    if (uddg) href = decodeURIComponent(uddg[1]);
    const sn = b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    out.push({
      title: decode(a[2].replace(/<[^>]+>/g, "")).trim(),
      url: href,
      snippet: decode((sn?.[1] || "").replace(/<[^>]+>/g, "")).trim(),
    });
    if (out.length >= limit) break;
  }
  return out;
}

async function youtubeRecent(input: string): Promise<{ channel: string; videos: string[] } | null> {
  let url = input;
  if (/^@[\w.-]+$/.test(input)) url = `https://www.youtube.com/${input}`;
  if (!/youtube\.com|youtu\.be/.test(url)) return null;
  const key = process.env.YOUTUBE_API_KEY;
  let channelId = url.match(/channel\/(UC[\w-]{22})/)?.[1];
  const handle = url.match(/youtube\.com\/(@[\w.-]+)/)?.[1];
  if (key && handle && !channelId) {
    try {
      const r = await fetch(
        `https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${encodeURIComponent(handle)}&key=${key}`
      );
      channelId = (await r.json())?.items?.[0]?.id;
    } catch {}
  }
  if (!channelId) {
    const html = await getText(url);
    channelId = html?.match(/"(?:channelId|externalId)":"(UC[\w-]{22})"/)?.[1];
  }
  if (!channelId) return null;
  const feed = await getText(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
  if (!feed) return null;
  const channel = decode(feed.match(/<title>([^<]+)<\/title>/)?.[1] || "");
  const videos = [...feed.matchAll(/<entry>[\s\S]*?<title>([^<]+)<\/title>[\s\S]*?<media:statistics views="(\d+)"/g)]
    .map((m) => `${decode(m[1])} (${Number(m[2]).toLocaleString()} views)`)
    .slice(0, 15);
  return { channel, videos };
}

function normalizeUrl(input: string): string | null {
  const s = input.trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(s) && !s.includes(" ")) return "https://" + s;
  return null;
}


/** Homemade crawler: website + inner pages + public social metadata + YouTube feed + web search. No keys required. */
export async function gatherEvidence(input: string, extra_context?: string) {
  const opts = { extra_context };
  const evidence: Record<string, unknown> = { input };
  const sources: string[] = [];

  const url = normalizeUrl(input);
  const isYT = /youtube\.com|youtu\.be/.test(input) || /^@[\w.-]+$/.test(input.trim());

  const tasks: Promise<void>[] = [];

  if (isYT) {
    tasks.push(
      youtubeRecent(input.trim()).then((yt) => {
        if (yt) {
          evidence.youtube = yt;
          sources.push(input);
        }
      })
    );
  }

  if (url && !isYT) {
    tasks.push(
      (async () => {
        const html = await getText(url);
        if (!html) return;
        const page = extractPage(html, url);
        evidence.website = page;
        sources.push(url);
        // Pull a couple of inner pages (about/services) for depth.
        const origin = new URL(url).origin;
        const inner = [...html.matchAll(/href=["']([^"'#]+)["']/gi)]
          .map((m) => {
            try {
              return new URL(m[1], origin).href;
            } catch {
              return "";
            }
          })
          .filter((h) => h.startsWith(origin) && /about|service|pricing|product|menu|shop|work|gallery/i.test(h))
          .filter((v, i, a) => a.indexOf(v) === i)
          .slice(0, 3);
        const innerPages = await Promise.all(
          inner.map(async (u) => {
            const h = await getText(u, 8000);
            if (!h) return null;
            const p = extractPage(h, u);
            sources.push(u);
            return { url: u, title: p.title, headings: p.headings.slice(0, 10), text: p.text.slice(0, 2000) };
          })
        );
        evidence.inner_pages = innerPages.filter(Boolean);
        // Try social profiles' public OG metadata (follower counts, bios).
        const socialMeta = await Promise.all(
          page.socials.slice(0, 4).map(async (s) => {
            const h = await getText(s, 8000);
            if (!h) return null;
            return { url: s, title: meta(h, "og:title"), description: meta(h, "og:description") || meta(h, "description") };
          })
        );
        evidence.social_profiles = socialMeta.filter((x) => x && (x.title || x.description));
      })()
    );
  }

  const name = url ? new URL(url).hostname.replace(/^www\./, "").split(".")[0] : input.trim();
  tasks.push(
    (async () => {
      const [general, social] = await Promise.all([
        webSearch(`${name} ${url ? "" : "company"}`.trim(), 6),
        webSearch(`${name} instagram OR tiktok OR facebook OR youtube`, 6),
      ]);
      evidence.search_results = [...general, ...social].filter(
        (r, i, a) => r.url && a.findIndex((x) => x.url === r.url) === i
      );
      for (const r of evidence.search_results as any[]) sources.push(r.url);
    })()
  );

  await Promise.all(tasks);
  if (opts.extra_context) evidence.owner_notes = opts.extra_context;
  return { evidence, sources: [...new Set(sources)] };
}

// ---------- main ----------

export async function researchBrand(
  input: string,
  opts: { extra_context?: string; refresh?: boolean } = {}
): Promise<BrandProfile> {
  const cacheKey = (input + "|" + (opts.extra_context || "")).toLowerCase().trim();
  const hit = cache.get(cacheKey);
  if (hit && !opts.refresh && Date.now() - hit.at < 6 * 3600_000) return hit.profile;

  const { evidence, sources } = await gatherEvidence(input, opts.extra_context);

  const profile = await chatJson<BrandProfile>(
    [
      {
        role: "system",
        content: `You are a senior brand strategist at a top social agency. From raw research evidence, build a precise brand profile that a content team can use to make scroll-stopping posts.
Rules:
- Only state facts the evidence supports. If something is a guess, say so in the field (e.g. "likely ...") and lower confidence.
- Be SPECIFIC: real service names, real towns, real price points, real phrases they use. Generic marketing fluff is a failure.
- banned_claims: claims the brand must NOT make because they aren't supported (e.g. "#1 in Canada", fake reviews, guarantees not offered).
- content_gaps_and_opportunities: what their current content is missing that would win (be concrete).
Return JSON with exactly these keys: name, source_input, one_liner, what_they_sell[], location_or_market, target_audience[{segment,pains[],desires[]}], brand_voice{tone[],do[],dont[],sample_line}, visual_identity{colors[],style,imagery_subjects[]}, content_pillars[{name,why}], proof_points[], offers_and_ctas[], competitors_or_peers[], existing_content_observations[], content_gaps_and_opportunities[], banned_claims[], confidence ("low"|"medium"|"high").`,
      },
      { role: "user", content: `Research evidence (JSON):\n${JSON.stringify(evidence).slice(0, 24_000)}` },
    ],
    { model: models.writer(), temperature: 0.3, maxTokens: 3000 }
  );

  profile.source_input = input;
  profile.sources = [...new Set(sources)].slice(0, 20);
  cache.set(cacheKey, { at: Date.now(), profile });
  return profile;
}
