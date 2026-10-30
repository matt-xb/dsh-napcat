// 脏输入语料：每次实测泄漏的原文都固化在这里，规则改动后先跑这个文件。
// 结构是表驱动：dump = 必须剥掉/拦下的泄漏物，keep = 必须原样保留的正常正文。
import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeOutgoingMessage, sanitizeReply } from '../lib/text.js'

/** 2026-10-30 群聊实测：模型把自己编的「哪条要回」判断 JSON 当正文发了出去（围栏块）。 */
const DECISION_JSON = '{\n  "language": "zh-CN",\n  "date": "2026-10-30",\n  "responses": [\n    {\n'
  + '      "id": "m00358",\n      "should_reply": false,\n      "reason": "用户重复发送同一句粗口“cnm”，上一轮已回复“复读机没电了”，无新信息。"\n'
  + '    }\n  ]\n}'

const DUMP = [
  // 决策载荷：围栏块（实测原样）、裸 JSON、数组形态、camelCase 字段、results 换名。
  ['决策载荷·围栏块', '复读机没电了\n\n```json\n' + DECISION_JSON + '\n```', '复读机没电了'],
  ['决策载荷·裸 JSON 独占一台', DECISION_JSON, ''],
  ['决策载荷·正文后跟裸 JSON', '复读机没电了\n\n' + DECISION_JSON, '复读机没电了'],
  ['决策载荷·camelCase', '{"shouldReply":true,"reason":"值得回"}', ''],
  ['决策载荷·数组形态', '[{"id":"m1","should_respond":false}]', ''],
  ['决策载荷·results', '{"results":[{"should_reply":false}]}', ''],
  // 宿主注入通知块（历史泄漏）。
  ['system_warning·成对', '在呢\n<system_warning>回复内容被拦截</system_warning>', '在呢'],
  ['system_warning·未闭合', '改完了\n<system_warning>不再重试该动作。', '改完了'],
  ['system_reminder·夹杂', '前一句<system_reminder>内部提醒</system_reminder>后一句', '前一句后一句'],
  ['宿主头（硬拒）', '这个会话来自QQ（NapCat渠道），聊天对象是 private:1', null],
  ['群上下文头（硬拒）', '【当前群消息上下文（聊天数据）】\n{"groupId":1}', null],
  // 伪角色行（历史泄漏）：User:/助手: 之后整段是聊天记录，不是回复。
  ['伪角色行·User', '刚才那条成功了\n\nUser: 什么', '刚才那条成功了'],
  ['伪角色行·助手', '助手: 我改完了', ''],
  ['伪角色行·单行 assistant', 'user 你不是说修了吗？\nassistant\n修了', 'user 你不是说修了吗？'],
  // runtime context（历史泄漏）。
  ['runtime context·整块', 'Time sampled while preparing turn 78, step 1: 2026-10-25T14:52:55+08:00[Asia/Singapore]\n'
    + 'Browser time zone for this request: unavailable. Ask the user to clarify otherwise-unqualified dates and times.\n'
    + 'Elapsed since the preceding model-visible message: 10m 0s.', ''],
  ['runtime context·正文后', '只能图个稳\n\nTime sampled while preparing turn 78, step 1: 2026-10-25T14:52:55+08:00\n'
    + 'Browser time zone for this request: unavailable.', '只能图个稳'],
  // 包装标签与工具语法（历史泄漏）。
  ['包装标签', '还在改，没修完\n</output>', '还在改，没修完'],
  ['工具语法', '好啊\n</｜｜DSML｜｜ parameter>\n> nope', '好啊'],
  ['本地图片语法', '![](D:\\NapCat\\stickers\\bqb-shock-01.jpg)', ''],
  ['静默标记', '[[NAPCAT_SILENT]]', ''],
]

const KEEP = [
  // 用户要的代码和 JSON 是内容，不是泄漏。
  ['代码块里的 JSON', '这个配置：\n```json\n{"userId": 42, "group": "abc"}\n```'],
  ['代码块里的对象字面量', '```js\nconst a = { b: 1 }\n```'],
  ['句子中间引用 JSON', '这个 {"should_reply":false} 是啥意思'],
  ['行内反引号', '写成 `<output>` 就行'],
  ['提到宿主标签名', '群友问 system_warning 是啥意思'],
  ['提到字段名', 'User 这个字段是宿主的'],
  ['提到 runtime 字样', 'Time sampled while preparing turn 78, step 1: 这句是报错原文吗'],
  ['普通多行正文', '第一行\n第二行'],
  ['尖括号比较', 'a < b 且 c > d'],
]

test('脏输入语料：实测泄漏物一律不外发', () => {
  for (const [name, input, expected] of DUMP) assert.equal(sanitizeReply(input), expected, name)
})

test('脏输入语料：正常正文与用户要的代码一字不动', () => {
  for (const [name, input] of KEEP) assert.equal(sanitizeReply(input), input, name)
})

test('脏输入语料：剥干净后走外发校验也不会发出空消息', () => {
  for (const [name, input, expected] of DUMP) {
    if (expected !== '') continue
    assert.throws(() => sanitizeOutgoingMessage(input), /空消息|内部上下文/, name)
  }
  // 决策载荷夹在正文里时，剥掉后剩下的正文照常发。
  assert.equal(sanitizeOutgoingMessage('复读机没电了\n\n```json\n' + DECISION_JSON + '\n```'), '复读机没电了')
})
