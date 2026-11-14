// Audience & topic research: what real people search for, ask about, and actually watch.
// All keyless: Google + DuckDuckGo autocomplete, YouTube search results, Reddit (JSON, falling back to web search).
// The output is evidence the writer builds on, so content answers real questions instead of guessing.
import { webSearch } from "./research";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

async function get(url: string, timeoutMs = 10_000, accept = "*/*"): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: accept, "Accept-Language": "en-US,en;q=0.9" },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** Run async jobs with a concurrency cap (autocomplete endpoints throttle bursts). */
async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    })
  );
  return out;
}

// ---------------- autocomplete ----------------

export async function suggest(q: string): Promise<string[]> {
  const [g, d] = await Promise.all([
    get(`https://suggestqueries.google.com/complete/search?client=firefox&hl=en&q=${encodeURIComponent(q)}`, 6000),
    get(`https://duckduckgo.com/ac/?type=list&q=${encodeURIComponent(q)}`, 6000),
  ]);
  const out: string[] = [];
  for (const raw of [g, d]) {
    try {
      const j = JSON.parse(raw || "null");
      if (Array.isArray(j) && Array.isArray(j[1])) out.push(...j[1].map(String));
      else if (Array.isArray(j)) out.push(...j.map((x: any) => String(x?.phrase || "")).filter(Boolean));
    } catch {}
  }
  return [...new Set(out.map((s) => s.toLowerCase().trim()))];
}

const QUESTION_PREFIXES = ["how", "why", "what", "when", "can", "should", "is", "does", "do i need"];
const QUESTION_SUFFIXES = ["cost", "price", "vs", "diy", "signs", "mistakes", "worth it", "near me", "how often", "problems", "tips", "best time"];

export type Intent = "cost" | "how_to" | "timing" | "problem" | "comparison" | "hiring" | "local" | "industry" | "other";

/** Queries from people in the trade (not customers): kept apart so posts aren't written for competitors. */
const INDUSTRY = /\b(business|businesses|start(ing)? an?|franchise|salary|jobs?|careers?|employment|how to become|make money|earn|income|how much to charge|charge per|pricing guide|software|for sale|bid|bidding|marketing|leads|license requirements?)\b/;

export function classifyIntent(q: string, location?: string): Intent {
  const s = q.toLowerCase();
  if (INDUSTRY.test(s)) return "industry";
  if (/\b(cost|price|prices|pricing|charge|how much|cheap|expensive|worth it|quote|estimate|\$)\b/.test(s)) return "cost";
  if (/\b(vs|versus|better|difference|compare|alternative)\b/.test(s)) return "comparison";
  if (/\b(when|how often|how long|season|winter|spring|summer|fall|autumn|best time|january|february|march|april|may|june|july|august|september|october|november|december)\b/.test(s)) return "timing";
  if (/\b(sign|signs|why|problem|problems|broken|leak|leaking|damage|stuck|not working|fail|mistake|mistakes|wrong|bad|smell|noise|clog|clogged)\b/.test(s)) return "problem";
  if (/\b(how to|diy|yourself|tips|guide|step|steps|tutorial|hack|tool|tools)\b/.test(s) || /^how\b/.test(s)) return "how_to";
  if (/\b(near me|best|company|companies|service|services|reviews|hire|contractor|professional|pro|licensed|insured)\b/.test(s)) return "hiring";
  const loc = (location || "").toLowerCase().split(/[,\s]+/).filter((w) => w.length > 3);
  if (loc.some((w) => s.includes(w))) return "local";
  return "other";
}

/** Question mining ("alphabet soup" over question words and buyer modifiers). */
export async function mineQuestions(seed: string, location?: string) {
  const s = seed.toLowerCase().trim();
  const city = (location || "").split(",")[0].trim().toLowerCase();
  const queries = [
    s,
    ...QUESTION_PREFIXES.map((p) => `${p} ${s}`),
    ...QUESTION_SUFFIXES.map((x) => `${s} ${x}`),
    ...(city ? [`${s} ${city}`, `${s} in ${city}`] : []),
  ];
  const lists = await pool(queries, 6, (q) => suggest(q));
  // Relevance: every meaningful seed word (by stem) must appear, so autocomplete drift ("how window cleaning") is dropped.
  const stems = s.split(/\s+/).filter((w) => w.length >= 4).map((w) => w.slice(0, Math.min(5, w.length - 1)));
  const relevant = (q: string) => stems.every((st) => q.includes(st));
  const bare = new Set(queries.filter((q) => q !== s));
  const seen = new Set<string>();
  const all: { q: string; intent: Intent; from: string }[] = [];
  lists.forEach((l, i) =>
    l.forEach((q) => {
      if (seen.has(q) || q === s || bare.has(q) || q.length < s.length + 3 || !relevant(q) || /\b(reddit|youtube|quora|tiktok|wikipedia|yelp|pdf)\b/.test(q)) return;
      seen.add(q);
      all.push({ q, intent: classifyIntent(q, location), from: queries[i] });
    })
  );
  const by: Record<string, string[]> = {};
  for (const x of all) (by[x.intent] ||= []).push(x.q);
  // Real questions (start with a question word, 4+ words) are the best post topics.
  const questions = all.filter((x) => x.intent !== "industry").filter((x) => /^(how|why|what|when|can|should|is|are|does|do|which|where|will)\b/.test(x.q) && x.q.split(" ").length >= 4).map((x) => x.q);
  return { queries_run: queries.length, total: all.length, by_intent: by, questions };
}

// ---------------- YouTube ----------------

export interface VideoHit {
  title: string;
  url: string;
  channel: string;
  views: number;
  age_years: number | null;
  views_per_year: number | null;
  length?: string;
  snippet?: string;
}

export function parseCount(s: string | undefined | null): number {
  if (!s) return 0;
  const m = String(s).replace(/,/g, "").match(/([\d.]+)\s*([KMB])?/i);
  if (!m) return 0;
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || "").toUpperCase() as "K" | "M" | "B"] || 1;
  return Math.round(parseFloat(m[1]) * mult);
}

export function parseAgeYears(s: string | undefined | null): number | null {
  if (!s) return null;
  const m = String(s).match(/(\d+)\s*(y|yr|year|mo|month|w|week|d|day|h|hour|min|minute)/i);
  if (!m) return null;
  const n = Number(m[1]);
  const u = m[2].toLowerCase();
  if (u.startsWith("y")) return n;
  if (u.startsWith("mo")) return n / 12;
  if (u.startsWith("w")) return n / 52;
  if (u.startsWith("d")) return n / 365;
  return n / 8760 / (u.startsWith("min") ? 60 : 1);
}

/** Extract the big JSON object assigned after `marker` in a page (YouTube's ytInitialData). */
export function extractJsonAfter(html: string, marker: string): any {
  const i = html.indexOf(marker);
  if (i < 0) return null;
  let j = html.indexOf("{", i);
  if (j < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let k = j; k < html.length; k++) {
    const ch = html[k];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try {
        return JSON.parse(html.slice(j, k + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Parse YouTube search results. Handles both the old videoRenderer and the newer lockupViewModel layouts. */
export function parseYouTubeResults(data: any): VideoHit[] {
  const out: VideoHit[] = [];
  const walk = (o: any) => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) return o.forEach(walk);
    if (o.videoRenderer) {
      const v = o.videoRenderer;
      const age = parseAgeYears(v.publishedTimeText?.simpleText);
      const views = parseCount(v.viewCountText?.simpleText || v.viewCountText?.runs?.map((r: any) => r.text).join(""));
      out.push({
        title: v.title?.runs?.map((r: any) => r.text).join("") || "",
        url: `https://www.youtube.com/watch?v=${v.videoId}`,
        channel: v.ownerText?.runs?.[0]?.text || "",
        views,
        age_years: age,
        views_per_year: age !== null ? Math.round(views / Math.max(age, 0.25)) : null,
        length: v.lengthText?.simpleText,
        snippet: v.detailedMetadataSnippets?.[0]?.snippetText?.runs?.map((r: any) => r.text).join(""),
      });
    }
    if (o.lockupViewModel && o.lockupViewModel.contentType === "LOCKUP_CONTENT_TYPE_VIDEO") {
      const lv = o.lockupViewModel;
      const md = lv.metadata?.lockupMetadataViewModel;
      const parts: string[] = (md?.metadata?.contentMetadataViewModel?.metadataRows || []).flatMap((r: any) =>
        (r.metadataParts || []).map((p: any) => p?.text?.content).filter(Boolean)
      );
      const viewsTxt = parts.find((p) => /^[\d.,]+\s*[KMB]?(\s*views?)?$/i.test(p.trim()) || /views?/i.test(p)) || "";
      const ageTxt = parts.find((p) => /\bago\b/i.test(p)) || "";
      const channel = (md?.image?.decoratedAvatarViewModel?.a11yLabel || "").replace(/^Go to channel\s*/i, "");
      const age = parseAgeYears(ageTxt);
      const views = parseCount(viewsTxt);
      const badge = JSON.stringify(lv.contentImage || {}).match(/"text":"(\d{1,2}:\d{2}(?::\d{2})?)"/)?.[1];
      out.push({
        title: md?.title?.content || "",
        url: `https://www.youtube.com/watch?v=${lv.contentId}`,
        channel,
        views,
        age_years: age,
        views_per_year: age !== null ? Math.round(views / Math.max(age, 0.25)) : null,
        length: badge,
        snippet: parts.find((p) => p.length > 40),
      });
    }
    for (const k in o) if (k !== "videoRenderer" && k !== "lockupViewModel") walk(o[k]);
  };
  walk(data);
  const seen = new Set<string>();
  return out.filter((v) => v.title && !seen.has(v.url) && seen.add(v.url));
}

export async function youtubeSearch(q: string): Promise<VideoHit[]> {
  const html = await get(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&hl=en&gl=US`, 12_000, "text/html");
  if (!html) return [];
  return parseYouTubeResults(extractJsonAfter(html, "ytInitialData"));
}

// ---------------- title patterns (what makes the winners click) ----------------

export const TITLE_PATTERNS: { key: string; label: string; re: RegExp }[] = [
  { key: "number", label: "Number / listicle (\"5 signs…\", \"3 mistakes…\")", re: /^\s*\d+|\b\d+\s+(signs|ways|mistakes|tips|things|reasons|steps|tools|hacks)\b/i },
  { key: "how_to", label: "How-to / tutorial", re: /\bhow (to|i|we)\b|\bguide\b|\btutorial\b/i },
  { key: "question", label: "Question title", re: /\?\s*$|^(why|what|is|are|should|can|does|do)\b/i },
  { key: "diy_saving", label: "DIY / saves money / cheap hack", re: /\bdiy\b|\bcheap(est)?\b|\bsave\b|\$\d+|\bdollar\b|\bhomemade\b|\bwithout\b/i },
  { key: "negative", label: "Warning / mistake / stop (loss aversion)", re: /\b(never|stop|don'?t|mistakes?|wrong|worst|avoid|warning|ruin(ed)?|disaster|fail(s|ed|ure)?|idiots?|dangerous)\b/i },
  { key: "transformation", label: "Before/after, deep clean, satisfying result", re: /\b(before|after|satisfying|transformation|deep clean(ed)?|restor(e|ation)|disgusting|gross|nasty|filthy|years|avalanche|sliding off|clearing)\b/i },
  { key: "price", label: "Price / cost reveal", re: /\b(cost|price|how much|charge|paid|earn|\$)\b/i },
  { key: "experiment", label: "Test / I tried / experiment", re: /\b(i tried|tested|test|experiment|vs\.?|versus|which is better|does it work)\b/i },
  { key: "pov_story", label: "Story / POV / day in the life", re: /\b(pov|day in the life|story|my first|i quit|i started|would you)\b/i },
  { key: "easy", label: "Easy / fast / no-skill promise", re: /\b(easy|easiest|quick|fast|simple|minutes|no ladder|from the ground|in \d+)\b/i },
];

export function titlePatterns(videos: VideoHit[]) {
  if (!videos.length) return [];
  // Weight each pattern by how well its videos actually perform (views per year), not just how common it is.
  const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
  const base = median(videos.map((v) => v.views_per_year ?? v.views));
  return TITLE_PATTERNS.map((p) => {
    const hits = videos.filter((v) => p.re.test(v.title));
    const perf = median(hits.map((v) => v.views_per_year ?? v.views));
    return {
      pattern: p.label,
      share: Math.round((hits.length / videos.length) * 100),
      lift: base ? Math.round((perf / base) * 10) / 10 : null,
      examples: hits.slice(0, 2).map((v) => v.title),
    };
  })
    .filter((p) => p.share > 0)
    .sort((a, b) => (b.lift ?? 0) * Math.sqrt(b.share) - (a.lift ?? 0) * Math.sqrt(a.share));
}

// ---------------- Reddit ----------------

export async function redditThreads(q: string, limit = 8) {
  const raw = await get(`https://www.reddit.com/search.json?q=${encodeURIComponent(q)}&sort=relevance&t=year&limit=${limit}`, 8000, "application/json");
  try {
    const j = JSON.parse(raw || "null");
    const posts = (j?.data?.children || []).map((c: any) => c.data).filter(Boolean);
    if (posts.length)
      return posts.map((p: any) => ({
        title: p.title,
        url: `https://www.reddit.com${p.permalink}`,
        subreddit: p.subreddit_name_prefixed,
        score: p.score,
        comments: p.num_comments,
        excerpt: String(p.selftext || "").replace(/\s+/g, " ").slice(0, 240),
      }));
  } catch {}
  // Reddit often blocks datacenter IPs; fall back to web search restricted to reddit.
  const hits = await webSearch(`site:reddit.com ${q}`, limit);
  return hits
    .filter((h) => /reddit\.com\/r\//.test(h.url))
    .map((h) => ({ title: h.title.replace(/\s*:\s*r\/\w+\s*$/i, "").replace(/\s*-\s*Reddit\s*$/i, ""), url: h.url, subreddit: h.url.match(/\/r\/(\w+)/)?.[0]?.slice(1) || "", score: null, comments: null, excerpt: h.snippet.slice(0, 240) }));
}

// ---------------- season & calendar ----------------

const SOUTH = /\b(australia|new zealand|nz|south africa|argentina|chile|brazil|uruguay|sydney|melbourne|brisbane|perth|auckland|cape town|johannesburg|buenos aires|santiago)\b/i;

export function seasonalContext(location = "", now = new Date()) {
  const m = now.getMonth();
  const south = SOUTH.test(location);
  const seasons = ["winter", "winter", "spring", "spring", "spring", "summer", "summer", "summer", "fall", "fall", "fall", "winter"];
  const season = seasons[south ? (m + 6) % 12 : m];
  const canada = /\b(canada|manitoba|ontario|alberta|quebec|british columbia|saskatchewan|nova scotia|winnipeg|toronto|calgary|edmonton|vancouver|ottawa|montreal|steinbach|regina|saskatoon|halifax)\b/i.test(location);
  const uk = /\b(uk|united kingdom|england|scotland|wales|london|manchester|birmingham|glasgow)\b/i.test(location);
  const y = now.getFullYear();
  const nthDow = (month: number, dow: number, n: number) => {
    const d = new Date(y, month, 1);
    const off = (dow - d.getDay() + 7) % 7;
    return new Date(y, month, 1 + off + (n - 1) * 7);
  };
  const lastDow = (month: number, dow: number) => {
    const d = new Date(y, month + 1, 0);
    return new Date(y, month, d.getDate() - ((d.getDay() - dow + 7) % 7));
  };
  const events: { name: string; date: Date }[] = [
    { name: "New Year", date: new Date(y, 0, 1) },
    { name: "Valentine's Day", date: new Date(y, 1, 14) },
    { name: uk ? "Mother's Day (UK)" : "Mother's Day", date: uk ? new Date(y, 2, 30) : nthDow(4, 0, 2) },
    { name: "Father's Day", date: nthDow(5, 0, 3) },
    { name: "Back to school", date: new Date(y, 8, 1) },
    { name: "Halloween", date: new Date(y, 9, 31) },
    { name: "Black Friday", date: new Date(nthDow(10, 4, 4).getTime() + 86400_000) },
    { name: "Small Business Saturday", date: new Date(nthDow(10, 4, 4).getTime() + 2 * 86400_000) },
    { name: "Christmas", date: new Date(y, 11, 25) },
    { name: "Boxing Day", date: new Date(y, 11, 26) },
    ...(canada
      ? [{ name: "Canada Day", date: new Date(y, 6, 1) }, { name: "Thanksgiving (Canada)", date: nthDow(9, 1, 2) }, { name: "Victoria Day", date: lastDow(4, 1) }]
      : uk
      ? [{ name: "Bonfire Night", date: new Date(y, 10, 5) }]
      : [{ name: "Memorial Day", date: lastDow(4, 1) }, { name: "4th of July", date: new Date(y, 6, 4) }, { name: "Labor Day", date: nthDow(8, 1, 1) }, { name: "Thanksgiving (US)", date: nthDow(10, 4, 4) }]),
  ];
  const day = 86400_000;
  const upcoming = events
    .flatMap((e) => [e, { name: e.name, date: new Date(e.date.getFullYear() + 1, e.date.getMonth(), e.date.getDate()) }])
    .map((e) => ({ name: e.name, in_days: Math.round((e.date.getTime() - now.getTime()) / day) }))
    .filter((e) => e.in_days >= 0 && e.in_days <= 60)
    .sort((a, b) => a.in_days - b.in_days);
  return {
    today: now.toISOString().slice(0, 10),
    month: now.toLocaleString("en", { month: "long" }),
    season,
    hemisphere: south ? "southern" : "northern",
    upcoming_events: upcoming,
    timing_tip: `Post 2-3 weeks ahead of the moment people need it (the problem before the season, the gift before the holiday). It's ${season}: what is about to go wrong, get expensive, or get booked up?`,
  };
}

// ---------------- ideas ----------------

const isQuestion = (q: string) => /^(how|why|what|when|can|should|is|are|does|do|which|where|will)\b/.test(q);
const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
const asQuestion = (q: string) => cap(q.replace(/\?$/, "")) + "?";

/** Starter hooks: the real question verbatim when it is one (formula: "real customer question, answered"), else a clean template. */
export function starterHook(intent: Intent, q: string, topic: string, city?: string): string {
  const T = cap(topic);
  if (isQuestion(q) && q.split(" ").length <= 10) return asQuestion(q);
  switch (intent) {
    case "cost": return `What ${topic} *actually* costs${city ? ` in ${city}` : ""}`;
    case "problem": return `3 signs you need ${topic} *now*`;
    case "how_to": return `${T}: the step most people *skip*`;
    case "timing": return `The *right* month for ${topic}${city ? ` in ${city}` : ""}`;
    case "comparison": return `${asQuestion(q)} The *honest* answer`;
    case "hiring": return `What a ${topic} pro checks *first*`;
    case "local": return `${T} in ${city || "your town"}: what to *know*`;
    default: return `${T}: what nobody *tells* you`;
  }
}

const FORMAT_FOR_INTENT: Record<Intent, { quick_video: string; angle: string }> = {
  cost: { quick_video: "price", angle: "price transparency" },
  problem: { quick_video: "three_signs", angle: "listicle: 3 signs" },
  how_to: { quick_video: "problem_fix", angle: "quick how-to tip" },
  timing: { quick_video: "pov", angle: "urgency / seasonal timing" },
  comparison: { quick_video: "myth_fact", angle: "myth-bust" },
  hiring: { quick_video: "problem_fix", angle: "behind-the-scenes / how we do it" },
  local: { quick_video: "service_area", angle: "local / service area" },
  industry: { quick_video: "problem_fix", angle: "behind-the-scenes / how we do it" },
  other: { quick_video: "problem_fix", angle: "pain point → fix" },
};

// ---------------- main ----------------

export interface ContentResearch {
  topic: string;
  location?: string;
  season: ReturnType<typeof seasonalContext>;
  audience_questions: { total: number; top_questions: string[]; by_intent: Record<string, string[]> };
  youtube: { searched: string[]; top_by_velocity: VideoHit[]; title_patterns: ReturnType<typeof titlePatterns> };
  reddit: Awaited<ReturnType<typeof redditThreads>>;
  ideas: { topic: string; intent: Intent; why: string; quick_video_format: string; angle: string; starter_hook: string }[];
  sources: string[];
}

const cache = new Map<string, { at: number; r: ContentResearch }>();

export async function researchContent(params: { topic: string; location?: string; depth?: "quick" | "deep"; now?: Date }): Promise<ContentResearch> {
  const topic = params.topic.trim();
  const location = params.location?.trim() || undefined;
  const key = `${topic}|${location || ""}|${params.depth || "quick"}`.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.r;

  const city = location?.split(",")[0].trim();
  const ytQueries = [topic, ...(params.depth === "deep" ? [`${topic} tips`, `${topic} mistakes`, `${topic} shorts`] : [`${topic} tips`])];
  const [qs, ytLists, reddit] = await Promise.all([
    mineQuestions(topic, location),
    Promise.all(ytQueries.map((q) => youtubeSearch(q))),
    redditThreads(city ? `${topic} ${city}` : topic, 8).then(async (r) => (r.length >= 3 || !city ? r : [...r, ...(await redditThreads(topic, 8))])),
  ]);
  const vids = ytLists.flat().filter((v, i, a) => a.findIndex((x) => x.url === v.url) === i);
  const top = [...vids].sort((a, b) => (b.views_per_year ?? b.views) - (a.views_per_year ?? a.views)).slice(0, 12);

  // Rank questions: questions first, then anything with a buyer/problem intent. Local ones get a boost.
  const priority: Intent[] = ["cost", "problem", "timing", "how_to", "comparison", "local", "hiring", "other"];
  const ranked = (list: string[]) => [...list].sort((a, b) => Number(isQuestion(b)) - Number(isQuestion(a)) || Math.abs(a.split(" ").length - 6) - Math.abs(b.split(" ").length - 6));
  const buckets = priority.map((i) => ranked(qs.by_intent[i] || []));
  const interleaved: string[] = [];
  for (let k = 0; interleaved.length < 40 && buckets.some((b) => b[k]); k++) for (const b of buckets) if (b[k]) interleaved.push(b[k]);
  const topQuestions = [...new Set(interleaved)].slice(0, 25);

  // One idea per intent bucket (variety), seeded by the strongest real query in it.
  const ideas: ContentResearch["ideas"] = [];
  for (const intent of priority) {
    const list = ranked(qs.by_intent[intent] || []);
    const q = list[0];
    if (!q) continue;
    const f = FORMAT_FOR_INTENT[intent];
    ideas.push({
      topic: q,
      intent,
      why: `Real search query (${list.length} related in the "${intent}" bucket)`,
      quick_video_format: f.quick_video,
      angle: f.angle,
      starter_hook: starterHook(intent, q, topic, city),
    });
  }
  const latin = (t: string) => (t.match(/[\u0000-\u024f]/g) || []).length / Math.max(1, t.length) > 0.9;
  for (const v of top.filter((v) => latin(v.title)).slice(0, 3)) {
    const T = cap(topic);
    const pat = TITLE_PATTERNS.find((p) => ["transformation", "negative", "number", "price", "easy", "how_to"].includes(p.key) && p.re.test(v.title))?.key;
    const hook = pat === "transformation" ? `${T}: before vs *after*` : pat === "negative" ? `Stop doing ${topic} *this* way` : pat === "number" ? `3 ${topic} mistakes to *avoid*` : pat === "price" ? `What ${topic} *actually* costs` : pat === "easy" || pat === "how_to" ? `${T}, the *fast* way` : `${T}: watch till the *end*`;
    if (ideas.some((i) => i.starter_hook === hook)) continue;
    ideas.push({
      topic: `Your local take on: "${v.title}"`,
      intent: "other",
      why: `${v.views.toLocaleString()} views${v.views_per_year ? ` (~${v.views_per_year.toLocaleString()}/yr)` : ""} on YouTube — proven demand; remake it with your own jobs, town and numbers`,
      quick_video_format: pat === "transformation" ? "before_after" : pat === "negative" || pat === "number" ? "three_signs" : pat === "price" ? "price" : "problem_fix",
      angle: "proven topic, local version",
      starter_hook: hook,
    });
  }

  const r: ContentResearch = {
    topic,
    location,
    season: seasonalContext(location, params.now),
    audience_questions: { total: qs.total, top_questions: topQuestions, by_intent: qs.by_intent },
    youtube: { searched: ytQueries, top_by_velocity: top, title_patterns: titlePatterns(vids) },
    reddit,
    ideas,
    sources: ["google autocomplete", "duckduckgo autocomplete", ...ytQueries.map((q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`), ...reddit.map((x: any) => x.url)],
  };
  cache.set(key, { at: Date.now(), r });
  return r;
}

/** Compact version for prompts (keeps token use small). */
export function researchBrief(r?: ContentResearch | null) {
  if (!r) return null;
  return {
    topic: r.topic,
    location: r.location,
    season: `${r.season.month}, ${r.season.season}${r.season.upcoming_events.length ? `; coming up: ${r.season.upcoming_events.map((e) => `${e.name} in ${e.in_days}d`).join(", ")}` : ""}`,
    real_customer_questions: r.audience_questions.top_questions.slice(0, 15),
    proven_titles: r.youtube.top_by_velocity.slice(0, 6).map((v) => `${v.title} (${v.views.toLocaleString()} views)`),
    winning_title_patterns: r.youtube.title_patterns.filter((p) => (p.lift ?? 0) >= 1).slice(0, 4).map((p) => `${p.pattern}${p.lift ? ` — ${p.lift}x median views/yr` : ""}`),
    underperforming_patterns: r.youtube.title_patterns.filter((p) => p.lift !== null && p.lift < 0.7).map((p) => p.pattern),
    community_threads: r.reddit.slice(0, 5).map((x: any) => x.title),
  };
}
