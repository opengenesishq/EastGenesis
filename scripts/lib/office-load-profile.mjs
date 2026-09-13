import { writeFileSync } from 'node:fs'
import path from 'node:path'

/** Opt-in diagnostics only; measurements and acceptance thresholds stay unchanged. */
export async function profileOfficeLoad(page, directory, name) {
  const session = await page.target().createCDPSession()
  let startAttempted = false
  let contextHookAttempted = false
  const restoreContexts = () => page.evaluate(() => {
    const value = window.__officeContextProfile
    value?.restore()
    delete window.__officeContextProfile
    return value?.observations ?? []
  })
  try {
    await session.send('Profiler.enable')
    await session.send('Profiler.setSamplingInterval', { interval: 1000 })
    startAttempted = true
    await session.send('Profiler.start')
    contextHookAttempted = true
    await page.evaluate(() => {
      const original = HTMLCanvasElement.prototype.getContext
      const observations = []
      window.__officeContextProfile = { observations, restore: () => { HTMLCanvasElement.prototype.getContext = original } }
      HTMLCanvasElement.prototype.getContext = function (kind, options) {
        if (kind !== 'webgl' && kind !== 'webgl2') return original.apply(this, arguments)
        const start = performance.now()
        try { return original.apply(this, arguments) } finally {
          observations.push({ kind, options, start, durationMs: performance.now() - start })
        }
      }
    })
  } catch (error) {
    const errors = [error]
    if (startAttempted) await attempt(errors, () => session.send('Profiler.stop'))
    if (contextHookAttempted) await attempt(errors, restoreContexts)
    await attempt(errors, () => session.detach())
    throwFailures(errors)
  }
  return onceAsync(async () => {
    const errors = []
    const result = await attempt(errors, () => session.send('Profiler.stop'))
    const contexts = await attempt(errors, restoreContexts)
    if (result?.profile) await attempt(errors, () => writeFileSync(path.join(directory, `${name}.cpuprofile`), JSON.stringify(result.profile)))
    if (contexts !== undefined) await attempt(errors, () => writeFileSync(path.join(directory, `${name}.contexts.json`), JSON.stringify(contexts, null, 2)))
    await attempt(errors, () => session.detach())
    throwFailures(errors)
  })
}

/** Frame tracing is diagnostic only and never changes the render/quality policy. */
export async function profileOfficeFrames(page, directory, name, { traceTimeoutMs = 30_000 } = {}) {
  if (!Number.isFinite(traceTimeoutMs) || traceTimeoutMs <= 0) throw new Error('traceTimeoutMs must be a positive finite number')
  const finishCpu = await profileOfficeLoad(page, directory, name)
  let session
  try {
    session = await page.target().createCDPSession()
    await session.send('Tracing.start', {
      categories: 'gpu,viz,cc,devtools.timeline,disabled-by-default-gpu.service,disabled-by-default-devtools.timeline.frame',
      transferMode: 'ReturnAsStream'
    })
  } catch (error) {
    const errors = [error]
    if (session) await attempt(errors, () => session.detach())
    await attempt(errors, finishCpu)
    throwFailures(errors)
  }
  return onceAsync(async () => {
    const errors = []
    let stream
    await attempt(errors, async () => {
      await endTrace(session, traceTimeoutMs, (result) => { stream = result?.stream })
      if (!stream) throw new Error('Tracing completed without a trace stream')
      const chunks = []
      for (;;) {
        const chunk = await session.send('IO.read', { handle: stream })
        chunks.push(Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8'))
        if (chunk.eof) break
      }
      writeFileSync(path.join(directory, `${name}.trace.json`), Buffer.concat(chunks))
    })
    if (stream) await attempt(errors, () => session.send('IO.close', { handle: stream }))
    await attempt(errors, () => session.detach())
    await attempt(errors, finishCpu)
    throwFailures(errors)
  })
}

async function endTrace(session, timeoutMs, onResult) {
  let onComplete
  let timer
  const completed = new Promise((resolve) => {
    onComplete = (result) => { onResult(result); resolve() }
    session.on('Tracing.tracingComplete', onComplete)
  })
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Tracing completion timed out after ${timeoutMs} ms`)), timeoutMs)
  })
  try {
    await Promise.race([Promise.all([session.send('Tracing.end'), completed]), timeout])
  } finally {
    clearTimeout(timer)
    session.off('Tracing.tracingComplete', onComplete)
  }
}

function onceAsync(action) {
  let result
  return () => result ??= Promise.resolve().then(action)
}

async function attempt(errors, action) {
  try { return await action() } catch (error) { errors.push(error) }
}

function throwFailures(errors) {
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) {
    // Keep the original failure as the cause and message; cleanup failures remain inspectable.
    throw new AggregateError(errors, errors[0] instanceof Error ? errors[0].message : String(errors[0]), { cause: errors[0] })
  }
}
