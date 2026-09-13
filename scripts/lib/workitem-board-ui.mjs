export async function enterStudio(page, timing, options, context) {
  const { projectId, itemCount, assert, markPhaseTiming, dismissRecoveryCenter } = context
  const expectedTotal = options.expectedTotal ?? itemCount
  await page.waitForSelector('.app', { timeout: 30_000 })
  markPhaseTiming(timing, 'appShellReady')
  await page.waitForFunction(() => typeof window.agentDesk?.listProjectWorkItems === 'function', { timeout: 30_000 })
  markPhaseTiming(timing, 'preloadApiReady')
  const studioButton = await page.$('[data-experience-mode-option="studio"]')
  assert(studioButton, 'Studio experience button is missing')
  await installStudioProbe(studioButton)
  const bounds = await studioButton.boundingBox()
  assert(bounds, 'Studio experience button has no visible bounds')
  const hit = await page.evaluate(({ x, y }) => {
    const button = document.querySelector('[data-experience-mode-option="studio"]')
    return Boolean(button?.contains(document.elementFromPoint(x, y)))
  }, { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 })
  assert(hit, 'Studio experience button is obscured before the measured click')
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  markPhaseTiming(timing, 'studioClickDispatched')
  if (options.forbidRecovery) await waitForColdWorkspace(page, projectId, expectedTotal, assert)
  if (options.dismissRecovery) {
    await waitForWorkspaceData(page, projectId, expectedTotal)
    await dismissRecoveryCenter(page)
    markPhaseTiming(timing, 'recoveryDismissed')
  }
  await page.waitForFunction(workspaceReady, { timeout: 90_000 }, {
    expectedProjectId: projectId,
    expectedTotal,
    requireList: options.requireList === true,
    forbidRecovery: options.forbidRecovery === true
  })
  const interaction = await page.evaluate(readStudioInteraction, {
    expectedProjectId: projectId,
    expectedTotal,
    requireList: options.requireList === true,
    forbidRecovery: options.forbidRecovery === true
  })
  markPhaseTiming(timing, 'interactive')
  return interaction
}

async function installStudioProbe(studioButton) {
  await studioButton.evaluate((element) => {
    if (!(element instanceof HTMLButtonElement) || element.disabled) throw new Error('Studio experience button is disabled')
    const state = {
      clickAt: null,
      initialStudioButtonPressed: element.getAttribute('aria-pressed') === 'true',
      recoveryDrawerObserved: Boolean(document.querySelector('.task-recovery-drawer'))
    }
    new MutationObserver(() => {
      if (document.querySelector('.task-recovery-drawer')) state.recoveryDrawerObserved = true
    }).observe(document.documentElement, { childList: true, subtree: true })
    window.__caogenWorkItemPerformance = state
    element.addEventListener('click', () => { state.clickAt = performance.now() }, { once: true, capture: true })
  })
}

async function waitForColdWorkspace(page, projectId, expectedTotal, assert) {
  await page.waitForFunction((args) => {
    if (window.__caogenWorkItemPerformance?.recoveryDrawerObserved || document.querySelector('.task-recovery-drawer')) return true
    const { expectedProjectId, expectedTotal } = args
    const root = document.querySelector('[data-project-workspace-studio]')
    const studioButton = document.querySelector('[data-experience-mode-option="studio"]')
    const pane = document.querySelector('.experience-pane')
    const workspacePane = document.getElementById('studio-projection-panel-workspace')
    const workspaceTab = document.querySelector('[data-studio-projection-tab="workspace"]')
    const select = document.querySelector('[data-project-workspace-select]')
    const surfaces = [...document.querySelectorAll('[data-work-item-surface="list"]')]
    const total = surfaces.reduce((sum, surface) => sum + Number(surface.getAttribute('data-total-work-items')), 0)
    const rendered = surfaces.reduce((sum, surface) => sum + Number(surface.getAttribute('data-rendered-work-items')), 0)
    const first = surfaces[0]?.querySelector('[data-work-item-id]')
    return root?.getAttribute('aria-busy') === 'false' &&
      studioButton?.getAttribute('aria-pressed') === 'true' &&
      pane?.getAttribute('data-experience-mode') === 'studio' &&
      pane?.getAttribute('data-studio-surface') === 'workspace' &&
      workspacePane instanceof HTMLElement && !workspacePane.hidden && workspacePane.contains(root) &&
      workspaceTab?.getAttribute('aria-selected') === 'true' && select?.value === expectedProjectId &&
      total === expectedTotal && rendered > 0 && Boolean(first && first.getBoundingClientRect().width > 0)
  }, { timeout: 90_000 }, { expectedProjectId: projectId, expectedTotal })
  const recoveryObserved = await page.evaluate(() => Boolean(
    window.__caogenWorkItemPerformance?.recoveryDrawerObserved || document.querySelector('.task-recovery-drawer')
  ))
  assert(!recoveryObserved, 'Recovery drawer appeared during a performance sample')
}

async function waitForWorkspaceData(page, projectId, expectedTotal) {
  await page.waitForFunction(({ expectedProjectId, expectedTotal }) => {
    const root = document.querySelector('[data-project-workspace-studio]')
    const select = document.querySelector('[data-project-workspace-select]')
    const surfaces = document.querySelectorAll('[data-work-item-surface="list"], [data-work-item-surface^="board-"]')
    const total = [...surfaces].reduce((sum, surface) => sum + Number(surface.getAttribute('data-total-work-items')), 0)
    const rendered = [...surfaces].reduce((sum, surface) => sum + Number(surface.getAttribute('data-rendered-work-items')), 0)
    return root?.getAttribute('aria-busy') === 'false' && select?.value === expectedProjectId && total === expectedTotal && rendered > 0
  }, { timeout: 90_000 }, { expectedProjectId: projectId, expectedTotal })
}

function workspaceReady({ expectedProjectId, expectedTotal, requireList, forbidRecovery }) {
  // Puppeteer serializes this predicate into the renderer. Keep its helpers
  // inside the predicate so it does not depend on the Node-side module scope.
  const root = document.querySelector('[data-project-workspace-studio]')
  const studioButton = document.querySelector('[data-experience-mode-option="studio"]')
  const pane = document.querySelector('.experience-pane')
  const workspacePane = document.getElementById('studio-projection-panel-workspace')
  const workspaceTab = document.querySelector('[data-studio-projection-tab="workspace"]')
  const select = document.querySelector('[data-project-workspace-select]')
  const view = document.querySelector('[data-work-item-view]')?.getAttribute('data-work-item-view')
  const selector = view === 'board' && !requireList
    ? '[data-work-item-surface^="board-"]'
    : '[data-work-item-surface="list"]'
  const surfaces = [...document.querySelectorAll(selector)]
  const first = surfaces[0]?.querySelector('[data-work-item-id]')
  const total = surfaces.reduce((sum, candidate) => sum + Number(candidate.getAttribute('data-total-work-items')), 0)
  const rendered = surfaces.reduce((sum, candidate) => sum + Number(candidate.getAttribute('data-rendered-work-items')), 0)
  const shellChecks = [
    root?.getAttribute('aria-busy') === 'false',
    studioButton?.getAttribute('aria-pressed') === 'true',
    pane?.getAttribute('data-experience-mode') === 'studio',
    pane?.getAttribute('data-studio-surface') === 'workspace',
    workspacePane instanceof HTMLElement,
    workspacePane?.hidden === false,
    workspacePane?.contains(root) === true,
    workspaceTab?.getAttribute('aria-selected') === 'true',
    select?.value === expectedProjectId
  ]
  const surfaceChecks = [
    requireList ? view === 'list' : true,
    forbidRecovery ? !document.querySelector('.task-recovery-drawer') : true,
    total === expectedTotal,
    rendered > 0,
    Boolean(first?.getBoundingClientRect().width)
  ]
  return shellChecks.every(Boolean) && surfaceChecks.every(Boolean)
}

function shellReady({ root, studioButton, pane, workspacePane, workspaceTab, select, expectedProjectId }) {
  return root?.getAttribute('aria-busy') === 'false' &&
    studioButton?.getAttribute('aria-pressed') === 'true' &&
    pane?.getAttribute('data-experience-mode') === 'studio' &&
    pane?.getAttribute('data-studio-surface') === 'workspace' &&
    workspacePane instanceof HTMLElement && !workspacePane.hidden && workspacePane.contains(root) &&
    workspaceTab?.getAttribute('aria-selected') === 'true' && select?.value === expectedProjectId
}

function readSurface(view, requireList) {
  const selector = view === 'board' && !requireList
    ? '[data-work-item-surface^="board-"]'
    : '[data-work-item-surface="list"]'
  const surfaces = [...document.querySelectorAll(selector)]
  return {
    surfaces,
    first: surfaces[0]?.querySelector('[data-work-item-id]'),
    total: surfaces.reduce((sum, candidate) => sum + Number(candidate.getAttribute('data-total-work-items')), 0),
    rendered: surfaces.reduce((sum, candidate) => sum + Number(candidate.getAttribute('data-rendered-work-items')), 0)
  }
}

function surfaceReady(surface, view, expectedTotal, requireList, forbidRecovery) {
  return (!requireList || view === 'list') && (!forbidRecovery || !document.querySelector('.task-recovery-drawer')) &&
    surface.total === expectedTotal && surface.rendered > 0 &&
    Boolean(surface.first && surface.first.getBoundingClientRect().width > 0)
}

function readStudioInteraction({ expectedProjectId, expectedTotal, requireList, forbidRecovery }) {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
    const state = window.__caogenWorkItemPerformance
    const pane = document.querySelector('.experience-pane')
    const select = document.querySelector('[data-project-workspace-select]')
    const view = requireList ? 'list' : document.querySelector('[data-work-item-view]')?.getAttribute('data-work-item-view')
    const surfaces = view === 'board' ? [...document.querySelectorAll('[data-work-item-surface^="board-"]')] : [...document.querySelectorAll('[data-work-item-surface="list"]')]
    const surface = surfaces.find((candidate) => Number(candidate.getAttribute('data-rendered-work-items')) > 0) ?? surfaces[0]
    const total = surfaces.reduce((sum, candidate) => sum + Number(candidate.getAttribute('data-total-work-items')), 0)
    const rendered = surfaces.reduce((sum, candidate) => sum + Number(candidate.getAttribute('data-rendered-work-items')), 0)
    const recoveryDrawerObserved = Boolean(state?.recoveryDrawerObserved || document.querySelector('.task-recovery-drawer'))
    if (typeof state?.clickAt !== 'number') throw new Error('measured Studio click timestamp is missing')
    if (requireList && state.initialStudioButtonPressed === true) throw new Error('cold Studio measurement started with Studio already selected')
    if (select?.value !== expectedProjectId || total !== expectedTotal || rendered <= 0 || (forbidRecovery && recoveryDrawerObserved)) {
      throw new Error(`WorkItem surface stopped being interactive: ${JSON.stringify({ projectId: select?.value, total, rendered, recoveryDrawerObserved })}`)
    }
    resolve({
      durationMs: Math.round((performance.now() - state.clickAt) * 10) / 10,
      view, total, rendered, projectId: select.value,
      studioButtonPressed: document.querySelector('[data-experience-mode-option="studio"]')?.getAttribute('aria-pressed') === 'true',
      studioButtonPressedBeforeClick: state.initialStudioButtonPressed === true,
      studioSurface: pane?.getAttribute('data-studio-surface') ?? null,
      workspacePaneVisible: !document.getElementById('studio-projection-panel-workspace')?.hidden,
      workspaceTabSelected: document.querySelector('[data-studio-projection-tab="workspace"]')?.getAttribute('aria-selected') === 'true',
      recoveryDrawerObserved
    })
  })))
}

export async function measureWarmViewSwitches(page, count, context) {
  const { projectId, itemCount, assert, report } = context
  const interactions = []
  let current = await page.$eval('[data-work-item-view]', (element) => element.getAttribute('data-work-item-view'))
  assert(current === 'list' || current === 'board', `unexpected initial WorkItem view: ${current}`)
  for (let index = 0; index < count; index += 1) {
    const target = current === 'list' ? 'board' : 'list'
    const button = await page.$(`[data-work-item-view] [data-view-option="${target}"]`)
    assert(button, `WorkItem ${target} view button is missing`)
    await button.evaluate((element) => {
      if (!(element instanceof HTMLButtonElement) || element.disabled) throw new Error('WorkItem view button is disabled')
      window.__caogenWorkItemViewPerformance = { clickAt: null }
      element.addEventListener('click', () => { window.__caogenWorkItemViewPerformance.clickAt = performance.now() }, { once: true, capture: true })
    })
    const bounds = await button.boundingBox()
    assert(bounds, `WorkItem ${target} view button has no visible bounds`)
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    await page.waitForFunction(({ expected, expectedProjectId, expectedTotal }) => {
      const toggle = document.querySelector('[data-work-item-view]')
      const surface = expected === 'board' ? document.querySelector('[data-work-item-surface="board-backlog"]') : document.querySelector('[data-work-item-surface="list"]')
      return document.querySelector('[data-project-workspace-studio]')?.getAttribute('aria-busy') === 'false' &&
        document.querySelector('[data-project-workspace-select]')?.value === expectedProjectId && toggle?.getAttribute('data-work-item-view') === expected &&
        Number(surface?.getAttribute('data-total-work-items')) === expectedTotal && Number(surface?.getAttribute('data-rendered-work-items')) > 0 &&
        !document.querySelector('.task-recovery-drawer')
    }, { timeout: 30_000 }, { expected: target, expectedProjectId: projectId, expectedTotal: itemCount })
    const measured = await page.evaluate(() => {
      const clickAt = window.__caogenWorkItemViewPerformance?.clickAt
      return {
        clickAt,
        durationMs: typeof clickAt === 'number' ? Math.round((performance.now() - clickAt) * 10) / 10 : null,
        recoveryDrawerObserved: Boolean(document.querySelector('.task-recovery-drawer'))
      }
    })
    assert(typeof measured.clickAt === 'number', 'measured WorkItem view click timestamp is missing')
    const interaction = {
      durationMs: measured.durationMs,
      view: target,
      total: itemCount,
      projectId,
      recoveryDrawerObserved: measured.recoveryDrawerObserved
    }
    report.performance.warmSamplesMs.push(interaction.durationMs)
    interactions.push(interaction)
    current = target
  }
  return interactions
}
