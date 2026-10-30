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
