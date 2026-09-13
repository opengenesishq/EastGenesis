import assert from 'node:assert/strict'

export function attachAssistantStudioPageDiagnostics(page, phase) {
  page.on('request', (request) => {
    const chunk = surfaceChunkName(request.url())
    if (chunk && !phase.requestedSurfaceChunks.includes(chunk)) phase.requestedSurfaceChunks.push(chunk)
  })
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      phase.warnings.push(`console ${message.type()}: ${message.text()}`)
    }
  })
  page.on('pageerror', (error) => phase.warnings.push(`pageerror: ${error.message}`))
}

export async function readLazySurfaceState(page, resources) {
  const state = await page.evaluate(() => ({
    studioMounted: Boolean(document.querySelector('[data-studio-view]')),
    videoMounted: Boolean(document.querySelector('[data-video-studio-view]')),
    officeMounted: Boolean(document.querySelector('.office'))
  }))
  return { ...state, resources: [...resources] }
}

export function assertLazyAssistantShell(state, viewportName) {
  assert(!state.studioMounted, `${viewportName}: Studio mounted before first activation`)
  assert(!state.videoMounted, `${viewportName}: Video mounted before first activation`)
  assert(!state.officeMounted, `${viewportName}: Office mounted before first activation`)
  assert(
    state.resources.length === 0,
    `${viewportName}: Assistant first paint requested heavy surface chunks: ${state.resources.join(', ')}`
  )
}

export async function measureStudioDataReady(page, fixture, phase, timeoutMs = 10_000) {
  try {
    return await page.evaluate(async (timeout) => {
      const startedAt = performance.now()
      const coldStartedAt = window.__assistantStudioPerformanceColdStartedAt
      if (!Number.isFinite(coldStartedAt)) throw new Error('cold switch timestamp is unavailable')
      return new Promise((resolve, reject) => {
        const poll = () => {
          const root = document.querySelector('[data-project-workspace-studio]')
          const refresh = document.querySelector('[data-studio-action="refresh"]')
          if (root?.getAttribute('aria-busy') === 'false' && refresh && !refresh.disabled) {
            const finishedAt = performance.now()
            resolve({
              afterShellInteractiveMs: rounded(finishedAt - startedAt),
              fromColdSwitchStartMs: rounded(finishedAt - coldStartedAt)
            })
            return
          }
          if (performance.now() - startedAt >= timeout) {
            reject(new Error(`Studio project data did not become ready within ${timeout}ms`))
            return
          }
          requestAnimationFrame(poll)
        }
        requestAnimationFrame(poll)
      })

      function rounded(value) {
        return Math.round(value * 100) / 100
      }
    }, timeoutMs)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes(`Studio project data did not become ready within ${timeoutMs}ms`)) throw error
    const diagnostics = await collectStudioDataReadyDiagnostics(page, fixture, phase).catch((diagnosticError) => ({
      capturedAt: new Date().toISOString(),
      dom: {
        rootPresent: null,
        ariaBusy: null,
        selectedProjectId: null,
        projectOptionCount: null,
        refreshPresent: null,
        refreshDisabled: null,
        visibilityState: null,
        alerts: []
      },
      expected: { projectId: fixture.projectId, goalId: fixture.goalId, workItemId: fixture.workItemId },
      directIpc: {
        projects: unavailableDiagnostic(),
        goals: unavailableDiagnostic(),
        workItems: unavailableDiagnostic()
      },
      pageErrors: phase.warnings.filter((warning) => warning.startsWith('pageerror:') || warning.startsWith('console error:')),
      diagnosticError: diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)
    }))
    const failure = new Error(
      `Studio project data did not become ready within ${timeoutMs}ms; ` +
      `aria-busy=${diagnostics.dom.ariaBusy ?? 'missing'}, ` +
      `selectedProjectId=${diagnostics.dom.selectedProjectId || 'none'}, ` +
      `goals=${diagnosticCount(diagnostics.directIpc.goals)}, ` +
      `workItems=${diagnosticCount(diagnostics.directIpc.workItems)}`
    )
    failure.code = 'studio-data-readiness-timeout'
    failure.diagnostics = diagnostics
    throw failure
  }
}

function surfaceChunkName(url) {
  try {
    const name = new URL(url).pathname.split('/').pop() || ''
    return /^(StudioView|StudioResultPanel|VideoStudioView|OfficeView)-.+\.js$/.test(name) ? name : ''
  } catch {
    return ''
  }
}

export function renderAssistantStudioPerformanceMarkdown(value, thresholdMs) {
  const lines = [
    '# Assistant/Studio Performance',
    '',
    `Status: ${value.status}`,
    'Requirement: NFR-PERF-001',
    `Threshold: P95 < ${thresholdMs}ms`,
    `Reference hardware: ${value.hardware.modelIdentifier}; ${value.hardware.cpuModel}; ${formatBytes(value.hardware.memoryBytes)}`,
    `Runtime: ${value.runtime.platform}/${value.runtime.arch}; macOS ${value.hardware.osVersion}; Electron ${value.runtime.electronVersion}; Node ${value.runtime.nodeVersion}`,
    '',
    '| Viewport attempt | Status | Accepted | Cold samples | Cold P95 | Warm samples | Warm P95 | Overall P95 | Data ready after cold |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|'
  ]
  for (const phase of value.phases) {
    const metrics = phase.metrics
    lines.push(
      `| ${phase.name} #${phase.attempt} ${phase.viewport.width}x${phase.viewport.height} | ${phase.status} | ${phase.accepted ? 'yes' : 'no'} | ` +
      `${metrics?.cold.count ?? 0} | ${formatMs(metrics?.cold.p95Ms)} | ${metrics?.warm.count ?? 0} | ` +
      `${formatMs(metrics?.warm.p95Ms)} | ${formatMs(metrics?.all.p95Ms)} | ${formatMs(phase.studioDataReady?.fromColdSwitchStartMs)} |`
    )
  }
  if (value.metrics) {
    lines.push(`| accepted aggregate | pass | yes | ${value.metrics.cold.count} | ${formatMs(value.metrics.cold.p95Ms)} | ${value.metrics.warm.count} | ${formatMs(value.metrics.warm.p95Ms)} | ${formatMs(value.metrics.all.p95Ms)} | diagnostic only |`)
  }
  lines.push('', 'Accepted switches ran while one local Provider response was held open. Each accepted viewport retained exactly one session, one canonical Run, one user message, and one model request.')
  const retriedAttempts = value.measurementAttempts.filter((attempt) => attempt.retryDecision?.action === 'retry')
  if (retriedAttempts.length > 0) {
    lines.push('', '## Fresh renderer retries', '')
    for (const attempt of retriedAttempts) {
      lines.push(`- ${attempt.viewport} attempt ${attempt.attempt}: ${attempt.retryDecision.reason}; failed attempt retained in report.phases.`)
    }
  }
  if (value.error) lines.push('', '## Error', '', '```text', value.error, '```')
  return `${lines.join('\n')}\n`
}

async function collectStudioDataReadyDiagnostics(page, fixture, phase) {
  const renderer = await page.evaluate(async (expected) => {
    const root = document.querySelector('[data-project-workspace-studio]')
    const select = document.querySelector('[data-project-workspace-select]')
    const refresh = document.querySelector('[data-studio-action="refresh"]')
    const alerts = Array.from(document.querySelectorAll('[role="alert"]'))
      .map((element) => element.textContent?.trim() ?? '')
      .filter(Boolean)
      .slice(0, 10)
    const [projects, goals, workItems] = await Promise.all([
      timedListQuery('projects', () => window.agentDesk.listProjectWorkspaces({ includeArchived: true, includeDeleted: true }), expected.projectId),
      timedListQuery('goals', () => window.agentDesk.listProjectGoals(expected.projectId, { includeArchived: true }), expected.goalId),
      timedListQuery('workItems', () => window.agentDesk.listProjectWorkItems(expected.projectId), expected.workItemId)
    ])
    return {
      capturedAt: new Date().toISOString(),
      dom: {
        rootPresent: Boolean(root),
        ariaBusy: root?.getAttribute('aria-busy') ?? null,
        selectedProjectId: select instanceof HTMLSelectElement ? select.value : null,
        projectOptionCount: select instanceof HTMLSelectElement ? select.options.length : 0,
        refreshPresent: Boolean(refresh),
        refreshDisabled: refresh instanceof HTMLButtonElement ? refresh.disabled : null,
        visibilityState: document.visibilityState,
        alerts
      },
      expected,
      directIpc: { projects, goals, workItems }
    }

    async function timedListQuery(name, load, expectedId) {
      const startedAt = performance.now()
      let timer
      try {
        const values = await Promise.race([
          load(),
          new Promise((_, reject) => {
            timer = window.setTimeout(() => reject(new Error(`${name} IPC query timed out after 2000ms`)), 2_000)
          })
        ])
        return {
          status: 'ok',
          durationMs: rounded(performance.now() - startedAt),
          count: Array.isArray(values) ? values.length : null,
          ids: Array.isArray(values) ? values.slice(0, 20).map((value) => value?.id).filter(Boolean) : [],
          expectedIdPresent: Array.isArray(values) ? values.some((value) => value?.id === expectedId) : false
        }
      } catch (cause) {
        return {
          status: 'error',
          durationMs: rounded(performance.now() - startedAt),
          count: null,
          ids: [],
          expectedIdPresent: false,
          error: cause instanceof Error ? cause.message : String(cause)
        }
      } finally {
        if (timer !== undefined) window.clearTimeout(timer)
      }
    }

    function rounded(value) {
      return Math.round(value * 100) / 100
    }
  }, { projectId: fixture.projectId, goalId: fixture.goalId, workItemId: fixture.workItemId })
  return {
    ...renderer,
    pageErrors: phase.warnings.filter((warning) => warning.startsWith('pageerror:') || warning.startsWith('console error:'))
  }
}

function diagnosticCount(query) {
  return query.status === 'ok' ? query.count : query.status
}

function unavailableDiagnostic() {
  return { status: 'diagnostic-unavailable', durationMs: null, count: null, ids: [], expectedIdPresent: false }
}

function formatMs(value) {
  return value === null || value === undefined || !Number.isFinite(Number(value))
    ? 'n/a'
    : `${Number(value).toFixed(2)}ms`
}

function formatBytes(value) {
  return `${(Number(value) / 1024 / 1024 / 1024).toFixed(1)} GiB`
}
