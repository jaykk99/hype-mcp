"""
Hype Video Worker — homemade AI video generation on a free Kaggle/Colab GPU.

Open models (no API keys):
  ltx  (default) Lightricks LTX-Video — fast, text→video and image→video
  wan            Wan 2.1 T2V 1.3B     — slower, higher quality text→video
  mock           no GPU; makes test clips with ffmpeg (for testing the plumbing)

API (all routes need ?token=... or header X-Token):
  GET  /health                     → gpu, model, queue
  POST /jobs   {prompt, negative_prompt?, image_b64?|image_url?, width, height, seconds, fps, steps, seed}
               → {id}
  GET  /jobs/{id}                  → {status: queued|running|done|error, progress, error?, seconds?}
  GET  /jobs/{id}/video            → mp4
Jobs are async because Cloudflare quick tunnels cut responses at ~100s.
"""
import base64, io, os, queue, secrets, subprocess, threading, time, traceback, uuid, urllib.request

from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse

MODEL = os.environ.get("HYPE_MODEL", "ltx").lower()
TOKEN = os.environ.get("HYPE_TOKEN") or secrets.token_urlsafe(12)
OUT = os.environ.get("HYPE_OUT", "/tmp/hype_worker")
os.makedirs(OUT, exist_ok=True)

app = FastAPI(title="Hype Video Worker")
JOBS: dict = {}
Q: "queue.Queue[str]" = queue.Queue()
PIPE = {"t2v": None, "i2v": None, "info": {}}


def auth(token_q, token_h):
    if (token_q or token_h) != TOKEN:
        raise HTTPException(401, "bad token")


# ---------------------------------------------------------------- model loading
def load_models():
    if MODEL == "mock":
        PIPE["info"] = {"model": "mock (ffmpeg test clips)", "gpu": None}
        return
    import torch

    gpu = torch.cuda.get_device_name(0) if torch.cuda.is_available() else None
    if not gpu:
        raise RuntimeError("No GPU found. On Kaggle: Settings → Accelerator → GPU T4 x2 (or P100). On Colab: Runtime → Change runtime type → T4 GPU.")
    bf16 = torch.cuda.is_bf16_supported()
    dtype = torch.bfloat16 if bf16 else torch.float16  # T4/P100 have no fast bf16
    vram = torch.cuda.get_device_properties(0).total_memory / 1e9

    if MODEL == "wan":
        from diffusers import AutoencoderKLWan, WanPipeline

        mid = "Wan-AI/Wan2.1-T2V-1.3B-Diffusers"
        vae = AutoencoderKLWan.from_pretrained(mid, subfolder="vae", torch_dtype=torch.float32)
        pipe = WanPipeline.from_pretrained(mid, vae=vae, torch_dtype=dtype)
        pipe.enable_model_cpu_offload()
        PIPE["t2v"] = pipe
    else:
        from diffusers import LTXImageToVideoPipeline, LTXPipeline

        mid = os.environ.get("HYPE_LTX_ID", "Lightricks/LTX-Video")
        t2v = LTXPipeline.from_pretrained(mid, torch_dtype=dtype)
        t2v.enable_model_cpu_offload()
        t2v.vae.enable_tiling()
        # Share weights between text→video and image→video (no second download, no extra VRAM).
        i2v = LTXImageToVideoPipeline(**t2v.components)
        i2v.enable_model_cpu_offload()
        PIPE["t2v"], PIPE["i2v"] = t2v, i2v
    PIPE["info"] = {"model": MODEL, "gpu": gpu, "vram_gb": round(vram, 1), "dtype": str(dtype)}


# ---------------------------------------------------------------- generation
def snap(n, m):  # model-friendly sizes
    return max(m, int(round(n / m)) * m)


def frames_for(seconds, fps):
    n = int(seconds * fps)
    return (n // 8) * 8 + 1  # LTX & Wan want 8k+1 frames


def load_image(job):
    from PIL import Image

    if job.get("image_b64"):
        raw = base64.b64decode(job["image_b64"].split(",")[-1])
    elif job.get("image_url"):
        req = urllib.request.Request(job["image_url"], headers={"User-Agent": "hype-worker"})
        raw = urllib.request.urlopen(req, timeout=60).read()
    else:
        return None
    return Image.open(io.BytesIO(raw)).convert("RGB")


def run_job(jid):
    job = JOBS[jid]
    job["status"], job["started"] = "running", time.time()
    out = f"{OUT}/{jid}.mp4"
    try:
        fps = int(job.get("fps") or 24)
        secs = float(job.get("seconds") or 4)
        if MODEL == "mock":
            w, h = int(job.get("width") or 480), int(job.get("height") or 832)
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", f"testsrc2=size={w}x{h}:rate={fps}", "-t", str(secs), "-pix_fmt", "yuv420p", out], check=True)
            time.sleep(1.5)
        else:
            import torch
            from diffusers.utils import export_to_video

            wan = MODEL == "wan"
            w = snap(int(job.get("width") or (480 if wan else 512)), 16 if wan else 32)
            h = snap(int(job.get("height") or (832 if wan else 768)), 16 if wan else 32)
            n = frames_for(secs, 16 if wan else fps)
            steps = int(job.get("steps") or (25 if wan else 30))
            gen = torch.Generator("cuda").manual_seed(int(job.get("seed") or secrets.randbelow(2**31)))
            neg = job.get("negative_prompt") or "worst quality, blurry, jittery, distorted, deformed hands, warped face, text, watermark, logo"

            def cb(pipe, i, t, kw):
                job["progress"] = round((i + 1) / steps, 3)
                return kw

            args = dict(prompt=job["prompt"], negative_prompt=neg, width=w, height=h, num_frames=n,
                        num_inference_steps=steps, generator=gen, callback_on_step_end=cb)
            img = load_image(job)
            if img is not None and PIPE["i2v"] is not None:
                img = img.resize((w, h))
                frames = PIPE["i2v"](image=img, **args).frames[0]
            else:
                if wan:
                    args["guidance_scale"] = 5.0
                frames = PIPE["t2v"](**args).frames[0]
            export_to_video(frames, out, fps=16 if wan else fps)
            torch.cuda.empty_cache()
        job.update(status="done", progress=1.0, seconds=round(time.time() - job["started"], 1), file=out)
    except Exception as e:  # keep the worker alive no matter what
        job.update(status="error", error=f"{type(e).__name__}: {e}", trace=traceback.format_exc()[-1500:])


def loop():
    while True:
        jid = Q.get()
        run_job(jid)


# ---------------------------------------------------------------- routes
@app.get("/health")
def health(token: str = Query(None), x_token: str = Header(None)):
    auth(token, x_token)
    return {"ok": True, **PIPE["info"], "queued": Q.qsize(), "jobs": len(JOBS)}


@app.post("/jobs")
async def create(req: Request, token: str = Query(None), x_token: str = Header(None)):
    auth(token, x_token)
    body = await req.json()
    if not str(body.get("prompt", "")).strip():
        raise HTTPException(400, "prompt required")
    jid = uuid.uuid4().hex[:10]
    JOBS[jid] = {"status": "queued", "progress": 0.0, "created": time.time(), **{k: body.get(k) for k in
                 ["prompt", "negative_prompt", "image_b64", "image_url", "width", "height", "seconds", "fps", "steps", "seed"]}}
    Q.put(jid)
    return {"id": jid, "position": Q.qsize()}


@app.get("/jobs/{jid}")
def status(jid: str, token: str = Query(None), x_token: str = Header(None)):
    auth(token, x_token)
    j = JOBS.get(jid)
    if not j:
        raise HTTPException(404, "no such job (worker restarted?)")
    return JSONResponse({k: j.get(k) for k in ["status", "progress", "error", "seconds"]})


@app.get("/jobs/{jid}/video")
def video(jid: str, token: str = Query(None), x_token: str = Header(None)):
    auth(token, x_token)
    j = JOBS.get(jid)
    if not j or j.get("status") != "done":
        raise HTTPException(404, "not ready")
    return FileResponse(j["file"], media_type="video/mp4", filename=f"{jid}.mp4")


def start_background():
    load_models()
    threading.Thread(target=loop, daemon=True).start()


if __name__ == "__main__":
    import uvicorn

    start_background()
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 8765)))
