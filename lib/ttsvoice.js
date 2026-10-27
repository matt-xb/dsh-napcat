const FALLBACK_VOICE_REF = 'D:/NapCat/tts/refs/user/yinyue_ref_n24.wav';
/** 按会话的运行时覆盖：chatKey → 预设名。全局唯一一份，voicestore 读写同一张表。 */
export const voiceOverrides = new Map();
/** 设定某个会话的音色（只改内存）。 */
export function setVoiceOverride(chatKey, name) {
    if (chatKey === '')
        return;
    voiceOverrides.set(chatKey, name);
}
/** 某个会话当前的覆盖名（没设过是 undefined）。 */
export function getVoiceOverride(chatKey) {
    return chatKey === '' ? undefined : voiceOverrides.get(chatKey);
}
/** 测试用：清覆盖；传 chatKey 只清该会话，不传清全部。 */
export function resetVoiceOverride(chatKey) {
    if (chatKey !== undefined && chatKey !== '') {
        voiceOverrides.delete(chatKey);
        return;
    }
    voiceOverrides.clear();
}
/** 当前音色名：该会话覆盖命中预设优先，否则用配置的 ttsVoice。chatKey 为空时跳过覆盖。 */
export function currentVoiceName(config, chatKey) {
    const override = getVoiceOverride(chatKey ?? '');
    if (override !== undefined && config.ttsVoices?.[override] !== undefined)
        return override;
    return String(config.ttsVoice ?? '');
}
/** 合成实际用的参考音频路径：会话覆盖 > 预设 > 旧的 ttsVoiceRef。 */
export function resolveVoiceRef(config, chatKey) {
    const presets = config.ttsVoices ?? {};
    const picked = presets[currentVoiceName(config, chatKey)];
    if (typeof picked === 'string' && picked.trim() !== '')
        return picked;
    return String(config.ttsVoiceRef ?? '').trim() || FALLBACK_VOICE_REF;
}
