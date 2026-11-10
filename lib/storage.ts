// Where rendered videos/images go. Priority: Vercel Blob → Supabase Storage → this server's /api/files (temporary).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const TMP = path.join(process.env.TMPDIR || "/tmp", "hype");

export function storageMode() {
  if (process.env.BLOB_READ_WRITE_TOKEN) return "vercel-blob";
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) return "supabase";
  return "temporary";
}

export async function publish(name: string, data: Buffer | string, contentType: string): Promise<{ url: string; storage: string }> {
  const buf = typeof data === "string" ? readFileSync(data) : data;
  const mode = storageMode();
  if (mode === "vercel-blob") {
    const { put } = await import("@vercel/blob");
    const r = await put(`hype/${name}`, buf, { access: "public", contentType, addRandomSuffix: true });
    return { url: r.url, storage: mode };
  }
  if (mode === "supabase") {
    const bucket = process.env.SUPABASE_BUCKET || "hype-media";
    const base = process.env.SUPABASE_URL!.replace(/\/$/, "");
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const res = await fetch(`${base}/storage/v1/object/${bucket}/${name}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, apikey: key, "Content-Type": contentType, "x-upsert": "true" },
      body: new Uint8Array(buf),
    });
    if (res.ok) return { url: `${base}/storage/v1/object/public/${bucket}/${name}`, storage: mode };
  }
  mkdirSync(TMP, { recursive: true });
  const safe = name.replace(/[^\w.-]/g, "_");
  writeFileSync(path.join(TMP, safe), buf);
  return { url: `${publicBase()}/api/files/${safe}`, storage: "temporary (lasts only while this server instance is warm — set BLOB_READ_WRITE_TOKEN)" };
}

export function publicBase() {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, "");
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return `http://localhost:${process.env.PORT || 3000}`;
}

export function readTemp(name: string): Buffer | null {
  const p = path.join(TMP, name.replace(/[^\w.-]/g, "_"));
  return existsSync(p) ? readFileSync(p) : null;
}
