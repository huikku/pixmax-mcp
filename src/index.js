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
 *   get_task         poll a task started with wait=false
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import * as px from './pixmax.js';
import { buildParams, estimateCredits, CREDIT_USD } from './models.js';

const server = new McpServer({ name: 'pixmax', version: '0.1.0' });

// ── helpers ────────────────────────────────────────────────────────────────

let _catalog = null;
async function catalog() {
    if (!_catalog) _catalog = await px.listModels();
    return _catalog;
}

/** Resolve a model argument (exact code, exact name, or partial name) → catalog entry. */
async function resolveModel(arg) {
    const all = await catalog();
    const lc = String(arg).toLowerCase();
    return (
        all.find((m) => m.modelCode === arg) ||
        all.find((m) => (m.modelName || '').toLowerCase() === lc) ||
        all.find((m) => (m.modelName || '').toLowerCase().includes(lc)) ||
        null
    );
}

/** Upload reference images (local paths or URLs) → assetsUuids. */
async function uploadRefs(refs = []) {
    const ids = [];
    for (const ref of refs) ids.push(await px.uploadAsset(await px.loadAsset(ref)));
    return ids;
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
async function runTask({ model, nodeType, prompt, refs = [], paramInput = {}, saveTo, wait = true }) {
    const m = await resolveModel(model);
    if (!m) throw new Error(`Unknown model "${model}". Call list_models to see what your key can use.`);
    if (m.nodeType !== nodeType) {
        throw new Error(`Model "${m.modelName}" is a ${m.nodeType} model, not ${nodeType}. Use the matching generate_* tool.`);
    }
    const projectUuid = await px.ensureProject();
    const inputAssetUuids = await uploadRefs(refs);
    const params = buildParams(m.modelCode, nodeType, { ...paramInput, has_image: inputAssetUuids.length > 0 });
    const taskUuid = await px.submitTask({ projectUuid, modelCode: m.modelCode, nodeType, prompt, inputAssetUuids, params });

    if (!wait) {
        const est = estimateCredits(m.modelCode, nodeType, params);
        return text(`Task submitted: ${taskUuid}\nModel: ${m.modelName}\n${est != null ? `Estimated cost: ${est} credits\n` : ''}Poll it with get_task.`);
    }

    const detail = await px.pollTask(taskUuid);
    const assets = px.resultAssets(detail);
    const saved = await saveResults(assets, saveTo);
    return { detail, m, assets, saved };
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
            'consistency — up to 14, and they are free. Blocks until the image is ready and returns the URL(s).',
        inputSchema: {
            prompt: z.string().describe('What to generate'),
            model: z.string().describe('Model code or name, e.g. "DOUBAO_SEEDREAM_5_PRO" or "Seedream 5.0 Pro"'),
            reference_images: z.array(z.string()).optional().describe('Local paths or URLs to condition on (i2i / character refs)'),
            resolution: z.string().optional().describe('e.g. 1K, 2K, 4K — resolution is free on most Pixmax image models'),
            aspect_ratio: z.string().optional().describe('e.g. 16:9, 1:1, 9:16'),
            count: z.number().int().min(1).max(4).optional().describe('Number of images (billed linearly)'),
            save_to: z.string().optional().describe('Directory to save the result(s) — Pixmax URLs expire'),
        },
    },
    async (a) => {
        try {
            const r = await runTask({
                model: a.model, nodeType: 'GENERATE_IMAGE', prompt: a.prompt, refs: a.reference_images,
                paramInput: { resolution: a.resolution, aspect_ratio: a.aspect_ratio, count: a.count }, saveTo: a.save_to,
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
            duration: z.number().int().optional().describe('Seconds (model-dependent; Veo=8, Hailuo=6|10)'),
            resolution: z.string().optional().describe('e.g. 720P, 1080P'),
            aspect_ratio: z.string().optional().describe('e.g. 16:9, 9:16'),
            include_audio: z.boolean().optional(),
            save_to: z.string().optional().describe('Directory to save the .mp4 — Pixmax URLs expire'),
            wait: z.boolean().optional().describe('Default true. false = return a task id immediately (poll with get_task)'),
        },
    },
    async (a) => {
        try {
            const r = await runTask({
                model: a.model, nodeType: 'GENERATE_VIDEO', prompt: a.prompt,
                refs: a.image ? [a.image] : [],
                paramInput: { duration: a.duration, resolution: a.resolution, aspect_ratio: a.aspect_ratio, include_audio: a.include_audio },
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
            const m = await resolveModel(a.model);
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
            save_to: z.string().optional().describe('Directory to save the .glb — Pixmax URLs expire'),
        },
    },
    async (a) => {
        try {
            const r = await runTask({ model: a.model || 'HUNYUAN_3D_PRO_30', nodeType: 'GENERATE_3D', prompt: a.prompt, saveTo: a.save_to });
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
        },
    },
    async (a) => {
        try {
            const r = await runTask({
                model: a.model, nodeType: 'GENERATE_AUDIO', prompt: a.prompt,
                paramInput: { duration: a.duration, lyrics: a.lyrics, music_mode: a.music_mode }, saveTo: a.save_to,
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

// ── start ────────────────────────────────────────────────────────────────

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // stderr is safe to log to; stdout is the MCP transport.
    console.error('pixmax-mcp running (stdio). Tools: list_models, generate_image, generate_video, generate_text, generate_3d, generate_audio, get_task');
}

main().catch((e) => {
    console.error('pixmax-mcp fatal:', e);
    process.exit(1);
});
