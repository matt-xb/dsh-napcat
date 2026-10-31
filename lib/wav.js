/** wav 结构校验与头回填：阿里云流式返回的 data 长度是占位值，落盘前必须按真实字节改写。 */
function chunkId(buffer, offset) {
    return buffer.subarray(offset, offset + 4).toString('latin1');
}
/**
 * 解析并校验 RIFF/WAVE。结构不通就抛错——退化音频（空壳、fmt 全零、没有音频帧）不许当成语音发出去。
 */
export function parseWav(buffer) {
    if (buffer.length < 44 || chunkId(buffer, 0) !== 'RIFF' || chunkId(buffer, 8) !== 'WAVE') {
        throw new Error('不是合法的 wav（' + buffer.length + ' 字节）');
    }
    let fmt = null;
    let data = null;
    let offset = 12;
    while (offset + 8 <= buffer.length) {
        const id = chunkId(buffer, offset);
        const size = buffer.readUInt32LE(offset + 4);
        const body = offset + 8;
        if (id === 'fmt ' && size >= 16 && body + 16 <= buffer.length) {
            fmt = {
                audioFormat: buffer.readUInt16LE(body),
                channels: buffer.readUInt16LE(body + 2),
                sampleRate: buffer.readUInt32LE(body + 4),
                bitsPerSample: buffer.readUInt16LE(body + 14),
            };
        }
        else if (id === 'data') {
            // 声明长度大于实际字节时按实际算：占位头（0x7FFFFFFF）走的正是这条路。
            data = { offset: body, length: Math.min(size, buffer.length - body) };
            break;
        }
        offset = body + size + (size % 2);
    }
    if (fmt === null)
        throw new Error('wav 缺少有效的 fmt 块（' + buffer.length + ' 字节）');
    if (fmt.channels === 0 || fmt.sampleRate === 0 || fmt.bitsPerSample === 0) {
        throw new Error('wav 的 fmt 块参数为 0（' + buffer.length + ' 字节）');
    }
    if (data === null)
        throw new Error('wav 缺少 data 块（' + buffer.length + ' 字节）');
    const frame = fmt.channels * (fmt.bitsPerSample / 8);
    if (data.length < frame)
        throw new Error('wav 的 data 块没有音频帧（' + buffer.length + ' 字节）');
    return { ...fmt, dataOffset: data.offset, dataLength: data.length };
}
/**
 * 把 RIFF/data 的尺寸字段改写成真实值，音频字节一个不动。
 * 阿里云 qwen-tts 返回的 wav 头是流式占位（data=0x7FFFFFFF），照原样落盘会让下游按错误长度读。
 */
export function normalizeWav(buffer) {
    const info = parseWav(buffer);
    const declaredData = buffer.readUInt32LE(info.dataOffset - 4);
    const declaredRiff = buffer.readUInt32LE(4);
    if (declaredData === info.dataLength && declaredRiff === buffer.length - 8) {
        return { buffer, fixed: false };
    }
    const copy = Buffer.from(buffer);
    copy.writeUInt32LE(info.dataLength, info.dataOffset - 4);
    copy.writeUInt32LE(copy.length - 8, 4);
    return { buffer: copy, fixed: true };
}
/**
 * 差额小于这个值就不补。QQ 侧是 Math.round，小数部分一旦 ≥ 0.5 本来就会进位，差额 < 30ms 时
 * 小数部分必然 ≥ 0.97，怎么取整都切不到有声部分，补它只是白送一段空白。
 */
export const PAD_MIN_MS = 30;
/**
 * 尾部补静音到下一个整秒，让最终 wav 时长天然是整数。
 *
 * NapCat 把小数的 duration 交给 QQ，QQ 侧按整秒收尾（Math.round），实测 38% 的合成音频会因此
 * 丢掉有声尾巴——TTS 尾部静音只有 10–67ms，几乎贴着最后一个音节就结束。补到整秒后 floor/round
 * 都切不到有声内容。补齐量由 ceil 保证一定 < 1 秒，不需要额外上限。非标准 PCM wav 原样返回。
 */
export function padWavToSecond(buffer) {
    let info;
    try {
        info = parseWav(buffer);
    }
    catch {
        // 补齐是锦上添花，不能因为它把整条语音弄挂。
        return { buffer, paddedMs: 0 };
    }
    if (info.audioFormat !== 1)
        return { buffer, paddedMs: 0 };
    const frameBytes = info.channels * (info.bitsPerSample / 8);
    // 按整帧算：补完的帧数必须是采样率的整数倍，否则尾部还留小数。
    const totalFrames = Math.floor(info.dataLength / frameBytes);
    const padFrames = Math.ceil(totalFrames / info.sampleRate) * info.sampleRate - totalFrames;
    // 取整到毫秒再比阈值：避免 30.000000000004 这种浮点残渣把「刚好 30ms」判成要补。
    const padMs = Math.round((padFrames / info.sampleRate) * 1000);
    if (padMs <= PAD_MIN_MS)
        return { buffer, paddedMs: 0 };
    const seen = info.dataOffset + info.dataLength;
    const padded = Buffer.concat([buffer.subarray(0, seen), Buffer.alloc(padFrames * frameBytes), buffer.subarray(seen)]);
    // 先自己把 data 尺寸写成补齐后的真实值：normalizeWav 只会把它改成「原有音频字节数」，
    // 不先改就会被截回原值，尾部静音成了孤儿。
    padded.writeUInt32LE(info.dataLength + padFrames * frameBytes, info.dataOffset - 4);
    return { buffer: normalizeWav(padded).buffer, paddedMs: padMs };
}
