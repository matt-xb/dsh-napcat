/** 测试用的最小合法 wav：24kHz/16bit/mono，默认 20ms（480 采样）一帧。 */
export function makeWav(samples = 480, options = {}) {
  const data = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i += 1) data.writeInt16LE(Math.round(Math.sin(i / 12) * 800), i * 2)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'latin1')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'latin1')
  header.write('fmt ', 12, 'latin1')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(24000, 24)
  header.writeUInt32LE(48000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'latin1')
  header.writeUInt32LE(data.length, 40)
  const buffer = Buffer.concat([header, data])
  if (options.placeholderHeader === true) {
    // 阿里云流式返回的头：RIFF/data 都写 0x7FFFFFFF 占位，实际字节在文件尾。
    buffer.writeUInt32LE(2147483583, 4)
    buffer.writeUInt32LE(2147483547, 40)
  }
  return buffer
}
