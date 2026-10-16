/**
 * Known image and video parameter defaults for the configured relay.
 *
 * The gateway this product talks to speaks one protocol per vendor family, and
 * each family declares — in its own plugin — which fields it reads and which
 * values it validates. This table is that declaration, collected per model id,
 * so the panels can offer controls from the available declarations:
 * a model with no reference-video input never gets that picker, and a model
 * whose duration menu is `6` gets a label instead of a slider.
 *
 * Sources, in order of authority:
 *   1. the plugin sources this gateway runs (new-api `plugins/tasks/*`), which
 *      are the exact fields each vendor route accepts — marked `plugin:<key>`;
 *   2. the vendor's published API reference, where a plugin is permissive and
 *      the real product has a narrower menu — marked `docs:<vendor>`;
 *   3. family behaviour for ids that arrive through a plain OpenAI-compatible
 *      channel — marked `family`, deliberately conservative.
 *
 * Live explicit capabilities override these defaults. An unknown model uses
 * conservative fallback menus; submission still validates upstream support.
 */

/** One image model's menu. */
export interface ImageSpec {
  /** Output size menu; empty means the route takes no size field. */
  readonly sizes: readonly string[]
  /** Largest number of images one call may ask for. */
  readonly maxCount: number
  /** Reference images an edit may carry; 0 means text-to-image only. */
  readonly maxEdits: number
  readonly qualities: readonly string[]
  readonly backgrounds: readonly string[]
  readonly formats: readonly string[]
  readonly moderations: readonly string[]
  /** A seed the route reads, when it has one. */
  readonly seed: boolean
  /** Where these values come from. */
  readonly source: string
}

/** One video model's menu. */
export interface VideoSpec {
  /** Every duration value the route validates, in seconds. */
  readonly durations: readonly number[]
  readonly resolutions: readonly string[]
  readonly ratios: readonly string[]
  /** First/last frame slots; 2 means both ends can be pinned. */
  readonly frames: number
  readonly referenceImages: number
  readonly referenceVideos: number
  readonly referenceAudios: number
  /** Renders its own audio track. */
  readonly audio: boolean
  /** Reads a `generate_audio` switch. */
  readonly audioToggle: boolean
  /** Quality tiers the vendor validates, e.g. `std` / `pro`. */
  readonly modes: readonly string[]
  /** A seed the route reads. */
  readonly seed: boolean
  readonly source: string
}

/** Every integer in a closed range, for menus the vendor spells as a bound. */
function range(from: number, to: number): number[] {
  const values: number[] = []
  for (let value = from; value <= to; value += 1) values.push(value)
  return values
}

/** The OpenAI Images shape: shared by every compatible image channel. */
const OPENAI_IMAGE: Omit<ImageSpec, 'source'> = {
  sizes: ['auto', '1024x1024', '1536x1024', '1024x1536'],
  maxCount: 4,
  maxEdits: 16,
  qualities: ['auto', 'low', 'medium', 'high'],
  backgrounds: ['auto', 'transparent', 'opaque'],
  formats: ['png', 'jpeg', 'webp'],
  moderations: ['auto', 'low'],
  seed: false,
}

/** Stated per model id; anything not listed comes from a family rule. */
export const IMAGE_MODELS: Record<string, ImageSpec> = {
  // ── OpenAI gpt-image family ────────────────────────────────────────────────
  'gpt-image-1': { ...OPENAI_IMAGE, source: 'docs:openai' },
  'gpt-image-1.5': { ...OPENAI_IMAGE, source: 'docs:openai' },
  'gpt-image-2': { ...OPENAI_IMAGE, source: 'docs:openai' },
  'gpt-image-2.5': { ...OPENAI_IMAGE, source: 'docs:openai' },
  'chatgpt-image-latest': { ...OPENAI_IMAGE, source: 'docs:openai' },
  'dall-e-3': {
    sizes: ['1024x1024', '1792x1024', '1024x1792'],
    maxCount: 1,
    maxEdits: 0,
    qualities: ['standard', 'hd'],
    backgrounds: [],
    formats: ['url', 'b64_json'],
    moderations: [],
    seed: false,
    source: 'docs:openai',
  },
  'dall-e-2': {
    sizes: ['256x256', '512x512', '1024x1024'],
    maxCount: 10,
    maxEdits: 1,
    qualities: [],
    backgrounds: [],
    formats: ['url', 'b64_json'],
    moderations: [],
    seed: false,
    source: 'docs:openai',
  },

  // ── ByteDance Seedream, from the gateway's own Ark plugin ─────────────────
  'doubao-seedream-5-0-pro-260628': {
    sizes: ['1K', '1.5K', '2K'], maxCount: 1, maxEdits: 10,
    qualities: [], backgrounds: ['auto', 'transparent', 'opaque'],
    formats: ['png', 'jpeg'], moderations: [], seed: false, source: 'plugin:doubao',
  },
  'doubao-seedream-5-0-flash-260915': {
    sizes: ['1K', '1.5K', '2K'], maxCount: 1, maxEdits: 10,
    qualities: [], backgrounds: ['auto', 'transparent', 'opaque'],
    formats: ['png', 'jpeg'], moderations: [], seed: false, source: 'plugin:doubao',
  },
  'doubao-seedream-5-0-lite-260128': {
    sizes: ['2K', '3K', '4K'], maxCount: 1, maxEdits: 14,
    qualities: [], backgrounds: [], formats: ['png', 'jpeg'], moderations: [], seed: false, source: 'plugin:doubao',
  },
  'doubao-seedream-5-0-260128': {
    sizes: ['2K', '3K', '4K'], maxCount: 1, maxEdits: 14,
    qualities: [], backgrounds: [], formats: ['png', 'jpeg'], moderations: [], seed: false, source: 'plugin:doubao',
  },
  'doubao-seedream-4-5-251128': {
    sizes: ['2K', '4K'], maxCount: 1, maxEdits: 14,
    qualities: [], backgrounds: [], formats: [], moderations: [], seed: false, source: 'plugin:doubao',
  },
  'doubao-seedream-4-0-250828': {
    sizes: ['1K', '2K', '4K'], maxCount: 1, maxEdits: 14,
    qualities: [], backgrounds: [], formats: [], moderations: [], seed: false, source: 'plugin:doubao',
  },

  // ── Alibaba Wan / Qwen image, from the gateway's DashScope plugin ─────────
  // The plugin forwards `size`, `n`, `seed` and reference images; the size
  // menus themselves differ per model upstream, so only shared facts are stated
  // and no size picker is offered rather than a wrong one.
  'wan2.7-image-pro': { sizes: [], maxCount: 4, maxEdits: 5, qualities: [], backgrounds: [], formats: [], moderations: [], seed: true, source: 'plugin:alibaba' },
  'wan2.7-image': { sizes: [], maxCount: 4, maxEdits: 5, qualities: [], backgrounds: [], formats: [], moderations: [], seed: true, source: 'plugin:alibaba' },
  'wan2.6-image': { sizes: [], maxCount: 4, maxEdits: 5, qualities: [], backgrounds: [], formats: [], moderations: [], seed: true, source: 'plugin:alibaba' },
  'wan2.6-t2i': { sizes: [], maxCount: 4, maxEdits: 5, qualities: [], backgrounds: [], formats: [], moderations: [], seed: true, source: 'plugin:alibaba' },
  'wan2.5-t2i-preview': { sizes: [], maxCount: 4, maxEdits: 5, qualities: [], backgrounds: [], formats: [], moderations: [], seed: true, source: 'plugin:alibaba' },
  'wan2.5-i2i-preview': { sizes: [], maxCount: 4, maxEdits: 5, qualities: [], backgrounds: [], formats: [], moderations: [], seed: true, source: 'plugin:alibaba' },
  'wanx2.1-imageedit': { sizes: [], maxCount: 1, maxEdits: 2, qualities: [], backgrounds: [], formats: [], moderations: [], seed: false, source: 'plugin:alibaba' },
  'wanx2.1-t2i-turbo': { sizes: [], maxCount: 4, maxEdits: 0, qualities: [], backgrounds: [], formats: [], moderations: [], seed: true, source: 'plugin:alibaba' },
  'wanx2.1-t2i-plus': { sizes: [], maxCount: 4, maxEdits: 0, qualities: [], backgrounds: [], formats: [], moderations: [], seed: true, source: 'plugin:alibaba' },
  'qwen-image': { sizes: [], maxCount: 4, maxEdits: 3, qualities: [], backgrounds: [], formats: [], moderations: [], seed: true, source: 'plugin:alibaba' },
  'qwen-image-plus': { sizes: [], maxCount: 4, maxEdits: 3, qualities: [], backgrounds: [], formats: [], moderations: [], seed: true, source: 'plugin:alibaba' },
  'qwen-image-max': { sizes: [], maxCount: 4, maxEdits: 3, qualities: [], backgrounds: [], formats: [], moderations: [], seed: true, source: 'plugin:alibaba' },
  'qwen-image-2.0': { sizes: [], maxCount: 4, maxEdits: 3, qualities: [], backgrounds: [], formats: [], moderations: [], seed: true, source: 'plugin:alibaba' },
  'qwen-image-2.0-pro': { sizes: [], maxCount: 4, maxEdits: 3, qualities: [], backgrounds: [], formats: [], moderations: [], seed: true, source: 'plugin:alibaba' },
  'qwen-image-3.0': { sizes: [], maxCount: 4, maxEdits: 3, qualities: [], backgrounds: [], formats: [], moderations: [], seed: true, source: 'plugin:alibaba' },
  'qwen-image-3.0-pro': { sizes: [], maxCount: 4, maxEdits: 3, qualities: [], backgrounds: [], formats: [], moderations: [], seed: true, source: 'plugin:alibaba' },
  'qwen-image-edit': { sizes: [], maxCount: 1, maxEdits: 3, qualities: [], backgrounds: [], formats: [], moderations: [], seed: true, source: 'plugin:alibaba' },
  'z-image-turbo': { sizes: [], maxCount: 4, maxEdits: 0, qualities: [], backgrounds: [], formats: [], moderations: [], seed: true, source: 'plugin:alibaba' },

  // ── Google image, through the mixed Gemini routes ─────────────────────────
  'gemini-3.1-flash-image': {
    sizes: ['1024x1024', '1344x768', '768x1344'], maxCount: 4, maxEdits: 5,
    qualities: [], backgrounds: [], formats: [], moderations: [], seed: false, source: 'docs:google',
  },
  'imagen-4.0-generate-001': {
    sizes: ['1024x1024', '1408x768', '768x1408'], maxCount: 4, maxEdits: 0,
    qualities: [], backgrounds: [], formats: [], moderations: [], seed: false, source: 'docs:google',
  },
  'nano-banana': {
    sizes: ['1024x1024', '1344x768', '768x1344'], maxCount: 4, maxEdits: 5,
    qualities: [], backgrounds: [], formats: [], moderations: [], seed: false, source: 'family',
  },
  'nano-banana-pro': {
    sizes: ['1024x1024', '1344x768', '768x1344'], maxCount: 4, maxEdits: 5,
    qualities: [], backgrounds: [], formats: [], moderations: [], seed: false, source: 'family',
  },

  // ── This deployment's own async image route ───────────────────────────────
  // Served by the gateway's `toapis-image` plugin. Measured on 2026-10-14:
  // a body carrying `size` is answered with HTTP 503 "Task request failed"
  // before any task is queued, so no size menu is offered; `n` must be 1, and
  // `reference_images` accepts only six `https://` URLs — a locally uploaded
  // file cannot become one, so edits stay closed until that route hosts files.
  'yunshu-internal-gpt-image-2': {
    sizes: [], maxCount: 1, maxEdits: 0,
    qualities: ['auto', 'low', 'medium', 'high'],
    backgrounds: ['auto', 'transparent', 'opaque'],
    formats: ['png', 'jpeg', 'webp'],
    moderations: [],
    seed: false,
    source: 'plugin:toapis-image',
  },
}

/**
 * Video models, stated per id wherever a vendor declares them.
 *
 * `durations` lists exactly what the route validates: a range where the vendor
 * only bounds it (MiniMax H3 4–15, Kling 3–15, Grok up to 15, Seedance up to
 * `maxDuration`), and the literal menu where the vendor names one (Hailuo 2.3:
 * 6 or 10; Vidu 2.0: 4 or 8; Veo: 4, 6 or 8).
 */
export const VIDEO_MODELS: Record<string, VideoSpec> = {
  // ── MiniMax Hailuo, from the gateway's hailuo plugin ──────────────────────
  'MiniMax-H3': {
    durations: range(4, 15), resolutions: ['768P', '2K'],
    ratios: ['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
    frames: 2, referenceImages: 9, referenceVideos: 3, referenceAudios: 3,
    audio: true, audioToggle: false, modes: [], seed: false, source: 'plugin:hailuo',
  },
  'MiniMax-Hailuo-2.3': {
    durations: [6, 10], resolutions: ['768P', '1080P'], ratios: ['16:9', '9:16'],
    frames: 1, referenceImages: 0, referenceVideos: 0, referenceAudios: 0,
    audio: false, audioToggle: false, modes: [], seed: false, source: 'plugin:hailuo',
  },
  'MiniMax-Hailuo-2.3-Fast': {
    durations: [6, 10], resolutions: ['768P', '1080P'], ratios: ['16:9', '9:16'],
    frames: 1, referenceImages: 0, referenceVideos: 0, referenceAudios: 0,
    audio: false, audioToggle: false, modes: [], seed: false, source: 'plugin:hailuo',
  },
  'MiniMax-Hailuo-02': {
    durations: [6, 10], resolutions: ['512P', '768P', '1080P'], ratios: ['16:9', '9:16'],
    frames: 1, referenceImages: 0, referenceVideos: 0, referenceAudios: 0,
    audio: false, audioToggle: false, modes: [], seed: false, source: 'plugin:hailuo',
  },
  'T2V-01-Director': {
    durations: [6], resolutions: ['720P'], ratios: ['16:9'],
    frames: 0, referenceImages: 0, referenceVideos: 0, referenceAudios: 0,
    audio: false, audioToggle: false, modes: [], seed: false, source: 'plugin:hailuo',
  },
  'T2V-01': {
    durations: [6], resolutions: ['720P'], ratios: ['16:9'],
    frames: 0, referenceImages: 0, referenceVideos: 0, referenceAudios: 0,
    audio: false, audioToggle: false, modes: [], seed: false, source: 'plugin:hailuo',
  },
  'I2V-01-Director': {
    durations: [6], resolutions: ['720P'], ratios: ['16:9'],
    frames: 1, referenceImages: 0, referenceVideos: 0, referenceAudios: 0,
    audio: false, audioToggle: false, modes: [], seed: false, source: 'plugin:hailuo',
  },
  'I2V-01-live': {
    durations: [6], resolutions: ['720P'], ratios: ['16:9'],
    frames: 1, referenceImages: 0, referenceVideos: 0, referenceAudios: 0,
    audio: false, audioToggle: false, modes: [], seed: false, source: 'plugin:hailuo',
  },
  'I2V-01': {
    durations: [6], resolutions: ['720P'], ratios: ['16:9'],
    frames: 1, referenceImages: 0, referenceVideos: 0, referenceAudios: 0,
    audio: false, audioToggle: false, modes: [], seed: false, source: 'plugin:hailuo',
  },
  'S2V-01': {
    durations: [6], resolutions: ['720P'], ratios: ['16:9'],
    frames: 1, referenceImages: 0, referenceVideos: 0, referenceAudios: 0,
    audio: false, audioToggle: false, modes: [], seed: false, source: 'plugin:hailuo',
  },

  // ── Kling, from the gateway's kling plugin ────────────────────────────────
  'kling-v1': {
    durations: [5, 10], resolutions: ['720P', '1080P'], ratios: ['16:9', '9:16', '1:1'],
    frames: 2, referenceImages: 0, referenceVideos: 0, referenceAudios: 0,
    audio: false, audioToggle: false, modes: ['std', 'pro'], seed: false, source: 'plugin:kling',
  },
  'kling-v1-6': {
    durations: range(3, 15), resolutions: ['720P', '1080P'], ratios: ['16:9', '9:16', '1:1'],
    frames: 2, referenceImages: 0, referenceVideos: 0, referenceAudios: 0,
    audio: false, audioToggle: false, modes: ['std', 'pro'], seed: false, source: 'plugin:kling',
  },
  'kling-v2-master': {
    durations: range(3, 15), resolutions: ['720P', '1080P'], ratios: ['16:9', '9:16', '1:1'],
    frames: 2, referenceImages: 0, referenceVideos: 0, referenceAudios: 0,
    audio: false, audioToggle: false, modes: ['pro'], seed: false, source: 'plugin:kling',
  },

  // ── Volcengine Jimeng ─────────────────────────────────────────────────────
  'jimeng_vgfm_t2v_l20': {
    durations: [5, 10], resolutions: ['720P', '1080P'],
    ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    frames: 2, referenceImages: 0, referenceVideos: 0, referenceAudios: 0,
    audio: false, audioToggle: false, modes: ['s2_pro', 'v30_720p', 'v30_1080p', 'v30_pro'],
    seed: false, source: 'plugin:jimeng',
  },

  // ── OpenAI Sora ───────────────────────────────────────────────────────────
  'sora-2': {
    durations: [4, 8, 12], resolutions: ['720P', '1080P'], ratios: ['9:16', '16:9', '7:4', '4:7'],
    frames: 1, referenceImages: 1, referenceVideos: 0, referenceAudios: 0,
    audio: true, audioToggle: false, modes: [], seed: false, source: 'docs:openai',
  },
  'sora-2-pro': {
    durations: [4, 8, 12], resolutions: ['720P', '1080P', '1792x1024'], ratios: ['9:16', '16:9', '7:4', '4:7'],
    frames: 1, referenceImages: 1, referenceVideos: 0, referenceAudios: 0,
    audio: true, audioToggle: false, modes: [], seed: false, source: 'docs:openai',
  },

  // ── Vidu ──────────────────────────────────────────────────────────────────
  'viduq2': {
    durations: range(1, 10), resolutions: ['360p', '540p', '720p', '1080p'], ratios: ['16:9', '9:16', '1:1'],
    frames: 2, referenceImages: 3, referenceVideos: 0, referenceAudios: 0,
    audio: false, audioToggle: false, modes: [], seed: false, source: 'plugin:vidu',
  },
  'viduq1': {
    durations: [5], resolutions: ['720p', '1080p'], ratios: ['16:9', '9:16', '1:1'],
    frames: 2, referenceImages: 3, referenceVideos: 0, referenceAudios: 0,
    audio: false, audioToggle: false, modes: [], seed: false, source: 'plugin:vidu',
  },
  'vidu2.0': {
    durations: [4, 8], resolutions: ['360p', '720p', '1080p'], ratios: ['16:9', '9:16', '1:1'],
    frames: 2, referenceImages: 3, referenceVideos: 0, referenceAudios: 0,
    audio: false, audioToggle: false, modes: [], seed: false, source: 'plugin:vidu',
  },
  'vidu1.5': {
    durations: [4, 8], resolutions: ['360p', '720p'], ratios: ['16:9', '9:16', '1:1'],
    frames: 2, referenceImages: 3, referenceVideos: 0, referenceAudios: 0,
    audio: false, audioToggle: false, modes: [], seed: false, source: 'plugin:vidu',
  },

  // ── Google Veo (both the Gemini and Vertex plugins declare the same set) ──
  'veo-3.0-generate-001': {
    durations: [4, 6, 8], resolutions: ['720p', '1080p'], ratios: ['16:9', '9:16'],
    frames: 1, referenceImages: 0, referenceVideos: 0, referenceAudios: 0,
    audio: true, audioToggle: false, modes: [], seed: false, source: 'docs:google',
  },
  'veo-3.0-fast-generate-001': {
    durations: [4, 6, 8], resolutions: ['720p', '1080p'], ratios: ['16:9', '9:16'],
    frames: 1, referenceImages: 0, referenceVideos: 0, referenceAudios: 0,
    audio: true, audioToggle: false, modes: [], seed: false, source: 'docs:google',
  },
  'veo-3.1-generate-preview': {
    durations: [4, 6, 8], resolutions: ['720p', '1080p', '4k'], ratios: ['16:9', '9:16'],
    frames: 2, referenceImages: 3, referenceVideos: 0, referenceAudios: 0,
    audio: true, audioToggle: false, modes: [], seed: false, source: 'docs:google',
  },
  'veo-3.1-fast-generate-preview': {
    durations: [4, 6, 8], resolutions: ['720p', '1080p', '4k'], ratios: ['16:9', '9:16'],
    frames: 2, referenceImages: 3, referenceVideos: 0, referenceAudios: 0,
    audio: true, audioToggle: false, modes: [], seed: false, source: 'docs:google',
  },

  // ── xAI Grok Imagine ──────────────────────────────────────────────────────
  'grok-imagine-video': {
    durations: range(1, 15), resolutions: ['480p', '720p', '1080p'], ratios: ['16:9', '9:16', '1:1'],
    frames: 4, referenceImages: 7, referenceVideos: 0, referenceAudios: 3,
    audio: true, audioToggle: true, modes: [], seed: false, source: 'plugin:xai',
  },

  // ── Alibaba Wan, from the DashScope plugin's own model table ─────────────
  'wan3.0-video': {
    durations: range(1, 30), resolutions: ['480P', '720P', '1080P'], ratios: ['16:9', '9:16'],
    frames: 2, referenceImages: 5, referenceVideos: 0, referenceAudios: 0,
    audio: false, audioToggle: false, modes: [], seed: true, source: 'plugin:alibaba',
  },
  'wan3.0-video-prime': {
    durations: range(1, 30), resolutions: ['480P', '720P', '1080P'], ratios: ['16:9', '9:16'],
    frames: 2, referenceImages: 5, referenceVideos: 0, referenceAudios: 0,
    audio: false, audioToggle: false, modes: [], seed: true, source: 'plugin:alibaba',
  },
  'wan2.7-t2v': {
    durations: range(1, 15), resolutions: ['720P', '1080P'], ratios: ['16:9', '9:16'],
    frames: 0, referenceImages: 0, referenceVideos: 0, referenceAudios: 0,
    audio: false, audioToggle: false, modes: [], seed: true, source: 'plugin:alibaba',
  },
  'wan2.7-i2v': {
    durations: range(1, 15), resolutions: ['720P', '1080P'], ratios: ['16:9', '9:16'],
    frames: 1, referenceImages: 0, referenceVideos: 0, referenceAudios: 0,
    audio: false, audioToggle: false, modes: [], seed: true, source: 'plugin:alibaba',
  },
  'wan2.6-t2v': {
    durations: range(1, 15), resolutions: ['720P', '1080P'], ratios: ['16:9', '9:16'],
    frames: 0, referenceImages: 0, referenceVideos: 0, referenceAudios: 0,
    audio: false, audioToggle: false, modes: [], seed: true, source: 'plugin:alibaba',
  },
  'wan2.6-i2v': {
    durations: range(1, 15), resolutions: ['720P', '1080P'], ratios: ['16:9', '9:16'],
    frames: 1, referenceImages: 0, referenceVideos: 0, referenceAudios: 0,
    audio: false, audioToggle: false, modes: [], seed: true, source: 'plugin:alibaba',
  },
  'wan2.6-i2v-flash': {
    durations: range(1, 15), resolutions: ['720P', '1080P'], ratios: ['16:9', '9:16'],
    frames: 1, referenceImages: 0, referenceVideos: 0, referenceAudios: 0,
    audio: false, audioToggle: false, modes: [], seed: true, source: 'plugin:alibaba',
  },
  'wan2.6-i2v-us': {
    durations: [5, 10, 15], resolutions: ['720P', '1080P'], ratios: ['16:9', '9:16'],
    frames: 1, referenceImages: 0, referenceVideos: 0, referenceAudios: 0,
    audio: false, audioToggle: false, modes: [], seed: true, source: 'plugin:alibaba',
  },
  'wan2.5-t2v-preview': {
    durations: [5, 10], resolutions: ['480P', '720P', '1080P'], ratios: ['16:9', '9:16'],
    frames: 0, referenceImages: 0, referenceVideos: 0, referenceAudios: 0,
    audio: false, audioToggle: false, modes: [], seed: true, source: 'plugin:alibaba',
  },
  'wan2.5-i2v-preview': {
    durations: [5, 10], resolutions: ['480P', '720P', '1080P'], ratios: ['16:9', '9:16'],
    frames: 1, referenceImages: 0, referenceVideos: 0, referenceAudios: 0,
    audio: false, audioToggle: false, modes: [], seed: true, source: 'plugin:alibaba',
  },
  'wan2.2-t2v-plus': {
    durations: [5], resolutions: ['480P', '1080P'], ratios: ['16:9', '9:16'],
    frames: 0, referenceImages: 0, referenceVideos: 0, referenceAudios: 0,
    audio: false, audioToggle: false, modes: [], seed: true, source: 'plugin:alibaba',
  },
  'wan2.2-i2v-flash': {
    durations: [5], resolutions: ['480P', '720P', '1080P'], ratios: ['16:9', '9:16'],
    frames: 1, referenceImages: 0, referenceVideos: 0, referenceAudios: 0,
    audio: false, audioToggle: false, modes: [], seed: true, source: 'plugin:alibaba',
  },
  'wan2.2-i2v-plus': {
    durations: [5], resolutions: ['480P', '1080P'], ratios: ['16:9', '9:16'],
    frames: 1, referenceImages: 0, referenceVideos: 0, referenceAudios: 0,
    audio: false, audioToggle: false, modes: [], seed: true, source: 'plugin:alibaba',
  },
  'wan2.2-kf2v-flash': {
    durations: [5], resolutions: ['480P', '720P', '1080P'], ratios: ['16:9', '9:16'],
    frames: 2, referenceImages: 0, referenceVideos: 0, referenceAudios: 0,
    audio: false, audioToggle: false, modes: [], seed: true, source: 'plugin:alibaba',
  },
  'wanx2.1-t2v-plus': {
    durations: [5], resolutions: ['720P'], ratios: ['16:9', '9:16'],
    frames: 0, referenceImages: 0, referenceVideos: 0, referenceAudios: 0,
    audio: false, audioToggle: false, modes: [], seed: false, source: 'plugin:alibaba',
  },
  'wanx2.1-t2v-turbo': {
    durations: [5], resolutions: ['480P', '720P'], ratios: ['16:9', '9:16'],
    frames: 0, referenceImages: 0, referenceVideos: 0, referenceAudios: 0,
    audio: false, audioToggle: false, modes: [], seed: false, source: 'plugin:alibaba',
  },
  'wanx2.1-i2v-plus': {
    durations: [5], resolutions: ['720P'], ratios: ['16:9', '9:16'],
    frames: 1, referenceImages: 0, referenceVideos: 0, referenceAudios: 0,
    audio: false, audioToggle: false, modes: [], seed: false, source: 'plugin:alibaba',
  },
  'wanx2.1-i2v-turbo': {
    durations: [3, 4, 5], resolutions: ['480P', '720P'], ratios: ['16:9', '9:16'],
    frames: 1, referenceImages: 0, referenceVideos: 0, referenceAudios: 0,
    audio: false, audioToggle: false, modes: [], seed: false, source: 'plugin:alibaba',
  },

  // ── ByteDance Seedance, from the Ark plugin's model table ────────────────
  'doubao-seedance-1-0-pro-250528': {
    durations: range(1, 12), resolutions: ['480p', '720p', '1080p'], ratios: ['16:9', '9:16', '1:1'],
    frames: 2, referenceImages: 2, referenceVideos: 0, referenceAudios: 0,
    audio: false, audioToggle: true, modes: [], seed: false, source: 'plugin:doubao',
  },
  'doubao-seedance-1-0-lite-t2v': {
    durations: range(1, 12), resolutions: ['480p', '720p', '1080p'], ratios: ['16:9', '9:16', '1:1'],
    frames: 0, referenceImages: 0, referenceVideos: 0, referenceAudios: 0,
    audio: false, audioToggle: true, modes: [], seed: false, source: 'plugin:doubao',
  },
  'doubao-seedance-1-0-lite-i2v': {
    durations: range(1, 12), resolutions: ['480p', '720p', '1080p'], ratios: ['16:9', '9:16', '1:1'],
    frames: 2, referenceImages: 2, referenceVideos: 0, referenceAudios: 0,
    audio: false, audioToggle: true, modes: [], seed: false, source: 'plugin:doubao',
  },
  'doubao-seedance-1-5-pro-251215': {
    durations: range(1, 12), resolutions: ['480p', '720p', '1080p'], ratios: ['16:9', '9:16', '1:1'],
    frames: 2, referenceImages: 2, referenceVideos: 0, referenceAudios: 0,
    audio: true, audioToggle: true, modes: [], seed: false, source: 'plugin:doubao',
  },
  'doubao-seedance-2-0-260128': {
    durations: range(1, 15), resolutions: ['480p', '720p', '1080p', '4k'], ratios: ['16:9', '9:16', '1:1'],
    frames: 2, referenceImages: 4, referenceVideos: 1, referenceAudios: 0,
    audio: true, audioToggle: true, modes: [], seed: false, source: 'plugin:doubao',
  },
  'doubao-seedance-2-0-fast-260128': {
    durations: range(1, 15), resolutions: ['480p', '720p'], ratios: ['16:9', '9:16', '1:1'],
    frames: 2, referenceImages: 4, referenceVideos: 1, referenceAudios: 0,
    audio: true, audioToggle: true, modes: [], seed: false, source: 'plugin:doubao',
  },
  'doubao-seedance-2-0-mini-260615': {
    durations: range(1, 15), resolutions: ['480p', '720p'], ratios: ['16:9', '9:16', '1:1'],
    frames: 2, referenceImages: 4, referenceVideos: 1, referenceAudios: 0,
    audio: true, audioToggle: true, modes: [], seed: false, source: 'plugin:doubao',
  },
  'doubao-seedance-2-5-260628': {
    durations: range(1, 30), resolutions: ['480p', '720p', '1080p'], ratios: ['16:9', '9:16', '1:1'],
    frames: 2, referenceImages: 4, referenceVideos: 1, referenceAudios: 0,
    audio: true, audioToggle: true, modes: [], seed: false, source: 'plugin:doubao',
  },
}

/**
 * Families that reach the gateway through a plain OpenAI-compatible channel,
 * matched by id so a model added from the vendor's catalogue is still shaped
 * correctly. Kept deliberately narrow: an overlap between two rules is worse
 * than no rule at all.
 */
export const IMAGE_FAMILIES: readonly { readonly match: RegExp; readonly spec: ImageSpec }[] = [
  { match: /^gpt-image|^chatgpt-image|^dall-?e/i, spec: { ...OPENAI_IMAGE, source: 'family:openai' } },
  { match: /flux/i, spec: { sizes: ['1024x1024', '1280x720', '720x1280', '1536x1024', '1024x1536'], maxCount: 4, maxEdits: 4, qualities: ['standard', 'fast', 'ultra'], backgrounds: [], formats: ['png', 'jpeg'], moderations: [], seed: true, source: 'family:flux' } },
  { match: /seedream|doubao.*image|seededit/i, spec: { sizes: ['1K', '2K', '4K'], maxCount: 1, maxEdits: 8, qualities: [], backgrounds: [], formats: ['png', 'jpeg'], moderations: [], seed: true, source: 'family:seedream' } },
  { match: /qwen-image|wanx|wan[0-9.]+-image|z-image/i, spec: { sizes: [], maxCount: 4, maxEdits: 3, qualities: [], backgrounds: [], formats: [], moderations: [], seed: true, source: 'family:qwen' } },
  { match: /nano-?banana|gemini.*image|imagen/i, spec: { sizes: ['1024x1024', '1344x768', '768x1344'], maxCount: 4, maxEdits: 5, qualities: [], backgrounds: [], formats: [], moderations: [], seed: false, source: 'family:google' } },
  { match: /glm-image|cogview/i, spec: { sizes: ['1024x1024', '1344x768', '768x1344'], maxCount: 4, maxEdits: 0, qualities: ['standard', 'hd'], backgrounds: [], formats: [], moderations: [], seed: true, source: 'family:zhipu' } },
  { match: /kolors|hunyuan.*image|hunyuanimage/i, spec: { sizes: ['1024x1024', '1280x720', '720x1280', '768x1024', '1024x768'], maxCount: 4, maxEdits: 2, qualities: [], backgrounds: [], formats: [], moderations: [], seed: true, source: 'family:kolors' } },
  { match: /ideogram/i, spec: { sizes: ['1024x1024', '1344x768', '768x1344'], maxCount: 8, maxEdits: 3, qualities: ['turbo', 'balanced', 'quality'], backgrounds: [], formats: [], moderations: [], seed: true, source: 'family:ideogram' } },
  { match: /recraft/i, spec: { sizes: ['1024x1024', '1365x1024', '1024x1365', '1536x1024', '1024x1536'], maxCount: 6, maxEdits: 2, qualities: [], backgrounds: [], formats: ['png', 'jpeg', 'webp'], moderations: [], seed: false, source: 'family:recraft' } },
  { match: /^(sd|sdxl|stable-diffusion|sd3)/i, spec: { sizes: ['512x512', '768x768', '1024x1024', '1280x720', '720x1280'], maxCount: 4, maxEdits: 1, qualities: [], backgrounds: [], formats: ['png', 'jpeg'], moderations: [], seed: true, source: 'family:stable-diffusion' } },
  { match: /grok.*image|image.*grok/i, spec: { sizes: ['1024x1024', '1280x720', '720x1280'], maxCount: 4, maxEdits: 4, qualities: [], backgrounds: [], formats: [], moderations: [], seed: false, source: 'family:xai' } },
]

/** Video families reachable through a plain compatible channel. */
export const VIDEO_FAMILIES: readonly { readonly match: RegExp; readonly spec: VideoSpec }[] = [
  { match: /kling/i, spec: { durations: range(3, 15), resolutions: ['720P', '1080P'], ratios: ['16:9', '9:16', '1:1'], frames: 2, referenceImages: 0, referenceVideos: 0, referenceAudios: 0, audio: false, audioToggle: false, modes: ['std', 'pro'], seed: false, source: 'family:kling' } },
  { match: /jimeng|seedance|doubao.*video/i, spec: { durations: range(1, 12), resolutions: ['480p', '720p', '1080p'], ratios: ['16:9', '9:16', '1:1'], frames: 2, referenceImages: 2, referenceVideos: 0, referenceAudios: 0, audio: false, audioToggle: true, modes: [], seed: true, source: 'family:seedance' } },
  { match: /hailuo|minimax/i, spec: { durations: range(4, 15), resolutions: ['768P', '1080P'], ratios: ['16:9', '9:16'], frames: 2, referenceImages: 9, referenceVideos: 3, referenceAudios: 3, audio: true, audioToggle: false, modes: [], seed: false, source: 'family:hailuo' } },
  { match: /^wan(x|[0-9])|通义万相/i, spec: { durations: range(1, 15), resolutions: ['480P', '720P', '1080P'], ratios: ['16:9', '9:16'], frames: 2, referenceImages: 5, referenceVideos: 0, referenceAudios: 0, audio: false, audioToggle: true, modes: [], seed: true, source: 'family:wan' } },
  { match: /veo/i, spec: { durations: [4, 6, 8], resolutions: ['720p', '1080p', '4k'], ratios: ['16:9', '9:16'], frames: 2, referenceImages: 3, referenceVideos: 0, referenceAudios: 0, audio: true, audioToggle: false, modes: [], seed: false, source: 'family:veo' } },
  { match: /sora/i, spec: { durations: [4, 8, 12], resolutions: ['720P', '1080P'], ratios: ['9:16', '16:9', '7:4', '4:7'], frames: 1, referenceImages: 1, referenceVideos: 0, referenceAudios: 0, audio: true, audioToggle: false, modes: [], seed: false, source: 'family:sora' } },
  { match: /vidu/i, spec: { durations: range(1, 10), resolutions: ['360p', '540p', '720p', '1080p'], ratios: ['16:9', '9:16', '1:1'], frames: 2, referenceImages: 3, referenceVideos: 0, referenceAudios: 0, audio: false, audioToggle: false, modes: [], seed: false, source: 'family:vidu' } },
  { match: /grok.*video/i, spec: { durations: range(1, 15), resolutions: ['480p', '720p', '1080p'], ratios: ['16:9', '9:16', '1:1'], frames: 4, referenceImages: 7, referenceVideos: 0, referenceAudios: 3, audio: true, audioToggle: true, modes: [], seed: false, source: 'family:xai' } },
  { match: /runway|gen-?[34]/i, spec: { durations: [5, 10], resolutions: ['720P', '1080P'], ratios: ['16:9', '9:16'], frames: 1, referenceImages: 2, referenceVideos: 0, referenceAudios: 0, audio: false, audioToggle: true, modes: [], seed: true, source: 'family:runway' } },
  { match: /luma|dream-?machine|ray-?[23]/i, spec: { durations: [5, 9], resolutions: ['540p', '720p', '1080p', '4k'], ratios: ['16:9', '9:16', '1:1', '4:3', '3:4'], frames: 2, referenceImages: 4, referenceVideos: 0, referenceAudios: 0, audio: false, audioToggle: false, modes: [], seed: false, source: 'family:luma' } },
  { match: /pika|pixverse|ltx|mochi|cogvideo/i, spec: { durations: [5, 10], resolutions: ['720P', '1080P'], ratios: ['16:9', '9:16', '1:1'], frames: 2, referenceImages: 2, referenceVideos: 0, referenceAudios: 0, audio: false, audioToggle: false, modes: [], seed: true, source: 'family:open-video' } },
]

/** What every route accepts when nothing else is known about a model. */
export const FALLBACK_IMAGE: ImageSpec = {
  sizes: [], maxCount: 1, maxEdits: 0, qualities: [], backgrounds: [], formats: [], moderations: [],
  seed: false, source: 'fallback',
}

/** Conservative video parameters used when neither an exact id nor a family matches. */
export const FALLBACK_VIDEO: VideoSpec = {
  durations: range(4, 15), resolutions: [], ratios: [], frames: 1,
  referenceImages: 0, referenceVideos: 0, referenceAudios: 0,
  audio: false, audioToggle: false, modes: [], seed: false, source: 'fallback',
}

/**
 * Look up one image model: exact id first, then the family rules.
 * @param id - Gateway model id.
 * @returns Exact, family, or fallback image parameters.
 */
export function imageSpec(id: string): ImageSpec {
  const exact = IMAGE_MODELS[id]
  if (exact !== undefined) return exact
  for (const family of IMAGE_FAMILIES) if (family.match.test(id)) return family.spec
  return FALLBACK_IMAGE
}

/**
 * Look up one video model: exact id first, then the family rules.
 * @param id - Gateway model id.
 * @returns Exact, family, or fallback video parameters.
 */
export function videoSpec(id: string): VideoSpec {
  const exact = VIDEO_MODELS[id]
  if (exact !== undefined) return exact
  for (const family of VIDEO_FAMILIES) if (family.match.test(id)) return family.spec
  return FALLBACK_VIDEO
}

/**
 * Every id this table describes, for the coverage report.
 * @returns Explicit image and video model ids; family patterns are excluded.
 */
export function describedModels(): { readonly image: readonly string[]; readonly video: readonly string[] } {
  return { image: Object.keys(IMAGE_MODELS), video: Object.keys(VIDEO_MODELS) }
}
