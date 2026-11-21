window.__ModuleLoader__.load({
  id: '@local/dsh-voice-proofread',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    // DSH does not expose the voice activity's start/stop methods. Limit the
    // bridge to the focused composer and known accessible voice labels.
    const voiceLabels = new Set([
      '开始录音', '打开语音输入引导', 'Start recording', 'Open voice input setup',
      '録音を開始', '音声入力のセットアップを開く', 'Empezar a grabar', 'Abrir configuración de entrada de voz',
      "Commencer l'enregistrement", 'Ouvrir la configuration de la saisie vocale',
      'Starten Sie die Aufnahme', 'Öffnen Sie die Einrichtung der Spracheingabe',
      'Начать запись', 'Открыть настройку голосового ввода', 'Comece a gravar', 'Abra a configuração de entrada de voz',
    ])
    const stopLabels = new Set(['停止并识别', 'Stop and transcribe', '停止して文字起こし',
      'Detener y transcribir', 'Arrêtez et transcrivez', 'Stoppen Sie und transkribieren Sie',
      'Остановись и перепиши', 'Pare e transcreva'])
    function voiceButton(target) {
      const card = target?.closest?.('[data-composer-card]')
      if (!card) return null
      const recording = card.querySelector('[data-voice-activity="recording"]')
      const buttons = recording ? Array.from(recording.querySelectorAll('button[aria-label]')).filter(button => stopLabels.has(button.getAttribute('aria-label')))
        : Array.from(card.querySelectorAll('button[aria-label]')).filter(button => voiceLabels.has(button.getAttribute('aria-label')))
      const button = buttons.length === 1 ? buttons[0] : null
      return button && !button.disabled && !button.closest('[hidden]') ? button : null
    }
    const zh = typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh')
    const text = zh ? {
      title: '校对模型', prompt: '选择已配置的模型', save: '保存', saving: '正在保存…', conflict: '设置已改变，请重新选择模型。',
      timeout: '校对超时时间', seconds: '秒', timeoutFailed: '超时时间保存失败，请重试。',
      saveChoiceFirst: '请先保存或重新选择模型，再修改超时时间。',
      privacy: '录音在本地识别；识别文字会发送至所选模型服务。', failed: '保存失败或设置已改变，请重试。',
      fallback: '校对失败时会直接插入未经校对的识别原文；当前录音界面不会单独提示，请发送前检查文字。',
      loading: '正在读取模型…', unavailable: '无法读取模型目录。', partial: '部分模型提供方不可用。',
      missing: '已保存的模型当前不在目录中，请检查模型配置或重新选择。',
      activate: '启用语音校对', activating: '正在启用…', activated: '语音校对已启用。', activationFailed: '无法启用语音校对。请先启用内置语音输入并等待本地识别器就绪。',
      speechUnavailable: '内置语音输入服务不可用。请先在插件中启用语音输入。',
    } : {
      title: 'Proofreading model', prompt: 'Choose a configured model', save: 'Save', saving: 'Saving…', conflict: 'Settings changed. Choose the model again.',
      timeout: 'Proofreading timeout', seconds: 'seconds', timeoutFailed: 'Could not save timeout. Try again.',
      saveChoiceFirst: 'Save or reselect the model before changing the timeout.',
      privacy: 'Audio is recognized locally; the transcript is sent to the selected model provider.',
      fallback: 'If proofreading fails, the original transcript is inserted without a separate warning. Review it before sending.',
      failed: 'Could not save; settings may have changed. Try again.',
      loading: 'Loading models…', unavailable: 'Could not load models.', partial: 'Some model providers are unavailable.',
      missing: 'The saved model is not currently available in the catalog. Check its configuration or choose another.',
      activate: 'Enable voice proofreading', activating: 'Enabling…', activated: 'Voice proofreading is enabled.', activationFailed: 'Could not enable voice proofreading. Enable built-in voice input and wait for the local recognizer first.',
      speechUnavailable: 'The built-in voice input service is unavailable. Enable voice input in Plugins first.',
    }
    function Settings({ form, remote, subscribeCatalog, getSpeech }) {
      const state = React.useSyncExternalStore(form.subscribe.bind(form), form.getSnapshot.bind(form))
      const [catalog, setCatalog] = React.useState(null)
      const [catalogAttempt, setCatalogAttempt] = React.useState(0)
      const [failure, setFailure] = React.useState('')
      const [choice, setChoice] = React.useState('')
      const [choiceRevision, setChoiceRevision] = React.useState(undefined)
      const [saving, setSaving] = React.useState(false)
      const [activating, setActivating] = React.useState(false)
      const [notice, setNotice] = React.useState('')
      React.useEffect(() => {
        return subscribeCatalog(() => { setCatalog(null); setFailure(''); setCatalogAttempt(attempt => attempt + 1) })
      }, [subscribeCatalog])
      React.useEffect(() => {
        let active = true
        remote.session.modelCatalog().then(result => {
          if (!active) return
          if (result.ok) setCatalog(result.value)
          else setFailure(text.unavailable)
        }).catch(() => { if (active) setFailure(text.unavailable) })
        return () => { active = false }
      }, [remote, catalogAttempt])
      const current = JSON.stringify([state.value?.provider || '', state.value?.model || ''])
      const selected = choice || current
      const options = catalog?.groups.flatMap(group => group.models.map(model => ({
        value: JSON.stringify([group.id, model.id]), label: `${group.name} / ${model.name}`,
      }))) || []
      async function save() {
        const option = options.find(item => item.value === selected)
        if (!option || saving) return
        if (choiceRevision === undefined || choiceRevision !== state.revision) {
          setChoice(''); setChoiceRevision(undefined); setFailure(text.conflict); return
        }
        const [provider, model] = JSON.parse(option.value)
        setSaving(true); setFailure('')
        try {
          const ok = await form.mutate([{ op: 'set', path: ['provider'], value: provider },
            { op: 'set', path: ['model'], value: model }], choiceRevision)
          if (!ok) { setChoice(''); setChoiceRevision(undefined); setFailure(text.failed) }
          else { setChoice(''); setChoiceRevision(undefined) }
        } catch { setFailure(text.failed) }
        finally { setSaving(false) }
      }
      async function activate() {
        if (activating) return
        setActivating(true); setFailure(''); setNotice('')
        const speech = getSpeech()
        if (!speech) { setFailure(text.speechUnavailable); setActivating(false); return }
        try {
          const result = await speech.configure({ providerId: 'sensevoice-proofread' })
          if (!result.ok) throw new Error(result.error.message)
          setNotice(text.activated)
        } catch { setFailure(text.activationFailed) }
        finally { setActivating(false) }
      }
      async function saveTimeout(event) {
        const seconds = Number(event.target.value)
        if (![10, 20, 30, 60].includes(seconds) || saving) return
        setSaving(true); setFailure(''); setNotice('')
        try {
          const ok = await form.mutate([{ op: 'set', path: ['timeoutSeconds'], value: seconds }], state.revision)
          if (!ok) setFailure(text.timeoutFailed)
          else { setChoice(''); setChoiceRevision(undefined) }
        } catch { setFailure(text.timeoutFailed) }
        finally { setSaving(false) }
      }
      return h('section', { style: { display: 'grid', gap: 12, padding: '12px 0' } },
        h('label', { htmlFor: 'voice-proofread-model' }, text.title),
        h('p', null, text.privacy),
        h('p', null, text.fallback),
        h('select', { id: 'voice-proofread-model', style: { width: '100%', maxWidth: 360, minWidth: 0, textOverflow: 'ellipsis' }, value: options.some(option => option.value === selected) ? selected : '',
          disabled: !catalog || state.status !== 'ready' || !state.writable || saving,
          onChange: event => {
            const next = event.target.value
            setChoice(next === current ? '' : next)
            setChoiceRevision(next && next !== current ? state.revision : undefined)
            setFailure('')
          } },
        h('option', { value: '' }, catalog ? text.prompt : text.loading),
        options.map(option => h('option', { key: option.value, value: option.value, title: option.label }, option.label))),
        h('label', { htmlFor: 'voice-proofread-timeout' }, text.timeout),
        choice && h('p', { role: 'status' }, text.saveChoiceFirst),
        h('select', { id: 'voice-proofread-timeout', style: { width: '100%', maxWidth: 160 }, value: state.value?.timeoutSeconds ?? 30,
          disabled: saving || !!choice || state.status !== 'ready' || !state.writable, onChange: saveTimeout },
        [10, 20, 30, 60].map(seconds => h('option', { key: seconds, value: seconds }, `${seconds} ${text.seconds}`))),
        catalog?.failures?.length > 0 && h('p', { role: 'status' }, text.partial),
        catalog && state.value?.provider && state.value?.model && !options.some(option => option.value === current)
          && h('p', { role: 'status' }, text.missing),
        failure && h('p', { role: 'alert' }, failure),
        !catalog && failure && h('button', { type: 'button', onClick: () => { setFailure(''); setCatalogAttempt(attempt => attempt + 1) } }, zh ? '重试读取模型' : 'Retry loading models'),
        notice && h('p', { role: 'status' }, notice),
        h('button', { type: 'button', disabled: saving || !choice || choice === current || !state.writable || !options.some(option => option.value === choice), onClick: save }, saving ? text.saving : text.save),
        h('button', { type: 'button', disabled: activating || saving || !!choice || state.status !== 'ready' || !catalog || !options.some(option => option.value === current), onClick: activate },
          activating ? text.activating : text.activate))
    }
    return {
      inject: ['slots', 'configForms', 'remote', 'remote.session', 'shortcuts'],
      apply(ctx) {
        ctx.effect(() => ctx.shortcuts.register({
          id: 'voice-proofread.toggle', label: () => zh ? '开始或停止语音输入' : 'Start or stop voice input',
          aliases: ['voice', 'dictation', '语音输入'], defaults: {}, regions: ['editable'], modals: [],
          resolve: ({ target }) => {
            const button = voiceButton(target)
            if (!button) return { status: 'pass' }
            return { status: 'handled', run: () => { if (voiceButton(target) === button) button.click() } }
          },
        }))
        const form = ctx.configForms.get('voice-proofread')
        const subscribeCatalog = listener => {
          const dispose = ['llm/adapters-updated', 'llm/models-updated', 'settings/document-updated',
            'credentials/record-updated', 'credentials/reference-updated'].map(event => ctx.remote.$on(event, listener))
          dispose.push(ctx.on('connection/reset', listener))
          return () => { for (const off of dispose) off() }
        }
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config', key: '@local/dsh-voice-proofread',
          inject: () => ({ form, remote: ctx.remote, subscribeCatalog, getSpeech: () => ctx.get('remote.speech') }),
        }, Settings))
      },
    }
  },
})
