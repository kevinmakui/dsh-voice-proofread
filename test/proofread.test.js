import test from 'node:test'
import assert from 'node:assert/strict'
import { proofread } from '../proofread.js'
import { apply } from '../index.js'

const signal = () => new AbortController().signal
const llm = chunks => ({ async *stream(options) { llm.last = options; yield* chunks } })
const config = { provider: 'provider', model: 'model' }

test('passes the transcript as data and collects a complete response', async () => {
  const result = await proofread(llm([{ type: 'text-delta', text: '你好' }, { type: 'text-delta', text: '。' },
    { type: 'finish', reason: { kind: 'stop' } }]), config, '你好', signal())
  assert.equal(result, '你好。')
  assert.deepEqual(llm.last.messages, [{ role: 'user', content: [{ type: 'text', text: '你好' }] }])
  assert.match(llm.last.system, /homophones/)
  assert.match(llm.last.system, /do not invent/i)
})

test('rejects incomplete, empty and failed model responses', async () => {
  for (const chunks of [[], [{ type: 'finish', reason: { kind: 'stop' } }],
    [{ type: 'finish', reason: { kind: 'error', failure: { message: 'offline' } } }]]) {
    await assert.rejects(proofread(llm(chunks), config, 'text', signal()))
  }
})

test('empty transcripts do not call the model', async () => {
  assert.equal(await proofread({ stream() { throw Error('unexpected call') } }, config, '', signal()), '')
})

test('cancellation is honored before and after the model stream', async () => {
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(proofread({ stream() { throw Error('unexpected call') } }, config, '', cancelled.signal), { name: 'AbortError' })
  const later = new AbortController()
  const service = { async *stream() { yield { type: 'text-delta', text: 'ok' }; yield { type: 'finish', reason: { kind: 'stop' } }; later.abort() } }
  await assert.rejects(proofread(service, config, 'text', later.signal), { name: 'AbortError' })
})

test('refuses text delivered after the terminal response', async () => {
  await assert.rejects(proofread(llm([{ type: 'finish', reason: { kind: 'stop' } },
    { type: 'text-delta', text: 'late' }]), config, 'text', signal()), /after completion/)
})

test('rejects excessive model output', async () => {
  await assert.rejects(proofread(llm([{ type: 'text-delta', text: 'x'.repeat(8193) }]),
    config, 'short', signal()), /too long/)
})

test('closes a model iterator when its response is rejected', async () => {
  let closed = false, adapterSignal
  const service = { async *stream({ signal }) {
    adapterSignal = signal
    try { yield { type: 'text-delta', text: 'x'.repeat(8193) }; yield { type: 'text-delta', text: 'unreachable' } }
    finally { closed = true }
  } }
  await assert.rejects(proofread(service, config, 'short', signal()), /too long/)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(closed, true)
  assert.equal(adapterSignal.aborted, true)
})

test('times out a model call and propagates cancellation to the adapter', async () => {
  let observed
  const service = { async *stream({ signal }) {
    observed = signal
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
  } }
  await assert.rejects(proofread(service, config, 'text', signal(), 5), /timed out/)
  assert.equal(observed.aborted, true)
})

test('timeout returns even if the adapter ignores cancellation', async () => {
  const service = { async *stream() { await new Promise(() => {}); yield {} } }
  await assert.rejects(proofread(service, config, 'text', signal(), 5), /timed out/)
})

test('schema supplies the default timeout and rejects unsupported choices', async () => {
  const { Config } = await import('../index.js')
  assert.equal(Config({ provider: '', model: '' }).timeoutSeconds.get(), 30)
  assert.equal(Config({ provider: '', model: '', timeoutSeconds: 10 }).timeoutSeconds.get(), 10)
  assert.throws(() => Config({ provider: '', model: '', timeoutSeconds: 7 }))
})

test('wrapper waits for a local provider and unregisters on disposal', async () => {
  let publish, close, registered, removed = false, cleanup
  const original = { info: { id: 'sensevoice-local', name: 'SenseVoice', location: 'host-local', languages: ['auto'] },
    async transcribe() { return { text: '原文', audioSeconds: 1, inferenceSeconds: 1 } } }
  const speech = {
    async *follow(signal) {
      const queue = []; let wake
      publish = value => { queue.push(value); wake?.() }
      close = () => wake?.()
      signal.addEventListener('abort', close)
      while (!signal.aborted) { if (!queue.length) await new Promise(resolve => { wake = resolve }); while (queue.length) yield queue.shift() }
    },
    resolve(request) { return { ...request, provider: original } },
    async transcribe(spec, signal) { return spec.provider.transcribe(spec, signal) },
    register(provider) { registered = provider; return async () => { removed = true } },
  }
  let selectedModel = ''
  apply({ speechToText: speech, llm: llm([{ type: 'text-delta', text: '校对' }, { type: 'finish', reason: { kind: 'stop' } }]),
    effect(fn) { cleanup = fn() }, logger: { warn(error) { throw error } } },
  { provider: { get: () => 'provider' }, model: { get: () => selectedModel } })
  publish({ providers: [original.info] })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(registered.info.id, 'sensevoice-proofread')
  assert.equal(registered.info.location, 'host-local')
  assert.equal((await registered.transcribe({ audio: new Uint8Array(), language: 'auto' }, signal())).text, '原文')
  selectedModel = 'first'
  assert.equal((await registered.transcribe({ audio: new Uint8Array(), language: 'auto' }, signal())).text, '校对')
  assert.equal(llm.last.model, 'first')
  selectedModel = 'second'
  await registered.transcribe({ audio: new Uint8Array(), language: 'auto' }, signal())
  assert.equal(llm.last.model, 'second')
  await cleanup()
  assert.equal(removed, true)
})

test('the selected timeout is applied to the live model request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let publish, cleanup, registered, modelStarted, warning
  const info = { id: 'sensevoice-local', name: 'SenseVoice', location: 'host-local', languages: ['auto'] }
  const original = { info }
  const speech = {
    async *follow(signal) {
      let wake
      publish = () => wake?.()
      signal.addEventListener('abort', () => wake?.())
      await new Promise(resolve => { wake = resolve })
      if (!signal.aborted) yield { providers: [info] }
      await new Promise(resolve => { wake = resolve })
    },
    resolve(request) { return { ...request, provider: original } },
    async transcribe() { return { text: '原文', audioSeconds: 1, inferenceSeconds: 1 } },
    register(provider) { registered = provider; return async () => {} },
  }
  const started = new Promise(resolve => { modelStarted = resolve })
  const llm = { async *stream() { modelStarted(); await new Promise(() => {}) } }
  apply({ speechToText: speech, llm, effect(fn) { cleanup = fn() }, logger: { warn(message) { warning = message } } },
    { ...config, timeoutSeconds: { get: () => 10 } })
  publish()
  await new Promise(resolve => setImmediate(resolve))
  const operation = registered.transcribe({ audio: new Uint8Array(), language: 'auto' }, signal())
  await started
  t.mock.timers.tick(10000)
  assert.equal((await operation).text, '原文')
  assert.match(warning, /timeout/)
  assert.doesNotMatch(warning, /原文/)
  await cleanup()
})

test('wrapper withdraws when the local recognizer disappears and returns when it is replaced', async () => {
  let publish, cleanup, current, registrations = 0, removals = 0
  const info = { id: 'sensevoice-local', name: 'SenseVoice', location: 'host-local', languages: ['auto'] }
  current = { info }
  const speech = {
    async *follow(signal) {
      const queue = []; let wake
      publish = value => { queue.push(value); wake?.() }
      signal.addEventListener('abort', () => wake?.())
      while (!signal.aborted) {
        if (!queue.length) await new Promise(resolve => { wake = resolve })
        while (queue.length) yield queue.shift()
      }
    },
    resolve(request) { return { ...request, provider: current } },
    register() { registrations++; return async () => { removals++ } },
  }
  apply({ speechToText: speech, llm: {}, effect(fn) { cleanup = fn() }, logger: { warn(error) { throw error } } }, config)
  const settle = () => new Promise(resolve => setImmediate(resolve))
  publish({ providers: [info] }); await settle()
  assert.equal(registrations, 1)
  publish({ providers: [] }); await settle()
  assert.equal(removals, 1)
  current = { info }
  publish({ providers: [info] }); await settle()
  assert.equal(registrations, 2)
  await cleanup()
  assert.equal(removals, 2)
})

test('cancellation during local recognition prevents sending text to the model', async () => {
  let publish, cleanup, registered, finishRecognition, calls = 0
  const info = { id: 'sensevoice-local', name: 'SenseVoice', location: 'host-local', languages: ['auto'] }
  const original = { info }
  const speech = {
    async *follow(signal) {
      let wake
      publish = () => wake?.()
      signal.addEventListener('abort', () => wake?.())
      await new Promise(resolve => { wake = resolve })
      if (!signal.aborted) yield { providers: [info] }
      await new Promise(resolve => { wake = resolve })
    },
    resolve(request) { return { ...request, provider: original } },
    transcribe() { return new Promise(resolve => { finishRecognition = resolve }) },
    register(provider) { registered = provider; return async () => {} },
  }
  apply({ speechToText: speech, llm: { stream() { calls++; throw Error('unexpected') } },
    effect(fn) { cleanup = fn() }, logger: { warn(error) { throw error } } }, config)
  publish()
  await new Promise(resolve => setImmediate(resolve))
  const abort = new AbortController()
  const operation = registered.transcribe({ audio: new Uint8Array(), language: 'auto' }, abort.signal)
  abort.abort()
  finishRecognition({ text: 'private text', audioSeconds: 1, inferenceSeconds: 1 })
  await assert.rejects(operation, { name: 'AbortError' })
  assert.equal(calls, 0)
  await cleanup()
})

test('proofreading failures preserve the local transcript without logging private data', async () => {
  let publish, cleanup, registered, warning
  const info = { id: 'sensevoice-local', name: 'SenseVoice', location: 'host-local', languages: ['auto'] }
  const original = { info }
  const speech = {
    async *follow(signal) {
      let wake
      publish = () => wake?.()
      signal.addEventListener('abort', () => wake?.())
      await new Promise(resolve => { wake = resolve })
      if (!signal.aborted) yield { providers: [info] }
      await new Promise(resolve => { wake = resolve })
    },
    resolve(request) { return { ...request, provider: original } },
    async transcribe() { return { text: 'speech', audioSeconds: 1, inferenceSeconds: 1 } },
    register(provider) { registered = provider; return async () => {} },
  }
  apply({ speechToText: speech, llm: { stream() { throw new Error('secret endpoint details') } },
    effect(fn) { cleanup = fn() }, logger: { warn(message) { warning = message } } }, config)
  publish()
  await new Promise(resolve => setImmediate(resolve))
  const result = await registered.transcribe({ audio: new Uint8Array(), language: 'auto' }, signal())
  assert.equal(result.text, 'speech')
  assert.match(warning, /proofreading failed/)
  assert.doesNotMatch(warning, /speech|secret endpoint/)
  await cleanup()
})

test('a logging failure cannot discard a transcript after proofreading fails', async () => {
  let publish, cleanup, registered
  const info = { id: 'sensevoice-local', name: 'SenseVoice', location: 'host-local', languages: ['auto'] }
  const original = { info }
  const speech = {
    async *follow(signal) {
      let wake
      publish = () => wake?.()
      signal.addEventListener('abort', () => wake?.())
      await new Promise(resolve => { wake = resolve })
      if (!signal.aborted) yield { providers: [info] }
      await new Promise(resolve => { wake = resolve })
    },
    resolve(request) { return { ...request, provider: original } },
    async transcribe() { return { text: '保留原文', audioSeconds: 1, inferenceSeconds: 1 } },
    register(provider) { registered = provider; return async () => {} },
  }
  apply({ speechToText: speech, llm: { stream() { throw Error('offline') } },
    effect(fn) { cleanup = fn() }, logger: { warn() { throw Error('logger unavailable') } } }, config)
  publish()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await registered.transcribe({ audio: new Uint8Array(), language: 'auto' }, signal())).text, '保留原文')
  await cleanup()
})

test('plugin disposal cancels a pending model request', async () => {
  let publish, cleanup, registered, started
  const info = { id: 'sensevoice-local', name: 'SenseVoice', location: 'host-local', languages: ['auto'] }
  const original = { info }
  const speech = {
    async *follow(signal) {
      let wake
      publish = () => wake?.()
      signal.addEventListener('abort', () => wake?.())
      await new Promise(resolve => { wake = resolve })
      if (!signal.aborted) yield { providers: [info] }
      await new Promise(resolve => { wake = resolve })
    },
    resolve(request) { return { ...request, provider: original } },
    async transcribe() { return { text: 'speech', audioSeconds: 1, inferenceSeconds: 1 } },
    register(provider) { registered = provider; return async () => {} },
  }
  const ready = new Promise(resolve => { started = resolve })
  const model = { async *stream({ signal }) {
    started()
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
  } }
  apply({ speechToText: speech, llm: model, effect(fn) { cleanup = fn() }, logger: { warn(error) { throw error } } }, config)
  publish()
  await new Promise(resolve => setImmediate(resolve))
  const operation = registered.transcribe({ audio: new Uint8Array(), language: 'auto' }, signal())
  await ready
  const rejected = assert.rejects(operation, { name: 'AbortError' })
  await cleanup()
  await rejected
})
