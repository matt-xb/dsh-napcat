import test from 'node:test'
import assert from 'node:assert/strict'
import { compactShortReply } from '../lib/text.js'

for (const [name, input, expected] of [
  ['short prose', '好呀\n\n下午见', '好呀 下午见'],
  ['CRLF and padding', ' 好呀 \r\n \r\n 下午见 ', '好呀 下午见'],
  ['punctuation retained', '真的？\n\n那还挺意外的……', '真的？ 那还挺意外的……'],
  ['one line', '那还行', '那还行'],
  ['empty', '', ''],
  ['long answer', '这是完整的说明'.repeat(25) + '\n\n第二段', '这是完整的说明'.repeat(25) + '\n\n第二段'],
  ['code fence', '示例\n```js\nrun()\n```', '示例\n```js\nrun()\n```'],
  ['code punctuation', '执行\nrun({ ok: true })', '执行\nrun({ ok: true })'],
  ['plain command', '执行\n npm test', '执行\n npm test'],
  ['math', '结果\n$x+y$', '结果\n$x+y$'],
  ['list', '准备：\n- 雨衣\n- 雨靴', '准备：\n- 雨衣\n- 雨靴'],
  ['ordered list', '步骤：\n1. 关机\n2. 等待', '步骤：\n1. 关机\n2. 等待'],
  ['Chinese list', '步骤：\n一、关机\n二、等待', '步骤：\n一、关机\n二、等待'],
  ['quote', '> 原话\n说明', '> 原话\n说明'],
  ['URL', '来源\nhttps://example.com/', '来源\nhttps://example.com/'],
  ['non-Chinese exact payload', 'alpha\n\nbeta', 'alpha\n\nbeta'],
]) test('short reply layout: ' + name, () => assert.equal(compactShortReply(input), expected))
