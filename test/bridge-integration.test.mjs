import test from 'node:test'
import assert from 'node:assert/strict'
import { Bridge } from '../lib/bridge.js'
import { registerTools } from '../lib/tools.js'
import { OneBotConnection } from '../lib/onebot.js'
import { resolveConfig } from '../lib/config.js'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture(kind = 'group') {
  const sent = [], memory = [], registry = new Map(), tools = new Map(), queued = [], listeners = new Map(), disposed = []
  const agent = { session: { id: 'front', header: { cwd: process.cwd() } }, followup(message) { queued.push(message) } }
  registry.set('front', agent)
  const ctx = { agents: { get: id => registry.get(id) }, tools: { register: t => tools.set(t.name, t) }, on(name, cb) { listeners.set(name, cb); return () => listeners.delete(name) } }
  const conn = { call: async (action, params) => { sent.push({ action, params }); return { message_id: sent.length } } }
  const b = new Bridge({ ctx, conn, config: resolveConfig({ dmPolicy: 'open', groupPolicy: 'open', memoryEnabled: true, replyAsQuote: false, sendIntervalMs: 0 }), log() {} })
  b.mem.appendRecent = async (...args) => memory.push(args)
  b.debugLog = () => {}
  const key = kind + ':100'
  const chat = { ref: { kind, id: '100', key }, buffer: [], lastReplyId: '', fresh: true, titleSet: true, agent, dispose: async () => { disposed.push('front') } }
  b.chats.set(key, chat); b.bySession.set('front', key)
  b.start()
  registerTools(ctx, conn, () => {}, {
    keyForSession: id => b.keyForSession(id), trackTextSend: (id, key) => b.trackTextSend(id, key),
    targetAllowed: (id, key) => b.taskTargetAllowed(id, key),
    taskMediaReceiver: (id, key) => b.taskMediaReceiver(id, key),
  })
  const emit = (type, data) => b.onSessionEvent(agent.session, { type, data })
  const start = turn => emit('turn/start', { turn })
  const message = (text, turn = 1, extra = {}, step = 1) => emit('assistant/message', { turn, step, message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text }], ...extra } })
  const end = turn => emit('turn/end', { turn, reason: { kind: 'completed' } })
  return { b, ctx, conn, queued, listeners, sent, memory, tools, registry, agent, chat, key, emit, start, message, end, disposed, exec: { agent } }
}
async function startWorker(f) {
  let resolve
  const result = new Promise(r => { resolve = r })
  f.ctx.subagents = { startActivation: async spec => ({ childId: spec.childId, result }) }
  const { childId } = await f.b.tasks.start({ parent: f.agent, chatKey: f.key, prompt: [] })
  return { childId, exec: { agent: { session: { id: childId } } }, finish: async (stopReason = 'completed') => { resolve({ output: [{ type: 'text', text: 'host final result' }], stopReason }); await tick(); await f.b.tasks.tasks.get(childId).delivery?.catch(() => {}) } }
}

test('worker text and raw sends are blocked even to origin; text returns to original parent queue once', async () => {
  const f = fixture(), worker = await startWorker(f)
  for (const [name, args] of [
    ['napcat_send_message', { chat_id: f.key, text: 'blocked' }],
    ['napcat_api', { action: 'send_group_msg', params_json: '{"group_id":"100","message":"blocked"}' }],
  ]) await assert.rejects(f.tools.get(name).execute(args, worker.exec), /后台任务/)
  f.start(1); f.message('still chatting')
  worker.finish(); worker.finish(); await tick()
  assert.equal(f.sent.length, 0); assert.equal(f.queued.length, 1)
  assert.match(f.queued[0].content.at(-1).text, /host final result/)
  assert.equal(f.chat.taskResultTurn, undefined)
  f.end(1); await tick(); assert.equal(f.sent.length, 1)
  f.emit('user/message', f.queued[0]); f.start(2)
  assert.equal(f.chat.taskResultTurn, true); assert.deepEqual(f.chat.taskInput, [])
  assert.equal(f.b.taskTargetAllowed('front', 'private:200'), false)
  await assert.rejects(f.tools.get('napcat_task_start').execute({ prompt: 'loop' }, f.exec), /回执轮/)
  f.message('reviewed result', 2); f.end(2); f.end(2); await tick()
  assert.equal(f.sent.length, 2); assert.equal(f.sent[1].params.message[0].data.text, 'reviewed result')
  assert.equal(f.chat.startTimer, undefined); assert.equal(f.chat.lastText, undefined)
})

test('worker local image/file snapshots are admitted to parent; only parent sends after checking', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'napcat-task-media-')); t.after(() => rm(dir, { recursive: true, force: true }))
  const source = join(dir, 'synthetic.png')
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jwXkAAAAASUVORK5CYII=', 'base64')
  for (const name of ['napcat_send_image', 'napcat_send_file']) {
    await writeFile(source, bytes)
    const f = fixture(), admitted = []
    f.agent.session.header.cwd = dir
    f.ctx.attachments = { admitPromptContent: async parts => { admitted.push(...parts); return [{ type: 'image', attachmentId: 'host-admitted-reference' }] } }
    const worker = await startWorker(f)
    const args = name.endsWith('image') ? { source } : { path: source, name: '../safe.png' }
    assert.match(await f.tools.get(name).execute(args, worker.exec), /尚未发送QQ/)
    assert.equal(f.sent.length, 0)
    await writeFile(source, 'changed after staging')
    await worker.finish()
    assert.equal(f.queued.length, 1)
    const receipt = JSON.parse(f.queued[0].content.at(-1).text.split('\n').at(-1))
    const media = receipt.media[0]
    assert.deepEqual(await readFile(media.path), bytes)
    assert.equal(media.name.includes('/'), false)
    assert.equal(admitted.length, name.endsWith('image') ? 1 : 0)
    if (admitted.length) assert.equal(admitted[0].data, bytes.toString('base64'))
    f.emit('user/message', f.queued[0]); f.start(1)
    await f.tools.get(name).execute(name.endsWith('image') ? { source: media.path } : { path: media.path, name: media.name }, f.exec)
    f.end(1); await tick(); assert.equal(f.sent.length, 1)
  }
})

test('worker media rejects wrong chat, remote URL, missing or oversize assets before QQ', async t => {
  const f = fixture(), worker = await startWorker(f)
  await assert.rejects(f.tools.get('napcat_send_image').execute({ source: 'https://example.invalid/secret' }, worker.exec), /本地路径/)
  await assert.rejects(f.tools.get('napcat_send_image').execute({ chat_id: 'group:200', source: 'missing' }, worker.exec), /目标/)
  await assert.rejects(f.tools.get('napcat_send_file').execute({ path: 'missing' }, worker.exec), /ENOENT/)
  const dir = await mkdtemp(join(tmpdir(), 'napcat-task-large-')); t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'large.bin'); await writeFile(path, Buffer.alloc(21 * 1024 * 1024))
  await assert.rejects(f.tools.get('napcat_send_file').execute({ path }, worker.exec), /超过上限/)
  assert.equal(f.sent.length, 0)
  worker.finish('error'); await tick(); assert.equal(f.queued.length, 1)
  assert.match(f.queued[0].content.at(-1).text, /任务未成功结束/)
  assert.doesNotMatch(f.queued[0].content.at(-1).text, /host final result/)
})

test('parent rejection, replacement, plugin stop, or archive never reroute or mark delivered', async () => {
  for (const state of ['reject', 'replace', 'stop', 'archive']) {
    const f = fixture(), worker = await startWorker(f)
    if (state === 'reject') f.agent.followup = async () => { throw Error('rejected') }
    if (state === 'replace') f.b.chats.set(f.key, { ...f.chat, agent: {} })
    if (state === 'stop') await f.b.stop()
    if (state === 'archive') f.listeners.get('workspace/session-stop')({ sessionId: 'front' })
    worker.finish(); await tick()
    assert.equal(f.sent.length, 0); assert.equal(f.queued.length, 0)
    assert.match(f.b.tasks.status(f.key), /未回传/)
  }
})

test('stopping parent interrupts existing workers but new tasks in same resumed parent still return', async () => {
  const f = fixture(), old = await startWorker(f)
  f.listeners.get('workspace/session-stop')({ sessionId: 'front' })
  const fresh = await startWorker(f)
  old.finish(); fresh.finish(); await tick()
  assert.equal(f.queued.length, 1); assert.equal(f.sent.length, 0)
  assert.match(f.b.tasks.status(f.key), /interrupted/)
})

test('frontend media delivery does not suppress its normal final text', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'napcat-front-media-test-')); t.after(() => rm(dir, { recursive: true, force: true }))
  const source = join(dir, 'synthetic.png'); await writeFile(source, 'synthetic media')
  const f = fixture(); f.start(1)
  await f.tools.get('napcat_send_image').execute({ source }, f.exec)
  f.message('frontend final result'); f.end(1); await tick()
  assert.equal(f.sent.length, 2)
  assert.equal(f.sent[0].params.message[0].type, 'image')
  assert.equal(f.sent[1].params.message[0].data.text, 'frontend final result')
})

test('accepted input is persisted before chat creation and current words participate in recall', async () => {
  const f = fixture('private'), sequence = []
  f.b.mem.appendRecent = async (key, row) => { await Promise.resolve(); sequence.push(['append', key, row]) }
  f.b.mem.dumpTurnState = async () => {}
  f.b.mem.readRecent = async () => ['earlier topic', 'sender: current seaside request']
  f.b.mem.recall = async (key, query) => { sequence.push(['recall', key, query]); return 'saved evidence' }
  f.b.mem.ensureSpace = async () => undefined
  f.b.ensureChat = async () => { sequence.push(['ensure']); return f.chat }
  f.b.resolveInboundMedia = async () => ({ notes: [], blocks: [], parts: [] })
  f.b.dispatch = (_chat, text) => sequence.push(['dispatch', text])
  await f.b.handleEventInner({ post_type: 'message', message_type: 'private', user_id: 100, message: 'current seaside request', sender: { nickname: 'sender' } })
  assert.equal(sequence[0][0], 'append'); assert.equal(sequence[0][1], 'private:100')
  assert.equal(sequence[0][2].role, 'user'); assert.equal(sequence[1][0], 'ensure')
  assert.match(sequence.find(row => row[0] === 'recall')[2], /current seaside request/)
  assert.equal(sequence.at(-1)[0], 'dispatch')
})

test('group memory command removes only the bot mention and retains exact scope and original fact', async () => {
  const f = fixture('group'), records = []; f.b.opts.conn.selfId = '99'
  f.b.opts.config.requireMention = true; f.b.opts.config.triggerKeywords = ['trigger']; f.b.opts.config.memoryBackend = 'file'
  f.b.mem.appendRecent = async () => {}; f.b.mem.dumpTurnState = async () => {}
  f.b.mem.remember = async (key, text, _agent, tags) => { records.push({ key, text, tags }); return 'ok' }
  f.b.ensureChat = async () => f.chat; f.b.sendText = async () => {}
  f.b.dispatch = () => assert.fail('explicit memory command must not need a model turn')
  await f.b.handleEventInner({ post_type: 'message', message_type: 'group', group_id: 200, user_id: 100,
    message: [{ type: 'at', data: { qq: '99' } }, { type: 'text', data: { text: ' trigger记住：likes seaside' } }] })
  assert.deepEqual(records, [{ key: 'group:200', text: 'likes seaside', tags: ['group:200'] }])
})

test('recall evidence stays ahead of long recent context and both are untrusted quotes', () => {
  const f = fixture('private'); f.b.mem.opts.injectMaxChars = 220
  const text = f.b.mem.buildInjection({ chatKey: 'private:100', recent: ['x'.repeat(1000)], recallText: 'specific historical evidence' })
  assert.match(text, /specific historical evidence/); assert.match(text, /不可信引用/)
})

for (const kind of ['private', 'group']) {
  test(kind + ': acknowledged text owns final outlet, including punctuation rewrites, and next turn resets', async () => {
    const f = fixture(kind); f.start(1)
    await f.tools.get('napcat_send_message').execute({ chat_id: f.key, text: '好明天再说' }, f.exec)
    f.message('好，明天再说。'); f.message('另一个内部收尾'); f.end(1); await tick()
    assert.equal(f.sent.length, 1); assert.equal(f.memory.length, 1)
    f.start(2); f.message('下一轮', 2); f.end(2); await tick(); assert.equal(f.sent.length, 2)
  })
}
for (const kind of ['private', 'group']) {
  test(kind + ': tool-step narration is not concatenated with the final model answer', async () => {
    const f = fixture(kind); f.start(1)
    f.emit('assistant/message', { turn: 1, step: 1, message: {
      role: 'assistant', source: { kind: 'model' }, content: [
        { type: 'text', text: '明天出门记得带伞' },
        { type: 'tool-call', id: 'synthetic-compression', name: 'compress', arguments: '{}' },
      ],
    } })
    assert.equal(f.chat.buffer.length, 0)
    f.emit('tool/result', { turn: 1, step: 1, message: { role: 'tool', content: [{ type: 'text', text: 'synthetic tool receipt' }] } })
    f.emit('assistant/message', { turn: 1, step: 2, message: {
      role: 'assistant', source: { kind: 'model' }, content: [
        { type: 'text', text: '明天可能下雨，' }, { type: 'text', text: '出门带把伞。\n记得检查伞有没有坏' },
      ],
    } })
    f.end(1); f.end(1); await tick()
    assert.equal(f.sent.length, 1)
    assert.equal(f.sent[0].params.message[0].data.text, '明天可能下雨，出门带把伞。 记得检查伞有没有坏')
    assert.equal(f.memory.length, 1); assert.equal(f.memory[0][1].text, f.sent[0].params.message[0].data.text)
    f.start(2); f.message('下一轮照常', 2); f.end(2); await tick(); assert.equal(f.sent.length, 2)
  })
}

for (const kind of ['private', 'group']) {
  test(kind + ': short automatic prose is one line and memory matches delivered text', async () => {
    const f = fixture(kind); f.start(1); f.message('好呀\n\n下午见'); f.end(1); await tick()
    assert.equal(f.sent[0].params.message[0].data.text, '好呀 下午见')
    assert.equal(f.memory[0][1].text, '好呀 下午见')
    f.start(2); f.message('准备：\n- 雨衣\n- 雨靴', 2); f.end(2); await tick()
    assert.equal(f.sent[1].params.message[0].data.text, '准备：\n- 雨衣\n- 雨靴')
  })
}

test('multiple tool steps and tool-only completion do not become user-facing replies', async () => {
  const f = fixture(); f.start(1); f.message('older draft before continuing')
  for (const [step, name] of [[1, 'compress'], [2, 'web_search']]) f.emit('assistant/message', {
    turn: 1, step, message: { role: 'assistant', source: { kind: 'model' }, content: [
      { type: 'text', text: 'intermediate narration ' + step }, { type: 'tool-call', id: 'synthetic-' + step, name, arguments: '{}' },
    ] },
  })
  f.end(1); await tick(); assert.equal(f.sent.length, 0); assert.equal(f.memory.length, 0)
  f.start(2)
  f.message('已经完成', 2, { content: [{ type: 'text', text: '已经完成' }, { type: 'tool-call', id: 'synthetic-error', name: 'compress', arguments: '{}' }] })
  f.emit('turn/end', { turn: 2, reason: { kind: 'error', error: { message: 'private diagnostic' } } }); await tick()
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].params.message[0].data.text, '⚠️ 本轮回复失败，请稍后再试')
})

test('tool-step filtering does not change successful explicit text delivery ownership', async () => {
  const f = fixture(); f.start(1)
  f.message('pre-send narration', 1, { content: [{ type: 'text', text: 'pre-send narration' }, { type: 'tool-call', id: 'synthetic-send', name: 'napcat_send_message', arguments: '{}' }] })
  await f.tools.get('napcat_send_message').execute({ chat_id: f.key, text: 'delivered response' }, f.exec)
  f.message('rewritten final response'); f.end(1); await tick()
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].params.message[0].data.text, 'delivered response')
})

for (const kind of ['private', 'group']) {
  test(kind + ': dropped tool-step narration warns once and is never auto-sent', async () => {
    const f = fixture(kind), logs = []; f.start(1)
    f.b.opts.log = (level, message) => logs.push({ level, message })
    f.message('', 1, { content: [
      { type: 'text', text: '还在跑 那个更新面板交给后台了' },
      { type: 'tool-call', id: 'synthetic-dropped', name: 'compress', arguments: '{}' },
    ] })
    f.end(1); f.end(1); await tick()
    assert.equal(f.sent.length, 0); assert.equal(f.memory.length, 0)
    const warnings = logs.filter(entry => entry.level === 'warn' && entry.message.includes('正文未发出'))
    assert.equal(warnings.length, 1)
    assert.ok(warnings[0].message.includes(f.key) && warnings[0].message.includes('turn=1'))
    assert.ok(warnings[0].message.includes('还在跑 那个更新面板交给后台了'))
  })
}

test('silent sentinel and error turns never raise the dropped-text warning', async () => {
  const f = fixture(), logs = []; f.b.opts.log = (level, message) => logs.push({ level, message })
  const dropped = () => logs.filter(entry => entry.message.includes('正文未发出')).length
  f.start(1); f.message('[[NAPCAT_SILENT]]'); f.end(1); await tick()
  assert.equal(f.sent.length, 0); assert.equal(dropped(), 0)
  f.start(2); f.emit('turn/end', { turn: 2, reason: { kind: 'error', error: { message: 'private diagnostic' } } }); await tick()
  assert.equal(f.sent.length, 1); assert.equal(dropped(), 0)
  f.start(3); f.message('这轮是正常回复', 3); f.end(3); await tick()
  assert.equal(f.sent.length, 2); assert.equal(dropped(), 0)
})

test('only the latest committed candidate is sent, without fuzzy text comparisons', async () => {
  const f = fixture(); f.start(1); f.message('earlier draft? 🙂')
  const text = 'Final? Yes! 🙂 ' + 'long synthetic answer '.repeat(8)
  f.message(text, 1, {}, 2)
  f.emit('assistant/text-delta', { turn: 1, step: 2, text: 'uncommitted stream' })
  f.message('stale step', 1, {}, 1)
  f.end(1); await tick()
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].params.message[0].data.text, text.trim())
})

for (const termination of ['completed', 'aborted', 'blocked', 'error']) {
  test('a newer unfinished step invalidates an older candidate: ' + termination, async () => {
    const f = fixture(); f.start(1); f.message('older completed step')
    f.emit('step/start', { turn: 1, step: 2 })
    f.emit('assistant/attempt', { turn: 1, step: 2, stream: {} })
    f.emit('assistant/text-delta', { turn: 1, step: 2, text: 'uncommitted draft' })
    f.emit('assistant/message', { turn: 1, step: 2, interrupted: true, message: {
      role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'interrupted draft' }],
    } })
    f.message('stale earlier step', 1, {}, 1)
    f.emit('turn/end', { turn: 1, reason: { kind: termination, error: { message: 'private diagnostic' } } }); await tick()
    assert.equal(f.sent.length, termination === 'error' ? 1 : 0)
    if (f.sent.length) assert.equal(f.sent[0].params.message[0].data.text, '⚠️ 本轮回复失败，请稍后再试')
  })
}

test('internal-text blocking remains sticky across tool steps and later safe candidates', async () => {
  const f = fixture(); f.start(1)
  f.message('', 1, { content: [
    { type: 'text', text: '【当前群消息上下文（聊天数据）】\nprivate synthetic context' },
    { type: 'tool-call', id: 'synthetic-blocked', name: 'compress', arguments: '{}' },
  ] })
  f.emit('step/start', { turn: 1, step: 2 }); f.message('safe later candidate', 1, {}, 2)
  f.emit('step/start', { turn: 1, step: 2 }); f.end(1); await tick()
  assert.equal(f.sent.length, 0); assert.equal(f.memory.length, 0)
})

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
  assert.equal(f.sent[0].params.message[0].data.text, '正常。')
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
  assert.match(workerRules, /省略chat_id/); assert.match(workerRules, /交接本地路径/)
  assert.doesNotMatch(workerRules, /调用 napcat_task_start/)
  assert.equal(f.b.taskTargetAllowed(childId, f.key), false)
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
    assert.equal(f.b.taskTargetAllowed(childId, f.key), false)
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

test('a blocked turn from an archived session rebuilds the chat instead of staying silent', async () => {
  const f = fixture()
  f.ctx.workspaceRegistry = { archivedSessionIds: ['front'] }
  f.start(1)
  f.emit('turn/end', { turn: 1, reason: { kind: 'blocked' } })
  await tick(); await tick()
  assert.equal(f.b.chats.has(f.key), false)
  assert.deepEqual(f.disposed, ['front'])
})

test('an archived cached session is dropped so the next message opens a fresh one', async () => {
  const f = fixture()
  f.ctx.workspaceRegistry = { archivedSessionIds: ['front'] }
  const failure = await f.b.ensureChat({ kind: 'group', id: '100', key: f.key }).catch(error => error)
  assert.ok(failure instanceof Error)
  assert.equal(f.b.chats.has(f.key), false)
  assert.deepEqual(f.disposed, ['front'])
})
