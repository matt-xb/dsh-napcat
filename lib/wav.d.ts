/** wav 结构校验与头回填：阿里云流式返回的 data 长度是占位值，落盘前必须按真实字节改写。 */
export interface WavInfo {
    /** fmt 块的 wFormatTag：1 = PCM。 */
    audioFormat: number;
    channels: number;
    sampleRate: number;
    bitsPerSample: number;
    /** data 块第一个音频字节的偏移。 */
    dataOffset: number;
    /** data 块里真实存在的音频字节数（已被文件长度截过）。 */
    dataLength: number;
}
/**
 * 解析并校验 RIFF/WAVE。结构不通就抛错——退化音频（空壳、fmt 全零、没有音频帧）不许当成语音发出去。
 */
export declare function parseWav(buffer: Buffer): WavInfo;
/**
 * 把 RIFF/data 的尺寸字段改写成真实值，音频字节一个不动。
 * 阿里云 qwen-tts 返回的 wav 头是流式占位（data=0x7FFFFFFF），照原样落盘会让下游按错误长度读。
 */
export declare function normalizeWav(buffer: Buffer): {
    buffer: Buffer;
    fixed: boolean;
};
/**
 * 差额小于这个值就不补。QQ 侧是 Math.round，小数部分一旦 ≥ 0.5 本来就会进位，差额 < 30ms 时
 * 小数部分必然 ≥ 0.97，怎么取整都切不到有声部分，补它只是白送一段空白。
 */
export declare const PAD_MIN_MS = 30;
/**
 * 尾部补静音到下一个整秒，让最终 wav 时长天然是整数。
 *
 * NapCat 把小数的 duration 交给 QQ，QQ 侧按整秒收尾（Math.round），实测 38% 的合成音频会因此
 * 丢掉有声尾巴——TTS 尾部静音只有 10–67ms，几乎贴着最后一个音节就结束。补到整秒后 floor/round
 * 都切不到有声内容。补齐量由 ceil 保证一定 < 1 秒，不需要额外上限。非标准 PCM wav 原样返回。
 */
export declare function padWavToSecond(buffer: Buffer): {
    buffer: Buffer;
    paddedMs: number;
};
