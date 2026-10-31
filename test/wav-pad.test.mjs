// 尾部补静音到整秒：NapCat 把小数 duration 交给 QQ，QQ 侧 Math.round 收尾会切掉有声尾巴。
import test from 'node:test'
import assert from 'node:assert/strict'

import { padWavToSecond, parseWav, PAD_MIN_MS } from '../lib/wav.js'
import { makeWav } from './wav-fixture.mjs'

const RATE = 24000

/** 时长（秒）→ 采样数。 */
const samples = seconds => Math.round(seconds * RATE)

test('padWavToSecond 表驱动：该补的补齐到整秒，不该补的原样返回', () => {
  const cases = [
    { name: '需要补 640ms', inputSec: 3.36, expectPadMs: 640 },
    { name: '已经正好整秒不补', inputSec: 4, expectPadMs: 0 },
    { name: '刚好差 30ms（阈值下界，不补）', inputSec: 3.97, expectPadMs: 0 },
    { name: '差 31ms（越过阈值，补）', inputSec: 3.969, expectPadMs: 31 },
  ]
  for (const item of cases) {
    const input = makeWav(samples(item.inputSec))
    const { buffer, paddedMs } = padWavToSecond(input)
    const label = item.name + '（' + (input.length - 44) / 2 + ' 采样）'
    if (item.expectPadMs === 0) {
      assert.equal(paddedMs, 0, label + ' 不该补')
      assert.equal(buffer, input, label + ' 应原样返回同一个 buffer')
      continue
    }
    assert.equal(paddedMs, item.expectPadMs, label + ' 补齐量')
    // 补完的时长必须正好整秒。
    const info = parseWav(buffer)
    assert.equal(info.dataLength % (RATE * 2), 0, label + ' 补完必须是整秒')
    assert.equal(info.dataLength / (RATE * 2), Math.ceil(item.inputSec), label + ' 补到下一个整秒')
  }
})

test('padWavToSecond 只动尾部：原有音频字节一个不改，补的全是零采样', () => {
  const input = makeWav(samples(3.36))
  const { buffer } = padWavToSecond(input)
  const info = parseWav(buffer)
  assert.deepEqual(buffer.subarray(20, 36), input.subarray(20, 36), 'fmt 块（采样率/位深/声道）必须原样')
  assert.deepEqual(buffer.subarray(44, input.length), input.subarray(44), '有声部分必须原样')
  const tail = buffer.subarray(input.length)
  assert.equal(tail.length, info.dataLength - (input.length - 44), '补的字节数对得上')
  assert.ok(tail.length > 0, '确实补了字节')
  assert.ok(tail.every(byte => byte === 0), '补的是纯静音')
})

test('padWavToSecond 正确回填 RIFF/data 长度字段', () => {
  const input = makeWav(samples(3.36))
  const { buffer } = padWavToSecond(input)
  const info = parseWav(buffer)
  assert.equal(buffer.length, info.dataOffset + info.dataLength, '文件长度=data 起点+data 长度')
  assert.equal(buffer.readUInt32LE(4), buffer.length - 8, 'RIFF size')
  assert.equal(buffer.readUInt32LE(info.dataOffset - 4), info.dataLength, 'data size')
  assert.ok(buffer.readUInt32LE(info.dataOffset - 4) > input.readUInt32LE(40), 'data size 确实变大了')
})

test('padWavToSecond 占位头也能补齐（阿里云流式返回的那种）', () => {
  const { buffer, paddedMs } = padWavToSecond(makeWav(samples(3.36), { placeholderHeader: true }))
  assert.equal(paddedMs, 640)
  const info = parseWav(buffer)
  assert.equal(info.dataLength / (RATE * 2), 4, '占位头不该影响补到几秒')
  assert.equal(buffer.readUInt32LE(4), buffer.length - 8)
})

test('padWavToSecond 对非 wav 输入安全跳过', () => {
  const mp3 = Buffer.from('ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000', 'latin1')
  const { buffer, paddedMs } = padWavToSecond(mp3)
  assert.equal(paddedMs, 0)
  assert.equal(buffer, mp3, '非 wav 必须原样返回，不能抛错也不能改字节')
})

test('padWavToSecond 对立体声也按整帧补，不按字节算', () => {
  // 把 fixture 改成 24kHz/16bit/双声道：同样的数据字节，帧数只有一半，补齐量要跟着变。
  const input = Buffer.from(makeWav(samples(3.36)))
  input.writeUInt16LE(2, 22)
  input.writeUInt32LE(RATE * 4, 28)
  const { buffer, paddedMs } = padWavToSecond(input)
  // 立体声下 3.36s 的字节数是双声道的一半时长 → 1.68s → 补 320ms。
  assert.equal(paddedMs, 320, '立体声帧长翻倍，补齐量按秒算')
  const info = parseWav(buffer)
  assert.equal(info.channels, 2)
  assert.equal(info.dataLength % (RATE * 4), 0, '立体声也要落在整秒')
  assert.equal(info.dataLength / (RATE * 4), 2, '补到 2 秒')
})

test('PAD_MIN_MS 是 30ms：小数部分已够进位时不白加空白', () => {
  assert.equal(PAD_MIN_MS, 30)
})
