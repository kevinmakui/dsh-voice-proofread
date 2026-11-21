import { proofread, ProofreadingTimeoutError } from './proofread.js'
import z from '@deepseek-ai/schemastery'

export const name = 'voice-proofread'
export const inject = ['speechToText', 'llm']
export const Config = z.object({
  provider: z.string().default('').volatile(),
  model: z.string().default('').volatile(),
  timeoutSeconds: z.union([z.const(10), z.const(20), z.const(30), z.const(60)]).default(30).volatile(),
})

const value = field => typeof field?.get === 'function' ? field.get() : field

// Register an additional provider; the original recognizer owns all model resources.
export function apply(ctx, config) {
  const { speechToText, llm } = ctx
  const sourceId = 'sensevoice-local'
  const id = 'sensevoice-proofread'
  ctx.effect(() => {
    const lifetime = new AbortController()
    let unregister
    let current
    const task = (async () => {
      try {
        for await (const snapshot of speechToText.follow(lifetime.signal)) {
          const info = snapshot.providers.find(item => item.id === sourceId && item.location === 'host-local')
          let original
          if (info) {
            try {
              original = speechToText.resolve({ audio: new Uint8Array(), providerId: sourceId, language: info.languages[0] }).provider
            } catch { /* The provider disappeared after the snapshot. */ }
          }
          if (original === current) continue
          if (unregister) { await unregister(); unregister = undefined }
          current = undefined
          if (!original || lifetime.signal.aborted) continue
          const captured = original
          unregister = speechToText.register({
            // The audio recognizer is local; the selected LLM receives only its text.
            // Keeping host-local also lets the built-in UI offer model preparation.
            info: { ...captured.info, id, name: `${captured.info.name} + LLM proofreading` },
            preparation: captured.preparation,
            async transcribe(input, signal) {
              signal = AbortSignal.any([signal, lifetime.signal])
              signal.throwIfAborted()
              const route = { provider: value(config.provider)?.trim(), model: value(config.model)?.trim() }
              const spec = speechToText.resolve({ ...input, providerId: sourceId })
              if (spec.provider !== captured) throw new Error('The local speech provider changed; retry recording')
              const result = await speechToText.transcribe(spec, signal)
              try {
                if (!route.provider || !route.model) throw new Error('Configure the proofreading provider and model first')
                const configuredTimeout = value(config.timeoutSeconds)
                const seconds = [10, 20, 30, 60].includes(configuredTimeout) ? configuredTimeout : 30
                return { ...result, text: await proofread(llm, route, result.text, signal, seconds * 1000) }
              } catch (error) {
                signal.throwIfAborted()
                const reason = error instanceof ProofreadingTimeoutError ? 'timeout' : 'model error'
                try { ctx.logger.warn(`Voice proofreading failed (${reason}); returning the uncorrected local transcript.`) } catch { /* Logging must not discard recognized speech. */ }
                return result
              }
            },
          })
          current = captured
        }
      } catch (error) {
        if (!lifetime.signal.aborted) ctx.logger.warn(error)
      }
    })()
    return async () => { lifetime.abort(); await task; if (unregister) await unregister() }
  })
}
