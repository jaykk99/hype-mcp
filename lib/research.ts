import { chatJson, models } from "./llm";
import { researchContent, researchBrief, suggest } from "./audience";

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
  real_photo_urls?: string[];
  verified_prices?: string[];
  customer_questions?: string[];
  facts?: SiteFacts;
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
  const fullText = decode(
    html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")
  ).replace(/\s+/g, " ");
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
    emails: [...new Set([...html.matchAll(/mailto:([^"'?\s>]+)/gi)].map((m) => decode(m[1])))].slice(0, 3),
    structured: parseJsonLd(html),
    images: extractImages(html, url),
    faqs: extractFaqs(html),
    prices: extractPrices(fullText),
  };
}

// ---------- structured facts ----------

export interface SiteFacts {
  types: string[];
  name?: string;
  telephone?: string;
  email?: string;
  address?: string;
  area_served: string[];
  price_range?: string;
  opening_hours: string[];
  rating?: { value: number; count: number };
  services: string[];
  faqs: { q: string; a: string }[];
  same_as: string[];
  founded?: string;
}

const txt = (v: any): string =>
  v == null ? "" : typeof v === "string" ? v : Array.isArray(v) ? v.map(txt).filter(Boolean).join(", ") : typeof v === "object" ? txt(v.name ?? v["@value"] ?? v.text ?? "") : String(v);

/** schema.org JSON-LD: the most reliable facts a site publishes (hours, phone, area served, rating, services, FAQ). */
export function parseJsonLd(html: string): SiteFacts {
  const facts: SiteFacts = { types: [], area_served: [], opening_hours: [], services: [], faqs: [], same_as: [] };
  const nodes: any[] = [];
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const j = JSON.parse(m[1].trim().replace(/^<!\[CDATA\[|\]\]>$/g, ""));
      const stack = [j];
      while (stack.length) {
        const n = stack.pop();
        if (!n || typeof n !== "object") continue;
        if (Array.isArray(n)) { stack.push(...n); continue; }
        nodes.push(n);
        if (n["@graph"]) stack.push(n["@graph"]);
        for (const k of ["mainEntity", "makesOffer", "hasOfferCatalog", "itemListElement", "itemOffered", "provider", "publisher"]) if (n[k]) stack.push(n[k]);
      }
    } catch {}
  }
  for (const n of nodes) {
    const types = ([] as string[]).concat(n["@type"] || []).map(String);
    facts.types.push(...types);
    const isOrg = types.some((t) => /Organization|Business|Service|Store|Restaurant|Contractor|Plumber|Electrician|Roofing|HVAC|Dentist|Attorney|Agent|Shop|Place/i.test(t));
    if (isOrg) {
      facts.name ||= txt(n.name) || undefined;
      facts.telephone ||= txt(n.telephone) || undefined;
      facts.email ||= txt(n.email) || undefined;
      facts.price_range ||= txt(n.priceRange) || undefined;
      facts.founded ||= txt(n.foundingDate) || undefined;
      if (n.address && !facts.address) {
        const a = n.address;
        facts.address = typeof a === "string" ? a : [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode, a.addressCountry].map(txt).filter(Boolean).join(", ");
      }
      for (const a of [].concat(n.areaServed || [])) facts.area_served.push(txt(a));
      for (const h of [].concat(n.openingHours || [])) facts.opening_hours.push(txt(h));
      for (const h of [].concat(n.openingHoursSpecification || []) as any[])
        facts.opening_hours.push(`${txt(h.dayOfWeek).replace(/https?:\/\/schema\.org\//g, "")} ${txt(h.opens)}-${txt(h.closes)}`);
      if (n.aggregateRating && !facts.rating) {
        const v = Number(n.aggregateRating.ratingValue), c = Number(n.aggregateRating.reviewCount || n.aggregateRating.ratingCount);
        if (v) facts.rating = { value: v, count: c || 0 };
      }
      for (const s of [].concat(n.sameAs || [])) facts.same_as.push(txt(s));
    }
    if (types.some((t) => /^(Service|Product|Offer)$/i.test(t)) && n.name) facts.services.push(txt(n.name) + (n.offers?.price || n.price ? ` (${txt(n.offers?.priceCurrency || n.priceCurrency)} ${txt(n.offers?.price || n.price)})` : ""));
    if (types.includes("Question") && n.name) facts.faqs.push({ q: txt(n.name), a: txt(n.acceptedAnswer?.text).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300) });
  }
  const uniq = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
  facts.types = uniq(facts.types).slice(0, 8);
  facts.area_served = uniq(facts.area_served).slice(0, 20);
  facts.opening_hours = uniq(facts.opening_hours).slice(0, 8);
  facts.services = uniq(facts.services).slice(0, 20);
  facts.same_as = uniq(facts.same_as).slice(0, 10);
  facts.faqs = facts.faqs.slice(0, 12);
  return facts;
}

/** Real photos on the site (for graphics and videos). Skips logos, icons, sprites, tracking pixels and SVGs. */
export function extractImages(html: string, pageUrl: string): string[] {
  const out: { url: string; score: number }[] = [];
  const add = (src: string | undefined, hint = "", w = 0) => {
    if (!src || src.startsWith("data:")) return;
    let u: string;
    try { u = new URL(decode(src.trim()), pageUrl).href; } catch { return; }
    if (!/^https?:/.test(u) || /\.(svg|gif|ico)(\?|$)/i.test(u)) return;
    if (/logo|icon|favicon|sprite|pixel|badge|avatar|placeholder|spinner|loader|emoji|flag|payment|visa|mastercard|1x1|blank/i.test(u + " " + hint)) return;
    if (w && w < 300) return;
    out.push({ url: u, score: (w || 600) + (/hero|banner|project|gallery|before|after|job|work|team|crew|portfolio/i.test(u + hint) ? 500 : 0) });
  };
  add(meta(html, "og:image"), "og", 1200);
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const attr = (n: string) => tag.match(new RegExp(`\\s${n}=["']([^"']+)["']`, "i"))?.[1];
    const srcset = attr("srcset") || attr("data-srcset");
    const best = srcset?.split(",").map((s) => s.trim().split(/\s+/)).sort((a, b) => parseInt(b[1] || "0") - parseInt(a[1] || "0"))[0]?.[0];
    add(best || attr("data-src") || attr("data-lazy-src") || attr("src"), `${attr("alt") || ""} ${attr("class") || ""}`, parseInt(attr("width") || "0"));
  }
  for (const m of html.matchAll(/background(?:-image)?\s*:\s*url\(["']?([^"')]+)["']?\)/gi)) add(m[1], "background", 800);
  const seen = new Set<string>();
  return out.sort((a, b) => b.score - a.score).map((o) => o.url).filter((u) => !seen.has(u.split("?")[0]) && seen.add(u.split("?")[0])).slice(0, 12);
}

/** Questions the site itself answers (FAQ sections, headings ending in "?"). */
export function extractFaqs(html: string): string[] {
  const qs = [...html.matchAll(/<(h[1-6]|summary|dt|button|strong)[^>]*>([\s\S]*?)<\/\1>/gi)]
    .map((m) => decode(m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()))
    .filter((q) => q.endsWith("?") && q.length > 10 && q.length < 160);
  return [...new Set(qs)].slice(0, 15);
}

/** Price mentions with their context, so real prices can be used (and invented ones caught). */
export function extractPrices(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/[^.!?\n]{0,70}(?:\$|£|€|CAD|USD)\s?\d[\d,]*(?:\.\d{2})?(?:\s?(?:-|–|to)\s?\$?\d[\d,]*)?[^.!?\n]{0,50}/g)) {
    const s = m[0].replace(/\s+/g, " ").trim();
    if (s.length > 8 && !out.some((o) => o.includes(s) || s.includes(o))) out.push(s);
    if (out.length >= 12) break;
  }
  return out;
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
        evidence.website = { ...page, images: undefined, structured: undefined, faqs: undefined, prices: undefined };
        sources.push(url);
        // Inner pages that hold the facts content is made from: services, pricing, FAQ, reviews, areas, gallery.
        const origin = new URL(url).origin;
        const PRIORITY = /pric|cost|rate|service|faq|question|review|testimonial|area|location|cities|about|gallery|project|portfolio|work|before|menu|product|shop|offer|special|promo|blog/i;
        let links = [...html.matchAll(/href=["']([^"'#]+)["']/gi)]
          .map((m) => { try { return new URL(decode(m[1]), origin).href.replace(/\/$/, ""); } catch { return ""; } })
          .filter((h) => h.startsWith(origin) && h !== url.replace(/\/$/, "") && !/\.(jpg|jpeg|png|webp|gif|svg|pdf|zip|css|js)(\?|$)|\/wp-(content|json|admin)|\/(cart|checkout|account|login|privacy|terms|cookie)/i.test(h));
        if (links.filter((h) => PRIORITY.test(h)).length < 3) {
          const sm = (await getText(`${origin}/sitemap.xml`, 6000)) || "";
          const locs = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => decode(m[1]).trim());
          const pageLocs = locs.filter((l) => !/sitemap.*\.xml/i.test(l));
          const child = locs.find((l) => /page.*sitemap|sitemap.*page/i.test(l));
          const more = child ? [...((await getText(child, 6000)) || "").matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => decode(m[1]).trim()) : [];
          links.push(...[...pageLocs, ...more].filter((l) => l.startsWith(origin)).map((l) => l.replace(/\/$/, "")));
        }
        const rank = (h: string) => { const m = h.match(PRIORITY); return m ? PRIORITY.source.split("|").findIndex((k) => new RegExp(k, "i").test(m[0])) : 99; };
        const inner = [...new Set(links)].filter((h) => PRIORITY.test(h) && !/\/blog\/.+\/.+/.test(h)).sort((a, b) => rank(a) - rank(b) || a.length - b.length).slice(0, 6);
        const pages = [page];
        const innerPages = await Promise.all(
          inner.map(async (u) => {
            const h = await getText(u, 8000);
            if (!h) return null;
            const p = extractPage(h, u);
            pages.push(p);
            sources.push(u);
            return { url: u, title: p.title, headings: p.headings.slice(0, 12), text: p.text.slice(0, 2200) };
          })
        );
        evidence.inner_pages = innerPages.filter(Boolean);
        // Merge the reliable facts across every crawled page.
        const merged = parseJsonLd("");
        for (const p of pages) {
          const f = p.structured;
          for (const k of ["name", "telephone", "email", "address", "price_range", "founded"] as const) (merged as any)[k] ||= (f as any)[k];
          merged.rating ||= f.rating;
          for (const k of ["types", "area_served", "opening_hours", "services", "same_as"] as const) merged[k] = [...new Set([...merged[k], ...f[k]])];
          merged.faqs.push(...f.faqs.filter((x) => !merged.faqs.some((y) => y.q === x.q)));
        }
        evidence.site_facts = merged;
        evidence.real_photo_urls = [...new Set(pages.flatMap((p) => p.images))].slice(0, 16);
        evidence.questions_site_answers = [...new Set([...merged.faqs.map((f) => f.q), ...pages.flatMap((p) => p.faqs)])].slice(0, 20);
        evidence.prices_on_site = [...new Set(pages.flatMap((p) => p.prices))].slice(0, 15);
        evidence.contact = { phones: [...new Set(pages.flatMap((p) => p.phones))].slice(0, 3), emails: [...new Set(pages.flatMap((p) => p.emails))].slice(0, 3) };
        const extraSocial = merged.same_as.filter((u) => /instagram|tiktok|facebook|youtube|linkedin|x\.com|twitter|threads/i.test(u));
        page.socials = [...new Set([...page.socials, ...extraSocial])];
        // Public social profiles' OG metadata (follower counts, bios).
        const socialMeta = await Promise.all(
          page.socials.slice(0, 5).map(async (s) => {
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
      const brandWords = name.replace(/[-_]+/g, " ");
      const [general, social, reviews, branded] = await Promise.all([
        webSearch(`${brandWords} ${url ? "" : "company"}`.trim(), 6),
        webSearch(`${brandWords} instagram OR tiktok OR facebook OR youtube`, 6),
        webSearch(`${brandWords} reviews`, 5),
        suggest(brandWords).catch(() => [] as string[]),
      ]);
      // What people type after the brand name: branded demand (reviews? price? a specific service?).
      if (branded.length) evidence.branded_searches = branded.slice(0, 10);
      if (reviews.length) evidence.review_mentions = reviews.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet }));
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
- site_facts (schema.org data the site publishes), prices_on_site and questions_site_answers are the most reliable evidence. Use them; never contradict them.
- proof_points: only verifiable things (years in business, rating + review count from site_facts, jobs shown in photos, certifications named on the site).
- offers_and_ctas: copy real prices and offers word-for-word from prices_on_site / pages. No price that isn't in the evidence.
- target_audience pains: phrase them the way customers would (use branded_searches and review_mentions for wording).
- content_gaps_and_opportunities: what their current content is missing that would win (be concrete).
Return JSON with exactly these keys: name, source_input, one_liner, what_they_sell[], location_or_market, target_audience[{segment,pains[],desires[]}], brand_voice{tone[],do[],dont[],sample_line}, visual_identity{colors[],style,imagery_subjects[]}, content_pillars[{name,why}], proof_points[], offers_and_ctas[], competitors_or_peers[], existing_content_observations[], content_gaps_and_opportunities[], banned_claims[], confidence ("low"|"medium"|"high").`,
      },
      { role: "user", content: `Research evidence (JSON):\n${JSON.stringify(evidence).slice(0, 24_000)}` },
    ],
    { model: models.writer(), temperature: 0.3, maxTokens: 3000 }
  );

  profile.source_input = input;
  profile.sources = [...new Set(sources)].slice(0, 20);
  // Deterministic facts go straight onto the profile (the writer and the invented-offer check both use them).
  if (evidence.site_facts) profile.facts = evidence.site_facts as SiteFacts;
  if (Array.isArray(evidence.real_photo_urls)) profile.real_photo_urls = evidence.real_photo_urls as string[];
  if (Array.isArray(evidence.prices_on_site) && evidence.prices_on_site.length) profile.verified_prices = evidence.prices_on_site as string[];
  // What customers actually ask about the main service, in this market.
  try {
    const topic = (profile.what_they_sell?.[0] || "").replace(/\(.*?\)/g, "").trim();
    if (topic) {
      const r = await researchContent({ topic, location: profile.location_or_market });
      profile.customer_questions = [...new Set([...((evidence.questions_site_answers as string[]) || []), ...r.audience_questions.top_questions])].slice(0, 20);
    }
  } catch {}
  cache.set(cacheKey, { at: Date.now(), profile });
  return profile;
}
