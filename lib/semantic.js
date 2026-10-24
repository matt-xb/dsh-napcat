import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const MODEL = 'Xenova/bge-small-zh-v1.5';
const MIN_COSINE = 0.45;
const BAND = 0.08;
const CACHE_FILE = 'stickers-embeddings.json';
let extractor;
let ready;
const vectors = new Map();
const keyOf = (id, text) => id + '\u0000' + text;
async function loadExtractor(cacheDir) {
    if (extractor)
        return extractor;
    const mod = await import('@xenova/transformers');
    mod.env.remoteHost = 'https://hf-mirror.com';
    mod.env.cacheDir = cacheDir;
    mod.env.allowLocalModels = true;
    extractor = await mod.pipeline('feature-extraction', MODEL, { quantized: true });
    return extractor;
}
async function encode(texts, cacheDir) {
    const pipe = await loadExtractor(cacheDir);
    const out = await pipe(texts, { pooling: 'mean', normalize: true });
    const dim = out.dims[1];
    const data = out.data;
    return texts.map((_, index) => {
        const vec = new Float32Array(dim);
        for (let i = 0; i < dim; i++)
            vec[i] = data[index * dim + i];
        return vec;
    });
}
const normalizeText = (value) => value.normalize('NFKC').replace(/\s+/g, ' ').trim();
async function loadCache(cacheDir) {
    try {
        const raw = JSON.parse(await readFile(join(cacheDir, CACHE_FILE), 'utf8'));
        if (raw?.model !== MODEL || !raw.items)
            return null;
        return raw.items;
    }
    catch {
        return null;
    }
}
async function persist(cacheDir) {
    const items = {};
    for (const [key, vec] of vectors)
        items[key] = Array.from(vec, value => Math.round(value * 1e4) / 1e4);
    try {
        await mkdir(cacheDir, { recursive: true });
        await writeFile(join(cacheDir, CACHE_FILE), JSON.stringify({ model: MODEL, dim: 512, items }), 'utf8');
    }
    catch { /* Cache is optional; a failed write only costs a re-encode. */ }
}
function init(items, cacheDir) {
    ready ??= (async () => {
        const cached = await loadCache(cacheDir);
        const pending = [];
        for (const item of items) {
            const text = normalizeText(item.text);
            if (!text)
                continue;
            const key = keyOf(item.id, text);
            const hit = cached?.[key];
            if (Array.isArray(hit) && hit.length === 512) {
                vectors.set(key, Float32Array.from(hit));
                continue;
            }
            pending.push({ key, text });
        }
        if (pending.length) {
            const encoded = await encode(pending.map(item => item.text), cacheDir);
            pending.forEach((item, index) => vectors.set(item.key, encoded[index]));
            await persist(cacheDir);
        }
        return true;
    })();
    return ready;
}
/**
 * Cosine similarity per catalog id. Returns an empty map when the local model
 * is missing or fails, so the caller keeps its lexical ranking untouched.
 */
export async function semanticScores(items, query, cacheDir) {
    const scores = new Map();
    if (!items.length || !query.trim())
        return scores;
    try {
        await init(items, cacheDir);
        const [queryVec] = await encode([normalizeText(query)], cacheDir);
        const dots = [];
        for (const item of items) {
            const vec = vectors.get(keyOf(item.id, normalizeText(item.text)));
            if (!vec)
                continue;
            let dot = 0;
            for (let i = 0; i < vec.length; i++)
                dot += vec[i] * queryVec[i];
            dots.push([item.id, dot]);
        }
        if (!dots.length)
            return scores;
        // bge scores cluster high, so keep only the band below the best hit.
        const top = Math.max(...dots.map(([, dot]) => dot));
        if (top < MIN_COSINE)
            return scores;
        for (const [id, dot] of dots) {
            if (dot >= top - BAND)
                scores.set(id, dot);
        }
    }
    catch {
        return new Map();
    }
    return scores;
}
export async function warmSemantic(items, cacheDir) {
    try {
        await init(items, cacheDir);
        return true;
    }
    catch {
        return false;
    }
}
