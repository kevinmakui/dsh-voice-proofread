// PCM16 mono WAV format accepted by DSH's speech controller.
export function encodeWave(samples) {
  const bytes = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(bytes.buffer)
  const tag = (offset, text) => { for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i) }
  tag(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); tag(8, 'WAVE'); tag(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true)
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); tag(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true)
  }
  return bytes
}

// Owns a single microphone request, including grants that arrive after cancellation.
export class Recording {
  constructor(environment = globalThis) {
    this.env = environment
    this.cancelled = false
    this.chunks = []
  }

  async start(onError = () => {}) {
    if (this.started || this.cancelled) throw new Error('Recording is not available')
    this.started = true
    const stream = await this.env.navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    if (this.cancelled) {
      stream.getTracks().forEach(track => track.stop())
      throw new Error('Recording cancelled')
    }
    this.stream = stream
    try {
      this.context = new this.env.AudioContext()
      this.recorder = new this.env.MediaRecorder(stream)
      this.recorder.ondataavailable = event => { if (!this.cancelled && event.data.size) this.chunks.push(event.data) }
      const interrupted = () => {
        if (this.cancelled || this.stopping) return
        void this.dispose().catch(() => {})
        onError(new Error('Recording interrupted'))
      }
      this.recorder.onerror = interrupted
      for (const track of stream.getTracks()) track.addEventListener('ended', interrupted)
      this.recorder.start()
    } catch (error) { await this.dispose(); throw error }
  }

  async stop(maxDurationSeconds) {
    const recorder = this.recorder, context = this.context
    if (this.cancelled || this.stopping || !recorder || recorder.state !== 'recording') throw new Error('No active recording')
    this.stopping = true
    try {
      await new Promise((resolve, reject) => {
        this.rejectStop = reject
        recorder.onstop = resolve
        recorder.onerror = () => reject(new Error('Recording failed'))
        recorder.stop()
      })
      this.rejectStop = undefined
      this.stream.getTracks().forEach(track => track.stop())
      if (this.cancelled) throw new Error('Recording cancelled')
      const blob = new this.env.Blob(this.chunks, { type: recorder.mimeType })
      if (!blob.size) throw new Error('Recording is empty')
      const decoded = await context.decodeAudioData(await blob.arrayBuffer())
      if (this.cancelled) throw new Error('Recording cancelled')
      const length = Math.max(1, Math.floor(Math.min(decoded.duration, maxDurationSeconds) * 16000))
      const offline = new this.env.OfflineAudioContext(1, length, 16000)
      const source = offline.createBufferSource()
      source.buffer = decoded
      source.connect(offline.destination)
      source.start()
      const result = await offline.startRendering()
      if (this.cancelled) throw new Error('Recording cancelled')
      return encodeWave(result.getChannelData(0))
    } finally { await this.dispose() }
  }

  dispose() {
    if (this.disposal) return this.disposal
    this.cancelled = true
    this.rejectStop?.(new Error('Recording cancelled'))
    try { if (this.recorder?.state === 'recording') this.recorder.stop() } catch { /* Release tracks even if the recorder failed. */ }
    this.stream?.getTracks().forEach(track => { try { track.stop() } catch { /* Release remaining tracks. */ } })
    this.chunks = []
    const context = this.context
    this.disposal = context && context.state !== 'closed' ? Promise.resolve(context.close()) : Promise.resolve()
    return this.disposal
  }
}
