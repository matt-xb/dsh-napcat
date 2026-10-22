/** 媒体收发：本地文件 ↔ base64、URL 下载、收件目录。NapCat 在远端时一律用 base64。 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
export const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;
export function isHttpUrl(text) {
    return /^https?:\/\//i.test(text);
}
/** 把任意名字洗成安全的单段文件名。 */
export function safeName(name, fallback) {
    const base = basename(name.replace(/[\\/]+$/, ''))
        .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
        .trim();
    if (base === '' || base === '.' || base === '..')
        return fallback;
    return base.slice(0, 80);
}
/** 每个会话自己的收件箱目录（在会话 cwd 下，agent 可直接读取）。 */
export async function ensureInbox(cwd) {
    const dir = join(cwd, 'napcat-inbox');
    await mkdir(dir, { recursive: true });
    return dir;
}
/** 插件自己的临时目录（下载 URL 用）。 */
export async function ensureTempDir() {
    const dir = join(tmpdir(), 'dsh-napcat');
    await mkdir(dir, { recursive: true });
    return dir;
}
/** 下载到目录，返回本地绝对路径；超限直接抛错。 */
export async function downloadToFile(url, dir, name, maxBytes) {
    const response = await fetch(url);
    if (!response.ok)
        throw new Error('下载失败 HTTP ' + response.status + ': ' + url);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
        throw new Error('文件超过上限 ' + Math.round(maxBytes / 1024 / 1024) + 'MB（实际 ' + Math.round(buffer.byteLength / 1024) + 'KB）');
    }
    const target = join(dir, Date.now().toString(36) + '-' + safeName(name, 'download'));
    await writeFile(target, buffer);
    return { path: target, bytes: buffer.byteLength };
}
/** 本地文件 → base64://（NapCat 在远端也能用）。 */
export async function localToBase64Url(path, maxBytes) {
    const buffer = await readFile(path);
    if (buffer.byteLength > maxBytes) {
        throw new Error('文件超过上限 ' + Math.round(maxBytes / 1024 / 1024) + 'MB（实际 ' + Math.round(buffer.byteLength / 1024) + 'KB）: ' + path);
    }
    return { url: 'base64://' + buffer.toString('base64'), bytes: buffer.byteLength, name: safeName(path, 'file') };
}
/** 路径或 URL → base64://（URL 先下到临时目录）。 */
export async function sourceToBase64Url(source, maxBytes) {
    if (!isHttpUrl(source))
        return await localToBase64Url(source, maxBytes);
    const dir = await ensureTempDir();
    const name = safeName(source.split('?')[0]?.split('/').pop() ?? 'download', 'download');
    const { path, bytes } = await downloadToFile(source, dir, name, maxBytes);
    return { url: 'base64://' + (await readFile(path)).toString('base64'), bytes, name };
}
/** base64://… → Buffer（收文件时 NapCat 可能直接回 base64）。 */
export function base64UrlToBuffer(value) {
    const raw = value.startsWith('base64://') ? value.slice('base64://'.length) : value;
    return Buffer.from(raw, 'base64');
}
/** 从「file:///path」「C:\\x\\y.png」「a.png」里取一个像样的文件名。 */
export function nameFromRef(ref, fallback) {
    let candidate = ref;
    if (candidate.startsWith('file://'))
        candidate = candidate.slice('file://'.length);
    candidate = candidate.split('?')[0] ?? candidate;
    const segments = candidate.split(/[\\/]/);
    return safeName(segments[segments.length - 1] ?? '', fallback);
}
