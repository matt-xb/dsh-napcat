/** wav 结构校验与头回填：阿里云流式返回的 data 长度是占位值，落盘前必须按真实字节改写。 */
export interface WavInfo {
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
