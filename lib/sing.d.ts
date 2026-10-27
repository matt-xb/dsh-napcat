/**
 * 唱歌（"嗓子"）：简谱 → DiffSinger 歌声合成 → Seed-VC 音色转换 → wav，供 napcat_sing 发 record 段。
 *
 * 全离线、本机跑：SVS 出 24kHz 原唱，Seed-VC 转成当前音色预设（src/ttsvoice.ts 解析）出 44.1kHz。
 * Seed-VC 峰值显存 11–13 GiB，所以整链走 gpu.js 的串行队列，和 TTS 排同一条队。
 * 任一步失败都抛 Error（带步骤名 + stderr 摘要），由工具层转成文字错误。
 */
import type { Config } from './config.js';
import type { LogLevel } from './onebot.js';
type Log = (level: LogLevel, message: string) => void;
/** sing.py 的 score 三分量。 */
export interface Score {
    text: string;
    notes: string;
    durs: string;
}
export interface SingResult {
    wav: string;
    audioSec: number | undefined;
    timings: {
        svsSec: number;
        svcSec: number;
    };
}
/**
 * 简谱文本 → sing.py 的 score 对象。
 * 三行：歌词 / 音高 / 时值（秒）；一行一个字对应一个音符，一字多音用 '|' 分组，
 * 空行和 # 开头的行忽略。也接受直接给 {"text","notes","durs"} 的 JSON。
 */
export declare function parseScore(raw: unknown): Score;
/** 唱一首歌，返回 { wav, audioSec }；串行占用显存，失败抛 Error。 */
export declare function synthesizeSing(scoreText: string, config: Config, log: Log): Promise<SingResult>;
export {};
