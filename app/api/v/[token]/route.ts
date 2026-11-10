// Permanent video link: the URL carries the spec; the server re-renders on demand (and caches).
import { readFileSync } from "node:fs";
import { decodeSpec, produceVideo } from "@/lib/video/produce";
export const runtime = "nodejs";
export const maxDuration = 300;
export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await ctx.params;
    const spec = decodeSpec(token.replace(/\.mp4$/, ""));
    const p = await produceVideo(spec);
    return new Response(new Uint8Array(readFileSync(p.file)), {
      headers: { "Content-Type": "video/mp4", "Cache-Control": "public, max-age=31536000, immutable", "Content-Disposition": `inline; filename="${(p.spec.brand_name || "video").replace(/\W+/g, "-")}.mp4"` },
    });
  } catch (e: any) {
    return new Response("Could not render this link: " + (e?.message || e), { status: 400 });
  }
}
