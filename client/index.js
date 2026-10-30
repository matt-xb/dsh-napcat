/**
 * dsh-napcat 设置页（浏览器半仓 · 手写客户端模块 · 免构建）。
 *
 * 形态照搬宿主自带的客户端包（@deepseek-ai/dsh-client-ui-settings-plugins）：
 *   window.__ModuleLoader__.load({ id, factory })
 *   factory(require) 里先 `var module = { exports: {} }; var exports = module.exports`，
 *   末尾 `exports.apply = apply; exports.inject = inject; return module.exports`。
 * 少了这两行 `var module/exports` 会在浏览器里抛 `ReferenceError: exports is not defined`，
 * 进而把客户端模块图带崩 —— 这是必须严格照抄的原因。
 *
 * 页面挂在「设置 → 插件」的 settings.plugins.tab 列表槽（与内置插件页同一套）。
 * 读写配置走宿主已有的 settings Remote 域（= ctx.settings / configEditor）：
 *   describe() → 当前值 + revision
 *   update(ns, patch, revision) → 写 profile 的 cordis.patch.yml 并热重载
 * 所以保存后会自动追加配置行，与别的插件行为一致。
 *
 * 顶部 window 守卫：本文件是浏览器专属；万一被 Node 侧扫描/import 时安静退出，绝不拖累宿主启动。
 */

const moduleLoader = typeof window === 'undefined' ? undefined : window.__ModuleLoader__

if (moduleLoader !== undefined && moduleLoader !== null) {
  moduleLoader.load({
    id: 'dsh-napcat',
    factory: (require) => {
      var module = { exports: {} }
      var exports = module.exports

      const react = require('react')

      /**
       * qwen3-tts-flash（非实时）官方音色，取自
       * https://help.aliyun.com/zh/model-studio/qwen-tts-voice-list
       * 左列是 API 里传的 voice 参数，右列是控制台/文档里的中文名。
       */
      const ALIYUN_VOICES = [
        ['Cherry', '芊悦 · 女 · 阳光亲切'], ['Serena', '苏瑶 · 女 · 温柔'],
        ['Ethan', '晨煦 · 男 · 阳光活力'], ['Chelsie', '千雪 · 女 · 二次元'],
        ['Momo', '茉兔 · 女 · 撒娇搞怪'], ['Vivian', '十三 · 女 · 小暴躁'],
        ['Moon', '月白 · 男 · 率性'], ['Maia', '四月 · 女 · 知性'],
        ['Kai', '凯 · 男 · 松弛'], ['Nofish', '不吃鱼 · 男 · 设计师'],
        ['Bella', '萌宝 · 女 · 小萝莉'], ['Jennifer', '詹妮弗 · 女 · 电影质感'],
        ['Ryan', '甜茶 · 男 · 戏感'], ['Katerina', '卡捷琳娜 · 女 · 御姐'],
        ['Aiden', '艾登 · 男 · 大男孩'], ['Eldric Sage', '沧明子 · 男 · 老者'],
        ['Mia', '乖小妹 · 女 · 温顺'], ['Mochi', '沙小弥 · 男 · 小大人'],
        ['Bellona', '燕铮莺 · 女 · 洪亮'], ['Vincent', '田叔 · 男 · 烟嗓'],
        ['Bunny', '萌小姬 · 女 · 萌'], ['Neil', '阿闻 · 男 · 新闻'],
        ['Elias', '墨讲师 · 女 · 讲解'], ['Arthur', '徐大爷 · 男 · 质朴'],
        ['Nini', '邻家妹妹 · 女 · 软黏'], ['Seren', '小婉 · 女 · 助眠'],
        ['Pip', '顽屁小孩 · 男 · 调皮'], ['Stella', '少女阿月 · 女 · 甜美'],
        ['Bodega', '博德加 · 男 · 西班牙大叔'], ['Sonrisa', '索尼莎 · 女 · 拉美大姐'],
        ['Alek', '阿列克 · 男 · 俄式'], ['Dolce', '多尔切 · 男 · 慵懒'],
        ['Sohee', '素熙 · 女 · 韩系'], ['Ono Anna', '小野杏 · 女 · 青梅'],
        ['Lenn', '莱恩 · 男 · 德式'], ['Emilien', '埃米尔安 · 男 · 浪漫'],
        ['Andre', '安德雷 · 男 · 磁性'], ['Radio Gol', '拉迪奥·戈尔 · 男 · 解说'],
        ['Jada', '上海-阿珍 · 女 · 沪语'], ['Dylan', '北京-晓东 · 男 · 京腔'],
        ['Li', '南京-老李 · 男 · 南京话'], ['Marcus', '陕西-秦川 · 男 · 陕西话'],
        ['Roy', '闽南-阿杰 · 男 · 闽南语'], ['Peter', '天津-李彼得 · 男 · 相声'],
        ['Sunny', '四川-晴儿 · 女 · 川话'], ['Eric', '四川-程川 · 男 · 川话'],
        ['Rocky', '粤语-阿强 · 男 · 粤语'], ['Kiki', '粤语-阿清 · 女 · 粤语'],
      ]

      /**
       * 设置页字段（与 src/config.ts 的 Config 一一对应）。
       * group 只决定“画在哪个卡片里”，数组顺序就是卡片里的顺序；常用项排在最前。
       */
      const FIELDS = [
        { key: 'mode', label: '连接方式', kind: 'select', options: [['forward', 'forward：插件连 NapCat'], ['reverse', 'reverse：NapCat 拨入']] },
        { key: 'url', label: 'NapCat WebSocket 地址', kind: 'text', placeholder: 'ws://<napcat-host>:3001' },
        { key: 'accessToken', label: 'Access Token', kind: 'password', placeholder: '与 NapCat 的 WebSocket 服务器一致' },
        { key: 'host', label: 'reverse 监听地址', kind: 'text', placeholder: '0.0.0.0（NapCat 在别的机器上）' },
        { key: 'port', label: 'reverse 监听端口', kind: 'number' },
        { key: 'botQQ', label: '机器人 QQ（留空自动学习）', kind: 'text' },
        { key: 'adminUsers', label: '管理员 QQ（逗号分隔）', kind: 'list' },
        { key: 'dmPolicy', label: '私聊策略', kind: 'select', options: [['admin', 'admin：仅管理员'], ['open', 'open：任何人'], ['disabled', 'disabled：关闭']] },
        { key: 'allowFrom', label: '私聊额外白名单（逗号分隔，留空=不限）', kind: 'list' },
        { key: 'groupPolicy', label: '群聊策略', kind: 'select', options: [['allowlist', 'allowlist：仅白名单群'], ['open', 'open：任何群'], ['disabled', 'disabled：关闭']] },
        { key: 'groupAllowFrom', label: '允许的群号（逗号分隔）', kind: 'list' },
        { key: 'requireMention', label: '群聊必须 @机器人 才响应（关掉=任何群消息都进模型）', kind: 'boolean' },
  { key: 'triggerKeywords', label: '群聊关键字触发（逗号分隔；命中就响应，不要求 @）', kind: 'list' },
        { key: 'ignoreSelf', label: '忽略机器人自己的消息', kind: 'boolean' },
        { key: 'replyAsQuote', label: '回复时引用原消息', kind: 'boolean' },
        { key: 'splitMaxChars', label: '单条消息最大字数（0=不分段）', kind: 'number' },
        { key: 'sendIntervalMs', label: '分段消息间隔（毫秒，防 QQ 风控）', kind: 'number' },
        { key: 'reconnectMaxAttempts', label: '重连上限（0=无限）', kind: 'number' },
        { key: 'workspacePath', label: '会话工作区路径（留空=宿主 cwd）', kind: 'text' },
  { key: 'perChatWorkspace', label: '每个会话用独立子目录（workspacePath/napcat/<群号或QQ>）', kind: 'boolean' },
  { key: 'personaOverrides', label: '群/人性格（每行 group:<群号>=<人设> 或 private:<QQ>=<人设>）', kind: 'textarea', placeholder: 'group:123456=你是群宠小灯，语气活泼\nprivate:10001=你是我的私人助理，正式一点' },
        { key: 'agentPreset', label: 'Agent 预设（留空=宿主默认）', kind: 'text' },
        { key: 'provider', label: '模型 provider（留空=宿主默认）', kind: 'text' },
        { key: 'model', label: '模型 id（留空=宿主默认）', kind: 'text' },
        { key: 'logLevel', label: '日志级别', kind: 'select', options: [['info', 'info'], ['debug', 'debug'], ['warn', 'warn']] },
        { key: 'memoryEnabled', label: '群记忆：开启（最近对话缓冲 + 长期记忆）', kind: 'boolean' },
        { key: 'memoryBackend', label: '长期记忆后端', kind: 'select', options: [['mnemon', 'mnemon：每群一个记忆空间'], ['file', 'file：纯本地文件，不碰 mnemon']] },
        { key: 'memorySpacePrefix', label: '记忆空间名前缀（mnemon 模式）', kind: 'text', placeholder: 'napcat-' },
        { key: 'recentLimit', label: '每群保留最近消息条数', kind: 'number' },
        { key: 'injectRecent', label: '每次触发注入最近对话条数', kind: 'number' },
        { key: 'injectMaxChars', label: '记忆注入字符上限', kind: 'number' },
        { key: 'warmupHistory', label: '预热条数：缓冲不足就拉历史（0=关闭）', kind: 'number' },
        { key: 'warmupStaleMinutes', label: '预热新鲜度：最新一条超过多少分钟视为过期', kind: 'number' },
        { key: 'warmupImages', label: '预热时也缓存历史图片（file id 失效则标记已过期）', kind: 'boolean' },
        { key: 'warmupImageLimit', label: '单次预热最多下载几张历史图片（默认 30）', kind: 'number' },
        { key: 'voiceToText', label: '语音自动转文字（后端见下方「语音识别后端」；失败/超时回退 [语音]）', kind: 'boolean' },
        { key: 'voiceWhisperBin', label: 'whisper-cli 路径', kind: 'text' },
        { key: 'voiceWhisperModel', label: 'whisper 模型路径（推荐 large-v3-turbo）', kind: 'text' },
        { key: 'voiceLanguage', label: '识别语言（zh / auto）', kind: 'text' },
        { key: 'voiceTimeoutMs', label: '单条语音识别超时（毫秒，默认 30000）', kind: 'number' },
        { key: 'voiceAsrProvider', label: '语音识别后端', kind: 'select', options: [['local', 'local：本机 whisper.cpp'], ['aliyun', 'aliyun：阿里云百炼（云端，按秒计费）']] },
        { key: 'voiceTtsProvider', label: '语音合成后端', kind: 'select', options: [['local', 'local：本机 IndexTTS'], ['aliyun', 'aliyun：阿里云百炼（云端，按字符计费）']] },
        { key: 'aliyunApiKey', label: '阿里云百炼 API Key（只填本机，别提交仓库）', kind: 'password', placeholder: 'sk-…' },
        { key: 'aliyunAsrModel', label: '云端识别模型（默认 qwen3-asr-flash）', kind: 'text', placeholder: 'qwen3-asr-flash' },
        { key: 'aliyunTtsModel', label: '云端合成模型（默认 qwen3-tts-flash）', kind: 'text', placeholder: 'qwen3-tts-flash' },
        { key: 'aliyunTtsVoice', label: '云端音色（只对 aliyun 后端有效）', kind: 'select', options: ALIYUN_VOICES },
        { key: 'ttsEnabled', label: '发语音：开启（本机 TTS 合成后发语音消息）', kind: 'boolean' },
        { key: 'ttsServerUrl', label: 'TTS 服务地址（默认 http://127.0.0.1:9880）', kind: 'text' },
        { key: 'ttsVoiceRef', label: '音色参考音频路径', kind: 'text' },
        { key: 'ttsSpeed', label: '语速（1=原速，默认 1.15）', kind: 'number' },
        { key: 'ttsEmotion', label: '默认情绪（calm/happy/angry/sad/afraid/disgusted/melancholic/surprised）', kind: 'text' },
        { key: 'ttsTimeoutMs', label: '单条语音合成超时（毫秒，默认 30000）', kind: 'number' },
        { key: 'ttsAutoStart', label: 'TTS 服务没起时自动拉起（默认开）', kind: 'boolean' },
        { key: 'singEnabled', label: '唱歌：开启（简谱 → 歌声合成 → 音色转换 → 发语音）', kind: 'boolean' },
        { key: 'singTimeoutMs', label: '整条唱歌链路超时（毫秒，默认 300000）', kind: 'number' },
        { key: 'proactiveEnabled', label: '主动发言（伪人模式）：群里有话题时自己插话', kind: 'boolean' },
        { key: 'proactiveRatePerHour', label: '主动发言频率 λ（次/小时，0=改用固定概率）', kind: 'number' },
        { key: 'proactiveChance', label: '固定概率模式的插话概率（0~1）', kind: 'number' },
        { key: 'proactiveCooldownMinutes', label: '两次主动发言最小间隔（分钟）', kind: 'number' },
        { key: 'proactiveMaxPerHour', label: '每小时最多主动发言次数', kind: 'number' },
        { key: 'proactiveQuietHours', label: '主动发言静默时段（如 00:00-08:00,12:00-13:00）', kind: 'text' },
        { key: 'proactiveMinMessages', label: '窗口内至少多少条他人消息才考虑插话', kind: 'number' },
        { key: 'proactiveWindowMinutes', label: '观察窗口（分钟）', kind: 'number' },
        { key: 'imageCache', label: '群聊图片缓存（存表情包/分享图，便于以后回看）', kind: 'select', options: [['off', 'off：只存叫到机器人时的图'], ['all', 'all：群里的图也存（带配额）']] },
        { key: 'imageCacheMaxBytes', label: '单张图片缓存上限（字节）', kind: 'number' },
        { key: 'imageCacheDailyCap', label: '每个聊天每天最多缓存张数', kind: 'number' },
        { key: 'imageCacheRetentionDays', label: '图片缓存保留天数（超期清理）', kind: 'number' },
      ]

      const NS = 'dsh-napcat'

      /**
       * 卡片分组。keys 的顺序就是卡片里的顺序；primary 常驻在页首，
       * 带 collapsed 的组收进原生 <details>。字段的 key/label/kind 一律回 FIELDS 取，这里只排位置。
       */
      const GROUPS = [
        { id: 'primary', title: '常用',
          hint: '先把这几项填上就能连上 QQ；其余的按需往下翻。',
          keys: ['mode', 'url', 'accessToken', 'botQQ', 'adminUsers', 'dmPolicy', 'groupPolicy', 'requireMention', 'voiceAsrProvider', 'voiceTtsProvider'] },
        { id: 'connection', title: '连接与门控', keys: ['host', 'port', 'allowFrom', 'groupAllowFrom', 'triggerKeywords', 'ignoreSelf', 'replyAsQuote', 'splitMaxChars', 'sendIntervalMs'] },
        { id: 'session', title: '会话与人格', keys: ['workspacePath', 'perChatWorkspace', 'personaOverrides'] },
        { id: 'memory', title: '群记忆', hint: '最近对话缓冲 + 长期记忆，按群隔离。', keys: ['memoryEnabled', 'memoryBackend', 'memorySpacePrefix', 'recentLimit', 'injectRecent', 'injectMaxChars'] },
        { id: 'voice', title: '语音识别', hint: '收到语音转文字。本机 whisper.cpp 或阿里云云端二选一。', keys: ['voiceToText', 'voiceWhisperBin', 'voiceWhisperModel', 'voiceLanguage', 'voiceTimeoutMs'] },
        { id: 'tts', title: '语音合成', keys: ['ttsEnabled', 'ttsServerUrl', 'ttsVoiceRef', 'ttsSpeed', 'ttsEmotion', 'ttsTimeoutMs', 'ttsAutoStart', 'singEnabled', 'singTimeoutMs'] },
        { id: 'aliyun', title: '阿里云云端语音', hint: '识别/合成后端选 aliyun 时才需要填。', keys: ['aliyunApiKey', 'aliyunTtsVoice'] },
        { id: 'advanced', title: '高级设置', collapsed: true,
          keys: ['reconnectMaxAttempts', 'agentPreset', 'provider', 'model', 'logLevel',
            'warmupHistory', 'warmupStaleMinutes', 'warmupImages', 'warmupImageLimit',
            'aliyunAsrModel', 'aliyunTtsModel',
            'proactiveEnabled', 'proactiveRatePerHour', 'proactiveChance', 'proactiveCooldownMinutes', 'proactiveMaxPerHour', 'proactiveQuietHours', 'proactiveMinMessages', 'proactiveWindowMinutes',
            'imageCache', 'imageCacheMaxBytes', 'imageCacheDailyCap', 'imageCacheRetentionDays'] },
      ]

      const FIELD_BY_KEY = {}
      for (const field of FIELDS) FIELD_BY_KEY[field.key] = field

      // 分组表漏项的兜底：漏掉的字段绝不能从页面上静默消失，塞进高级设置并告警。
      {
        const placed = new Set()
        for (const group of GROUPS) {
          group.keys = group.keys.filter((key) => {
            if (FIELD_BY_KEY[key] === undefined || placed.has(key)) return false
            placed.add(key)
            return true
          })
        }
        const missing = FIELDS.filter((field) => !placed.has(field.key))
        if (missing.length > 0) {
          const advanced = GROUPS[GROUPS.length - 1]
          advanced.keys = advanced.keys.concat(missing.map((field) => field.key))
          console.warn('[dsh-napcat] 设置页分组表漏了字段，已放进高级设置：' + missing.map((field) => field.key).join(', '))
        }
      }

      /**
       * 视觉全部抄宿主设置页（`.wCInkW_*` / `._3nPmjq_*`）的 token：卡片、32px 输入框、
       * 36px 按钮、details 折叠箭头。宿主面板内容列约 564px 宽，所以布局一律走流式/网格。
       */
      const CSS_TEXT = `
.npc-page{max-width:760px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.npc-title{margin:0 0 4px;font-size:16px;font-weight:500;line-height:24px;color:var(--dsw-alias-label-primary)}
.npc-intro{margin:0 0 10px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-tertiary)}
.npc-badges{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0 0 12px}
.npc-badge{display:inline-flex;align-items:center;gap:5px;padding:1px 6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xs)}
.npc-dot{width:8px;height:8px;border-radius:50%;flex:none;display:inline-block}
.npc-dot--on{background:var(--dsw-alias-state-success-primary)}
.npc-dot--off{background:var(--dsw-alias-state-error-primary)}
.npc-card{display:flex;flex-direction:column;gap:12px;margin:0 0 12px;padding:14px 16px;border:.5px solid var(--dsw-alias-settings-card-stroke);background:var(--dsw-alias-settings-card-fill);border-radius:var(--dsw-radius-xl)}
.npc-card-title{margin:0;font-size:14px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-primary)}
.npc-card-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.npc-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
.npc-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.npc-field--wide{grid-column:1/-1}
.npc-label{font-size:12px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-secondary)}
.npc-input{box-sizing:border-box;width:100%;height:32px;padding:0 10px;font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md)}
.npc-input:focus{border-color:var(--dsw-alias-state-business-primary);outline:none}
.npc-input::placeholder{color:var(--dsw-alias-label-dimmed)}
textarea.npc-input{height:auto;min-height:88px;padding:8px 10px;resize:vertical;font-family:inherit}
select.npc-input{cursor:pointer;max-width:100%}
.npc-check{display:flex;align-items:flex-start;gap:8px;padding:2px 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.npc-check input{flex:none;width:16px;height:16px;margin:2px 0 0;accent-color:var(--dsw-alias-state-business-primary)}
.npc-adv{margin:0 0 12px;padding-top:10px;border-top:.5px solid var(--dsw-alias-border-l2)}
.npc-summary{display:flex;align-items:center;gap:6px;width:fit-content;margin-left:-4px;padding:2px 4px;font-size:12px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm);cursor:pointer;list-style:none}
.npc-summary::-webkit-details-marker{display:none}
.npc-summary:before{content:"";width:5px;height:5px;border-bottom:1.5px solid;border-right:1.5px solid;transform:rotate(-45deg) translate(-1px,-1px);transition:transform .12s}
.npc-adv[open]>.npc-summary:before{transform:rotate(45deg) translate(-1px,-1px)}
.npc-summary:hover{color:var(--dsw-alias-label-primary)}
.npc-adv[open]>.npc-grid{margin-top:12px}
.npc-savebar{position:sticky;bottom:0;z-index:2;display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:0;padding:12px 0;background:var(--dsw-alias-bg-layer-2);border-top:1px solid var(--dsw-alias-border-l2)}
.npc-savebar-actions{display:flex;align-items:center;gap:8px;margin-left:auto}
.npc-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:36px;padding:0 14px;font:inherit;font-size:14px;line-height:22px;border:none;border-radius:var(--dsw-radius-md);cursor:pointer}
.npc-btn--primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.npc-btn--primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.npc-btn--ghost{background:0 0;border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary)}
.npc-btn--ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.npc-btn:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
.npc-btn:disabled{opacity:.4;cursor:default}
.npc-note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.npc-note--dirty{color:var(--dsw-alias-label-secondary)}
.npc-note--ok{color:var(--dsw-alias-state-success-primary)}
.npc-note--warn{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-secondary))}
.npc-note--error{color:var(--dsw-alias-state-error-primary)}
.npc-pre{margin:0;padding:12px;font-family:var(--ds-font-family-code,monospace);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform);border-radius:var(--dsw-radius-lg);overflow-x:auto;white-space:pre-wrap}
@media (prefers-reduced-motion:reduce){.npc-summary:before{transition:none}}
`

      /** 解包 Remote 结果：{ ok, value } / { ok:false, error }。 */
      function unwrap(result) {
        if (result !== null && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'ok')) {
          if (result.ok !== true) {
            const code = result.error && result.error.code
            const message = result.error && result.error.message
            throw new Error((code ? code + ': ' : '') + (message || 'remote call failed'))
          }
          return result.value
        }
        return result
      }

      /** Remote 方法签名（见 typert.remote-client.d.ts）：
       *  describe() → { writable, hasDocument, namespaces: SettingsNamespaceView[] }
       *  update(ns, patch, expectedRevision) → SettingsNamespaceView
       * 两者都返回 { ok, value } 包装。
       */

      /** 取 Remote 门面（客户端服务名 `remote`）。 */
      function remoteOf(ctx) {
        try {
          const viaNamespace = ctx.remote && ctx.remote.settings
          if (viaNamespace && typeof viaNamespace.describe === 'function') return { settings: viaNamespace }
          const viaService = typeof ctx.get === 'function' ? ctx.get('remote.settings') : undefined
          if (viaService && typeof viaService.describe === 'function') return { settings: viaService }
          return null
        } catch (error) {
          return null
        }
      }

      function toList(value) {
        const raw = String(value == null ? '' : value)
        return raw.split(/[,，\s]+/).map((item) => item.trim()).filter((item) => item !== '')
      }

      function renderField(field, value, onChange, disabled) {
        const id = NS + '-' + field.key
        if (field.kind === 'boolean') {
          return react.createElement('div', { className: 'npc-check npc-field--wide', key: field.key },
            react.createElement('input', {
              id, type: 'checkbox', checked: Boolean(value), disabled: Boolean(disabled),
              onChange: (event) => onChange(field.key, event.target.checked),
            }),
            react.createElement('label', { htmlFor: id }, field.label))
        }
        let control
        if (field.kind === 'select') {
          control = react.createElement('select', {
            id, className: 'npc-input', value: value == null ? '' : String(value), disabled: Boolean(disabled),
            onChange: (event) => onChange(field.key, event.target.value),
          }, field.options.map((pair) => react.createElement('option', { key: pair[0], value: pair[0] }, pair[1])))
        } else if (field.kind === 'number') {
          control = react.createElement('input', {
            id, type: 'number', className: 'npc-input', value: value == null ? '' : String(value), disabled: Boolean(disabled),
            onChange: (event) => onChange(field.key, event.target.value === '' ? undefined : Number(event.target.value)),
          })
        } else if (field.kind === 'textarea') {
          control = react.createElement('textarea', {
            id, className: 'npc-input', style: { minHeight: '88px' },
            placeholder: field.placeholder, value: value == null ? '' : String(value), disabled: Boolean(disabled),
            onChange: (event) => onChange(field.key, event.target.value),
          })
        } else if (field.kind === 'list') {
          // value 这里就是原始文本（不是数组）：输入过程中逗号/空格原样保留，
          // 由调用方在 onChange 里解析成数组，避免"刚敲下的逗号被吃掉"。
          control = react.createElement('input', {
            id, type: 'text', className: 'npc-input', placeholder: field.placeholder,
            value: value == null ? '' : String(value), disabled: Boolean(disabled),
            onChange: (event) => onChange(field.key, event.target.value),
          })
        } else {
          control = react.createElement('input', {
            id, type: field.kind === 'password' ? 'password' : 'text', className: 'npc-input',
            placeholder: field.placeholder, value: value == null ? '' : String(value), disabled: Boolean(disabled),
            onChange: (event) => onChange(field.key, event.target.value),
          })
        }
        return react.createElement('div', { className: 'npc-field' + (field.kind === 'textarea' ? ' npc-field--wide' : ''), key: field.key },
          react.createElement('label', { className: 'npc-label', htmlFor: id }, field.label),
          control)
      }

      /** 把一组字段 key 渲染成网格；key 一定在 FIELDS 里（启动时已核过）。 */
      function renderGroupFields(keys, draft, onChange, disabled) {
        return keys.map((key) => renderField(FIELD_BY_KEY[key], draft[key], onChange, disabled))
      }

      function DraftPage(props) {
        const { draft, revision, writable, onChange, onSave, onReload, message } = props
        const disabled = writable !== true
        const dirty = JSON.stringify(draft) !== JSON.stringify(props.loaded)
        const cards = GROUPS.filter((group) => !group.collapsed).map((group) => react.createElement('section', { className: 'npc-card', key: group.id },
          react.createElement('h3', { className: 'npc-card-title' }, group.title),
          group.hint === undefined ? null : react.createElement('p', { className: 'npc-card-hint' }, group.hint),
          react.createElement('div', { className: 'npc-grid' }, renderGroupFields(group.keys, draft, onChange, disabled))))
        const advanced = GROUPS.filter((group) => group.collapsed).map((group) => react.createElement('details', { className: 'npc-adv', key: group.id },
          react.createElement('summary', { className: 'npc-summary' },
            group.title + '（' + group.keys.length + ' 项）'),
          react.createElement('div', { className: 'npc-grid' }, renderGroupFields(group.keys, draft, onChange, disabled))))
        return react.createElement('div', { className: 'npc-page' },
          react.createElement('h2', { className: 'npc-title' }, 'NapCat'),
          react.createElement('p', { className: 'npc-intro' }, 'DeepSeek Harness 的 QQ 通道：私聊 + 群聊、@ 门控、白名单、长文分段、语音与图片。保存后写入 profile 的 cordis.patch.yml 并热重载插件，不用重启宿主。'),
          react.createElement('div', { className: 'npc-badges' },
            react.createElement('span', { className: 'npc-badge' }, 'revision ' + (revision === undefined ? '—' : String(revision))),
            react.createElement('span', { className: 'npc-badge' },
              react.createElement('span', { className: 'npc-dot ' + (writable ? 'npc-dot--on' : 'npc-dot--off') }),
              writable ? '可写' : '只读')),
          react.createElement('div', { className: 'npc-savebar' },
            react.createElement('span', { className: 'npc-note' + (writable ? '' : ' npc-note--warn') },
              writable ? '保存后立即热重载插件。' : '配置文件只读或被锁定，本页只能查看，改配置文件后才能保存。'),
            react.createElement('div', { className: 'npc-savebar-actions' },
              react.createElement('button', {
                type: 'button', className: 'npc-btn npc-btn--primary',
                disabled: disabled || !dirty, onClick: () => void onSave(),
              }, dirty ? '保存' : '已保存'),
              react.createElement('button', {
                type: 'button', className: 'npc-btn npc-btn--ghost', onClick: () => void onReload(),
              }, '重新读取')),
            message === undefined ? null
              : react.createElement('p', { className: 'npc-note ' + (message.ok ? 'npc-note--ok' : 'npc-note--error') }, message.text)),
          cards,
          advanced)
      }

      /** 页面主体。 */
      function NapcatSettingsPage(props) {
        const ctx = props.ctx
        const [state, setState] = react.useState({ phase: 'loading' })
        const [draft, setDraft] = react.useState({})
        const [loaded, setLoaded] = react.useState({})
        const [revision, setRevision] = react.useState(undefined)
        const [message, setMessage] = react.useState(undefined)
        const [writable, setWritable] = react.useState(true)

        const load = react.useCallback(async () => {
          const remote = remoteOf(ctx)
          if (remote === null) {
            setState({ phase: 'unsupported' })
            return
          }
          setState({ phase: 'loading' })
          try {
            const described = unwrap(await remote.settings.describe())
            const list = described && Array.isArray(described.namespaces) ? described.namespaces : []
            if (!Array.isArray(described && described.namespaces)) {
              throw new Error('describe 返回的形状不对：' + JSON.stringify(described).slice(0, 200))
            }
            setWritable(described.writable !== false)
            const row = list.find((item) => item && item.ns === NS)
            if (row === undefined) {
              setState({ phase: 'missing' })
              return
            }
            const normalized = Object.assign({}, row.value || {})
            for (const field of FIELDS) {
              if (field.kind === 'list' && Array.isArray(normalized[field.key])) {
                normalized[field.key] = normalized[field.key].join(', ')
              }
            }
            setDraft(normalized)
            setLoaded(normalized)
            setRevision(row.revision)
            setState({ phase: 'ready' })
          } catch (error) {
            setState({ phase: 'error', error: String(error && error.message ? error.message : error) })
          }
        }, [ctx])

        react.useEffect(() => { void load() }, [load])

        const save = async () => {
          const remote = remoteOf(ctx)
          if (remote === null) return
          setMessage(undefined)
          try {
            const described = unwrap(await remote.settings.describe())
            const list = described && Array.isArray(described.namespaces) ? described.namespaces : []
            if (!Array.isArray(described && described.namespaces)) {
              throw new Error('describe 返回的形状不对：' + JSON.stringify(described).slice(0, 200))
            }
            setWritable(described.writable !== false)
            const row = list.find((item) => item && item.ns === NS)
            const next = {}
            for (const field of FIELDS) {
              if (!Object.prototype.hasOwnProperty.call(draft, field.key)) continue
              // 数组字段在表单里是逗号分隔字符串，保存时再解析
              next[field.key] = field.kind === 'list' ? toList(draft[field.key]) : draft[field.key]
            }
            await unwrap(await remote.settings.update(NS, next, row ? row.revision : revision))
            setMessage({ ok: true, text: '已保存（写入 profile 的 cordis.patch.yml，插件会热重载）' })
            await load()
          } catch (error) {
            setMessage({ ok: false, text: '保存失败：' + String(error && error.message ? error.message : error) })
          }
        }

        if (state.phase === 'loading') return react.createElement('p', { className: 'npc-note' }, '读取配置中…')

        if (state.phase === 'unsupported') {
          return react.createElement('div', { className: 'npc-page' },
            react.createElement('p', { className: 'npc-intro' }, '当前宿主没有暴露 settings Remote 域，无法在本页读写配置。可以手动在 profile 的 cordis.patch.yml 追加：'),
            react.createElement('pre', { className: 'npc-pre' },
              '- id: ' + NS + '\n  name: ' + NS + '\n  config:\n    mode: forward\n    url: ws://<napcat-ip>:3001\n    accessToken: <token>\n    adminUsers: [\'<你的QQ>\']'))
        }

        if (state.phase === 'missing') {
          return react.createElement('div', { className: 'npc-page' },
            react.createElement('p', { className: 'npc-intro' }, '宿主里没找到 dsh-napcat 的配置条目。确认插件已安装并启用，再点重试。'),
            react.createElement('button', { type: 'button', className: 'npc-btn npc-btn--ghost', onClick: () => void load() }, '重试'))
        }

        if (state.phase === 'error') {
          return react.createElement('div', { className: 'npc-page' },
            react.createElement('p', { className: 'npc-note npc-note--error' }, '读取配置失败：' + state.error),
            react.createElement('button', { type: 'button', className: 'npc-btn npc-btn--ghost', onClick: () => void load() }, '重试'))
        }

        return react.createElement(react.Fragment, null,
          react.createElement('style', null, CSS_TEXT),
          react.createElement(DraftPage, {
            draft,
            loaded,
            revision,
            writable,
            message,
            onSave: save,
            onReload: load,
            onChange: (key, value) => {
              setDraft((previous) => {
                const nextDraft = Object.assign({}, previous)
                nextDraft[key] = value
                return nextDraft
              })
            },
          }))
      }

      // remote.settings = @deepseek-ai/dsh-api-settings-controller 暴露的 settings Remote 域
      // （configEditor / ctx.settings 的浏览器半边），读写配置都走它。
      const inject = ['slots', 'remote', 'remote.settings']

      /** 注册成「设置」左侧菜单里的一个独立页面（与「内置插件」同级）。 */
      function apply(ctx) {
        const Page = (props) => react.createElement(NapcatSettingsPage, Object.assign({}, props, { ctx: ctx }))
        // 用 slots.inject 等宿主声明出 settings.section 之后再注册；
        // 直接 register 会在槽还不存在时抛错，导致整条客户端 entry 变成 failed。
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'napcat',
          order: 60,
          label: () => 'NapCat',
        }, Page))
      }

      exports.apply = apply
      exports.inject = inject
      return module.exports
    },
  })
}
