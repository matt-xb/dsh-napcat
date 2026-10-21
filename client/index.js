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

      /** 设置页字段（与 src/config.ts 的 Config 一一对应）。 */
      const FIELDS = [
        { key: 'mode', label: '连接方式', kind: 'select', options: [['forward', 'forward：插件连 NapCat'], ['reverse', 'reverse：NapCat 拨入']] },
        { key: 'url', label: 'NapCat WebSocket 地址', kind: 'text', placeholder: 'ws://81.70.163.182:3001' },
        { key: 'accessToken', label: 'Access Token', kind: 'password', placeholder: '与 NapCat 的 WebSocket 服务器一致' },
        { key: 'host', label: 'reverse 监听地址', kind: 'text', placeholder: '0.0.0.0（NapCat 在别的机器上）' },
        { key: 'port', label: 'reverse 监听端口', kind: 'number' },
        { key: 'botQQ', label: '机器人 QQ（留空自动学习）', kind: 'text' },
        { key: 'adminUsers', label: '管理员 QQ（逗号分隔）', kind: 'list' },
        { key: 'dmPolicy', label: '私聊策略', kind: 'select', options: [['admin', 'admin：仅管理员'], ['open', 'open：任何人'], ['disabled', 'disabled：关闭']] },
        { key: 'allowFrom', label: '私聊额外白名单（逗号分隔，留空=不限）', kind: 'list' },
        { key: 'groupPolicy', label: '群聊策略', kind: 'select', options: [['allowlist', 'allowlist：仅白名单群'], ['open', 'open：任何群'], ['disabled', 'disabled：关闭']] },
        { key: 'groupAllowFrom', label: '允许的群号（逗号分隔）', kind: 'list' },
        { key: 'requireMention', label: '群聊必须 @机器人 才响应', kind: 'boolean' },
        { key: 'ignoreSelf', label: '忽略机器人自己的消息', kind: 'boolean' },
        { key: 'replyAsQuote', label: '回复时引用原消息', kind: 'boolean' },
        { key: 'splitMaxChars', label: '单条消息最大字数（0=不分段）', kind: 'number' },
        { key: 'reconnectMaxAttempts', label: '重连上限（0=无限）', kind: 'number' },
        { key: 'workspacePath', label: '会话工作区路径（留空=宿主 cwd）', kind: 'text' },
        { key: 'agentPreset', label: 'Agent 预设（留空=宿主默认）', kind: 'text' },
        { key: 'provider', label: '模型 provider（留空=宿主默认）', kind: 'text' },
        { key: 'model', label: '模型 id（留空=宿主默认）', kind: 'text' },
        { key: 'logLevel', label: '日志级别', kind: 'select', options: [['info', 'info'], ['debug', 'debug'], ['warn', 'warn']] },
      ]

      const NS = 'dsh-napcat'
      const style = {
        wrap: { display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '620px' },
        hint: { color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: '12px', margin: 0, lineHeight: 1.6, whiteSpace: 'pre-wrap' },
        row: { display: 'flex', flexDirection: 'column', gap: '4px' },
        label: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #555)' },
        input: {
          font: 'inherit', fontSize: '13px', padding: '7px 9px', borderRadius: '6px',
          border: '1px solid var(--dsw-alias-border-l2, #d0d0d0)',
          background: 'var(--dsw-alias-bg-l1, #fff)', color: 'inherit', width: '100%', boxSizing: 'border-box',
        },
        checkRow: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' },
        bar: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
        btn: {
          font: 'inherit', fontSize: '13px', padding: '7px 14px', borderRadius: '6px', cursor: 'pointer',
          border: '1px solid var(--dsw-alias-border-l2, #d0d0d0)', background: 'transparent', color: 'inherit',
        },
        primary: {
          font: 'inherit', fontSize: '13px', padding: '7px 14px', borderRadius: '6px', cursor: 'pointer',
          border: '1px solid transparent', background: 'var(--dsw-alias-state-business-primary, #1677ff)', color: '#fff',
        },
        error: { color: 'var(--dsw-alias-state-error-primary, #d4380d)', fontSize: '12px', margin: 0, whiteSpace: 'pre-wrap' },
        ok: { color: 'var(--dsw-alias-state-success-primary, #389e0d)', fontSize: '12px', margin: 0 },
      }

      /** 取 Remote 门面（客户端服务名 `remote`）。 */
      function remoteOf(ctx) {
        try {
          const remote = ctx.remote ?? (typeof ctx.get === 'function' ? ctx.get('remote') : undefined)
          return remote && remote.settings && typeof remote.settings.describe === 'function' ? remote : null
        } catch (error) {
          return null
        }
      }

      function toList(value) {
        const raw = String(value == null ? '' : value)
        return raw.split(/[,，\s]+/).map((item) => item.trim()).filter((item) => item !== '')
      }

      function renderField(field, value, onChange) {
        const id = NS + '-' + field.key
        if (field.kind === 'boolean') {
          return react.createElement('div', { style: style.checkRow, key: field.key },
            react.createElement('input', {
              id, type: 'checkbox', checked: Boolean(value),
              onChange: (event) => onChange(field.key, event.target.checked),
            }),
            react.createElement('label', { htmlFor: id }, field.label))
        }
        let control
        if (field.kind === 'select') {
          control = react.createElement('select', {
            id, style: style.input, value: value == null ? '' : String(value),
            onChange: (event) => onChange(field.key, event.target.value),
          }, field.options.map((pair) => react.createElement('option', { key: pair[0], value: pair[0] }, pair[1])))
        } else if (field.kind === 'number') {
          control = react.createElement('input', {
            id, type: 'number', style: style.input, value: value == null ? '' : String(value),
            onChange: (event) => onChange(field.key, event.target.value === '' ? undefined : Number(event.target.value)),
          })
        } else if (field.kind === 'list') {
          control = react.createElement('input', {
            id, type: 'text', style: style.input, placeholder: field.placeholder,
            value: Array.isArray(value) ? value.join(', ') : String(value == null ? '' : value),
            onChange: (event) => onChange(field.key, toList(event.target.value)),
          })
        } else {
          control = react.createElement('input', {
            id, type: field.kind === 'password' ? 'password' : 'text', style: style.input,
            placeholder: field.placeholder, value: value == null ? '' : String(value),
            onChange: (event) => onChange(field.key, event.target.value),
          })
        }
        return react.createElement('div', { style: style.row, key: field.key },
          react.createElement('label', { style: style.label, htmlFor: id }, field.label),
          control)
      }

      /** 页面主体。 */
      function NapcatSettingsPage(props) {
        const ctx = props.ctx
        const [state, setState] = react.useState({ phase: 'loading' })
        const [draft, setDraft] = react.useState({})
        const [revision, setRevision] = react.useState(undefined)
        const [message, setMessage] = react.useState(undefined)

        const load = react.useCallback(async () => {
          const remote = remoteOf(ctx)
          if (remote === null) {
            setState({ phase: 'unsupported' })
            return
          }
          setState({ phase: 'loading' })
          try {
            const rows = await remote.settings.describe()
            const row = (rows || []).find((item) => item && item.ns === NS)
            if (row === undefined) {
              setState({ phase: 'missing' })
              return
            }
            setDraft(Object.assign({}, row.value || {}))
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
            const rows = await remote.settings.describe()
            const row = (rows || []).find((item) => item && item.ns === NS)
            const next = {}
            for (const field of FIELDS) {
              if (Object.prototype.hasOwnProperty.call(draft, field.key)) next[field.key] = draft[field.key]
            }
            await remote.settings.update(NS, next, row ? row.revision : revision)
            setMessage({ ok: true, text: '已保存（写入 profile 的 cordis.patch.yml，插件会热重载）' })
            await load()
          } catch (error) {
            setMessage({ ok: false, text: '保存失败：' + String(error && error.message ? error.message : error) })
          }
        }

        if (state.phase === 'loading') return react.createElement('p', { style: style.hint }, '读取配置中…')

        if (state.phase === 'unsupported') {
          return react.createElement('div', { style: style.wrap },
            react.createElement('p', { style: style.hint }, '当前宿主没有暴露 settings Remote 域，无法在本页读写配置。可以手动在 profile 的 cordis.patch.yml 追加：'),
            react.createElement('pre', { style: style.hint },
              '- id: ' + NS + '\n  name: ' + NS + '\n  config:\n    mode: forward\n    url: ws://<napcat-ip>:3001\n    accessToken: <token>\n    adminUsers: [\'<你的QQ>\']'))
        }

        if (state.phase === 'missing') {
          return react.createElement('div', { style: style.wrap },
            react.createElement('p', { style: style.hint }, '宿主里没找到 dsh-napcat 的配置条目。确认插件已安装并启用，再点重试。'),
            react.createElement('button', { style: style.btn, onClick: () => void load() }, '重试'))
        }

        if (state.phase === 'error') {
          return react.createElement('div', { style: style.wrap },
            react.createElement('p', { style: style.error }, '读取配置失败：' + state.error),
            react.createElement('button', { style: style.btn, onClick: () => void load() }, '重试'))
        }

        return react.createElement('div', { style: style.wrap },
          react.createElement('p', { style: style.hint },
            '保存后写入 profile 的 cordis.patch.yml 并热重载插件。' +
            (revision === undefined ? '' : ' 当前 revision：' + revision)),
          FIELDS.map((field) => renderField(field, draft[field.key], (key, value) => {
            setDraft((previous) => {
              const nextDraft = Object.assign({}, previous)
              nextDraft[key] = value
              return nextDraft
            })
          })),
          react.createElement('div', { style: style.bar },
            react.createElement('button', { style: style.primary, onClick: () => void save() }, '保存'),
            react.createElement('button', { style: style.btn, onClick: () => void load() }, '重新读取'),
            message === undefined ? null
              : react.createElement('p', { style: message.ok ? style.ok : style.error }, message.text)))
      }

      const inject = ['slots']

      /** 注册进「设置 → 插件」的 tab 列表。 */
      function apply(ctx) {
        const Page = (props) => react.createElement(NapcatSettingsPage, Object.assign({}, props, { ctx: ctx }))
        // 必须用 slots.inject 等宿主声明出 settings.plugins.tab 之后再注册；
        // 直接 register 会在槽还不存在时抛错，导致整条客户端 entry 变成 failed。
        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
          name: 'settings.plugins.tab',
          id: NS,
          order: 200,
          label: () => 'NapCat',
        }, Page))
      }

      exports.apply = apply
      exports.inject = inject
      return module.exports
    },
  })
}
