// Runs AI-written animation code inside QuickJS (WebAssembly) — a real sandbox: no fs, network, process, or host objects.
// The code draws on a *recording* ctx; each frame returns a JSON display list that the host replays onto the real canvas
// through a whitelist. A bug or prompt-injected payload can at worst draw ugly pixels.
import { getQuickJS, shouldInterruptAfterDeadline, type QuickJSContext } from "quickjs-emscripten";
import type { SKRSContext2D, Image } from "@napi-rs/canvas";

const PROPS = [
  "fillStyle", "strokeStyle", "lineWidth", "font", "textAlign", "textBaseline", "globalAlpha", "shadowColor",
  "shadowBlur", "shadowOffsetX", "shadowOffsetY", "lineCap", "lineJoin", "globalCompositeOperation", "letterSpacing",
];
const METHODS = [
  "save", "restore", "translate", "rotate", "scale", "beginPath", "closePath", "moveTo", "lineTo", "arc", "arcTo",
  "ellipse", "rect", "roundRect", "quadraticCurveTo", "bezierCurveTo", "fill", "stroke", "fillRect", "strokeRect",
  "clearRect", "fillText", "strokeText", "clip", "setLineDash", "drawImage", "setTransform", "resetTransform",
];
const COMPOSITE_OK = new Set(["source-over", "lighter", "multiply", "screen", "overlay", "destination-out", "source-atop", "darken", "lighten"]);

export const SANDBOX_API_DOC = `Write: function draw(ctx, t, p, W, H, A) { ... }  — called every frame.
- t = seconds since this scene started, p = progress 0..1 through the scene, W/H = canvas size (e.g. 1080x1920).
- ctx is a Canvas 2D context: fillRect, strokeRect, clearRect, beginPath, moveTo, lineTo, arc, ellipse, rect, roundRect(x,y,w,h,r),
  quadraticCurveTo, bezierCurveTo, fill, stroke, clip, save, restore, translate, rotate, scale, setTransform, setLineDash,
  fillText, strokeText, measureText(text).width, createLinearGradient, createRadialGradient (+ addColorStop),
  drawImage(assetKey, x, y, w, h) — images are referenced by key string from A.assets, not objects.
  Props: fillStyle, strokeStyle, lineWidth, font ("120px Anton", "800 64px Inter", "500 40px Inter"), textAlign, textBaseline,
  globalAlpha, shadowColor, shadowBlur, lineCap, lineJoin, globalCompositeOperation, letterSpacing.
- A.colors = {bg, fg, accent, accent2}; A.assets = {key: true}; A.fonts = {display:"Anton", body:"Inter"}
- A.ease.out(x) / A.ease.inOut(x) / A.ease.back(x) / A.ease.elastic(x); A.lerp(a,b,k); A.clamp(x,a,b); A.rand(seed) -> 0..1 deterministic
- A.wrap(ctx, text, maxWidth) -> array of lines (uses ctx.font)
- Animate everything from t/p (deterministic, no Date/Math.random). Keep ALL text inside x 60..W-60 and y 0.12H..A.textBottom (A.textBottom = 0.64H when voiceover captions are on — they occupy ~0.70-0.82H — else 0.78H). Overlaps are measured and penalized.
- No DOM, no fetch, no timers, no requestAnimationFrame. Keep it under ~300 draw calls per frame.`;

export interface CompiledScene {
  frame(t: number, p: number): { cmds: any[] | null; error?: string };
  dispose(): void;
}

let qjsPromise: ReturnType<typeof getQuickJS> | null = null;

export async function compileScene(
  code: string,
  env: { W: number; H: number; colors: Record<string, string>; assets: string[]; charWidths: Record<string, number[]>; textBottom?: number }
): Promise<CompiledScene> {
  qjsPromise ||= getQuickJS();
  const QJS = await qjsPromise;
  const runtime = QJS.newRuntime();
  runtime.setMemoryLimit(48 * 1024 * 1024);
  runtime.setMaxStackSize(1024 * 1024);
  const vm: QuickJSContext = runtime.newContext();

  const prelude = `
const __P=${JSON.stringify(PROPS)}, __M=${JSON.stringify(METHODS)}, __CW=${JSON.stringify(env.charWidths)};
let __c=[], __g=0;
const ctx={};
let __font="40px Inter";
for (const k of __P) Object.defineProperty(ctx,k,{set(v){ if(k==="font") __font=String(v); __c.push(["p",k,(v&&v.__g)?{g:v.__g}:v]); },get(){ return k==="font"?__font:undefined; }});
for (const m of __M) ctx[m]=function(){ __c.push(["m",m,...arguments]); };
ctx.createLinearGradient=function(a,b,c,d){const id=++__g; __c.push(["g","l",id,a,b,c,d]); return {__g:id,addColorStop(o,col){__c.push(["s",id,o,col]);}};};
ctx.createRadialGradient=function(a,b,c,d,e,f){const id=++__g; __c.push(["g","r",id,a,b,c,d,e,f]); return {__g:id,addColorStop(o,col){__c.push(["s",id,o,col]);}};};
ctx.measureText=function(s){ const m=/(\\d+(?:\\.\\d+)?)px\\s+([A-Za-z]+)/.exec(__font)||[0,40,"Inter"]; const size=+m[1]; const bold=/\\b(7|8|9)00\\b|bold/.test(__font);
  const tbl=__CW[m[2]==="Anton"?"Anton":(bold?"InterBold":"Inter")]||__CW.Inter; let w=0; for(const ch of String(s)){const i=ch.charCodeAt(0)-32; w+=(i>=0&&i<tbl.length?tbl[i]:tbl[33])*size/100;} return {width:w}; };
const A={textBottom:${Math.round(env.textBottom ?? env.H * 0.78)},colors:${JSON.stringify(env.colors)},assets:${JSON.stringify(Object.fromEntries(env.assets.map((a) => [a, true])))},fonts:{display:"Anton",body:"Inter"},
 ease:{out:x=>1-Math.pow(1-x,3),inOut:x=>x<.5?4*x*x*x:1-Math.pow(-2*x+2,3)/2,back:x=>{const c1=1.70158,c3=c1+1;return 1+c3*Math.pow(x-1,3)+c1*Math.pow(x-1,2);},elastic:x=>x===0?0:x===1?1:Math.pow(2,-10*x)*Math.sin((x*10-.75)*(2*Math.PI/3))+1},
 lerp:(a,b,k)=>a+(b-a)*k, clamp:(x,a,b)=>Math.max(a,Math.min(b,x)), rand:(s)=>{const x=Math.sin(s*12.9898+78.233)*43758.5453;return x-Math.floor(x);},
 wrap:(c,text,max)=>{const words=String(text).split(/\\s+/);const lines=[];let line="";for(const w of words){const t=line?line+" "+w:w;if(c.measureText(t).width>max&&line){lines.push(line);line=w;}else line=t;}if(line)lines.push(line);return lines;}};
const W=${env.W}, H=${env.H};
`;
  const boot = vm.evalCode(prelude + "\n" + code + "\n;globalThis.__draw = typeof draw === 'function' ? draw : null;");
  if (boot.error) {
    const err = vm.dump(boot.error);
    boot.error.dispose();
    vm.dispose();
    runtime.dispose();
    throw new Error("code scene failed to compile: " + JSON.stringify(err).slice(0, 300));
  }
  boot.value.dispose();

  return {
    frame(t, p) {
      runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + 250));
      const r = vm.evalCode(
        `(function(){ __c=[]; __g=0; if(!__draw) throw new Error("no draw() function"); __draw(ctx, ${t}, ${p}, W, H, A); return JSON.stringify(__c.slice(0,6000)); })()`
      );
      if (r.error) {
        const e = vm.dump(r.error);
        r.error.dispose();
        return { cmds: null, error: typeof e === "object" ? `${e?.name || "Error"}: ${e?.message || ""}` : String(e) };
      }
      const s = vm.getString(r.value);
      r.value.dispose();
      try {
        return { cmds: JSON.parse(s) };
      } catch {
        return { cmds: null, error: "bad display list" };
      }
    },
    dispose() {
      vm.dispose();
      runtime.dispose();
    },
  };
}

const num = (v: any) => (typeof v === "number" && isFinite(v) ? v : 0);

/** Replay a display list onto the real canvas — whitelisted ops only. */
export function replay(
  ctx: SKRSContext2D,
  cmds: any[],
  images: Record<string, Image | undefined>,
  onText?: (box: { x: number; y: number; w: number; h: number; color: string }) => void
) {
  const grads = new Map<number, CanvasGradient>();
  ctx.save();
  try {
    for (const c of cmds) {
      if (!Array.isArray(c)) continue;
      const [kind, a, ...rest] = c;
      if (kind === "p" && PROPS.includes(a)) {
        let v = rest[0];
        if (v && typeof v === "object" && "g" in v) v = grads.get(v.g);
        if (a === "globalCompositeOperation" && !COMPOSITE_OK.has(v)) continue;
        if (a === "font" && typeof v === "string") v = v.replace(/[^\w\s.\-"',]/g, "");
        if (v === undefined || v === null) continue;
        (ctx as any)[a] = v;
      } else if (kind === "m" && METHODS.includes(a)) {
        if (a === "drawImage") {
          const img = images[String(rest[0])];
          if (!img) continue;
          const n = rest.slice(1).map(num);
          if (n.length >= 4) ctx.drawImage(img, n[0], n[1], n[2], n[3]);
          else if (n.length >= 2) ctx.drawImage(img, n[0], n[1]);
          continue;
        }
        if (a === "fillText" || a === "strokeText") {
          if (onText) {
            // Measure where the model's text lands (with current transform) so QA can check overlap + contrast.
            const str = String(rest[0]).slice(0, 300);
            const w = ctx.measureText(str).width;
            const size = Number(/(\d+(?:\.\d+)?)px/.exec(ctx.font)?.[1] || 40);
            const al = ctx.textAlign;
            let x = num(rest[1]) - (al === "center" ? w / 2 : al === "right" || al === "end" ? w : 0);
            let y = num(rest[2]) - size * 0.85;
            const m = ctx.getTransform();
            const sx = Math.hypot(m.a, m.b) || 1, sy = Math.hypot(m.c, m.d) || 1;
            const X = m.a * x + m.c * y + m.e, Y = m.b * x + m.d * y + m.f;
            if (sx > 0.5 && ctx.globalAlpha > 0.4) onText({ x: X, y: Y, w: w * sx, h: size * 1.05 * sy, color: typeof ctx.fillStyle === "string" ? ctx.fillStyle : "#ffffff" });
          }
          (ctx as any)[a](String(rest[0]).slice(0, 300), num(rest[1]), num(rest[2]), ...(rest[3] !== undefined ? [num(rest[3])] : []));
          continue;
        }
        if (a === "setLineDash") {
          ctx.setLineDash(Array.isArray(rest[0]) ? rest[0].map(num).slice(0, 8) : []);
          continue;
        }
        if (a === "roundRect") {
          const n = rest.map((x: any) => (Array.isArray(x) ? num(x[0]) : num(x)));
          ctx.roundRect(n[0], n[1], n[2], n[3], n[4] || 0);
          continue;
        }
        (ctx as any)[a](...rest.map(num));
      } else if (kind === "g") {
        const id = rest[0];
        const n = rest.slice(1).map(num);
        grads.set(id, a === "r" ? ctx.createRadialGradient(n[0], n[1], n[2], n[3], n[4], n[5]) : ctx.createLinearGradient(n[0], n[1], n[2], n[3]));
      } else if (kind === "s") {
        const g = grads.get(a);
        try {
          g?.addColorStop(Math.max(0, Math.min(1, num(rest[0]))), String(rest[1]));
        } catch {}
      }
    }
  } finally {
    ctx.restore();
  }
}
