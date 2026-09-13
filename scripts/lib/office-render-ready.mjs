import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { PNG } = require('pngjs')

export const DEFAULT_OFFICE_RED_AREA_RATIO = 0.015

export async function focusElectronPage(page, focusSession) {
  await focusSession.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await page.bringToFront()
}

export async function readOfficeLoadMeasurement(page) {
  return page.evaluate(() => {
    const measurement = window.__caogenOfficeLoadMeasurement
    if (!measurement) throw new Error('Office load phase measurement disappeared')
    if (measurement.rafId) window.cancelAnimationFrame(measurement.rafId)
    const milliseconds = (value) => Number.isFinite(value) ? Number(value.toFixed(1)) : null
    const durations = measurement.workerProbeDurationsMs
    const result = {
      kind: measurement.kind,
      expectedAgents: measurement.expectedAgents,
      expectedRenderedAgents: measurement.expectedRenderedAgents,
      expectedQuality: measurement.expectedQuality,
      startedAtEpochMs: Math.round(measurement.startedAtEpochMs),
      shellReadyMs: milliseconds(measurement.shellReadyMs),
      canvasReadyMs: milliseconds(measurement.canvasReadyMs),
      basicNonblankMs: milliseconds(measurement.basicNonblankMs),
      sceneAssetsReadyMs: milliseconds(measurement.sceneAssetsReadyMs),
      charactersReadyMs: milliseconds(measurement.charactersReadyMs),
      interactiveReadyMs: milliseconds(measurement.interactiveReadyMs),
      debugTimeline: Array.isArray(measurement.debugTimeline)
        ? measurement.debugTimeline.map((entry) => ({ ...entry }))
        : [],
      workerProbeDurationMs: {
        samples: durations.length,
        maximum: milliseconds(Math.max(0, ...durations)),
        mean: milliseconds(durations.length > 0
          ? durations.reduce((sum, value) => sum + value, 0) / durations.length
          : 0)
      },
      prewarm: window.__caogenOfficePrewarm ? {
        firstTrigger: window.__caogenOfficePrewarm.firstTrigger,
        triggers: window.__caogenOfficePrewarm.triggers,
        moduleRequestedAtEpochMs: window.__caogenOfficePrewarm.moduleRequestedAtEpochMs,
        moduleReadyAtEpochMs: window.__caogenOfficePrewarm.moduleReadyAtEpochMs,
        shellMountedAtEpochMs: window.__caogenOfficePrewarm.shellMountedAtEpochMs,
        moduleRequestCount: window.__caogenOfficePrewarm.moduleRequestCount
      } : null,
      observed: measurement.observed
    }
    delete window.__caogenOfficeLoadMeasurement
    return result
  })
}

export async function closeOfficeAndWaitForContextRelease(page) {
  await page.evaluate(() => {
    const canvas = document.querySelector('.office-canvas-wrap canvas')
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Office WebGL canvas unavailable')
    const release = { observed: false }
    window.__caogenOfficeContextRelease = release
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault()
      release.observed = true
    }, { once: true })
  })
  await page.click('.office-actions .btn-primary')
  await page.waitForFunction(() => !document.querySelector('.office-canvas-wrap'), { timeout: 10_000 })
  await page.waitForFunction(() => typeof window.__caogenOfficePerformance === 'undefined', { timeout: 5_000 })
  await page.waitForFunction(() => window.__caogenOfficeContextRelease?.observed === true, { timeout: 5_000 })
  await page.evaluate(() => { delete window.__caogenOfficeContextRelease })
}

export async function startOfficeViewDiagnostics(page) {
  await page.evaluate(() => {
    const target = window
    if (target.__officeViewDiagnosticsTimer) window.clearInterval(target.__officeViewDiagnosticsTimer)
    const diagnostics = { startedAt: performance.now(), timeline: [] }
    let previous = ''
    const capture = () => {
      const state = {
        app: Boolean(document.querySelector('.app')),
        office: Boolean(document.querySelector('.office')),
        canvasWrap: Boolean(document.querySelector('.office-canvas-wrap')),
        officeEmpty: Boolean(document.querySelector('.office-empty')),
        officeLoading: Boolean(document.querySelector('.office-loading')),
        settings: Boolean(document.querySelector('.settings-page')),
        list: Boolean(document.querySelector('[data-experience-mode-switcher]')),
        focused: document.hasFocus(),
        hidden: document.hidden
      }
      const serialized = JSON.stringify(state)
      if (serialized === previous) return
      previous = serialized
      diagnostics.timeline.push({ elapsedMs: Math.round(performance.now() - diagnostics.startedAt), ...state })
    }
    target.__officeViewDiagnostics = diagnostics
    capture()
    target.__officeViewDiagnosticsTimer = window.setInterval(capture, 100)
  })
}

export async function readOfficeViewDiagnostics(page) {
  return page.evaluate(() => {
    const target = window
    const diagnostics = target.__officeViewDiagnostics ?? { startedAt: performance.now(), timeline: [] }
    return {
      url: window.location.href,
      focused: document.hasFocus(),
      hidden: document.hidden,
      body: document.body?.innerText.slice(0, 1_200) ?? '',
      timeline: diagnostics.timeline
    }
  })
}

export async function waitForOfficeRenderLoop(page, timeout = 8_000) {
  let lastState = null
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeout) {
    lastState = await page.evaluate(() => {
      const wrap = document.querySelector('.office-canvas-wrap')
      return {
        hidden: document.hidden,
        focused: document.hasFocus(),
        renderActive: wrap?.getAttribute('data-office-render-active') ?? '',
        frameLoop: wrap?.getAttribute('data-office-frame-loop') ?? ''
      }
    })
    if (!lastState.hidden && lastState.focused && lastState.renderActive === '1' && lastState.frameLoop === 'manual') {
      return lastState
    }
    await delay(100)
  }
  throw new Error(`focused office render loop did not become active: ${JSON.stringify(lastState)}`)
}

export async function waitForOfficeScenePixels(page, timeout = 15_000) {
  let lastStats = null
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeout) {
    const canvas = await readCanvasState(page)
    if (canvas.gl && canvas.width >= 100 && canvas.height >= 100 && canvas.rectWidth >= 300 && canvas.rectHeight >= 200) {
      const png = PNG.sync.read(await page.screenshot({ fullPage: false }))
      const scene = analyzeRobotWorkArea(png)
      lastStats = { ...canvas, screenshotWidth: png.width, screenshotHeight: png.height, ...scene }
      if (scene.uniqueColorBuckets >= 20 && scene.luminanceRange >= 24) return lastStats
    } else {
      lastStats = canvas
    }
    await delay(300)
  }
  throw new Error(`3D office canvas did not become visibly nonblank: ${JSON.stringify(lastStats)}`)
}

export function officeNonErrorWorkAreaIsStable(
  area,
  workAreaNonDark,
  maxRedAreaRatio = DEFAULT_OFFICE_RED_AREA_RATIO
) {
  return area.nonDarkRatio > workAreaNonDark && area.redAreaRatio < maxRedAreaRatio
}

export async function captureStableOfficeScreenshot(
  capture,
  analyze,
  workAreaNonDark,
  maxRedAreaRatio = DEFAULT_OFFICE_RED_AREA_RATIO,
  maxAttempts = 3
) {
  let stats
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (attempt > 0) await delay(900)
    stats = analyze(await capture(attempt))
    if (officeNonErrorWorkAreaIsStable(stats.nonErrorWorkArea, workAreaNonDark, maxRedAreaRatio)) return stats
  }
  return stats
}

async function readCanvasState(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('.office canvas')
    if (!canvas) return { canvas: false, gl: false, width: 0, height: 0, rectWidth: 0, rectHeight: 0 }
    const rect = canvas.getBoundingClientRect()
    return {
      canvas: true,
      gl: Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl')),
      width: canvas.width,
      height: canvas.height,
      rectWidth: rect.width,
      rectHeight: rect.height
    }
  })
}

function analyzeRobotWorkArea(png) {
  const x0 = Math.floor(png.width * 0.25)
  const x1 = Math.floor(png.width * 0.73)
  const y0 = Math.floor(png.height * 0.32)
  const y1 = Math.floor(png.height * 0.82)
  const buckets = new Set()
  let minimumLuminance = 255
  let maximumLuminance = 0
  let samples = 0
  for (let y = y0; y < y1; y += 4) {
    for (let x = x0; x < x1; x += 4) {
      const offset = (y * png.width + x) * 4
      const r = png.data[offset]
      const g = png.data[offset + 1]
      const b = png.data[offset + 2]
      const luminance = r * 0.2126 + g * 0.7152 + b * 0.0722
      minimumLuminance = Math.min(minimumLuminance, luminance)
      maximumLuminance = Math.max(maximumLuminance, luminance)
      buckets.add(`${r >> 4},${g >> 4},${b >> 4}`)
      samples += 1
    }
  }
  return {
    samples,
    uniqueColorBuckets: buckets.size,
    luminanceRange: maximumLuminance - minimumLuminance
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
