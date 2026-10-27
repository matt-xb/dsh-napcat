const FALLBACK_VOICE_REF = 'D:/NapCat/tts/refs/user/yinyue_ref_n24.wav';
/** 运行时切换的预设名（进程内有效；重启后回到配置的 ttsVoice）。 */
let override;
export function setVoiceOverride(name) {
    override = name;
}
/** 测试用：清掉运行时覆盖。 */
export function resetVoiceOverride() {
    override = undefined;
}
/** 当前音色名：运行时覆盖命中预设优先，否则用配置的 ttsVoice。 */
export function currentVoiceName(config) {
    if (override !== undefined && config.ttsVoices?.[override] !== undefined)
        return override;
    return String(config.ttsVoice ?? '');
}
/** 合成实际用的参考音频路径：覆盖 > 预设 > 旧的 ttsVoiceRef。 */
export function resolveVoiceRef(config) {
    const presets = config.ttsVoices ?? {};
    const picked = presets[currentVoiceName(config)];
    if (typeof picked === 'string' && picked.trim() !== '')
        return picked;
    return String(config.ttsVoiceRef ?? '').trim() || FALLBACK_VOICE_REF;
}
