import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

test('voice shortcut targets only the focused composer and stops its active recording', async () => {
  let module, command, clicked = 0, phase = 'idle'
  vm.runInNewContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'),
    { window: { __ModuleLoader__: { load(value) { module = value } } }, navigator: { language: 'zh-CN' } })
  const plugin = module.factory(() => React)
  plugin.apply({ effect(fn) { fn() }, shortcuts: { register(value) { command = value; return () => {} } },
    configForms: { get() { return {} } }, remote: {}, slots: { inject() {} } })
  const button = { disabled: false, getAttribute: () => phase === 'recording' ? '停止并识别' : '开始录音', closest: () => null, click() { clicked++ } }
  const card = { querySelector: () => phase === 'recording' ? { querySelectorAll: () => [button] } : null,
    querySelectorAll: () => [button] }
  const target = { closest: () => card }
  assert.equal(command.resolve({ target: null }).status, 'pass')
  let action = command.resolve({ target })
  assert.equal(action.status, 'handled')
  action.run()
  phase = 'recording'
  action = command.resolve({ target }); action.run()
  assert.equal(clicked, 2)
  button.disabled = true
  assert.equal(command.resolve({ target }).status, 'pass')
})

test('client registers its configuration page using the DSH form and model catalog', async () => {
  let module
  const context = { window: { __ModuleLoader__: { load(value) { module = value } } }, navigator: { language: 'zh-CN' } }
  vm.runInNewContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'), context)
  const react = { createElement() {}, useSyncExternalStore() {}, useState() {}, useEffect() {} }
  const plugin = module.factory(name => { assert.equal(name, 'react'); return react })
  assert.deepEqual(Array.from(plugin.inject), ['slots', 'configForms', 'remote', 'remote.session', 'shortcuts'])
  let registration, component, requested
  const form = {}
  const ctx = {
    effect(fn) { return fn() }, shortcuts: { register() { return () => {} } },
    configForms: { get(name) { requested = name; return form } }, remote: { $on() { return () => {} } }, on() { return () => {} },
    slots: { inject(name, fn) { assert.equal(name, 'plugins.bundle.config'); fn() },
      register(options, view) { registration = options; component = view } },
  }
  plugin.apply(ctx)
  assert.equal(requested, 'voice-proofread')
  assert.equal(registration.key, '@local/dsh-voice-proofread')
  assert.equal(registration.inject().form, form)
  assert.equal(typeof component, 'function')
})

test('selecting a model saves both route fields and enables speech proofreading', async () => {
  let module, component, registration
  vm.runInNewContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'),
    { window: { __ModuleLoader__: { load(value) { module = value } } }, navigator: { language: 'zh-CN' } })
  const plugin = module.factory(() => React)
  let snapshot = { status: 'ready', writable: true, revision: 4, value: { provider: '', model: '' } }
  let subscriber, mutations, enabled
  const form = { getSnapshot: () => snapshot, subscribe(fn) { subscriber = fn; return () => {} },
    async mutate(ops, revision) {
      mutations = { ops: structuredClone(ops), revision }
      snapshot = { ...snapshot, revision: 5, value: { provider: 'p', model: 'm' } }
      subscriber()
      return true
    } }
  const remote = { $on() { return () => {} }, session: { async modelCatalog() { return { ok: true, value: { groups: [{ id: 'p', name: 'Provider', models: [{ id: 'm', name: 'Model' }] }], failures: [] } } } },
    speech: { async configure(value) { enabled = value.providerId; return { ok: true } } } }
  plugin.apply({ effect(fn) { return fn() }, shortcuts: { register() { return () => {} } }, configForms: { get: () => form }, remote, get: () => remote.speech, on() { return () => {} },
    slots: { inject(_, callback) { callback() }, register(options, view) { registration = options; component = view } } })
  let root
  await act(async () => { root = TestRenderer.create(React.createElement(component, registration.inject())) })
  const select = root.root.findByProps({ id: 'voice-proofread-model' })
  assert.equal(root.root.findAllByType('option')[1].children[0], 'Provider / Model')
  await act(async () => { select.props.onChange({ target: { value: JSON.stringify(['p', 'm']) } }) })
  assert.deepEqual(mutations, { ops: [{ op: 'set', path: ['provider'], value: 'p' },
    { op: 'set', path: ['model'], value: 'm' }], revision: 4 })
  await act(async () => { await root.root.findAllByType('button')[0].props.onClick() })
  assert.equal(enabled, 'sensevoice-proofread')
  await act(async () => { root.unmount() })
})

test('model directory can be retried after a failed request', async () => {
  let module, component, registration, attempts = 0
  vm.runInNewContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'),
    { window: { __ModuleLoader__: { load(value) { module = value } } }, navigator: { language: 'zh-CN' } })
  const plugin = module.factory(() => React)
  const snapshot = { status: 'ready', writable: true, revision: 1, value: {} }
  const form = { getSnapshot: () => snapshot, subscribe() { return () => {} } }
  const remote = { $on() { return () => {} }, session: { async modelCatalog() {
    if (++attempts === 1) return { ok: false }
    return { ok: true, value: { groups: [{ id: 'p', name: 'P', models: [{ id: 'm', name: 'M' }] }], failures: [] } }
  } } }
  plugin.apply({ effect(fn) { return fn() }, shortcuts: { register() { return () => {} } }, configForms: { get: () => form }, remote, get: () => remote.speech, on() { return () => {} },
    slots: { inject(_, callback) { callback() }, register(options, view) { registration = options; component = view } } })
  let root
  await act(async () => { root = TestRenderer.create(React.createElement(component, registration.inject())) })
  assert.equal(root.root.findByProps({ role: 'alert' }).children[0], '无法读取模型目录。')
  await act(async () => { root.root.findAllByType('button').find(item => item.children[0] === '重试读取模型').props.onClick() })
  assert.equal(attempts, 2)
  assert.equal(root.root.findAllByType('option')[1].children[0], 'P / M')
  await act(async () => { root.unmount() })
})

test('timeout selection is saved with the current configuration revision', async () => {
  let module, component, registration, mutation
  vm.runInNewContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'),
    { window: { __ModuleLoader__: { load(value) { module = value } } }, navigator: { language: 'zh-CN' } })
  const snapshot = { status: 'ready', writable: true, revision: 7, value: {} }
  const form = { getSnapshot: () => snapshot, subscribe() { return () => {} }, async mutate(ops, revision) {
    mutation = { ops: structuredClone(ops), revision }; return true
  } }
  const remote = { $on() { return () => {} }, session: { async modelCatalog() { return { ok: true, value: { groups: [], failures: [] } } } } }
  module.factory(() => React).apply({ effect(fn) { return fn() }, shortcuts: { register() { return () => {} } },
    configForms: { get: () => form }, remote, get() {}, on() { return () => {} },
    slots: { inject(_, callback) { callback() }, register(options, view) { registration = options; component = view } } })
  let root
  await act(async () => { root = TestRenderer.create(React.createElement(component, registration.inject())) })
  const select = root.root.findByProps({ id: 'voice-proofread-timeout' })
  assert.equal(select.props.value, 30)
  await act(async () => { await select.props.onChange({ target: { value: '10' } }) })
  assert.deepEqual(mutation, { ops: [{ op: 'set', path: ['timeoutSeconds'], value: 10 }], revision: 7 })
  await act(async () => { root.unmount() })
})

test('failed timeout save is reported without changing the accepted timeout', async () => {
  let module, component, registration
  vm.runInNewContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'),
    { window: { __ModuleLoader__: { load(value) { module = value } } }, navigator: { language: 'zh-CN' } })
  const snapshot = { status: 'ready', writable: true, revision: 7, value: { timeoutSeconds: 30 } }
  const form = { getSnapshot: () => snapshot, subscribe() { return () => {} }, async mutate() { return false } }
  const remote = { $on() { return () => {} }, session: { async modelCatalog() { return { ok: true, value: { groups: [], failures: [] } } } } }
  module.factory(() => React).apply({ effect(fn) { return fn() }, shortcuts: { register() { return () => {} } },
    configForms: { get: () => form }, remote, get() {}, on() { return () => {} },
    slots: { inject(_, callback) { callback() }, register(options, view) { registration = options; component = view } } })
  let root
  await act(async () => { root = TestRenderer.create(React.createElement(component, registration.inject())) })
  await act(async () => { await root.root.findByProps({ id: 'voice-proofread-timeout' }).props.onChange({ target: { value: '10' } }) })
  assert.equal(root.root.findByProps({ id: 'voice-proofread-timeout' }).props.value, 30)
  assert.match(root.root.findByProps({ role: 'alert' }).children[0], /超时时间保存失败/)
  await act(async () => { root.unmount() })
})

test('model selection displays the catalog and protects an unsaved choice', async () => {
  let module, component, registration
  vm.runInNewContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'),
    { window: { __ModuleLoader__: { load(value) { module = value } } }, navigator: { language: 'zh-CN' } })
  const snapshot = { status: 'ready', writable: true, revision: 1, value: { provider: 'p', model: 'a' } }
  const form = { getSnapshot: () => snapshot, subscribe() { return () => {} } }
  const remote = { $on() { return () => {} }, session: { async modelCatalog() { return { ok: true, value: { groups: [
    { id: 'p', name: 'Provider', models: [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }, { id: 'c', name: 'Gamma' }] },
  ], failures: [] } } } } }
  module.factory(() => React).apply({ effect(fn) { return fn() }, shortcuts: { register() { return () => {} } },
    configForms: { get: () => form }, remote, get() {}, on() { return () => {} },
    slots: { inject(_, callback) { callback() }, register(options, view) { registration = options; component = view } } })
  let root
  await act(async () => { root = TestRenderer.create(React.createElement(component, registration.inject())) })
  assert.equal(root.root.findAllByProps({ type: 'search' }).length, 0)
  const options = root.root.findByProps({ id: 'voice-proofread-model' }).findAllByType('option').map(option => option.children[0])
  assert.deepEqual(options, ['选择已配置的模型', 'Provider / Alpha', 'Provider / Beta', 'Provider / Gamma'])
  await act(async () => { root.unmount() })
})

test('catalog refresh ignores a superseded response and releases subscriptions', async () => {
  let module, component, registration, changed, resolveFirst, unsubs = 0, calls = 0
  vm.runInNewContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'),
    { window: { __ModuleLoader__: { load(value) { module = value } } }, navigator: { language: 'en' } })
  const plugin = module.factory(() => React)
  const snapshot = { status: 'ready', writable: true, revision: 1, value: {} }
  const form = { getSnapshot: () => snapshot, subscribe() { return () => {} } }
  const remote = { $on(event, fn) { if (event === 'llm/models-updated') changed = fn; return () => { unsubs++ } },
    session: { modelCatalog() {
      if (++calls === 1) return new Promise(resolve => { resolveFirst = resolve })
      return Promise.resolve({ ok: true, value: { groups: [{ id: 'new', name: 'New', models: [{ id: 'm', name: 'M' }] }], failures: [] } })
    } } }
  plugin.apply({ effect(fn) { return fn() }, shortcuts: { register() { return () => {} } }, configForms: { get: () => form }, remote, get: () => remote.speech, on() { return () => { unsubs++ } },
    slots: { inject(_, callback) { callback() }, register(options, view) { registration = options; component = view } } })
  let root
  await act(async () => { root = TestRenderer.create(React.createElement(component, registration.inject())) })
  await act(async () => { changed() })
  await act(async () => { resolveFirst({ ok: true, value: { groups: [{ id: 'old', name: 'Old', models: [{ id: 'm', name: 'M' }] }], failures: [] } }) })
  assert.equal(root.root.findAllByType('option')[1].children[0], 'New / M')
  await act(async () => { root.unmount() })
  assert.equal(unsubs, 6)
})

test('speech activation failure is displayed and does not report success', async () => {
  let module, component, registration
  vm.runInNewContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'),
    { window: { __ModuleLoader__: { load(value) { module = value } } }, navigator: { language: 'zh-CN' } })
  const plugin = module.factory(() => React)
  const snapshot = { status: 'ready', writable: true, revision: 1, value: { provider: 'p', model: 'm' } }
  const form = { getSnapshot: () => snapshot, subscribe() { return () => {} } }
  const remote = { $on() { return () => {} }, session: { async modelCatalog() {
    return { ok: true, value: { groups: [{ id: 'p', name: 'P', models: [{ id: 'm', name: 'M' }] }], failures: [] } }
  } }, speech: { async configure() { return { ok: false, error: { message: 'unavailable' } } } } }
  plugin.apply({ effect(fn) { return fn() }, shortcuts: { register() { return () => {} } }, configForms: { get: () => form }, remote, get: () => remote.speech, on() { return () => {} },
    slots: { inject(_, callback) { callback() }, register(options, view) { registration = options; component = view } } })
  let root
  await act(async () => { root = TestRenderer.create(React.createElement(component, registration.inject())) })
  await act(async () => { await root.root.findAllByType('button').find(item => item.children[0] === '启用语音校对').props.onClick() })
  assert.match(root.root.findByProps({ role: 'alert' }).children[0], /无法启用语音校对/)
  assert.equal(root.root.findAllByProps({ role: 'status' }).length, 0)
  await act(async () => { root.unmount() })
})

test('activation button follows the selected speech provider', async () => {
  let module, component, registration, push, disposed = false
  vm.runInNewContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'),
    { window: { __ModuleLoader__: { load(value) { module = value } } }, navigator: { language: 'zh-CN' } })
  const snapshot = { status: 'ready', writable: true, revision: 1, value: { provider: 'p', model: 'm' } }
  const form = { getSnapshot: () => snapshot, subscribe() { return () => {} } }
  let wake, queue = []
  const stream = { async *[Symbol.asyncIterator]() {
    while (!disposed) {
      if (!queue.length) await new Promise(resolve => { wake = resolve })
      while (queue.length) yield { value: { selection: { providerId: queue.shift() } }, accept() {} }
    }
  }, async dispose() { disposed = true; wake?.() } }
  push = id => { queue.push(id); wake?.() }
  const remote = { $on() { return () => {} }, $stream() { return stream }, session: { async modelCatalog() {
    return { ok: true, value: { groups: [{ id: 'p', name: 'P', models: [{ id: 'm', name: 'M' }] }], failures: [] } }
  } } }
  module.factory(() => React).apply({ effect(fn) { return fn() }, shortcuts: { register() { return () => {} } },
    configForms: { get: () => form }, remote, get: () => ({ follow() {} }), on() { return () => {} },
    slots: { inject(_, callback) { callback() }, register(options, view) { registration = options; component = view } } })
  let root
  await act(async () => { root = TestRenderer.create(React.createElement(component, registration.inject())) })
  await act(async () => { push('sensevoice-proofread') })
  assert.equal(root.root.findAllByType('button').find(item => item.children[0] === '语音校对已启用').props.disabled, true)
  await act(async () => { push('sensevoice-local') })
  assert.equal(root.root.findAllByType('button').find(item => item.children[0] === '启用语音校对').props.disabled, false)
  await act(async () => { root.unmount() })
  assert.equal(disposed, true)
})

test('missing speech service has a specific recovery message', async () => {
  let module, component, registration
  vm.runInNewContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'),
    { window: { __ModuleLoader__: { load(value) { module = value } } }, navigator: { language: 'zh-CN' } })
  const plugin = module.factory(() => React)
  const snapshot = { status: 'ready', writable: true, revision: 1, value: { provider: 'p', model: 'm' } }
  const form = { getSnapshot: () => snapshot, subscribe() { return () => {} } }
  const remote = { $on() { return () => {} }, session: { async modelCatalog() {
    return { ok: true, value: { groups: [{ id: 'p', name: 'P', models: [{ id: 'm', name: 'M' }] }], failures: [] } }
  } } }
  plugin.apply({ effect(fn) { return fn() }, shortcuts: { register() { return () => {} } }, configForms: { get: () => form }, remote, get: () => undefined, on() { return () => {} },
    slots: { inject(_, callback) { callback() }, register(options, view) { registration = options; component = view } } })
  let root
  await act(async () => { root = TestRenderer.create(React.createElement(component, registration.inject())) })
  await act(async () => { await root.root.findAllByType('button').find(item => item.children[0] === '启用语音校对').props.onClick() })
  assert.match(root.root.findByProps({ role: 'alert' }).children[0], /内置语音输入服务不可用/)
  await act(async () => { root.unmount() })
})

test('a refused save clears the stale choice so it can be selected again', async () => {
  let module, component, registration, attempts = 0
  vm.runInNewContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'),
    { window: { __ModuleLoader__: { load(value) { module = value } } }, navigator: { language: 'zh-CN' } })
  const plugin = module.factory(() => React)
  const snapshot = { status: 'ready', writable: true, revision: 1, value: { provider: '', model: '' } }
  const form = { getSnapshot: () => snapshot, subscribe() { return () => {} }, async mutate() { attempts++; return false } }
  const remote = { $on() { return () => {} }, session: { async modelCatalog() {
    return { ok: true, value: { groups: [{ id: 'p', name: 'P', models: [{ id: 'm', name: 'M' }] }], failures: [] } }
  } } }
  plugin.apply({ effect(fn) { return fn() }, shortcuts: { register() { return () => {} } }, configForms: { get: () => form }, remote, get: () => undefined, on() { return () => {} },
    slots: { inject(_, callback) { callback() }, register(options, view) { registration = options; component = view } } })
  let root
  await act(async () => { root = TestRenderer.create(React.createElement(component, registration.inject())) })
  const select = root.root.findByProps({ id: 'voice-proofread-model' })
  await act(async () => { select.props.onChange({ target: { value: JSON.stringify(['p', 'm']) } }) })
  assert.equal(select.props.value, '')
  assert.match(root.root.findByProps({ role: 'alert' }).children[0], /保存失败/)
  await act(async () => { select.props.onChange({ target: { value: JSON.stringify(['p', 'm']) } }) })
  assert.equal(attempts, 2)
  await act(async () => { root.unmount() })
})
