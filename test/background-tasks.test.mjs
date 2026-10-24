import test from 'node:test'
import assert from 'node:assert/strict'
import { BackgroundTasks, registerTaskTools } from '../lib/tasks.js'

const deferred = () => {
  let resolve, reject
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
const parent = { session: { id: 'foreground-1' } }
const prompt = [{ type: 'text', text: 'make something' }]
function fixture() {
  const runs = [], sent = [], logs = []
  const tasks = new BackgroundTasks({
    start: async input => {
      const result = deferred()
      const run = { ...input, result, disposed: false }
      runs.push(run)
      return { childId: input.childId, result: result.promise, dispose: async () => { run.disposed = true } }
    },
    notify: async (key, text) => { sent.push({ key, text }) },
    log: message => logs.push(message),
  })
  return { tasks, runs, sent, logs }
}

test('activation returns before result; ownership exists before provider starts; result returns to origin only', async () => {
  let tasks
  const result = deferred(), sent = []
  tasks = new BackgroundTasks({
    start: async input => {
      assert.equal(tasks.keyForSession(input.childId), 'private:1')
      return { childId: input.childId, result: result.promise }
    },
    notify: async (key, text) => { sent.push({ key, text }) },
  })
  const receipt = await tasks.start({ parent, chatKey: 'private:1', prompt })
  assert.equal(receipt.taskId, receipt.childId)
  assert.equal(tasks.canSend('unrelated-session', 'private:1'), undefined)
  assert.equal(tasks.canSend(receipt.childId, 'private:1'), true)
  assert.equal(tasks.canSend(receipt.childId, 'private:2'), false)
  assert.match(tasks.status('private:1'), /running/)
  assert.equal(sent.length, 0)
  assert.doesNotMatch(tasks.status('private:2'), new RegExp(receipt.taskId))
  result.resolve({ output: [{ type: 'text', text: 'done' }], stopReason: 'completed' })
  await tick()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].key, 'private:1')
  assert.match(sent[0].text, /done/)
  assert.equal(tasks.keyForSession(receipt.childId), 'private:1')
  assert.equal(tasks.canSend(receipt.childId, 'private:1'), false)
  assert.equal(tasks.trackTextSend(receipt.childId, 'private:1'), undefined)
  assert.match(tasks.status('private:1'), /已回传/)
})

test('a task final result retains all legitimate text blocks from the host receipt', async () => {
  const { tasks, runs, sent } = fixture()
  await tasks.start({ parent, chatKey: 'private:1', prompt })
  runs[0].result.resolve({ output: [{ type: 'text', text: 'first final section' }, { type: 'text', text: 'second final section' }], stopReason: 'completed' })
  await tick()
  assert.equal(sent.length, 1); assert.match(sent[0].text, /first final section[\s\S]*second final section/)
})

test('progress uses event names only, not thought, arguments or result body', async () => {
  const { tasks } = fixture()
  const { childId } = await tasks.start({ parent, chatKey: 'group:2', prompt })
  tasks.onSessionEvent({ id: childId }, { type: 'tool/call', data: { name: 'image_generate', arguments: 'secret-arguments' } })
  assert.match(tasks.status('group:2'), /image_generate/)
  assert.doesNotMatch(tasks.status('group:2'), /secret-arguments/)
  tasks.onSessionEvent({ id: childId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'private-thought' }] } } })
  assert.doesNotMatch(tasks.status('group:2'), /private-thought/)
  tasks.onSessionEvent({ id: childId }, { type: 'tool/result', data: { message: { content: 'secret-result' } } })
  assert.match(tasks.status('group:2'), /工具调用结束/)
  assert.doesNotMatch(tasks.status('group:2'), /secret-result/)
  await tasks.stop()
})

test('successful tool text suppresses duplicate final text, but wrong-target and incomplete sends do not', async () => {
  const { tasks, runs, sent } = fixture()
  const a = await tasks.start({ parent, chatKey: 'private:1', prompt })
  const b = await tasks.start({ parent, chatKey: 'private:2', prompt })
  assert.equal(tasks.trackTextSend(a.childId, 'private:2'), undefined)
  await tasks.trackTextSend(a.childId, 'private:1')('already delivered', true)
  await tasks.trackTextSend(b.childId, 'private:2')('partial')
  for (const run of runs) run.result.resolve({ output: [{ type: 'text', text: 'final' }], stopReason: 'completed' })
  await tick()
  assert.deepEqual(sent.map(item => item.key), ['private:2'])
})

test('successful media suppresses completed task prose and empty completion notices only for its original chat', async () => {
  const { tasks, runs, sent } = fixture()
  const a = await tasks.start({ parent, chatKey: 'private:1', prompt })
  const b = await tasks.start({ parent, chatKey: 'private:2', prompt })
  const c = await tasks.start({ parent, chatKey: 'private:3', prompt })
  tasks.recordMediaSend(a.childId, 'private:1')
  tasks.recordMediaSend(b.childId, 'private:2')
  tasks.recordMediaSend(c.childId, 'private:1')
  tasks.recordMediaSend('unregistered-session', 'private:3')
  runs[0].result.resolve({ output: [{ type: 'text', text: 'redundant media summary' }], stopReason: 'completed' })
  runs[1].result.resolve({ output: [], stopReason: 'completed' })
  runs[2].result.resolve({ output: [{ type: 'text', text: 'legitimate text result' }], stopReason: 'completed' })
  await tick()
  assert.deepEqual(sent.map(item => item.key), ['private:3'])
  assert.match(sent[0].text, /legitimate text result/)
  assert.match(tasks.status('private:1'), /completed.*已回传/)
  assert.match(tasks.status('private:2'), /completed.*已回传/)
})

test('media delivery does not suppress error or aborted task notices', async () => {
  const { tasks, runs, sent } = fixture()
  for (const stopReason of ['error', 'aborted']) {
    const { childId } = await tasks.start({ parent, chatKey: 'private:1', prompt })
    tasks.recordMediaSend(childId, 'private:1')
    runs.at(-1).result.resolve({ output: [{ type: 'text', text: 'misleading media summary' }], stopReason })
  }
  await tick()
  assert.equal(sent.length, 2)
  assert.match(sent[0].text, /任务未成功结束/)
  assert.match(sent[1].text, /任务被中断/)
  assert.ok(sent.every(item => !item.text.includes('misleading media summary')))
})

test('late media acknowledgement cannot affect another task and stopped tasks ignore media', async () => {
  const { tasks, runs, sent } = fixture()
  const first = await tasks.start({ parent, chatKey: 'private:1', prompt })
  runs[0].result.resolve({ output: [{ type: 'text', text: 'first text result' }], stopReason: 'completed' })
  await tick()
  const second = await tasks.start({ parent, chatKey: 'private:1', prompt })
  tasks.recordMediaSend(first.childId, 'private:1')
  runs[1].result.resolve({ output: [{ type: 'text', text: 'second text result' }], stopReason: 'completed' })
  await tick()
  assert.equal(sent.length, 2)
  assert.match(sent[1].text, /second text result/)
  assert.equal(tasks.canSend(second.childId, 'private:1'), false)
  const stopped = await tasks.start({ parent, chatKey: 'private:1', prompt })
  await tasks.stop()
  tasks.recordMediaSend(stopped.childId, 'private:1')
  runs[2].result.resolve({ output: [], stopReason: 'completed' })
  await tick()
  assert.equal(sent.length, 2)
  assert.match(tasks.status('private:1'), /interrupted.*未回传/)
})

test('non-success stop reasons and rejection are not reported as completed', async () => {
  const { tasks, runs, sent } = fixture()
  for (const stopReason of ['max-tokens', 'aborted', 'error']) {
    await tasks.start({ parent, chatKey: 'private:1', prompt })
    runs.at(-1).result.resolve({ output: [{ type: 'text', text: 'misleading partial output' }], stopReason })
  }
  await tasks.start({ parent, chatKey: 'private:1', prompt })
  runs.at(-1).result.reject(new Error('private provider diagnostic'))
  await tick()
  assert.equal(sent.length, 4)
  assert.ok(sent.every(item => !item.text.includes('任务完成') && !item.text.includes('misleading partial output') && !item.text.includes('private provider diagnostic')))
  assert.match(tasks.status('private:1'), /interrupted/)
})

test('notification failure is retained as undelivered without leaking raw error', async () => {
  const result = deferred(), logs = []
  const tasks = new BackgroundTasks({
    start: async input => ({ childId: input.childId, result: result.promise }),
    notify: async () => { throw new Error('private credentials') },
    log: line => logs.push(line),
  })
  await tasks.start({ parent, chatKey: 'private:1', prompt })
  result.resolve({ output: [], stopReason: 'completed' })
  await tick()
  assert.match(tasks.status('private:1'), /未回传/)
  assert.ok(logs.every(line => !line.includes('private credentials')))
})

test('stop drains accepted children and ignores late results', async () => {
  const { tasks, runs, sent } = fixture()
  const { childId } = await tasks.start({ parent, chatKey: 'private:1', prompt })
  await tasks.stop()
  assert.equal(runs[0].signal.aborted, true)
  assert.equal(runs[0].disposed, true)
  assert.equal(tasks.keyForSession(childId), 'private:1')
  assert.equal(tasks.canSend(childId, 'private:1'), false)
  assert.equal(tasks.trackTextSend(childId, 'private:1'), undefined)
  runs[0].result.resolve({ output: [{ type: 'text', text: 'too late' }], stopReason: 'completed' })
  await tick()
  assert.equal(sent.length, 0)
  assert.match(tasks.status('private:1'), /interrupted/)
  await assert.rejects(tasks.start({ parent, chatKey: 'private:1', prompt }), /已停止/)
})

test('stop during admission disposes the eventual receipt without a late send', async () => {
  const activation = deferred(), result = deferred()
  let disposed = false, input
  const tasks = new BackgroundTasks({
    start: request => { input = request; return activation.promise },
    notify: async () => { assert.fail('must not send after stop') },
  })
  const starting = tasks.start({ parent, chatKey: 'private:1', prompt })
  const rejected = assert.rejects(starting, /已停止/)
  const stopping = tasks.stop()
  activation.resolve({ childId: input.childId, result: result.promise, dispose: async () => { disposed = true } })
  await Promise.all([rejected, stopping])
  result.resolve({ output: [], stopReason: 'completed' })
  await tick()
  assert.equal(disposed, true)
})

test('task tools hand off only the resolved per-turn admitted snapshot; worker cannot recursively start', async () => {
  const { tasks, runs } = fixture()
  const tools = new Map()
  const attachment = { type: 'text', text: 'admitted-file-note-A' }
  registerTaskTools({ tools: { register: tool => tools.set(tool.name, tool) } }, {
    tasks,
    resolveContext: exec => exec.agent === parent ? { parent, chatKey: 'private:1', attachments: [attachment] } : undefined,
  })
  const started = await tools.get('napcat_task_start').execute({ prompt: 'edit it', label: 'edit' }, { agent: parent })
  assert.match(started, /后台任务已接受/)
  assert.deepEqual(runs[0].prompt, [attachment, { type: 'text', text: 'edit it' }])
  assert.match(await tools.get('napcat_task_status').execute({}, { agent: parent }), /running/)
  await assert.rejects(tools.get('napcat_task_start').execute({ prompt: 'again' }, { agent: { session: { id: runs[0].childId } } }), /前台会话/)
  await tasks.stop()
})
