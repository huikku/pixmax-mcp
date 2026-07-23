/**
 * Per-model request quirks and reference credit costs.
 *
 * Pixmax bills in CREDITS. The API returns the authoritative cost per task
 * (`estimatedCost` before, `actualCost` after) — this module only supplies:
 *   1) an up-front ESTIMATE for display (measured 2026-07, may drift), and
 *   2) the request-shaping quirks that aren't obvious from the docs.
 *
 * Credit → USD depends on your plan (Starter 1.0¢, Pro 0.7¢, Ultra/Max 0.65¢,
 * annual 0.5¢). Override the display rate with PIXMAX_CREDIT_USD; default 0.7¢.
 */

export const CREDIT_USD = Number(process.env.PIXMAX_CREDIT_USD) || 0.007;

// Max reference images per image model (measured from the model configs).
export const MAX_REFS = {
    MIDJOURNEY: 5, MIDJOURNEY_V8_1: 5, MIDJOURNEY_NIJI_7: 5,
    QWEN_IMAGE_EDIT_MAX: 3, QWEN_IMAGE_EDIT_PLUS: 3,
    MINIMAX_IMAGE_01: 0, MINIMAX_IMAGE_01_LIVE: 0,
};
export const DEFAULT_MAX_REFS = 14;
export const maxRefsFor = (modelCode) => MAX_REFS[modelCode] ?? DEFAULT_MAX_REFS;

/**
 * Weave per-reference guidance into the prompt — the same convention the
 * IntelliStory pipeline uses, and one ByteDance models natively understand
 * (@Image tags). This is most of the quality gap between "raw refs attached"
 * and "refs the model knows how to use": each line tells the model what a
 * reference IS (role) and how hard to follow it (strength), plus a note.
 *
 * refs: [{ role, strength, note }] in upload order.
 */
export function weaveRefGuidance(prompt, refs = []) {
    const lines = refs.map((r, i) => {
        const parts = [`@Image${i + 1}`];
        const meta = [r.role, r.strength].filter(Boolean).join(', ');
        if (meta) parts.push(`[${meta}]`);
        let line = parts.join(' ');
        if (r.note) line += ` — ${r.note}`;
        return line;
    });
    if (!lines.length) return prompt;
    return `${prompt ? prompt + '\n\n' : ''}Reference images:\n${lines.join('\n')}`;
}

// Flat per-image credit cost (resolution, refs and prompt length are free).
export const IMAGE_CREDITS = {
    MINIMAX_IMAGE_01: 2, MINIMAX_IMAGE_01_LIVE: 2,
    BANANA: 4, JIMENG_5_LITE: 5, GPT_IMAGE_2: 6, DOUBAO_SEEDREAM_4_5: 6,
    WAN2_7_IMAGE: 8, QWEN_IMAGE_EDIT_PLUS: 8, DOUBAO_SEEDREAM_5_PRO: 10,
    BANANA_2: 14, MIDJOURNEY: 16, MIDJOURNEY_NIJI_7: 16, QWEN_IMAGE_EDIT_MAX: 16,
    WAN2_7_IMAGE_PRO: 16, BANANA_PRO: 18, MIDJOURNEY_V8_1: 20,
};

// Flat per-call credit cost (measured with short prompts; may scale with length).
export const TEXT_CREDITS = {
    DEEPSEEK_V4_FLASH: 1, DOUBAO_SEED_2_LITE: 1, GEMINI_25_FLASH: 1,
    GEMINI_3_FLASH: 1, GEMINI_31_FLASH: 1, MINIMAX_M3: 1,
    DEEPSEEK_V4_PRO: 2, DOUBAO_SEED_2_PRO: 2, GEMINI_25_PRO: 3,
    DOUBAO_SEED_2_1_TURBO: 3, GEMINI_31_PRO: 4,
};

// Audio scales with output duration → credits per second.
export const AUDIO_CREDITS_PER_SEC = {
    MINIMAX_SPEECH_28_TURBO: 0.125, MINIMAX_SPEECH_28_HD: 0.22,
    ELEVENLABS_V3: 0.75, ELEVENLABS_V2: 1.0, ELEVENLABS_MUSIC: 2.0,
    MINIMAX_MUSIC_26: 2.0, // requires `music_mode` + `lyrics`; cost estimate is approximate
};

export const THREE_D_CREDITS = { HUNYUAN_3D_PRO_30: 115, HUNYUAN_3D_PRO_31: 135 };

// Video scales with pixels × seconds → credits per second at 720p reference.
export const VIDEO_CREDITS_PER_SEC = {
    PIXVERSE_V6: 5, KLING_2_6: 4, SEEDANCE_1_5: 5, VIDU_Q2_PRO: 5, PIXVERSE_C1: 5,
    HAILUO_02: 6, HAILUO_23: 7, KLING_O1: 8, WAN2_7: 9, WAN2_6: 10,
    KLING_V3: 11, KLING_V3_OMNI: 11, PIXDANCE_2_MINI: 14, VIDU_Q3_PRO: 16,
    VIDU_Q3_MIX: 16, PIXDANCE_2_FAST: 22, VEO31: 25, HAPPYHORSE_10: 26, PIXDANCE_2: 28,
};

const REF_PIXELS = 1280 * 720;
const RES_PIXELS = {
    '480P': 864 * 496, '720P': 1280 * 720, '768P': 1366 * 768,
    '1080P': 1920 * 1080, '2K': 2560 * 1440, '4K': 3840 * 2160,
};

/** Rough up-front credit estimate for display. Null if unknown (the API still bills correctly). */
export function estimateCredits(modelCode, nodeType, { resolution = '720P', duration = 5, count = 1 } = {}) {
    let c = null;
    if (nodeType === 'GENERATE_VIDEO') {
        const perSec = VIDEO_CREDITS_PER_SEC[modelCode];
        if (perSec != null) c = perSec * Number(duration) * ((RES_PIXELS[String(resolution).toUpperCase()] || REF_PIXELS) / REF_PIXELS);
    } else if (nodeType === 'GENERATE_AUDIO') {
        const perSec = AUDIO_CREDITS_PER_SEC[modelCode];
        if (perSec != null) c = perSec * Number(duration || 10);
    } else if (nodeType === 'GENERATE_TEXT') c = TEXT_CREDITS[modelCode];
    else if (nodeType === 'GENERATE_3D') c = THREE_D_CREDITS[modelCode];
    else c = IMAGE_CREDITS[modelCode];
    return c == null ? null : Math.round(c * Number(count || 1) * 100) / 100;
}

/**
 * Shape the `params` object for a task, applying the per-model quirks that
 * aren't documented and will otherwise fail:
 *   • VEO31 rejects duration=5 (must be 8)
 *   • Hailuo accepts only duration 6 or 10
 *   • VIDU_Q3_MIX supports referModel "imageRefer" only
 *   • Hunyuan 3D is textTo3D only (imageTo3D fails)
 *   • MiniMax Music requires a `lyrics` param
 */
export function buildParams(modelCode, nodeType, input = {}) {
    const p = {};
    if (nodeType === 'GENERATE_VIDEO') {
        p.resolution = String(input.resolution || '720p').toUpperCase();
        let dur = parseInt(input.duration) || 5;
        if (modelCode === 'VEO31') dur = 8;
        if (/^HAILUO/.test(modelCode) && dur !== 6 && dur !== 10) dur = 6;
        p.duration = String(dur);
        p.aspectRatio = input.aspect_ratio || '16:9';
        p.includeAudio = input.include_audio ?? false;
        p.referModel = input.refer_model
            || (modelCode === 'VIDU_Q3_MIX' ? 'imageRefer'
                : input.has_image ? 'imageToVideo' : 'textToVideo');
        p.count = Number(input.count || 1);
    } else if (nodeType === 'GENERATE_IMAGE' || nodeType === 'GENERATE_STORYBOARD') {
        p.resolution = String(input.resolution || '2K').toUpperCase(); // resolution is free
        p.aspectRatio = input.aspect_ratio || '16:9';
        if (modelCode === 'GPT_IMAGE_2') p.quality = input.quality || 'medium';
        if (/^QWEN_IMAGE_EDIT/.test(modelCode)) p.promptExtend = input.prompt_extend ?? true;
        p.count = Number(input.count || 1);
    } else if (nodeType === 'GENERATE_AUDIO') {
        if (input.duration) p.duration = Number(input.duration);
        if (modelCode === 'MINIMAX_MUSIC_26') {
            if (input.lyrics) p.lyrics = input.lyrics;
            if (input.music_mode) p.musicMode = input.music_mode; // required by MiniMax Music
        }
    } else if (nodeType === 'GENERATE_3D') {
        p.referModel = 'textTo3D';
        p.generateType = input.generate_type || 'Normal';
        p.enablePBR = input.enable_pbr ?? false;
        p.faceCount = String(input.face_count || 300000);
        p.polygonType = input.polygon_type || 'triangle';
        p.count = 1;
    }
    return p;
}
