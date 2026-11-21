import test from 'node:test'
import assert from 'node:assert/strict'
import { encodeWave, Recording } from '../audio.js'

test('encodes 16 kHz mono PCM16 with bounded samples', () => {
  const bytes = encodeWave(new Float32Array([-2, 0, 2]))
  const view = new DataView(bytes.buffer)
  assert.equal(Buffer.from(bytes.subarray(0, 4)).toString(), 'RIFF')
  assert.equal(Buffer.from(bytes.subarray(8, 12)).toString(), 'WAVE')
  assert.equal(view.getUint32(4, true), bytes.length - 8)
  assert.equal(view.getUint32(24, true), 16000)
  assert.equal(view.getUint16(22, true), 1)
  assert.equal(view.getUint16(34, true), 16)
  assert.equal(view.getUint32(40, true), 6)
  assert.deepEqual([view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true)], [-32768, 0, 32767])
})

test('a microphone grant arriving after disposal is immediately released', async () => {
  let grant, stopped = 0
  const recording = new Recording({ navigator: { mediaDevices: { getUserMedia: () => new Promise(resolve => { grant = resolve }) } } })
  const started = recording.start()
  await recording.dispose()
  grant({ getTracks: () => [{ stop() { stopped++ } }] })
  await assert.rejects(started, /cancelled/)
  assert.equal(stopped, 1)
})

test('capture converts audio to bounded WAV and releases resources', async () => {
  let stopped = 0, closed = 0, length
  const track = { stop() { stopped++ }, addEventListener() {} }
  class Recorder {
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm' }
    start() { this.state = 'recording' }
    stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['audio']) }); this.onstop?.() }
  }
  class Context {
    state = 'running'
    async decodeAudioData() { return { duration: 2 } }
    async close() { closed++ }
  }
  class Offline {
    constructor(channels, samples, rate) { assert.equal(channels, 1); assert.equal(rate, 16000); length = samples }
    createBufferSource() { return { connect() {}, start() {} } }
    async startRendering() { return { getChannelData: () => new Float32Array(length) } }
  }
  const recording = new Recording({ navigator: { mediaDevices: { async getUserMedia() { return { getTracks: () => [track] } } } },
    MediaRecorder: Recorder, AudioContext: Context, OfflineAudioContext: Offline, Blob })
  await recording.start()
  const bytes = await recording.stop(1)
  assert.equal(length, 16000)
  assert.equal(bytes.length, 32044)
  assert.ok(stopped >= 1)
  assert.equal(closed, 1)
  await recording.dispose()
  assert.equal(closed, 1)
})

test('cancelling while the recorder is stopping releases the microphone and rejects the pending stop', async () => {
  let stopped = 0, closed = 0
  const track = { stop() { stopped++ }, addEventListener() {} }
  class Recorder {
    state = 'inactive'
    start() { this.state = 'recording' }
    stop() { this.state = 'inactive' }
  }
  class Context { state = 'running'; async close() { closed++ } }
  const recording = new Recording({ navigator: { mediaDevices: { async getUserMedia() { return { getTracks: () => [track] } } } },
    MediaRecorder: Recorder, AudioContext: Context })
  await recording.start()
  const stop = recording.stop(1)
  await assert.rejects(recording.stop(1), /No active recording/)
  const rejected = assert.rejects(stop, /cancelled/)
  await recording.dispose()
  await rejected
  assert.equal(stopped, 1)
  assert.equal(closed, 1)
})

test('recorder failure does not prevent microphone tracks from being released', async () => {
  let stopped = 0, closed = 0
  class Recorder { state = 'recording'; start() {}; stop() { throw Error('device failed') } }
  class Context { state = 'running'; async close() { closed++ } }
  const recording = new Recording({ navigator: { mediaDevices: { async getUserMedia() { return { getTracks: () => [
    { stop() { throw Error('track failed') }, addEventListener() {} }, { stop() { stopped++ }, addEventListener() {} },
  ] } } } }, MediaRecorder: Recorder, AudioContext: Context })
  await recording.start()
  await recording.dispose()
  assert.equal(stopped, 1)
  assert.equal(closed, 1)
})
