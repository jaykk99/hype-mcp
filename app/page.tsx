const tools = [
  ["research_brand", "Crawls the site, socials, YouTube and web search → brand profile (offer, audience pains, voice, pillars, gaps, banned claims)."],
  ["create_post", "Writes 3+ variants from different angles → benchmarks each → rewrites the winner until it clears the bar → renders + visually QA's images."],
  ["benchmark_content", "Scores any post 0–100 (yours or a competitor's) with concrete fixes."],
  ["content_plan", "Brand-specific calendar of reels, carousels and photos with hooks."],
  ["make_video", "Writes, codes and renders a real MP4: kinetic type, custom-coded animations, AI footage, voiceover with word-timed captions, music. Then watches its own frames and fixes them."],
  ["render_video_spec", "Edit any scene, timing, color or animation code and re-render."],
  ["render_reel / check_render", "Low-level AI clip jobs (needs FAL_KEY)."],
];
export default function Home() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "48px 20px", lineHeight: 1.55 }}>
      <h1 style={{ fontSize: 40, margin: 0 }}>Hype MCP</h1>
      <p style={{ opacity: 0.75 }}>A marketing agent you plug into Claude. Give it a company or channel — it studies it, makes posts, photos and reels, then grades and rewrites its own work until it passes.</p>
      <h3>Connect</h3>
      <pre style={{ background: "#16161d", padding: 16, borderRadius: 10, overflowX: "auto" }}>https://YOUR-DEPLOYMENT.vercel.app/api/mcp?key=YOUR_MCP_API_KEY</pre>
      <p style={{ opacity: 0.75 }}>Claude → Settings → Connectors → Add custom connector → paste the URL.</p>
      <h3>Tools</h3>
      <ul>{tools.map(([n, d]) => <li key={n} style={{ marginBottom: 8 }}><code>{n}</code> — {d}</li>)}</ul>
    </main>
  );
}
