// Permanent graphic link: ?n=2 picks a carousel slide (1-based).
import { decodeSpec, produceStills } from "@/lib/video/produce";
export const runtime = "nodejs";
export const maxDuration = 120;
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await ctx.params;
    const n = Math.max(1, Number(new URL(req.url).searchParams.get("n") || 1));
    const r = await produceStills(decodeSpec(token.replace(/\.png$/, "")));
    const img = r.images[Math.min(n, r.images.length) - 1];
    return new Response(new Uint8Array(img), { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=31536000, immutable" } });
  } catch (e: any) {
    return new Response("Could not render this link: " + (e?.message || e), { status: 400 });
  }
}
