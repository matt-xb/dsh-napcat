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
  // 2026-10-30 12:30 实测：思考独白写进了正文 text 块（不是 reasoning 通道）。
  ['思考独白·整段', '？？\n\n<br>\n\n用户说"比如 ？？"，我回"？？"作为演示。\n\n直接回。\n\n？？\n\n等等，我上一轮已经发过"……"，这轮发"？？"正好演示。就回。\n\n？？\n\n直接输出文字即可。？？\n', '？？'],
  ['思考独白·只有说明句', '好\n直接输出文字即可。', '好'],
  ['思考独白·第三人称复述', '嗯\n用户说"在吗"，我回"在"作为演示', '嗯'],
  ['残闭合标签', '</apc">!!!\n\n!!!\n\n\n!!!', '!!!\n!!!\n!!!'],
  ['残闭合标签·行内', '改完了</apc">', '改完了'],
  // 控制标记：全角竖线的 DSML 与 <|im_start|> 一族。
  ['控制标记·DSML 收尾三连', '嘿嘿\n\n</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>', '嘿嘿'],
  ['控制标记·invoke 残段', '任务派出去了\n<｜｜DSML｜｜ invoke name="napcat_task_status">\n｜｜/｜｜DSML｜｜ invoke>', '任务派出去了'],
  ['控制标记·im_start 与 im_end', '好\n<|im_start|>你\n<|im_end|>', '好\n你'],
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
  // 反引号/代码块里在讲这个标签，不能当注入块删。
  ['反引号里的 system_warning', '又是同一类毛病：`<system_warning>` 这种内部标签被当成正文发出去了'],
  ['代码块里的 system_reminder', '看这段：\n```html\n<system_reminder>x</system_reminder>\n```'],
  // 独白特征词出现在真正的问句/转述里要放行。
  ['独白特征·真问句', '等等，你说的是哪个文件？'],
  ['独白特征·第三人称转述', '用户说他在改配置，我回了个收到'],
  ['独白特征·直接回答', '直接回答我就行'],
  ['进度表句式', '我这边接着等结果'],
  ['含 invoke 的路径', '看 src/bridge/invoke.ts 那个文件'],
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
