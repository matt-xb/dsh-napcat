// 本插件自己产生的消息来源 kind（会话日志里能区分"QQ 入站"与 Web UI 输入）。
// 宿主用 MessageSourceMap 的声明合并来校验 source.kind；不登记就过不了类型检查。
import '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'plugin:dsh-napcat': { kind: 'plugin:dsh-napcat' }
  }
}
