/**
 * dsh-napcat 设置页（浏览器半仓，手写的客户端模块，无需构建）。
 *
 * 加载方式：宿主客户端按 package.json 的 `dsh.client` + `exports["./client"]`
 * 找到本文件，调用 `window.__ModuleLoader__.load({ id, factory })`。
 *
 * 页面挂在「设置 → 插件」的 `settings.plugins.tab` 列表槽里（与内置插件页同一套）。
 * 读写配置走宿主已有的 `settings` Remote 域（= ctx.settings / configEditor）：
 *   describe() → 拿到本插件条目的 schema、当前值、revision
 *   update(ns, patch, revision) → 落 profile 的 cordis.patch.yml 并热重载
 * 这样保存后**自动追加**配置行，和别的插件行为一致。
 */

window.__ModuleLoader__.load({
  id: 'dsh-napcat',
  factory: (require) => {
    const react = require('react')

    /** 设置页要展示的字段（与 src/config.ts 的 Config 一一对应）。 */
    const FIELDS = [
      { key: 'mode', label: '连接方式', kind: 'select', options: [['forward', 'forward：插件连 NapCat'], ['reverse', 'reverse：NapCat 拨入']] },
      { key: 'url', label: 'NapCat WebSocket 地址', kind: 'text', placeholder: 'ws://81.70.163.182:3001' },
      { key: 'accessToken', label: 'Access Token', kind: 'password', placeholder: '与 NapCat 的 WebSocket 服务器一致' },
      { key: 'host', label: 'reverse 监听地址', kind: 'text', placeholder: '0.0.0.0（NapCat 在别的机器上）' },
      { key: 'port', label: 'reverse 监听端口', kind: 'number' },
      { key: 'botQQ', label: '机器人 QQ（可留空自动学习）', kind: 'text' },
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
    const s = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '620px' },
      hint: { color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: '12px', margin: 0, lineHeight: 1.6 },
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

    /** 从客户端上下文里拿 Remote 门面（服务名是 `remote`）。 */
    function remoteOf(ctx) {
      try {
        const r = ctx.remote ?? (typeof ctx.get === 'function' ? ctx.get('remote') : undefined)
        return r && r.settings && typeof r.settings.describe === 'function' ? r : null
      } catch {
        return null
      }
    }

    function toList(value) {
      const raw = String(value == null ? '' : value)
      return raw.split(/[,，\s]+/).map((x) => x.trim()).filter((x) => x !== '')
    }

    function renderField(field, value, onChange) {
      const id = NS + '-' + field.key
      let control
      if (field.kind === 'select') {
        control = react.createElement('select', {
          id, style: s.input, value: value == null ? '' : String(value),
          onChange: (event) => onChange(field.key, event.target.value),
        }, field.options.map(([v, text]) => react.createElement('option', { key: v, value: v }, text)))
      } else if (field.kind === 'boolean') {
        return react.createElement('div', { style: s.checkRow, key: field.key },
          react.createElement('input', {
            id, type: 'checkbox', checked: Boolean(value),
            onChange: (event) => onChange(field.key, event.target.checked),
          }),
          react.createElement('label', { htmlFor: id }, field.label))
      } else if (field.kind === 'number') {
        control = react.createElement('input', {
          id, type: 'number', style: s.input, value: value == null ? '' : String(value),
          onChange: (event) => onChange(field.key, event.target.value === '' ? undefined : Number(event.target.value)),
        })
      } else if (field.kind === 'list') {
        control = react.createElement('input', {
          id, type: 'text', style: s.input, placeholder: field.placeholder,
          value: Array.isArray(value) ? value.join(', ') : String(value == null ? '' : value),
          onChange: (event) => onChange(field.key, toList(event.target.value)),
        })
      } else {
        control = react.createElement('input', {
          id, type: field.kind === 'password' ? 'password' : 'text', style: s.input,
          placeholder: field.placeholder, value: value == null ? '' : String(value),
          onChange: (event) => onChange(field.key, event.target.value),
        })
      }
      return react.createElement('div', { style: s.row, key: field.key },
        react.createElement('label', { style: s.label, htmlFor: id }, field.label),
        control)
    }

    /** 设置页主体。 */
    function NapcatSettingsPage({ ctx }) {
      const reactRef = react
      const [state, setState] = reactRef.useState({ phase: 'loading' })
      const [draft, setDraft] = reactRef.useState({})
      const [revision, setRevision] = reactRef.useState(undefined)
      const [message, setMessage] = reactRef.useState(undefined)

      const load = reactRef.useCallback(async () => {
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
          setDraft({ ...(row.value || {}) })
          setRevision(row.revision)
          setState({ phase: 'ready' })
        } catch (error) {
          setState({ phase: 'error', error: String(error && error.message ? error.message : error) })
        }
      }, [ctx])

      reactRef.useEffect(() => { void load() }, [load])

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
          setMessage({ ok: true, text: '已保存（已写入 profile 的 cordis.patch.yml，插件会热重载）' })
          await load()
        } catch (error) {
          const text = String(error && error.message ? error.message : error)
          setMessage({ ok: false, text: '保存失败：' + text })
        }
      }

      if (state.phase === 'loading') return react.createElement('p', { style: s.hint }, '读取配置中…')
      if (state.phase === 'unsupported') {
        return react.createElement('div', { style: s.wrap },
          react.createElement('p', { style: s.hint }, '当前宿主没有暴露 settings Remote 域，无法在此页面读写配置。'),
          react.createElement('p', { style: s.hint }, '可以手动在 profile 的 cordis.patch.yml 追加：'),
          react.createElement('pre', { style: { ...s.hint, whiteSpace: 'pre-wrap' } },
            '- id: ' + NS + '\n  name: ' + NS + '\n  config:\n    mode: forward\n    url: ws://<napcat-ip>:3001\n    accessToken: <token>\n    adminUsers: [\'<你的QQ>\']'))
      }
      if (state.phase === 'missing') {
        return react.createElement('div', { style: s.wrap },
          react.createElement('p', { style: s.hint }, '宿主里没有找到 dsh-napcat 的配置条目。'),
          react.createElement('p', { style: s.hint }, '确认插件已安装并启用（设置 → 插件 里应能看到它），然后点下面的按钮重试。'),
          react.createElement('button', { style: s.btn, onClick: () => void load() }, '重试'))
      }
      if (state.phase === 'error') {
        return react.createElement('div', { style: s.wrap },
          react.createElement('p', { style: s.error }, '读取配置失败：' + state.error),
          react.createElement('button', { style: s.btn, onClick: () => void load() }, '重试'))
      }

      return react.createElement('div', { style: s.wrap },
        react.createElement('p', { style: s.hint },
          '保存后写入 profile 的 cordis.patch.yml 并热重载插件（与其它插件同一套机制）。' +
          (revision === undefined ? '' : ' 当前 revision：' + revision)),
        FIELDS.map((field) => renderField(field, draft[field.key], (key, value) => {
          setDraft((previous) => ({ ...previous, [key]: value }))
        })),
        react.createElement('div', { style: s.bar },
          react.createElement('button', { style: s.primary, onClick: () => void save() }, '保存'),
          react.createElement('button', { style: s.btn, onClick: () => void load() }, '重新读取'),
          message === undefined ? null
            : react.createElement('p', { style: message.ok ? s.ok : s.error }, message.text)))
    }

    const inject = ['slots', 'locale']

    /** 把 tab 注册进「设置 → 插件」。 */
    function apply(ctx) {
      const Page = (props) => react.createElement(NapcatSettingsPage, { ...props, ctx })
      ctx.slots.register({
        name: 'settings.plugins.tab',
        id: NS,
        order: 200,
        label: () => 'NapCat',
      }, Page)
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
