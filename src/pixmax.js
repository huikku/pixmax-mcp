/**
 * Minimal, dependency-free client for the Pixmax OpenAPI.
 *
 * Base:  https://console.pixmax.ai/openapi
 * Auth:  Authorization: Bearer <PIXMAX_API_KEY>   (a pk_live_… platform key)
 * Flow:  ensureProject → (uploadAsset)* → submitTask → pollTask → resultAssets
 *
 * Everything is a POST returning { success, errCode, errMessage, data, ... }.
 * Uses only Node 18+ built-ins (fetch, FormData, Blob).
 */

import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

const BASE = process.env.PIXMAX_BASE_URL || 'https://console.pixmax.ai/openapi';

function getKey() {
    const k = (process.env.PIXMAX_API_KEY || '').trim();
    if (!k) {
        throw new Error(
            'PIXMAX_API_KEY is not set. Create a platform key (pk_live_…) in the Pixmax ' +
            'console and set PIXMAX_API_KEY in your MCP server config or environment.'
        );
    }
    return k;
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/** POST with retries: network errors and 5xx back off and retry (3 attempts). */
async function call(path, body) {
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
        let r;
        try {
            r = await fetch(BASE + path, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getKey() },
                body: JSON.stringify(body || {}),
            });
        } catch (e) {
            lastErr = new Error(`Pixmax ${path} network error: ${e.message}`);
            await sleep(attempt * 1500);
            continue;
        }
        let j;
        try { j = await r.json(); } catch { j = {}; }
        if (j && j.success) return j.data;
        const msg = `Pixmax ${path} failed (${r.status}): ${(j && (j.errMessage || j.errCode)) || 'unknown error'}`;
        if (r.status >= 500) { lastErr = new Error(msg); await sleep(attempt * 1500); continue; }
        throw new Error(msg);   // 4xx = our fault, don't retry
    }
    throw lastErr;
}

/** All models this key is authorised for. */
export async function listModels() {
    return call('/model/available', {});
}

let _projectCache = null;
/** A project UUID to attach tasks to. Reused within a process; overridable via PIXMAX_PROJECT_UUID. */
export async function ensureProject(name = 'pixmax-mcp') {
    if (process.env.PIXMAX_PROJECT_UUID) return process.env.PIXMAX_PROJECT_UUID;
    if (_projectCache) return _projectCache;
    _projectCache = await call('/project/createOrUpdate', { name, description: 'Created by pixmax-mcp' });
    return _projectCache;
}

const CONTENT_TYPES = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.gif': 'image/gif', '.bmp': 'image/bmp', '.tiff': 'image/tiff', '.heic': 'image/heic',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
};

/** Load a reference asset from a local file path OR an http(s) URL → {buffer, filename, contentType}. */
export async function loadAsset(pathOrUrl) {
    if (/^https?:\/\//i.test(pathOrUrl)) {
        const r = await fetch(pathOrUrl);
        if (!r.ok) throw new Error(`Could not fetch reference "${pathOrUrl}" (${r.status})`);
        const buffer = Buffer.from(await r.arrayBuffer());
        const name = basename(new URL(pathOrUrl).pathname) || 'ref';
        return { buffer, filename: name, contentType: r.headers.get('content-type') || 'application/octet-stream' };
    }
    const buffer = await readFile(pathOrUrl);
    const ext = extname(pathOrUrl).toLowerCase();
    return { buffer, filename: basename(pathOrUrl), contentType: CONTENT_TYPES[ext] || 'application/octet-stream' };
}

/** Upload one asset → assetsUuid (used as inputAssetUuids on a task). */
export async function uploadAsset({ buffer, filename = 'ref.png', contentType = 'image/png' }) {
    let lastErr;
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const fd = new FormData();
            fd.append('file', new Blob([buffer], { type: contentType }), filename);
            const r = await fetch(BASE + '/assets/upload', {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + getKey() }, // no Content-Type — fetch sets the multipart boundary
                body: fd,
            });
            let j;
            try { j = await r.json(); } catch { j = {}; }
            if (j && j.success) return j.data.assetsUuid || j.data.assetUuid;
            lastErr = new Error(`Pixmax asset upload failed (${r.status}): ${(j && j.errMessage) || 'unknown error'}`);
        } catch (e) { lastErr = e; }
        await sleep(1500);
    }
    throw lastErr;
}

/** Submit a generation task → taskUuid. */
export async function submitTask({ projectUuid, modelCode, nodeType, prompt = '', inputAssetUuids = [], params = {} }) {
    const data = await call('/task/submit', {
        projectUuid,
        ...(inputAssetUuids.length ? { inputAssetUuids } : {}),
        inputTexts: prompt ? [prompt] : [],
        params: { prompt, model: modelCode, nodeType, ...params },
    });
    return data.taskUuid;
}

/** Fetch a task's detail (status, results, estimatedCost/actualCost). */
export async function getTask(taskUuid) {
    return call('/task/detail', { taskUuid });
}

/**
 * List recent tasks for this key (newest first), paginated.
 * Returns { items, totalCount, pageIndex, pageSize }. Each item carries
 * status, modelCode, inputTexts and resultAssets — handy for recovering a
 * result URL you forgot to save, or auditing recent spend.
 */
export async function listTasks({ pageIndex = 1, pageSize = 20, status } = {}) {
    const r = await fetch(BASE + '/task/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getKey() },
        body: JSON.stringify({ pageIndex, pageSize, ...(status ? { status } : {}) }),
    });
    let j;
    try { j = await r.json(); } catch { j = {}; }
    if (!j || !j.success) {
        throw new Error(`Pixmax /task/list failed (${r.status}): ${(j && (j.errMessage || j.errCode)) || 'unknown error'}`);
    }
    // The API nests pagination meta at the top level with `data` as the array.
    const items = Array.isArray(j.data) ? j.data : (j.data && Array.isArray(j.data.data) ? j.data.data : []);
    return {
        items,
        totalCount: j.totalCount ?? j.data?.totalCount ?? items.length,
        pageIndex: j.pageIndex ?? j.data?.pageIndex ?? pageIndex,
        pageSize: j.pageSize ?? j.data?.pageSize ?? pageSize,
    };
}

/**
 * Poll until a task reaches a terminal state.
 * Statuses: QUEUE → RUNNING → COMPLETE | FAILED | ABORTED | RESOURCE_INSUFFICIENT.
 */
export async function pollTask(taskUuid, { timeoutMs = 12 * 60 * 1000, intervalMs = 4000, onProgress } = {}) {
    const start = Date.now();
    let pollErrors = 0;
    while (Date.now() - start < timeoutMs) {
        await new Promise((res) => setTimeout(res, intervalMs));
        let d;
        try {
            d = await getTask(taskUuid);
            pollErrors = 0;
        } catch (e) {
            // A blipped poll is not a failed generation — keep polling.
            if (++pollErrors >= 5) throw e;
            continue;
        }
        if (onProgress) { try { onProgress(d); } catch { /* ignore */ } }
        if (d.status === 'COMPLETE') return d;
        if (d.status === 'RESOURCE_INSUFFICIENT') throw new Error('Pixmax credit balance is exhausted (RESOURCE_INSUFFICIENT).');
        if (d.status === 'FAILED' || d.status === 'ABORTED') {
            throw new Error(`Pixmax task ${d.status}: ${d.providerErrorMsg || 'unknown error'}`);
        }
    }
    throw new Error(`Pixmax task ${taskUuid} timed out after ${Math.round(timeoutMs / 1000)}s.`);
}

const OSS_FALLBACK = 'https://pixmax-ai-prod.oss-accelerate.aliyuncs.com';

/**
 * Normalise a completed task's outputs to absolute URLs.
 * ⚠️ These live on Aliyun OSS with no documented TTL — download promptly if you need them.
 */
export function resultAssets(detail) {
    return (detail.resultAssets || []).map((a) => {
        const raw = a.webUrl || '';
        return {
            url: raw.startsWith('http') ? raw : (a.ossDomain || OSS_FALLBACK) + raw,
            assetsUuid: a.assetsUuid,
            fileType: a.fileType, // IMG | VIDEO | AUDIO | MODEL_3D
            width: a.metaData?.width,
            height: a.metaData?.height,
            duration: a.metaData?.duration,
        };
    });
}
