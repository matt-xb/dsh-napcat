import test from 'node:test'
import assert from 'node:assert/strict'
import { Bridge } from '../lib/bridge.js'
import { registerTools } from '../lib/tools.js'
import { OneBotConnection } from '../lib/onebot.js'
import { resolveConfig } from '../lib/config.js'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture(kind = 'group') {
  const sent = [], memory = [], registry = new Map(), tools = new Map()
  const agent = { session: { id: 'front', header: { cwd: process.cwd() } }, followup() {} }
  registry.set('front', agent)
  const ctx = { agents: { get: id => registry.get(id) }, tools: { register: t => tools.set(t.name, t) }, on() { return () => {} } }
  const conn = { call: async (action, params) => { sent.push({ action, params }); return { message_id: sent.length } } }
  const b = new Bridge({ ctx, conn, config: resolveConfig({ dmPolicy: 'open', groupPolicy: 'open', memoryEnabled: true, replyAsQuote: false, sendIntervalMs: 0 }), log() {} })
  b.mem.appendRecent = async (...args) => memory.push(args)
  b.debugLog = () => {}
  const key = kind + ':100'
  const chat = { ref: { kind, id: '100', key }, buffer: [], lastReplyId: '', fresh: true, titleSet: true, agent }
  b.chats.set(key, chat); b.bySession.set('front', key)
  b.start()
  registerTools(ctx, conn, () => {}, {
    keyForSession: id => b.keyForSession(id), trackTextSend: (id, key) => b.trackTextSend(id, key),
    targetAllowed: (id, key) => b.taskTargetAllowed(id, key),
  })
  const emit = (type, data) => b.onSessionEvent(agent.session, { type, data })
  const start = turn => emit('turn/start', { turn })
  const message = (text, turn = 1, extra = {}) => emit('assistant/message', { turn, message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text }], ...extra } })
  const end = turn => emit('turn/end', { turn, reason: { kind: 'completed' } })
  return { b, ctx, conn, sent, memory, tools, registry, agent, chat, key, emit, start, message, end, exec: { agent } }
}
for (const kind of ['private', 'group']) {
  test(kind + ': acknowledged text owns final outlet, including punctuation rewrites, and next turn resets', async () => {
    const f = fixture(kind); f.start(1)
    await f.tools.get('napcat_send_message').execute({ chat_id: f.key, text: '好明天再说' }, f.exec)
    f.message('好，明天再说。'); f.message('另一个内部收尾'); f.end(1); await tick()
    assert.equal(f.sent.length, 1); assert.equal(f.memory.length, 1)
    f.start(2); f.message('下一轮', 2); f.end(2); await tick(); assert.equal(f.sent.length, 2)
  })
}
test('partial or failed text send does not claim completion; delivered exact chunks are not resent', async () => {
  const f = fixture(); f.start(1); const original = f.conn.call; let calls = 0
  f.conn.call = (...args) => { if (++calls === 2) throw Error('definite rejection'); return original(...args) }
  await assert.rejects(f.tools.get('napcat_send_message').execute({ chat_id: f.key, text: '甲'.repeat(1300) }, f.exec))
  assert.equal(f.chat.toolTextComplete, false); assert.equal(f.memory.length, 0)
  f.conn.call = original; f.message(f.sent[0].params.message[0].data.text); f.message('剩余部分'); f.end(1); await tick()
  assert.equal(f.sent.length, 2); assert.equal(f.sent[1].params.message[0].data.text, '剩余部分')
})
test('raw pure text owns output, but sending to another chat does not suppress origin', async () => {
  const f = fixture(); f.start(1)
  await f.tools.get('napcat_api').execute({ action: 'send_group_msg', params_json: JSON.stringify({ group_id: '100', message: '原始文本' }) }, f.exec)
  f.message('不同的最终改写'); f.end(1); await tick(); assert.equal(f.sent.length, 1)
  f.start(2)
  await f.tools.get('napcat_send_message').execute({ chat_id: 'private:200', text: '其他目标' }, f.exec)
  f.message('本群仍回复', 2); f.end(2); await tick(); assert.equal(f.sent.length, 3)
})
test('queued messages cannot wipe current output or change its admitted task snapshot', async () => {
  const f = fixture(); f.start(1)
  const image = { type: 'image', attachmentId: 'synthetic-reference-A' }
  f.agent.followup = msg => { f.emit('user/message', msg) }
  f.b.dispatch(f.chat, 'first task', [image]); f.message('保留')
  const accepted = f.chat.taskInput
  let queued; f.agent.followup = msg => { queued = msg }
  f.b.dispatch(f.chat, 'second task', [{ type: 'image', attachmentId: 'synthetic-reference-B' }])
  assert.equal(f.chat.taskInput, accepted); assert.equal(f.chat.taskInput[0], image)
  f.start(1); f.end(1); await tick(); assert.equal(f.sent[0].params.message[0].data.text, '保留')
  f.emit('user/message', queued); assert.equal(f.chat.taskInput[0].attachmentId, 'synthetic-reference-B')
  assert.equal(f.chat.pendingTaskInputs.size, 0)
})
test('non-model/interrupted/stale events never leak; duplicate end sends once; memory failure does not resend', async () => {
  const f = fixture(); f.start(1)
  f.message('notice', 1, { source: { kind: 'model-selection' } })
  f.emit('assistant/message', { turn: 1, interrupted: true, message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'partial' }] } })
  f.message('旧轮', 0); f.message('正常'); f.message('正常。')
  f.b.mem.appendRecent = async () => { throw Error('disk failure') }
  f.end(1); f.end(1); await tick(); assert.equal(f.sent.length, 1)
  assert.equal(f.sent[0].params.message[0].data.text, '正常')
})
test('late tool acknowledgement cannot claim next turn or a replacement chat', async () => {
  const f = fixture(); f.start(1); const sent = f.b.trackTextSend('front', f.key)
  f.end(1); f.start(2); await sent('late', true); assert.equal(f.chat.toolTextComplete, false)
  const replacement = f.b.trackTextSend('front', f.key); f.b.chats.set(f.key, { ...f.chat })
  await replacement('late', true); assert.equal(f.memory.length, 0)
})
test('worker permissions stay bound; descendants, missing parents and cycles cannot send', async () => {
  const f = fixture(); let resolve
  const result = new Promise(r => { resolve = r })
  f.ctx.subagents = { startActivation: async spec => ({ childId: spec.childId, result }) }
  const { childId } = await f.b.tasks.start({ parent: f.agent, chatKey: f.key, prompt: [] })
  const workerRules = f.b.personaText({ agent: { session: { id: childId } } })
  assert.match(workerRules, /napcat_send_image/); assert.match(workerRules, /napcat_send_file/)
  assert.match(workerRules, /省略chat_id/); assert.match(workerRules, /不能把本地路径/)
  assert.doesNotMatch(workerRules, /调用 napcat_task_start/)
  assert.equal(f.b.taskTargetAllowed(childId, f.key), true)
  assert.equal(f.b.taskTargetAllowed(childId, 'private:200'), false)
  f.registry.set('grandchild', { session: { header: { parentSession: childId } } })
  f.registry.set('orphan', { session: { header: { parentSession: 'missing' } } })
  f.registry.set('cycle', { session: { header: { parentSession: 'cycle' } } })
  for (const id of ['grandchild', 'orphan', 'cycle', 'unknown']) assert.equal(f.b.taskTargetAllowed(id, f.key), false)
  assert.equal(f.b.taskTargetAllowed('front', f.key), true)
  resolve({ output: [], stopReason: 'completed' }); await tick()
  assert.equal(f.b.taskTargetAllowed(childId, f.key), false)
  assert.equal(f.b.taskTargetAllowed('grandchild', f.key), false)
})
test('worker ACL is applied before every public send tool and raw API send', async () => {
  const f = fixture(); f.ctx.subagents = { startActivation: async spec => ({ childId: spec.childId, result: new Promise(() => {}) }) }
  const { childId } = await f.b.tasks.start({ parent: f.agent, chatKey: f.key, prompt: [] })
  const exec = { agent: { session: { id: childId } } }
  for (const [name, args] of [
    ['napcat_send_message', { chat_id: 'group:200', text: 'blocked' }],
    ['napcat_send_image', { chat_id: 'group:200', source: 'nonexistent.png' }],
    ['napcat_send_file', { chat_id: 'group:200', path: 'nonexistent.bin' }],
    ['napcat_api', { action: 'send_group_msg', params_json: '{"group_id":"200","message":"blocked"}' }],
  ]) await assert.rejects(f.tools.get(name).execute(args, exec), /目标|来源|绑定|后台/)
  assert.equal(f.sent.length, 0)
})
test('stop during media reads or file fallback cannot begin another transmission', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'napcat-stop-test-')); t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'synthetic.png')
  await writeFile(path, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jwXkAAAAASUVORK5CYII=', 'base64'))
  for (const name of ['napcat_send_image', 'napcat_send_file']) {
    const f = fixture(); const args = name.endsWith('image') ? { source: path } : { path }
    const pending = f.tools.get(name).execute(args, f.exec)
    f.b.stopped = true
    await assert.rejects(pending, /后台任务/); assert.equal(f.sent.length, 0)
  }
  const f = fixture(); let calls = 0
  f.conn.call = async () => { calls++; f.b.stopped = true; throw Error('file rejected') }
  await assert.rejects(f.tools.get('napcat_send_file').execute({ path }, f.exec), /后台任务/)
  assert.equal(calls, 1)
})
test('stop between text chunks prevents the next chunk and completion acknowledgement', async () => {
  const f = fixture(); f.start(1); let calls = 0
  f.conn.call = async () => { calls++; f.b.stopped = true; return { message_id: 1 } }
  await assert.rejects(f.tools.get('napcat_send_message').execute({ chat_id: f.key, text: '甲'.repeat(1300) }, f.exec), /后台任务/)
  assert.equal(calls, 1); assert.equal(f.chat.toolTextComplete, false)
})
test('a running worker loses sending permission when current chat policy is revoked', async () => {
  for (const kind of ['private', 'group']) {
    const f = fixture(kind); let resolve
    f.ctx.subagents = { startActivation: async spec => ({ childId: spec.childId, result: new Promise(r => { resolve = r }) }) }
    const { childId } = await f.b.tasks.start({ parent: f.agent, chatKey: f.key, prompt: [] })
    assert.equal(f.b.taskTargetAllowed(childId, f.key), true)
    f.b.opts.config[kind === 'private' ? 'dmPolicy' : 'groupPolicy'] = 'disabled'
    assert.equal(f.b.taskTargetAllowed(childId, f.key), false)
    resolve({ output: [{ type: 'text', text: 'finished after revocation' }], stopReason: 'completed' }); await tick()
    assert.equal(f.sent.length, 0); assert.match(f.b.tasks.status(f.key), /未回传/)
  }
})
test('wildcard persona covers new chats; precise persona replaces it; style is sticker-first not a quota', () => {
  const f = fixture(); f.b.opts.config.personaOverrides = 'group:* = wildcard\ngroup:100 = precise\nprivate:* = private-style'; f.b.refreshPersonas()
  assert.equal(f.b.personaForChat('group:100'), 'precise'); assert.equal(f.b.personaForChat('group:200'), 'wildcard')
  assert.equal(f.b.personaForChat('private:200'), 'private-style')
  const rules = f.b.personaText({ agent: f.agent }); assert.match(rules, /表情包/); assert.match(rules, /napcat_task_start/)
})
test('wire rejects internal context before transmission and accepts a valid success acknowledgement', async () => {
  const conn = new OneBotConnection({ log() {} }), sent = []
  conn.socket = { readyState: 1, send(raw, callback) {
    const request = JSON.parse(raw); sent.push(request)
    queueMicrotask(() => conn.onMessage(Buffer.from(JSON.stringify({ status: 'ok', retcode: 0, echo: request.echo, data: { message_id: 1 } })))); callback()
  } }
  await assert.rejects(conn.call('send_msg', { message: '【当前群消息上下文（聊天数据）】\nprivate context' }), /内部上下文|模型通知/)
  assert.equal(sent.length, 0)
  await conn.call('send_msg', { message_type: 'group', group_id: '100', message: '普通文本' })
  assert.equal(sent.length, 1); assert.equal(conn.pending.size, 0)
})
