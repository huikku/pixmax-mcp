#!/usr/bin/env node
/**
 * pixmax-mcp — a Model Context Protocol server for the Pixmax generation API.
 *
 * Exposes Pixmax's image / video / text / audio / 3D models to any MCP client
 * (Claude Desktop, Cursor, etc.) as tools. Self-contained — talks straight to
 * console.pixmax.ai/openapi with your pk_live_ key. No third-party services.
 *
 * Tools:
 *   list_models      discover the models your key can use
 *   generate_image   Seedream, Nano Banana, Midjourney, GPT Image, Qwen, MiniMax, Wan
 *   generate_video   Kling, Veo, Hailuo, Wan, PixVerse, Vidu, Seedance
 *   generate_text    DeepSeek, Gemini, MiniMax, Doubao
 *   generate_3d      Hunyuan 3D (text → .glb)
 *   generate_audio   ElevenLabs, MiniMax (speech & music)
 *   generate_storyboard  GENERATE_STORYBOARD panels (GPT Image 2, Nano Banana 2/Pro)
 *   get_task         poll a task started with wait=false
 *   list_tasks       recent task history (status, prompt, result URLs)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import * as px from './pixmax.js';
import { buildParams, estimateCredits, CREDIT_USD, weaveRefGuidance, maxRefsFor } from './models.js';

const server = new McpServer({ name: 'pixmax', version: '0.1.0' });

// ── helpers ────────────────────────────────────────────────────────────────

let _catalog = null;
async function catalog() {
    if (!_catalog) _catalog = await px.listModels();
    return _catalog;
}

/**
 * Resolve a model argument (exact code, exact name, or partial name) → catalog entry.
 * A model code can appear under more than one nodeType (e.g. GPT_IMAGE_2 is both
 * GENERATE_IMAGE and GENERATE_STORYBOARD); pass `preferNodeType` to pick the right one.
 */
async function resolveModel(arg, preferNodeType) {
    const all = await catalog();
    const lc = String(arg).toLowerCase();
    const ok = (m) => !preferNodeType || m.nodeType === preferNodeType;
    const name = (m) => (m.modelName || '').toLowerCase();
    return (
        all.find((m) => m.modelCode === arg && ok(m)) ||
        all.find((m) => name(m) === lc && ok(m)) ||
        all.find((m) => name(m).includes(lc) && ok(m)) ||
        all.find((m) => m.modelCode === arg) ||
        all.find((m) => name(m) === lc) ||
        all.find((m) => name(m).includes(lc)) ||
        null
    );
}

/**
 * Normalize references: plain strings (path/URL) or rich objects
 * { source, role?, strength?, note? }. strength 'off' drops the ref.
 */
function normalizeRefs(refs = []) {
    return refs
        .map((r) => (typeof r === 'string' ? { source: r } : r))
        .filter((r) => r && r.source && (r.strength || 'strong') !== 'off')
        .map((r) => ({ source: r.source, role: r.role || 'character', strength: r.strength || 'strong', note: r.note || '' }));
}

/** Upload normalized refs (capped per model) → { ids, used, dropped }. */
async function uploadRefs(refs = [], modelCode) {
    const cap = maxRefsFor(modelCode);
    const used = refs.slice(0, cap);
    const dropped = refs.length - used.length;
    const ids = [];
    for (const ref of used) ids.push(await px.uploadAsset(await px.loadAsset(ref.source)));
    return { ids, used, dropped };
}

/** Optionally download results locally (Pixmax URLs expire). Returns saved paths. */
async function saveResults(assets, saveTo) {
    if (!saveTo || !assets.length) return [];
    await mkdir(saveTo, { recursive: true });
    const saved = [];
    for (const a of assets) {
        const r = await fetch(a.url);
        const buf = Buffer.from(await r.arrayBuffer());
        const name = basename(new URL(a.url).pathname) || `${Date.now()}.bin`;
        const p = join(saveTo, name);
        await writeFile(p, buf);
        saved.push(p);
    }
    return saved;
}

function costLine(detail) {
    const cr = detail.actualCost ?? detail.estimatedCost;
    if (cr == null) return '';
    return `\nCost: ${cr} credits (~$${(cr * CREDIT_USD).toFixed(3)})`;
}

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const err = (e) => ({ content: [{ type: 'text', text: `Error: ${e && e.message ? e.message : e}` }], isError: true });

/**
 * Shared submit → (wait) → format path for the media-producing tools.
 * With wait=false it returns the task id so a long job can be polled via get_task.
 */
async function runTask({ model, nodeType, prompt, refs = [], style, paramInput = {}, saveTo, wait = true }) {
    const m = await resolveModel(model, nodeType);
    if (!m) throw new Error(`Unknown model "${model}". Call list_models to see what your key can use.`);
    if (m.nodeType !== nodeType) {
        throw new Error(`Model "${m.modelName}" is a ${m.nodeType} model, not ${nodeType}. Use the matching generate_* tool.`);
    }
    const projectUuid = await px.ensureProject();

    // References: upload (capped per model) + weave per-ref guidance into the
    // prompt — the convention ByteDance models natively understand, and the
    // main quality gap vs raw images silently attached.
    const normRefs = normalizeRefs(refs);
    const { ids: inputAssetUuids, used, dropped } = await uploadRefs(normRefs, m.modelCode);

    // Style scaffolding — a consistent visual-language suffix (lightweight
    // equivalent of IntelliStory's Look injection).
    let effPrompt = prompt || '';
    if (style) effPrompt = `${effPrompt ? effPrompt + '\n\n' : ''}Style: ${style}`;
    effPrompt = weaveRefGuidance(effPrompt, used);

    const params = buildParams(m.modelCode, nodeType, { ...paramInput, has_image: inputAssetUuids.length > 0 });
    const submit = () => px.submitTask({ projectUuid, modelCode: m.modelCode, nodeType, prompt: effPrompt, inputAssetUuids, params });
    let taskUuid = await submit();

    if (!wait) {
        const est = estimateCredits(m.modelCode, nodeType, params);
        return text(`Task submitted: ${taskUuid}\nModel: ${m.modelName}\n${est != null ? `Estimated cost: ${est} credits\n` : ''}Poll it with get_task.`);
    }

    // One automatic resubmit on a FAILED generation (provider flakiness is
    // real; failed tasks cost 0 credits). Disable with PIXMAX_RETRIES=0.
    let detail;
    try {
        detail = await px.pollTask(taskUuid);
    } catch (e) {
        const retries = process.env.PIXMAX_RETRIES === '0' ? 0 : 1;
        if (!retries || !/FAILED/i.test(e.message)) throw e;
        taskUuid = await submit();
        detail = await px.pollTask(taskUuid);
    }
    const assets = px.resultAssets(detail);
    const saved = await saveResults(assets, saveTo);
    return { detail, m, assets, saved, dropped };
}

// ── tools ──────────────────────────────────────────────────────────────────

server.registerTool(
    'list_models',
    {
        title: 'List Pixmax models',
        description:
            'List the models your Pixmax key can use, with type and an estimated credit cost. ' +
            'Optionally filter by node type. Call this first to discover exact model codes.',
        inputSchema: {
            node_type: z
                .enum(['GENERATE_IMAGE', 'GENERATE_VIDEO', 'GENERATE_TEXT', 'GENERATE_AUDIO', 'GENERATE_3D'])
                .optional()
                .describe('Filter to one category'),
        },
    },
    async ({ node_type }) => {
        try {
            const all = await catalog();
            const rows = all
                .filter((m) => !node_type || m.nodeType === node_type)
                .sort((a, b) => a.nodeType.localeCompare(b.nodeType) || a.modelCode.localeCompare(b.modelCode))
                .map((m) => {
                    const est = estimateCredits(m.modelCode, m.nodeType);
                    const cost = est != null ? `~${est}${m.nodeType === 'GENERATE_VIDEO' || m.nodeType === 'GENERATE_AUDIO' ? 'cr/s' : 'cr'}` : '';
                    return `${m.modelCode.padEnd(24)} ${(m.modelName || '').padEnd(26)} [${m.nodeType.replace('GENERATE_', '')}] ${cost}`;
                });
            return text(rows.join('\n') || '(no models available to this key)');
        } catch (e) {
            return err(e);
        }
    }
);

server.registerTool(
    'generate_image',
    {
        title: 'Generate an image',
        description:
            'Generate an image with a Pixmax model (Seedream 5 Pro/Lite, Nano Banana / 2 / Pro, Midjourney V7/V8.1/Niji, ' +
            'GPT Image 2, Qwen, MiniMax, Wan). Pass reference_images (file paths or URLs) for image-to-image or character ' +
            'consistency — up to 14, and they are free. Rich refs ({source, role, strength, note}) get their guidance woven into the prompt. `style` keeps a whole set visually coherent. Failed generations retry once automatically. Blocks until ready and returns the URL(s).',
        inputSchema: {
            prompt: z.string().describe('What to generate'),
            model: z.string().describe('Model code or name, e.g. "DOUBAO_SEEDREAM_5_PRO" or "Seedream 5.0 Pro"'),
            reference_images: z.array(z.union([
                z.string(),
                z.object({
                    source: z.string().describe('Local path or URL'),
                    role: z.string().optional().describe('What this ref is: character, style, composition, background, lighting…'),
                    strength: z.enum(['off', 'hint', 'flexible', 'strong', 'strict']).optional().describe('How closely to follow it (default strong; off = skip)'),
                    note: z.string().optional().describe('What to take from this ref, e.g. "keep the goggles exactly"'),
                }),
            ])).optional().describe('References — plain paths/URLs, or rich objects with role/strength/note; guidance is woven into the prompt so the model knows what each ref is FOR'),
            style: z.string().optional().describe('Visual-language suffix applied consistently across generations (e.g. "handmade stop-motion miniature, muted palette")'),
            resolution: z.string().optional().describe('e.g. 1K, 2K, 4K — resolution is free on most Pixmax image models'),
            aspect_ratio: z.string().optional().describe('e.g. 16:9, 1:1, 9:16'),
            count: z.number().int().min(1).max(4).optional().describe('Number of images (billed linearly)'),
            quality: z.enum(['low', 'medium', 'high']).optional().describe('GPT Image 2 only — render quality (default medium)'),
            prompt_extend: z.boolean().optional().describe('Qwen Image Edit only — auto-expand the prompt (default true)'),
            save_to: z.string().optional().describe('Directory to save the result(s) — Pixmax URLs expire'),
            wait: z.boolean().optional().describe('Default true. false = return a task id immediately (poll with get_task)'),
        },
    },
    async (a) => {
        try {
            const r = await runTask({
                model: a.model, nodeType: 'GENERATE_IMAGE', prompt: a.prompt, refs: a.reference_images, style: a.style,
                paramInput: { resolution: a.resolution, aspect_ratio: a.aspect_ratio, count: a.count, quality: a.quality, prompt_extend: a.prompt_extend },
                saveTo: a.save_to, wait: a.wait !== false,
            });
            if (r.content) return r; // wait=false path (not used here) / passthrough
            return text(
                `Generated ${r.assets.length} image(s) with ${r.m.modelName}:\n` +
                r.assets.map((x) => `  ${x.url}  (${x.width}x${x.height})`).join('\n') +
                (r.saved.length ? `\nSaved: ${r.saved.join(', ')}` : '') +
                costLine(r.detail)
            );
        } catch (e) {
            return err(e);
        }
    }
);

server.registerTool(
    'generate_video',
    {
        title: 'Generate a video',
        description:
            'Generate a video with a Pixmax model (Kling V3/O1/2.6, Veo 3.1, Hailuo, Wan, PixVerse, Vidu, Seedance). ' +
            'Pass an image (path or URL) for image-to-video. Note: Veo 3.1 runs 8s; Hailuo runs 6s or 10s. ' +
            'Video can take a few minutes; set wait=false to get a task id and poll with get_task.',
        inputSchema: {
            prompt: z.string(),
            model: z.string().describe('Model code or name, e.g. "KLING_V3" or "Veo 3.1"'),
            image: z.string().optional().describe('Local path or URL for image-to-video (first frame / reference)'),
            reference_images: z.array(z.union([
                z.string(),
                z.object({
                    source: z.string().describe('Local path or URL'),
                    role: z.string().optional().describe('What this ref is: character, style, composition, background, lighting…'),
                    strength: z.enum(['off', 'hint', 'flexible', 'strong', 'strict']).optional().describe('How closely to follow it (default strong; off = skip)'),
                    note: z.string().optional().describe('What to take from this ref, e.g. "keep the goggles exactly"'),
                }),
            ])).optional().describe('Multiple reference images for i2v / reference-to-video (first = primary frame); rich objects add role/strength/note guidance'),
            style: z.string().optional().describe('Visual-language suffix for consistency across clips'),
            duration: z.number().int().optional().describe('Seconds (model-dependent; Veo=8, Hailuo=6|10)'),
            resolution: z.string().optional().describe('e.g. 480P, 720P, 1080P'),
            aspect_ratio: z.string().optional().describe('e.g. 16:9, 9:16'),
            include_audio: z.boolean().optional(),
            count: z.number().int().min(1).max(4).optional().describe('Number of clips (billed linearly)'),
            refer_model: z.string().optional().describe('Override the reference mode, e.g. "textToVideo", "imageToVideo", "imageRefer" (Vidu Q3 Mix requires imageRefer)'),
            save_to: z.string().optional().describe('Directory to save the .mp4 — Pixmax URLs expire'),
            wait: z.boolean().optional().describe('Default true. false = return a task id immediately (poll with get_task)'),
        },
    },
    async (a) => {
        try {
            const refs = [...(a.image ? [a.image] : []), ...(a.reference_images || [])];
            const r = await runTask({
                model: a.model, nodeType: 'GENERATE_VIDEO', prompt: a.prompt,
                refs, style: a.style,
                paramInput: { duration: a.duration, resolution: a.resolution, aspect_ratio: a.aspect_ratio, include_audio: a.include_audio, count: a.count, refer_model: a.refer_model },
                saveTo: a.save_to, wait: a.wait !== false,
            });
            if (r.content) return r;
            const v = r.assets[0];
            return text(
                `Generated video with ${r.m.modelName}:\n  ${v?.url}  (${v?.width}x${v?.height}, ${Math.round(v?.duration || 0)}s)` +
                (r.saved.length ? `\nSaved: ${r.saved.join(', ')}` : '') +
                costLine(r.detail)
            );
        } catch (e) {
            return err(e);
        }
    }
);

server.registerTool(
    'generate_text',
    {
        title: 'Generate text',
        description: 'Run a text/LLM model (DeepSeek V4, Gemini 3.1, MiniMax, Doubao Seed). Returns the generated text.',
        inputSchema: {
            prompt: z.string(),
            model: z.string().describe('Model code or name, e.g. "DEEPSEEK_V4_FLASH"'),
        },
    },
    async (a) => {
        try {
            const m = await resolveModel(a.model, 'GENERATE_TEXT');
            if (!m) throw new Error(`Unknown model "${a.model}". Call list_models.`);
            if (m.nodeType !== 'GENERATE_TEXT') throw new Error(`"${m.modelName}" is ${m.nodeType}, not a text model.`);
            const projectUuid = await px.ensureProject();
            const taskUuid = await px.submitTask({ projectUuid, modelCode: m.modelCode, nodeType: 'GENERATE_TEXT', prompt: a.prompt });
            const detail = await px.pollTask(taskUuid, { timeoutMs: 3 * 60 * 1000 });
            return text((detail.resultText || '(no text returned)') + costLine(detail));
        } catch (e) {
            return err(e);
        }
    }
);

server.registerTool(
    'generate_3d',
    {
        title: 'Generate a 3D model',
        description: 'Generate a 3D model (.glb) from a text prompt with Hunyuan 3D. Text-to-3D only (image-to-3D is not supported).',
        inputSchema: {
            prompt: z.string(),
            model: z.string().optional().describe('Default HUNYUAN_3D_PRO_30. Or HUNYUAN_3D_PRO_31.'),
            generate_type: z.string().optional().describe('Mesh generation type (default "Normal")'),
            enable_pbr: z.boolean().optional().describe('Generate PBR materials (default false)'),
            face_count: z.number().int().optional().describe('Target face count (default 300000)'),
            polygon_type: z.enum(['triangle', 'quad']).optional().describe('Mesh topology (default triangle)'),
            save_to: z.string().optional().describe('Directory to save the .glb — Pixmax URLs expire'),
            wait: z.boolean().optional().describe('Default true. false = return a task id immediately (poll with get_task). 3D is slow — consider false.'),
        },
    },
    async (a) => {
        try {
            const r = await runTask({
                model: a.model || 'HUNYUAN_3D_PRO_30', nodeType: 'GENERATE_3D', prompt: a.prompt,
                paramInput: { generate_type: a.generate_type, enable_pbr: a.enable_pbr, face_count: a.face_count, polygon_type: a.polygon_type },
                saveTo: a.save_to, wait: a.wait !== false,
            });
            if (r.content) return r;
            const g = r.assets[0];
            return text(`Generated 3D model with ${r.m.modelName}:\n  ${g?.url}` + (r.saved.length ? `\nSaved: ${r.saved.join(', ')}` : '') + costLine(r.detail));
        } catch (e) {
            return err(e);
        }
    }
);

server.registerTool(
    'generate_audio',
    {
        title: 'Generate audio',
        description:
            'Generate speech or music (ElevenLabs V2/V3/Music, MiniMax Speech/Music). For MiniMax Music pass `lyrics`. ' +
            'Cost scales with duration.',
        inputSchema: {
            prompt: z.string().describe('Text to speak, or a music description'),
            model: z.string().describe('Model code or name, e.g. "ELEVENLABS_V3" or "MINIMAX_SPEECH_28_HD"'),
            duration: z.number().int().optional().describe('Seconds (music models)'),
            lyrics: z.string().optional().describe('For MiniMax Music'),
            music_mode: z.string().optional().describe('Required by MiniMax Music (MINIMAX_MUSIC_26) — see Pixmax docs for values'),
            save_to: z.string().optional().describe('Directory to save the audio — Pixmax URLs expire'),
            wait: z.boolean().optional().describe('Default true. false = return a task id immediately (poll with get_task)'),
        },
    },
    async (a) => {
        try {
            const r = await runTask({
                model: a.model, nodeType: 'GENERATE_AUDIO', prompt: a.prompt,
                paramInput: { duration: a.duration, lyrics: a.lyrics, music_mode: a.music_mode },
                saveTo: a.save_to, wait: a.wait !== false,
            });
            if (r.content) return r;
            const au = r.assets[0];
            return text(`Generated audio with ${r.m.modelName}:\n  ${au?.url}  (${Math.round(au?.duration || 0)}s)` + (r.saved.length ? `\nSaved: ${r.saved.join(', ')}` : '') + costLine(r.detail));
        } catch (e) {
            return err(e);
        }
    }
);

server.registerTool(
    'get_task',
    {
        title: 'Get task status / result',
        description: 'Check a task started with wait=false. Returns status, and result URL(s) + cost once COMPLETE.',
        inputSchema: {
            task_id: z.string(),
            save_to: z.string().optional().describe('If COMPLETE, save the result(s) here'),
        },
    },
    async ({ task_id, save_to }) => {
        try {
            const detail = await px.getTask(task_id);
            if (detail.status !== 'COMPLETE') {
                return text(`Status: ${detail.status}${detail.progress != null ? ` (${detail.progress}%)` : ''}${detail.providerErrorMsg ? `\n${detail.providerErrorMsg}` : ''}`);
            }
            const assets = px.resultAssets(detail);
            const saved = await saveResults(assets, save_to);
            return text(
                `COMPLETE — ${assets.length} result(s):\n` +
                assets.map((x) => `  ${x.url}`).join('\n') +
                (saved.length ? `\nSaved: ${saved.join(', ')}` : '') +
                costLine(detail)
            );
        } catch (e) {
            return err(e);
        }
    }
);

server.registerTool(
    'generate_storyboard',
    {
        title: 'Generate a storyboard panel',
        description:
            'Generate an image via the GENERATE_STORYBOARD node type (GPT Image 2, Nano Banana 2, Nano Banana Pro). ' +
            'Identical to generate_image — same pricing, same single-image output — just classified under a different ' +
            'node type. No multi-panel behavior; use generate_image unless something downstream specifically requires ' +
            'the GENERATE_STORYBOARD classification. Pass reference_images for consistency.',
        inputSchema: {
            prompt: z.string().describe('The panel to generate'),
            model: z.string().optional().describe('Storyboard-capable model (default BANANA_PRO). Also GPT_IMAGE_2, BANANA_2.'),
            reference_images: z.array(z.union([
                z.string(),
                z.object({
                    source: z.string().describe('Local path or URL'),
                    role: z.string().optional().describe('What this ref is: character, style, composition, background, lighting…'),
                    strength: z.enum(['off', 'hint', 'flexible', 'strong', 'strict']).optional().describe('How closely to follow it (default strong; off = skip)'),
                    note: z.string().optional().describe('What to take from this ref, e.g. "keep the goggles exactly"'),
                }),
            ])).optional().describe('References with optional role/strength/note guidance'),
            style: z.string().optional().describe('Visual-language suffix for a consistent board set'),
            resolution: z.string().optional().describe('e.g. 1K, 2K, 4K — free on most models'),
            aspect_ratio: z.string().optional().describe('e.g. 16:9, 1:1, 9:16'),
            count: z.number().int().min(1).max(4).optional().describe('Number of panels (billed linearly)'),
            save_to: z.string().optional().describe('Directory to save the result(s) — Pixmax URLs expire'),
            wait: z.boolean().optional().describe('Default true. false = return a task id immediately (poll with get_task)'),
        },
    },
    async (a) => {
        try {
            const r = await runTask({
                model: a.model || 'BANANA_PRO', nodeType: 'GENERATE_STORYBOARD', prompt: a.prompt, refs: a.reference_images, style: a.style,
                paramInput: { resolution: a.resolution, aspect_ratio: a.aspect_ratio, count: a.count },
                saveTo: a.save_to, wait: a.wait !== false,
            });
            if (r.content) return r;
            return text(
                `Generated ${r.assets.length} storyboard panel(s) with ${r.m.modelName}:\n` +
                r.assets.map((x) => `  ${x.url}  (${x.width}x${x.height})`).join('\n') +
                (r.saved.length ? `\nSaved: ${r.saved.join(', ')}` : '') +
                costLine(r.detail)
            );
        } catch (e) {
            return err(e);
        }
    }
);

server.registerTool(
    'list_tasks',
    {
        title: 'List recent tasks',
        description:
            'List your recent Pixmax generation tasks (newest first) with status, model, prompt, and result URL(s). ' +
            'Useful for recovering a result you forgot to save, checking on wait=false jobs, or auditing recent activity.',
        inputSchema: {
            limit: z.number().int().min(1).max(100).optional().describe('How many tasks to return (default 20)'),
            status: z
                .enum(['QUEUE', 'RUNNING', 'COMPLETE', 'FAILED', 'ABORTED'])
                .optional()
                .describe('Filter to one status'),
        },
    },
    async ({ limit, status }) => {
        try {
            const { items, totalCount } = await px.listTasks({ pageSize: limit || 20, status });
            if (!items.length) return text('No tasks found.');
            const rows = items.map((t) => {
                const when = t.createTime ? new Date(Number(t.createTime) * 1000).toISOString().replace('T', ' ').slice(0, 16) : '';
                const prompt = (t.inputTexts && t.inputTexts[0] ? t.inputTexts[0] : '').slice(0, 60);
                const assets = px.resultAssets(t);
                const urls = assets.map((x) => x.url).filter(Boolean);
                return (
                    `${(t.status || '').padEnd(9)} ${(t.modelCode || '').padEnd(22)} ${when}  ${t.taskUuid}` +
                    (prompt ? `\n    "${prompt}"` : '') +
                    (urls.length ? `\n    ${urls.join('\n    ')}` : '') +
                    (t.providerErrorMsg ? `\n    ⚠ ${t.providerErrorMsg}` : '')
                );
            });
            return text(`Recent tasks (showing ${items.length} of ${totalCount}):\n\n` + rows.join('\n'));
        } catch (e) {
            return err(e);
        }
    }
);

// ── start ────────────────────────────────────────────────────────────────

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // stderr is safe to log to; stdout is the MCP transport.
    console.error('pixmax-mcp running (stdio). Tools: list_models, generate_image, generate_video, generate_text, generate_3d, generate_audio, generate_storyboard, get_task, list_tasks');
}

main().catch((e) => {
    console.error('pixmax-mcp fatal:', e);
    process.exit(1);
});
