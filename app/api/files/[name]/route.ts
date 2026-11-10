import { readTemp } from "@/lib/storage";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const TYPES: Record<string, string> = { mp4: "video/mp4", jpg: "image/jpeg", png: "image/png", json: "application/json", mp3: "audio/mpeg" };
export async function GET(_req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  const buf = readTemp(name);
  if (!buf) return new Response("expired — files on temporary storage vanish when the server instance sleeps. Set BLOB_READ_WRITE_TOKEN.", { status: 404 });
  return new Response(new Uint8Array(buf), { headers: { "Content-Type": TYPES[name.split(".").pop() || ""] || "application/octet-stream", "Cache-Control": "public, max-age=3600" } });
}
