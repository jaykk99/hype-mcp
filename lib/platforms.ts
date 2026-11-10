export type Platform = "instagram" | "tiktok" | "facebook" | "linkedin" | "x" | "youtube_shorts" | "threads";
export type Format = "post" | "photo" | "carousel" | "reel" | "story";

export interface PlatformSpec {
  label: string;
  captionMax: number;
  captionIdeal: [number, number];
  hookVisibleChars: number; // chars shown before "...more"
  hashtags: [number, number];
  imageSize: { width: number; height: number };
  verticalSize: { width: number; height: number };
  videoSeconds: [number, number];
  notes: string;
}

export const PLATFORMS: Record<Platform, PlatformSpec> = {
  instagram: {
    label: "Instagram",
    captionMax: 2200,
    captionIdeal: [80, 400],
    hookVisibleChars: 125,
    hashtags: [3, 8],
    imageSize: { width: 1080, height: 1350 },
    verticalSize: { width: 1080, height: 1920 },
    videoSeconds: [7, 45],
    notes: "4:5 feed images. Reels: hook in first 1.5s, captions on screen, loopable ending. Keywords in caption help IG search.",
  },
  tiktok: {
    label: "TikTok",
    captionMax: 4000,
    captionIdeal: [40, 200],
    hookVisibleChars: 80,
    hashtags: [3, 5],
    imageSize: { width: 1080, height: 1920 },
    verticalSize: { width: 1080, height: 1920 },
    videoSeconds: [9, 60],
    notes: "Native, lo-fi, talking-to-camera beats polished ads. Pattern interrupt in first second. Keep text out of bottom 20% (UI).",
  },
  facebook: {
    label: "Facebook",
    captionMax: 63206,
    captionIdeal: [40, 300],
    hookVisibleChars: 140,
    hashtags: [0, 3],
    imageSize: { width: 1080, height: 1350 },
    verticalSize: { width: 1080, height: 1920 },
    videoSeconds: [7, 60],
    notes: "Older, local audience. Clear offer, phone/booking CTA, community tone. Local landmarks/towns land well.",
  },
  linkedin: {
    label: "LinkedIn",
    captionMax: 3000,
    captionIdeal: [150, 1300],
    hookVisibleChars: 210,
    hashtags: [2, 5],
    imageSize: { width: 1200, height: 1500 },
    verticalSize: { width: 1080, height: 1920 },
    videoSeconds: [15, 90],
    notes: "First 2 lines decide the click. Short paragraphs, a specific lesson or number, no hard sell.",
  },
  x: {
    label: "X",
    captionMax: 280,
    captionIdeal: [60, 260],
    hookVisibleChars: 280,
    hashtags: [0, 2],
    imageSize: { width: 1600, height: 900 },
    verticalSize: { width: 1080, height: 1920 },
    videoSeconds: [6, 45],
    notes: "One sharp idea. Opinion or specific number. Minimal hashtags.",
  },
  youtube_shorts: {
    label: "YouTube Shorts",
    captionMax: 5000,
    captionIdeal: [40, 300],
    hookVisibleChars: 100,
    hashtags: [2, 4],
    imageSize: { width: 1080, height: 1920 },
    verticalSize: { width: 1080, height: 1920 },
    videoSeconds: [15, 60],
    notes: "Title under 60 chars with a search keyword. Strong first frame, payoff before the loop.",
  },
  threads: {
    label: "Threads",
    captionMax: 500,
    captionIdeal: [40, 400],
    hookVisibleChars: 500,
    hashtags: [0, 1],
    imageSize: { width: 1080, height: 1350 },
    verticalSize: { width: 1080, height: 1920 },
    videoSeconds: [5, 60],
    notes: "Conversational, question-led, starts discussions.",
  },
};

export const ANGLES = [
  "pain point → fix (call out the exact frustration the customer feels, then show the fix)",
  "before/after transformation (visual proof)",
  "myth-bust / bold contrarian claim backed by a specific fact",
  "behind-the-scenes / how we actually do it",
  "quick how-to tip the viewer can use today (give value away)",
  "POV / relatable trend format",
  "social proof / customer story with a specific detail",
  "urgency / seasonal timing (why now)",
  "listicle: 3 signs / 3 mistakes",
];
