#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import { cpus, freemem, platform, release, totalmem, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dismissRecoveryCenter } from './lib/project-workspace-lifecycle-ui.mjs'
import {
  assertDeepEqual,
  assertRejects,
  completePhaseTiming,
  compareBoardOrder,
  createPhaseTiming,
  finalizeSourceBinding,
  gitState,
  markPhaseTiming,
  roundMilliseconds,
  safeError,
  sha256Directory,
  sha256File,
  summarizePerformance
} from './lib/workitem-board-support.mjs'
import { enterStudio as enterStudioUi, measureWarmViewSwitches as measureWarmViewSwitchesUi } from './lib/workitem-board-ui.mjs'

const repoRoot = process.cwd()
const require = createRequire(path.join(repoRoot, 'package.json'))
process.env.NODE_PATH = [path.join(repoRoot, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter)
require('node:module').Module._initPaths()
const puppeteer = require('puppeteer-core')
const packageJson = require(path.join(repoRoot, 'package.json'))
const electronPackage = require('electron/package.json')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const outputRoot = path.join(repoRoot, 'test-results', 'workitem-board')
const runDir = path.join(outputRoot, runId)
const reportPath = path.join(runDir, 'report.json')
const latestPath = path.join(outputRoot, 'latest.json')
const latestDiagnosticPath = path.join(outputRoot, 'latest-diagnostic.json')
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-workitem-board-'))
const domainOutDir = path.join(tempRoot, 'domain-compiled')
const domainDataDir = path.join(tempRoot, 'domain-data')
const userDataDir = path.join(tempRoot, 'electron-user-data')
const functionalTemplateDir = path.join(tempRoot, 'functional-template')
const performanceTemplateDir = path.join(tempRoot, 'performance-template')
const diagnosticFixtureDir = path.join(tempRoot, 'diagnostic-json-fixture')
const sourceOutDir = path.join(repoRoot, 'out')
const isolatedOutDir = path.join(runDir, 'app', 'out')
const mainEntry = path.join(isolatedOutDir, 'main', 'index.js')
const electronBin = process.platform === 'win32'
  ? path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(repoRoot, 'node_modules', '.bin', 'electron')
const projectId = 'workitem-board-project'
const ITEM_COUNT = 1000
const LIST_ROW_HEIGHT = 170
const BOARD_CARD_HEIGHT = 356
const INITIAL_INTERACTIVE_TARGET_MS = 1000
const COLD_INTERACTIVE_SAMPLE_COUNT = 5
const WARM_VIEW_SWITCH_SAMPLE_COUNT = 10
const PERF_DIAGNOSTICS_ENABLED = process.env.CAOGEN_WORKITEM_PERF_DIAGNOSTICS === '1'
const PERF_DIAGNOSTIC_ONLY = process.env.CAOGEN_WORKITEM_PERF_DIAGNOSTIC_ONLY === '1'
const PERF_DIAGNOSTIC_FIXTURE = process.env.CAOGEN_WORKITEM_PERF_DIAGNOSTIC_FIXTURE === 'canonical'
  ? 'canonical'
  : 'unmigrated'
const REPORT_MODE = PERF_DIAGNOSTIC_ONLY ? 'diagnostic' : 'required'

class PerformanceDiagnosticComplete extends Error {}

const report = {
  schemaVersion: 3,
  status: 'running',
  mode: REPORT_MODE,
  requiredAssertionsRun: false,
  requirement: 'WORK-002',
  gate: 'test:workitem-board:required',
  runId,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  packageVersion: packageJson.version,
  git: {
    started: gitState(repoRoot),
    finished: null,
    unchangedDuringRun: null
  },
  environment: {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    electronVersion: electronPackage.version,
    os: `${platform()} ${release()}`,
    cpuModel: cpus()[0]?.model ?? 'unknown',
    cpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    freeMemoryBytesAtStart: freemem()
  },
  sourceBinding: {
    scriptSha256: sha256File(fileURLToPath(import.meta.url)),
    finalScriptSha256: null,
    copiedBuildSha256: null,
    finalCopiedBuildSha256: null,
    unchangedDuringRun: null,
    functionalTemplateSha256: null,
    performanceTemplateSha256: null
  },
  checks: [],
  phases: [],
  screenshots: [],
  warnings: [],
  performance: {
    thresholdMs: INITIAL_INTERACTIVE_TARGET_MS,
    samplePlan: {
      coldProcessSamples: COLD_INTERACTIVE_SAMPLE_COUNT,
      warmViewSwitchSamples: WARM_VIEW_SWITCH_SAMPLE_COUNT
    },
    coldSamplesMs: [],
    warmSamplesMs: [],
    migrationSamplesMs: [],
    migrationResults: [],
    stageSamples: [],
    processSamples: [],
    coldIpcProbe: null,
    summary: null
  },
  coverage: {
    verified: [],
    explicitlyNotVerified: [
      'multi-user remote synchronization',
      'drag-and-drop pointer interaction; keyboard-accessible move controls are the 1.0 reorder surface'
    ]
  }
}

let activeRuntime
let compiledLedgerMigration
let compiledCanonicalView
mkdirSync(runDir, { recursive: true })

try {
  assert(!PERF_DIAGNOSTIC_ONLY || PERF_DIAGNOSTICS_ENABLED,
    'CAOGEN_WORKITEM_PERF_DIAGNOSTIC_ONLY=1 requires CAOGEN_WORKITEM_PERF_DIAGNOSTICS=1')
  assertGateDefinition()
  await runDomainChecks()
  report.coverage.verified.push('domain reorder CAS, project boundary, field preservation, durability, and legacy fallback')
  await prepareCanonicalTemplate(functionalTemplateDir, 'functional')
  await prepareCanonicalTemplate(performanceTemplateDir, 'performance')
  report.coverage.verified.push('production JSON-to-Ledger migration timing and canonical parity for 1,000 WorkItems')
  restoreElectronFixture(functionalTemplateDir)
  assertBuildInputs()
  copyBuiltApp()
  report.sourceBinding.copiedBuildSha256 = sha256Directory(isolatedOutDir, assert)

  if (PERF_DIAGNOSTICS_ENABLED) {
    if (PERF_DIAGNOSTIC_FIXTURE === 'canonical') restoreElectronFixture(performanceTemplateDir)
    else prepareElectronFixture(diagnosticFixtureDir, 'performance')
    await runColdIpcDiagnostic(
      PERF_DIAGNOSTIC_FIXTURE === 'canonical' ? userDataDir : diagnosticFixtureDir
    )
    if (PERF_DIAGNOSTIC_ONLY) throw new PerformanceDiagnosticComplete()
    restoreElectronFixture(functionalTemplateDir)
  }

  report.requiredAssertionsRun = true
  await runElectronPhase('list-board-1000', async (page) => {
    await check('Project Inbox stays bounded and leaves the primary WorkItem controls visible', async () => {
      const layout = await page.evaluate(() => {
        const primary = document.querySelector('[data-project-primary-surface]')
        const secondary = document.querySelector('[data-project-secondary-details]')
        const inbox = document.querySelector('[data-project-inbox]')
        const inboxList = inbox?.querySelector('.pws-inbox-list')
        const viewToggle = document.querySelector('[data-work-item-view]')
        const activeView = viewToggle?.getAttribute('data-work-item-view')
        const viewButton = activeView
          ? document.querySelector(`[data-view-option="${activeView}"]`)
          : null
        const toggleRect = viewToggle?.getBoundingClientRect()
        const buttonRect = viewButton?.getBoundingClientRect()
        return {
          primaryBeforeSecondary: Boolean(primary && secondary &&
            (primary.compareDocumentPosition(secondary) & Node.DOCUMENT_POSITION_FOLLOWING)),
          secondaryClosed: secondary?.hasAttribute('open') !== true,
          inboxTotal: Number(inboxList?.getAttribute('data-inbox-total')),
          inboxRendered: Number(inboxList?.getAttribute('data-inbox-rendered')),
          inboxClientHeight: inboxList?.clientHeight ?? 0,
          inboxScrollHeight: inboxList?.scrollHeight ?? 0,
          toggleInsideViewport: Boolean(toggleRect && toggleRect.top >= 0 && toggleRect.bottom <= window.innerHeight),
          buttonHit: Boolean(buttonRect && viewButton?.contains(document.elementFromPoint(
            buttonRect.left + buttonRect.width / 2,
            buttonRect.top + buttonRect.height / 2
          )))
        }
      })
      assert(layout.primaryBeforeSecondary, `secondary Project details precede the primary Work surface: ${JSON.stringify(layout)}`)
      assert(layout.secondaryClosed, `secondary Project details opened by default: ${JSON.stringify(layout)}`)
      assert(layout.inboxTotal === 500 && layout.inboxRendered === 50,
        `functional attention sample did not render the expected bounded Inbox projection: ${JSON.stringify(layout)}`)
      assert(layout.inboxClientHeight <= 220 && layout.inboxScrollHeight > layout.inboxClientHeight,
        `Project Inbox did not establish its own scroll boundary: ${JSON.stringify(layout)}`)
      assert(layout.toggleInsideViewport && layout.buttonHit,
        `Project Inbox pushed the primary WorkItem controls out of the initial viewport: ${JSON.stringify(layout)}`)
    })

    await check('List renders a bounded fixed-height window over 1,000 canonical WorkItems', async () => {
      const metrics = await page.$eval('[data-work-item-surface="list"]', (element) => ({
        total: Number(element.getAttribute('data-total-work-items')),
        rendered: Number(element.getAttribute('data-rendered-work-items')),
        height: element.getBoundingClientRect().height,
        rows: [...element.querySelectorAll('[data-work-item-id]')].map((row) => row.getBoundingClientRect().height)
      }))
      assert(metrics.total === ITEM_COUNT, `List total mismatch: ${metrics.total}`)
      assert(metrics.rendered > 0 && metrics.rendered < 30, `List did not window DOM rows: ${metrics.rendered}`)
      assert(metrics.height === 604, `List viewport height changed: ${metrics.height}`)
      assert(
        metrics.rows.every((height) => height === LIST_ROW_HEIGHT),
        `List rows are not fixed at ${LIST_ROW_HEIGHT}px: ${metrics.rows.join(',')}`
      )
    })

    await check('filtering after a deep virtual scroll resets to the first matching WorkItem', async () => {
      await page.$eval('[data-work-item-surface="list"]', (element) => {
        element.scrollTop = element.scrollHeight
        element.dispatchEvent(new Event('scroll', { bubbles: true }))
      })
      await page.waitForFunction(() => {
        const first = document.querySelector('[data-work-item-surface="list"] [data-work-item-id]')
        return first?.getAttribute('data-work-item-id') !== 'work-item-0000'
      }, { timeout: 30_000 })
      await page.select('[data-work-item-filter="status"]', 'blocked')
      await waitForTotal(page, 'list', 250)
      await page.waitForFunction(() => {
        const surface = document.querySelector('[data-work-item-surface="list"]')
        const first = surface?.querySelector('[data-work-item-id]')
        return surface?.scrollTop === 0 && first?.getAttribute('data-work-item-id') === 'work-item-0001'
      }, { timeout: 30_000 })
      await clearWorkItemFilters(page)
      await waitForTotal(page, 'list', ITEM_COUNT)
    })
  })
  report.coverage.verified.push('fixed-size List windowing with 1,000 canonical WorkItems')

  await runElectronPhase('filters-reorder-board', async (page) => {
    await check('search, status, Goal, and owner filters operate on the canonical projection', async () => {
      await page.type('[data-work-item-filter="query"]', 'Board item 0999')
      await waitForRenderedIds(page, ['work-item-0999'])
      await clearWorkItemFilters(page)
      await waitForTotal(page, 'list', ITEM_COUNT)

      await page.select('[data-work-item-filter="status"]', 'blocked')
      await waitForTotal(page, 'list', 250)
      await page.select('[data-work-item-filter="owner"]', 'human')
      await waitForTotal(page, 'list', 84)
      const filtered = await page.$$eval('[data-work-item-surface="list"] [data-work-item-id]', (rows) =>
        rows.map((row) => ({ status: row.getAttribute('data-status'), owner: row.getAttribute('data-owner-id') })))
      assert(filtered.length > 0, 'filtered List rendered no rows')
      assert(filtered.every((item) => item.status === 'blocked' && item.owner.startsWith('human-')), 'filter result leaked non-matching fields')

      await clearWorkItemFilters(page)
      await waitForTotal(page, 'list', ITEM_COUNT)
      await page.select('[data-work-item-filter="goal"]', 'workitem-board-goal')
      await waitForTotal(page, 'list', 100)
      await page.select('[data-work-item-filter="goal"]', 'none')
      await waitForTotal(page, 'list', 900)
      await clearWorkItemFilters(page)
      await waitForTotal(page, 'list', ITEM_COUNT)
    })

    await check('revision-guarded reorder persists without changing priority or status', async () => {
      const before = await page.evaluate(async () => ({
        first: await window.agentDesk.getProjectWorkItem('work-item-0000'),
        second: await window.agentDesk.getProjectWorkItem('work-item-0001')
      }))
      await page.click('[data-work-item-id="work-item-0001"] [data-work-item-reorder="up"]')
      await page.waitForFunction(async () => {
        const [first, second] = await Promise.all([
          window.agentDesk.getProjectWorkItem('work-item-0000'),
          window.agentDesk.getProjectWorkItem('work-item-0001')
        ])
        return Boolean(first && second && second.boardOrder < first.boardOrder)
      }, { timeout: 60_000 })
      const after = await page.evaluate(async () => ({
        first: await window.agentDesk.getProjectWorkItem('work-item-0000'),
        second: await window.agentDesk.getProjectWorkItem('work-item-0001')
      }))
      assert(after.second.revision === before.second.revision + 1, 'reorder did not increment the moved WorkItem revision exactly once')
      assert(after.second.priority === before.second.priority, 'reorder changed business priority')
      assert(after.second.status === before.second.status, 'reorder changed workflow status')
      report.reorder = {
        itemId: after.second.id,
        targetId: after.first.id,
        placement: 'before',
        boardOrder: after.second.boardOrder,
        revision: after.second.revision
      }
    })

    await check('List and Board expose identical canonical identity fields', async () => {
      const listProjection = await readRenderedProjection(page, 'work-item-0000')
      await page.click('[data-view-option="board"]')
      await page.waitForSelector('[data-work-item-surface="board-backlog"]')
      const boardProjection = await readRenderedProjection(page, 'work-item-0000')
      assertDeepEqual(boardProjection, listProjection, 'List/Board canonical projection differs')
      const canonical = await page.evaluate(() => window.agentDesk.getProjectWorkItem('work-item-0000'))
      assert(boardProjection.id === canonical.id, 'renderer ID differs from canonical WorkItem')
      assert(boardProjection.revision === String(canonical.revision), 'renderer revision differs from canonical WorkItem')
      assert(boardProjection.boardOrder === String(canonical.boardOrder), 'renderer boardOrder differs from canonical WorkItem')
      assert(boardProjection.priority === String(canonical.priority), 'renderer priority differs from canonical WorkItem')
    })

    await check('Board windows every status column and keeps aggregate DOM bounded', async () => {
      const metrics = await page.$$eval('[data-work-item-surface^="board-"]', (surfaces) => ({
        total: surfaces.reduce((sum, surface) => sum + Number(surface.getAttribute('data-total-work-items')), 0),
        rendered: surfaces.reduce((sum, surface) => sum + Number(surface.getAttribute('data-rendered-work-items')), 0),
        cardHeights: surfaces.flatMap((surface) => [...surface.querySelectorAll('[data-work-item-id]')].map((card) => card.getBoundingClientRect().height))
      }))
      assert(metrics.total === ITEM_COUNT, `Board aggregate total mismatch: ${metrics.total}`)
      assert(metrics.rendered > 0 && metrics.rendered < 80, `Board DOM is not bounded: ${metrics.rendered}`)
      assert(
        metrics.cardHeights.every((height) => height === BOARD_CARD_HEIGHT),
        `Board cards are not fixed at ${BOARD_CARD_HEIGHT}px: ${metrics.cardHeights.join(',')}`
      )
      await screenshot(page, 'workitem-board-1000')
    })

    await check('view and filters are stored for restart without mutating WorkItems', async () => {
      await page.select('[data-work-item-filter="status"]', 'blocked')
      await waitForTotal(page, 'board-blocked', 250)
      const stored = await page.evaluate((id) => ({
        view: window.localStorage.getItem('caogen.project-workspace.work-items.view.v1'),
        filters: window.localStorage.getItem(`caogen.project-workspace.work-items.filters.v1:${id}`)
      }), projectId)
      assert(stored.view === 'board', `stored view mismatch: ${stored.view}`)
      assert(JSON.parse(stored.filters).status === 'blocked', `stored status filter mismatch: ${stored.filters}`)
    })
  })
  report.coverage.verified.push(
    'canonical WorkItem ID and field parity across List and Board production projections',
    'search, status, Goal, and owner filtering controls',
    'revision-guarded durable reorder semantics independent from priority',
    'fixed-size Board column windowing with 1,000 canonical WorkItems'
  )

  await runElectronPhase('restart-consistency', async (page) => {
    await check('Board view and filter state survive a full Electron restart', async () => {
      const mode = await page.$eval('[data-work-item-view]', (element) => element.getAttribute('data-work-item-view'))
      const status = await page.$eval('[data-work-item-filter="status"]', (element) => element.value)
      assert(mode === 'board', `view did not survive restart: ${mode}`)
      assert(status === 'blocked', `filter did not survive restart: ${status}`)
      await waitForTotal(page, 'board-blocked', 250)
    })

    await check('canonical reorder survives restart and remains visible in List order', async () => {
      const canonical = await page.evaluate(async () => ({
        first: await window.agentDesk.getProjectWorkItem('work-item-0000'),
        second: await window.agentDesk.getProjectWorkItem('work-item-0001')
      }))
      assert(canonical.second.boardOrder < canonical.first.boardOrder, 'canonical boardOrder reverted after restart')
      await clearWorkItemFilters(page)
      await waitForBoardTotal(page, ITEM_COUNT)
      await page.click('[data-view-option="list"]')
      await waitForTotal(page, 'list', ITEM_COUNT)
      const firstRendered = await page.$eval('[data-work-item-surface="list"] [data-work-item-id]', (element) => element.getAttribute('data-work-item-id'))
      assert(firstRendered === 'work-item-0001', `List order reverted after restart: ${firstRendered}`)
      const persisted = JSON.parse(readFileSync(path.join(userDataDir, 'project-workspace.json'), 'utf8'))
      const first = persisted.workItems.find((item) => item.id === 'work-item-0000')
      const second = persisted.workItems.find((item) => item.id === 'work-item-0001')
      assert(second.boardOrder < first.boardOrder, 'durable JSON source lost reordered boardOrder')
    })
  }, { expectedTotal: 250 })
  report.coverage.verified.push('WorkItem order plus List/Board filter and view consistency across Electron restart')

  // Every claimed latency sample comes from the same all-backlog canonical
  // fixture. Each cold launch contributes exactly two warm view switches.
  for (let sampleOrdinal = 1; sampleOrdinal <= COLD_INTERACTIVE_SAMPLE_COUNT; sampleOrdinal += 1) {
    const fixtureSha256 = restoreElectronFixture(performanceTemplateDir)
    assert(
      fixtureSha256 === report.sourceBinding.performanceTemplateSha256,
      'fresh-process performance fixture bytes differ from the verified canonical template'
    )
    const sample = {
      ordinal: sampleOrdinal,
      phase: `performance-cold-${sampleOrdinal}`,
      fixtureProfile: 'performance-all-backlog',
      fixtureSha256,
      pid: null,
      exit: null,
      status: 'pending',
      coldInteraction: null,
      warmInteractions: []
    }
    report.performance.processSamples.push(sample)
    await runElectronPhase(sample.phase, async (page) => {
      await check('cold performance fixture reaches an interactive List surface', async () => {
        await page.waitForSelector('[data-work-item-surface="list"] [data-work-item-id]', { visible: true, timeout: 30_000 })
      })
      sample.warmInteractions = await check(
        `performance sample ${sampleOrdinal} completes two interactive warm view switches`,
        () => measureWarmViewSwitchesUi(page, WARM_VIEW_SWITCH_SAMPLE_COUNT / COLD_INTERACTIVE_SAMPLE_COUNT, {
          projectId,
          itemCount: ITEM_COUNT,
          assert,
          report
        })
      )
    }, { sampleKind: 'cold', performanceSample: sample })
  }

  assert(report.performance.coldSamplesMs.length === COLD_INTERACTIVE_SAMPLE_COUNT,
    `cold sample count must be exactly ${COLD_INTERACTIVE_SAMPLE_COUNT}, got ${report.performance.coldSamplesMs.length}`)
  assert(report.performance.warmSamplesMs.length === WARM_VIEW_SWITCH_SAMPLE_COUNT,
    `warm sample count must be exactly ${WARM_VIEW_SWITCH_SAMPLE_COUNT}, got ${report.performance.warmSamplesMs.length}`)
  assert(report.performance.migrationSamplesMs.length === 1,
    `migration sample count must be exactly 1, got ${report.performance.migrationSamplesMs.length}`)
  assert(report.performance.processSamples.length === COLD_INTERACTIVE_SAMPLE_COUNT,
    `performance process evidence count must be exactly ${COLD_INTERACTIVE_SAMPLE_COUNT}`)
  assert(new Set(report.performance.processSamples.map((sample) => sample.pid)).size === COLD_INTERACTIVE_SAMPLE_COUNT,
    'fresh-process performance samples must use unique Electron PIDs')
  for (const sample of report.performance.processSamples) {
    assert(Number.isInteger(sample.pid) && sample.pid > 0, `performance sample ${sample.ordinal} has no Electron PID`)
    assert(sample.fixtureSha256 === report.sourceBinding.performanceTemplateSha256,
      `performance sample ${sample.ordinal} fixture hash drifted`)
    assert(sample.exit?.observed === true,
      `performance sample ${sample.ordinal} has no observed Electron process exit`)
    assert(sample.coldInteraction?.studioButtonPressed === true &&
      sample.coldInteraction?.studioButtonPressedBeforeClick === false &&
      sample.coldInteraction?.studioSurface === 'workspace' &&
      sample.coldInteraction?.workspacePaneVisible === true &&
      sample.coldInteraction?.workspaceTabSelected === true,
    `performance sample ${sample.ordinal} did not prove the selected Studio workspace pane`)
    assert(sample.coldInteraction?.recoveryDrawerObserved === false,
      `performance sample ${sample.ordinal} observed the Recovery drawer during cold interaction`)
    assert(sample.warmInteractions.length === 2,
      `performance sample ${sample.ordinal} must contain exactly 2 warm interactions`)
    assert(sample.warmInteractions.every((item) => item.recoveryDrawerObserved === false),
      `performance sample ${sample.ordinal} observed the Recovery drawer during a warm interaction`)
  }
  report.performance.summary = summarizePerformance(report.performance, assert)
  assert(
    report.performance.summary.cold.p95Ms < INITIAL_INTERACTIVE_TARGET_MS,
    `cold initial-interactive P95 ${report.performance.summary.cold.p95Ms}ms is not <${INITIAL_INTERACTIVE_TARGET_MS}ms`
  )
  assert(
    report.performance.summary.warm.p95Ms < INITIAL_INTERACTIVE_TARGET_MS,
    `warm List/Board switch P95 ${report.performance.summary.warm.p95Ms}ms is not <${INITIAL_INTERACTIVE_TARGET_MS}ms`
  )
  report.coverage.verified.push('fresh-process initial-interactive cold samples and List/Board warm-switch latency P95')

  report.status = 'pass'
  report.conclusion = 'WORK-002 required gate passed with domain, production IPC/renderer, 1,000-item windowing, restart evidence, and NFR-PERF-002 latency samples.'
} catch (error) {
  if (error instanceof PerformanceDiagnosticComplete) {
    report.status = 'diagnostic'
    report.conclusion = 'Fresh-process startup and ProjectWorkspace IPC diagnostics completed; required WORK-002 assertions were intentionally not run.'
    report.coverage = {
      verified: [
        'production JSON-to-Ledger template migration timing and canonical parity',
        'fresh-process startup and ProjectWorkspace IPC diagnostic stages'
      ],
      explicitlyNotVerified: [
        'WORK-002 functional List/Board assertions',
        'required cold and warm P95 thresholds',
        'release readiness'
      ]
    }
  } else {
    report.status = 'fail'
    report.error = error instanceof Error ? error.stack ?? error.message : String(error)
    report.conclusion = 'WORK-002 required gate failed closed.'
  }
} finally {
  if (activeRuntime) await stopRuntime(activeRuntime).catch(() => undefined)
  report.finishedAt = new Date().toISOString()
  try {
    finalizeSourceBinding({
      repoRoot,
      report,
      isolatedOutDir,
      scriptPath: fileURLToPath(import.meta.url),
      assert
    })
  } catch (bindingError) {
    const message = safeError(bindingError)
    report.status = 'fail'
    report.error = report.error ? `${report.error}\nSource binding failure: ${message}` : message
    report.conclusion = 'WORK-002 gate failed closed because source or copied build bytes changed during the run.'
  }
  writeReport()
  rmSync(tempRoot, { recursive: true, force: true })
}

if (report.status === 'pass') {
  console.log(`workitem board required ok: ${reportPath}`)
  console.log(`${report.checks.length}/${report.checks.length} checks passed across domain and ${report.phases.length} Electron launches`)
} else if (report.status === 'diagnostic') {
  console.log(`workitem board performance diagnostic ok: ${reportPath}`)
} else {
  console.error(`workitem board required failed: ${report.error || 'unknown failure'}`)
  console.error(`report: ${reportPath}`)
}
process.exit(report.status === 'fail' ? 1 : 0)

function assertGateDefinition() {
  const matrix = readFileSync(path.join(repoRoot, 'docs', '1.0-ACCEPTANCE-MATRIX.md'), 'utf8')
  assert(matrix.includes('`WORK-002`') && matrix.includes('test:workitem-board:required'), 'WORK-002 acceptance gate declaration is missing')
}

async function runDomainChecks() {
  compileDomainSources()
  installElectronStub()
  const domainEntry = path.join(domainOutDir, 'main', 'project-workspace', 'index.js')
  assert(existsSync(domainEntry), 'compiled ProjectWorkspace entry is missing')
  const api = await import(pathToFileURL(domainEntry).href)
  compiledLedgerMigration = await import(pathToFileURL(path.join(domainOutDir, 'main', 'project-workspace', 'ledger-migration.js')).href)
  compiledCanonicalView = await import(pathToFileURL(path.join(domainOutDir, 'main', 'project-workspace', 'ledger-canonical-view.js')).href)
  const store = new api.ProjectWorkspaceStore(domainDataDir)
  await store.open()
  const workspace = await store.createWorkspace({ id: 'domain-project', name: 'Board domain', kind: 'software' })
  const foreign = await store.createWorkspace({ id: 'foreign-project', name: 'Foreign', kind: 'software' })
  const first = await store.createWorkItem({ id: 'domain-first', projectId: workspace.id, title: 'First', priority: 99 })
  const second = await store.createWorkItem({ id: 'domain-second', projectId: workspace.id, title: 'Second', priority: 1 })
  const third = await store.createWorkItem({ id: 'domain-third', projectId: workspace.id, title: 'Third', priority: 50 })
  const foreignItem = await store.createWorkItem({ id: 'domain-foreign', projectId: foreign.id, title: 'Foreign item' })
  assert(first.boardOrder < second.boardOrder && second.boardOrder < third.boardOrder, 'create did not assign stable sparse boardOrder')

  const moved = await store.reorderWorkItem(third.id, first.id, 'before', { expectedRevision: third.revision })
  assert(moved.boardOrder < first.boardOrder, 'before reorder did not place item before target')
  assert(moved.priority === third.priority && moved.status === third.status, 'reorder changed business fields')
  await assertRejects(
    store.reorderWorkItem(third.id, second.id, 'after', { expectedRevision: third.revision }),
    (error) => error?.code === 'stale_revision',
    'stale reorder must fail closed'
  )
  await assertRejects(
    store.reorderWorkItem(first.id, foreignItem.id, 'before', { expectedRevision: first.revision }),
    (error) => error?.code === 'cross_project',
    'cross-project reorder must fail closed'
  )
  const cancelled = await store.transitionWorkItem(first.id, 'cancelled', { expectedRevision: first.revision })
  const terminalMoved = await store.reorderWorkItem(cancelled.id, second.id, 'after', { expectedRevision: cancelled.revision })
  assert(terminalMoved.status === 'cancelled', 'terminal reorder changed status')

  const reopened = new api.ProjectWorkspaceStore(domainDataDir)
  await reopened.open()
  const durable = (await reopened.listWorkItems(workspace.id)).sort(compareBoardOrder)
  assertDeepEqual(durable.map((item) => item.id), ['domain-third', 'domain-second', 'domain-first'], 'domain order did not survive reopen')

  const legacyRoot = path.join(tempRoot, 'legacy-v1-data')
  mkdirSync(legacyRoot, { recursive: true })
  const legacyState = JSON.parse(readFileSync(path.join(domainDataDir, 'project-workspace.json'), 'utf8'))
  legacyState.workItems.forEach((item) => { delete item.boardOrder })
  writeFileSync(path.join(legacyRoot, 'project-workspace.json'), `${JSON.stringify(legacyState)}\n`, { mode: 0o600 })
  const legacy = new api.ProjectWorkspaceStore(legacyRoot)
  await legacy.open()
  const firstLegacyRead = (await legacy.listWorkItems(workspace.id)).sort(compareBoardOrder).map((item) => item.id)
  const secondLegacyRead = (await legacy.listWorkItems(workspace.id)).sort(compareBoardOrder).map((item) => item.id)
  assert(firstLegacyRead.length === 3, 'legacy v1 WorkItems without boardOrder were not readable')
  assertDeepEqual(secondLegacyRead, firstLegacyRead, 'legacy v1 fallback order is not deterministic')
  report.checks.push({
    name: 'domain reorder enforces CAS, project boundary, field preservation, terminal support, reopen durability, and legacy v1 fallback',
    status: 'pass'
  })
}

async function prepareCanonicalTemplate(templateRoot, profile) {
  prepareElectronFixture(userDataDir, profile)
  const sourcePath = path.join(userDataDir, 'project-workspace.json')
  const sourceBytes = readFileSync(sourcePath)
  const source = JSON.parse(sourceBytes.toString('utf8'))
  const startedAt = performance.now()
  const migrated = await compiledLedgerMigration.migrateProjectWorkspaceToWorkflowLedger(projectId, userDataDir)
  const migrationMs = roundMilliseconds(performance.now() - startedAt)
  const verificationStartedAt = performance.now()
  const current = await compiledLedgerMigration.migrateProjectWorkspaceToWorkflowLedger(projectId, userDataDir)
  const verificationMs = roundMilliseconds(performance.now() - verificationStartedAt)
  const canonicalViewStartedAt = performance.now()
  const view = await compiledCanonicalView.readVerifiedCanonicalProjectWorkspaceView(projectId, userDataDir)
  const canonicalViewMs = roundMilliseconds(performance.now() - canonicalViewStartedAt)
  assert(migrated.status === 'migrated', `${profile} template did not execute a production migration: ${migrated.status}`)
  assert(current.status === 'already_current', `${profile} template is not idempotently canonical: ${current.status}`)
  assert(Buffer.compare(sourceBytes, readFileSync(sourcePath)) === 0, `${profile} migration rewrote source JSON`)
  assert(view.sourceSha256 === migrated.sourceSha256,
    `${profile} canonical view source digest differs from the migration result`)
  assert(view.projectionDigest === migrated.projectionDigest,
    `${profile} canonical view projection digest differs from the migration result`)
  assert(view.goals.length === 1 && view.workItems.length === ITEM_COUNT,
    `${profile} canonical template count mismatch: ${view.goals.length}/${view.workItems.length}`)
  assertDeepEqual(
    [...view.workItems].sort((left, right) => left.id.localeCompare(right.id)),
    [...source.workItems].sort((left, right) => left.id.localeCompare(right.id)),
    `${profile} canonical template changed WorkItem fields`
  )
  const statusCounts = Object.fromEntries([...new Set(view.workItems.map((item) => item.status))]
    .sort().map((status) => [status, view.workItems.filter((item) => item.status === status).length]))
  if (profile === 'performance') {
    assert(statusCounts.backlog === ITEM_COUNT && Object.keys(statusCounts).length === 1,
      `performance canonical template must contain exactly ${ITEM_COUNT} backlog WorkItems: ${JSON.stringify(statusCounts)}`)
  }
  const stableFixtureSha256 = sha256Directory(userDataDir, assert)
  rmSync(templateRoot, { recursive: true, force: true })
  cpSync(userDataDir, templateRoot, { recursive: true, force: true })
  const templateSha256 = sha256Directory(templateRoot, assert)
  assert(templateSha256 === stableFixtureSha256,
    `${profile} canonical archive differs from the stable userDataDir fixture`)
  if (profile === 'performance') report.performance.migrationSamplesMs.push(migrationMs)
  report.performance.migrationResults.push({
    profile,
    durationMs: migrationMs,
    verificationMs,
    canonicalViewMs,
    firstStatus: migrated.status,
    verificationStatus: current.status,
    goals: view.goals.length,
    workItems: view.workItems.length,
    sourceSha256: migrated.sourceSha256,
    projectionDigest: migrated.projectionDigest,
    canonicalViewSourceSha256: view.sourceSha256,
    canonicalViewProjectionDigest: view.projectionDigest,
    statusCounts,
    templateSha256,
    migratedAtStableUserDataDir: true
  })
  if (profile === 'functional') report.sourceBinding.functionalTemplateSha256 = templateSha256
  else report.sourceBinding.performanceTemplateSha256 = templateSha256
}

function restoreElectronFixture(templateRoot) {
  rmSync(userDataDir, { recursive: true, force: true })
  cpSync(templateRoot, userDataDir, { recursive: true, force: true })
  return sha256Directory(userDataDir, assert)
}

function prepareElectronFixture(rootDir, profile) {
  rmSync(rootDir, { recursive: true, force: true })
  mkdirSync(rootDir, { recursive: true })
  const now = Date.now()
  const statuses = profile === 'performance'
    ? ['backlog']
    : ['backlog', 'blocked', 'failed', 'cancelled']
  const workItems = Array.from({ length: ITEM_COUNT }, (_, index) => {
    const ownerKind = index % 3
    const owner = ownerKind === 0
      ? undefined
      : ownerKind === 1
        ? { type: 'human', id: `human-${String(index).padStart(4, '0')}`, displayName: `Human ${index}` }
        : { type: 'digital_worker', id: `worker-${String(index).padStart(4, '0')}`, displayName: `Worker ${index}` }
    return {
      schemaVersion: 1,
      id: `work-item-${String(index).padStart(4, '0')}`,
      projectId,
      goalId: index % 10 === 0 ? 'workitem-board-goal' : undefined,
      type: index % 2 === 0 ? 'coding' : 'testing',
      title: `Board item ${String(index).padStart(4, '0')}`,
      description: `Canonical renderer fixture ${index}`,
      dependencyIds: [],
      priority: index % 7,
      boardOrder: (index + 1) * 1024,
      owner,
      status: statuses[index % statuses.length],
      acceptanceSpec: [],
      artifactRefs: [],
      runRefs: [],
      createdAt: now + index,
      updatedAt: now + index,
      revision: 1
    }
  })
  const state = {
    schemaVersion: 1,
    revision: ITEM_COUNT + 1,
    workspaces: [{
      schemaVersion: 1,
      id: projectId,
      name: 'WorkItem Board 1000',
      kind: 'software',
      status: 'active',
      resources: [],
      createdAt: now,
      updatedAt: now,
      revision: 1
    }],
    goals: [{
      schemaVersion: 1,
      id: 'workitem-board-goal',
      projectId,
      title: 'Board linked Goal',
      objective: 'Verify linked Goal filtering',
      constraints: [],
      successCriteria: [],
      riskLevel: 'medium',
      forbiddenActions: [],
      acceptance: [],
      contract: {
        objective: 'Verify linked Goal filtering',
        constraints: [],
        successCriteria: [],
        riskLevel: 'medium',
        forbiddenActions: [],
        acceptance: []
      },
      status: 'draft',
      createdAt: now,
      updatedAt: now,
      revision: 1
    }],
    workItems,
    events: []
  }
  writeFileSync(path.join(rootDir, 'project-workspace.json'), `${JSON.stringify(state)}\n`, { mode: 0o600 })
}

async function runElectronPhase(name, execute, options = {}) {
  const startedAt = Date.now()
  const timing = createPhaseTiming(name)
  activeRuntime = await launchRuntime(name, timing)
  const pid = activeRuntime.child.pid ?? null
  startPerformanceSample(options.performanceSample, pid)
  let interaction = null
  let phaseEvidence = null
  try {
    interaction = await enterStudioUi(activeRuntime.page, timing, phaseUiOptions(options), {
      projectId,
      itemCount: ITEM_COUNT,
      assert,
      markPhaseTiming,
      dismissRecoveryCenter
    })
    recordColdInteraction(options, interaction)
    await execute(activeRuntime.page)
    if (options.performanceSample) options.performanceSample.status = 'pass'
    phaseEvidence = createPhaseEvidence(name, startedAt, pid, options, interaction, 'pass')
    report.phases.push(phaseEvidence)
  } catch (error) {
    recordPhaseFailure(options.performanceSample, error)
    await screenshot(activeRuntime.page, `failure-${name}`).catch(() => undefined)
    phaseEvidence = createPhaseEvidence(name, startedAt, pid, options, interaction, 'fail', error)
    report.phases.push(phaseEvidence)
    throw error
  } finally {
    report.performance.stageSamples.push(completePhaseTiming(timing))
    const exit = await stopRuntime(activeRuntime)
    if (phaseEvidence) phaseEvidence.exit = exit
    if (options.performanceSample) options.performanceSample.exit = exit
    activeRuntime = null
    if (phaseEvidence?.status === 'pass') {
      assert(exit.observed, `${name} Electron process exit was not observed`)
    }
  }
}

function phaseUiOptions(options) {
  return {
    dismissRecovery: options.sampleKind !== 'cold',
    requireList: options.sampleKind === 'cold',
    forbidRecovery: options.sampleKind === 'cold',
    expectedTotal: options.expectedTotal ?? ITEM_COUNT
  }
}

function startPerformanceSample(sample, pid) {
  if (!sample) return
  sample.pid = pid
  sample.status = 'running'
}

function recordColdInteraction(options, interaction) {
  if (options.sampleKind !== 'cold') return
  report.performance.coldSamplesMs.push(interaction.durationMs)
  if (options.performanceSample) options.performanceSample.coldInteraction = interaction
}

function recordPhaseFailure(sample, error) {
  if (!sample) return
  sample.status = 'fail'
  sample.error = safeError(error)
}

function createPhaseEvidence(name, startedAt, pid, options, interaction, status, error = null) {
  return {
    name,
    status,
    durationMs: Date.now() - startedAt,
    pid,
    sampleKind: options.sampleKind ?? 'functional',
    sampleOrdinal: options.performanceSample?.ordinal ?? null,
    fixtureSha256: options.performanceSample?.fixtureSha256 ?? null,
    interaction,
    ...(error ? { error: safeError(error) } : {}),
    exit: null
  }
}

async function launchRuntime(phase, timing, fixtureRoot = userDataDir) {
  const port = await findFreePort(10040)
  markPhaseTiming(timing, 'debugPortSelected')
  const child = spawn(electronBin, [`--remote-debugging-port=${port}`, mainEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CAOGEN_USER_DATA_DIR: fixtureRoot,
      CAOGEN_MEMORY_DIR: path.join(tempRoot, 'memory'),
      CAOGEN_PROJECT_WORKSPACE_READ_MODE: 'canonical',
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  markPhaseTiming(timing, 'processSpawned')
  const output = { stdout: '', stderr: '' }
  child.stdout.on('data', (chunk) => { output.stdout += chunk.toString() })
  child.stderr.on('data', (chunk) => { output.stderr += chunk.toString() })
  try {
    await waitForDebugPort(port, 30_000)
    markPhaseTiming(timing, 'debugEndpointReady')
    const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null })
    markPhaseTiming(timing, 'browserConnected')
    const page = await waitForValue(
      async () => (await browser.pages()).find((candidate) => !candidate.url().startsWith('devtools://')),
      Boolean,
      30_000,
      'waiting for Electron renderer page'
    )
    markPhaseTiming(timing, 'rendererPageReady')
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') report.warnings.push(`${phase} console ${message.type()}: ${message.text()}`)
    })
    page.on('pageerror', (error) => report.warnings.push(`${phase} pageerror: ${error.message}`))
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
    markPhaseTiming(timing, 'viewportReady')
    return { browser, child, output, page, phase }
  } catch (error) {
    await terminate(child)
    throw error
  }
}

async function runColdIpcDiagnostic(fixtureRoot) {
  const name = 'diagnostic-cold-ipc'
  const startedAt = performance.now()
  const timing = createPhaseTiming(name, startedAt)
  const fixtureSha256 = sha256Directory(fixtureRoot, assert)
  const runtime = await launchRuntime(name, timing, fixtureRoot)
  try {
    await runtime.page.waitForSelector('.app', { timeout: 30_000 })
    markPhaseTiming(timing, 'appShellReady')
    await runtime.page.waitForFunction(() => typeof window.agentDesk?.listProjectWorkspaceContents === 'function', { timeout: 30_000 })
    markPhaseTiming(timing, 'preloadApiReady')
    const probe = await runtime.page.evaluate(async (expectedProjectId) => {
      const origin = performance.now()
      const elapsed = () => Math.round((performance.now() - origin) * 10) / 10
      const measure = async (name, invoke) => {
        const startedAtMs = elapsed()
        try {
          const value = await invoke()
          return {
            name,
            status: 'fulfilled',
            startedAtMs,
            completedAtMs: elapsed(),
            durationMs: Math.round((elapsed() - startedAtMs) * 10) / 10,
            resultCount: Array.isArray(value) ? value.length : value === undefined || value === null ? 0 : 1
          }
        } catch (error) {
          return {
            name,
            status: 'rejected',
            startedAtMs,
            completedAtMs: elapsed(),
            durationMs: Math.round((elapsed() - startedAtMs) * 10) / 10,
            error: error instanceof Error ? error.message : String(error)
          }
        }
      }
      const startupCalls = [
        ['getSettings', () => window.agentDesk.getSettings()],
        ['listSessions', () => window.agentDesk.listSessions()],
        ['listHistory', () => window.agentDesk.listHistory()],
        ['listDigitalWorkerAssignments', () => window.agentDesk.listDigitalWorkerAssignments()],
        ['listProjectWorkspaces', () => window.agentDesk.listProjectWorkspaces({
          includeArchived: true,
          includeDeleted: true
        })]
      ]
      const startup = await Promise.all(startupCalls.map(([name, invoke]) => measure(name, invoke)))
      const projectList = startup.find((entry) => entry.name === 'listProjectWorkspaces')
      const contentCalls = [
        ['listProjectWorkspaceContents', () => window.agentDesk.listProjectWorkspaceContents(expectedProjectId, {
          goals: { includeArchived: true },
          workItems: {}
        })],
        ['listProjectSquads', () => window.agentDesk.listProjectSquads(expectedProjectId, { includeArchived: true })],
        ['listProjectMembers', () => window.agentDesk.listProjectMembers(expectedProjectId, { includeArchived: true })],
        ['listProjectInvitations', () => window.agentDesk.listProjectInvitations(expectedProjectId, { includeArchived: true })],
        ['listProjectComments', () => window.agentDesk.listProjectComments(expectedProjectId)],
        ['listProjectSharedApprovals', () => window.agentDesk.listProjectSharedApprovals(expectedProjectId)],
        ['listProjectCollaborationInbox', () => window.agentDesk.listProjectCollaborationInbox(expectedProjectId, { includeHandled: true })],
        ['getProjectAuthorization', () => window.agentDesk.getProjectAuthorization(expectedProjectId)]
      ]
      const contents = await Promise.all(contentCalls.map(([name, invoke]) => measure(name, invoke)))
      return {
        projectId: expectedProjectId,
        totalMs: elapsed(),
        startup: startup.sort((left, right) => left.completedAtMs - right.completedAtMs),
        projectList,
        contents: contents.sort((left, right) => left.completedAtMs - right.completedAtMs)
      }
    }, projectId)
    report.performance.coldIpcProbe = {
      pid: runtime.child.pid ?? null,
      fixtureProfile: PERF_DIAGNOSTIC_FIXTURE,
      fixtureSha256,
      ...probe
    }
    markPhaseTiming(timing, 'ipcProbeReady')
  } finally {
    report.performance.stageSamples.push(completePhaseTiming(timing))
    await stopRuntime(runtime)
  }
}

async function check(name, execute) {
  const startedAt = Date.now()
  try {
    const result = await execute()
    report.checks.push({ name, status: 'pass', durationMs: Date.now() - startedAt })
    return result
  } catch (error) {
    report.checks.push({ name, status: 'fail', durationMs: Date.now() - startedAt, error: safeError(error) })
    throw error
  }
}

async function waitForTotal(page, surface, total) {
  await page.waitForFunction(
    ({ surface, total }) => Number(document.querySelector(`[data-work-item-surface="${surface}"]`)?.getAttribute('data-total-work-items')) === total,
    { timeout: 30_000 },
    { surface, total }
  )
}

async function waitForBoardTotal(page, total) {
  await page.waitForFunction((expectedTotal) => {
    const surfaces = [...document.querySelectorAll('[data-work-item-surface^="board-"]')]
    return surfaces.length > 0 && surfaces.reduce(
      (sum, surface) => sum + Number(surface.getAttribute('data-total-work-items')),
      0
    ) === expectedTotal
  }, { timeout: 30_000 }, total)
}

async function clearWorkItemFilters(page) {
  await page.$eval('[data-work-item-filter="clear"]', (element) => {
    if (!(element instanceof HTMLButtonElement) || element.disabled) {
      throw new Error('clear WorkItem filters control is not enabled')
    }
    element.click()
  })
  await page.waitForFunction(() => {
    const query = document.querySelector('[data-work-item-filter="query"]')
    const status = document.querySelector('[data-work-item-filter="status"]')
    const goal = document.querySelector('[data-work-item-filter="goal"]')
    const owner = document.querySelector('[data-work-item-filter="owner"]')
    return query?.value === '' && status?.value === 'all' && goal?.value === 'all' && owner?.value === 'all'
  }, { timeout: 30_000 })
}

async function waitForRenderedIds(page, expected) {
  await page.waitForFunction(
    (ids) => {
      const rendered = [...document.querySelectorAll('[data-work-item-surface="list"] [data-work-item-id]')]
        .map((element) => element.getAttribute('data-work-item-id'))
      return JSON.stringify(rendered) === JSON.stringify(ids)
    },
    { timeout: 30_000 },
    expected
  )
}

async function readRenderedProjection(page, id) {
  return page.$eval(`[data-work-item-id="${id}"]`, (element) => ({
    id: element.getAttribute('data-work-item-id'),
    status: element.getAttribute('data-status'),
    revision: element.getAttribute('data-work-item-revision'),
    boardOrder: element.getAttribute('data-board-order'),
    goalId: element.getAttribute('data-goal-id'),
    ownerId: element.getAttribute('data-owner-id'),
    priority: element.getAttribute('data-priority'),
    title: element.querySelector('strong')?.textContent?.trim() || ''
  }))
}

function compileDomainSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/shared/project-workspace-types.ts',
    'src/main/project-workspace/store.ts',
    'src/main/project-workspace/index.ts',
    'src/main/project-workspace/ledger-migration.ts',
    'src/main/project-workspace/ledger-canonical-view.ts',
    '--outDir', domainOutDir,
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop'
  ], { cwd: repoRoot, stdio: 'pipe' })
}

function installElectronStub() {
  const electronDir = path.join(domainOutDir, 'node_modules', 'electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(path.join(electronDir, 'index.js'), `export const app = { getPath: () => ${JSON.stringify(domainDataDir)} }\n`)
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"module"}\n')
}

function assertBuildInputs() {
  assert(existsSync(electronBin), 'Electron binary not found. Run npm install first.')
  for (const entry of ['main/index.js', 'preload/index.js', 'renderer/index.html']) {
    assert(existsSync(path.join(sourceOutDir, entry)), `Built app entry missing: out/${entry}`)
  }
}

function copyBuiltApp() {
  rmSync(isolatedOutDir, { recursive: true, force: true })
  mkdirSync(isolatedOutDir, { recursive: true })
  for (const directory of ['main', 'preload', 'renderer']) {
    cpSync(path.join(sourceOutDir, directory), path.join(isolatedOutDir, directory), { recursive: true })
  }
}

async function screenshot(page, name) {
  const file = path.join(runDir, `${name}.png`)
  await page.screenshot({ path: file, fullPage: false })
  report.screenshots.push(file)
}

async function stopRuntime(runtime) {
  const browserClosed = await Promise.race([
    runtime.browser.close().then(() => true).catch(() => false),
    sleep(3000).then(() => false)
  ])
  const cleanExit = browserClosed ? await waitForChildExit(runtime.child, 2500) : null
  const exited = cleanExit ?? await terminate(runtime.child)
  if (runtime.output.stderr.trim()) report.warnings.push(`${runtime.phase} stderr tail:\n${runtime.output.stderr.trim().slice(-1500)}`)
  if (runtime.output.stdout.trim()) report.warnings.push(`${runtime.phase} stdout tail:\n${runtime.output.stdout.trim().slice(-800)}`)
  if (exited.signal) report.warnings.push(`${runtime.phase} Electron exited by signal ${exited.signal}`)
  return {
    observed: runtime.child.exitCode !== null || runtime.child.signalCode !== null,
    code: exited.code ?? runtime.child.exitCode ?? null,
    signal: exited.signal ?? runtime.child.signalCode ?? null
  }
}

async function waitForDebugPort(port, timeoutMs) {
  await waitForValue(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok
    } catch {
      return false
    }
  }, Boolean, timeoutMs, `waiting for Electron debug port ${port}`)
}

async function waitForValue(producer, predicate, timeoutMs, label) {
  const startedAt = Date.now()
  let lastValue
  while (Date.now() - startedAt < timeoutMs) {
    lastValue = await producer()
    if (predicate(lastValue)) return lastValue
    await sleep(150)
  }
  throw new Error(`${label}: ${JSON.stringify(lastValue)}`)
}

async function findFreePort(start) {
  for (let port = start; port < start + 200; port += 1) if (await canListen(port)) return port
  throw new Error(`no free port from ${start}`)
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

async function terminate(child) {
  if (child.exitCode !== null) return { code: child.exitCode, signal: child.signalCode }
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
  child.kill('SIGTERM')
  const graceful = await Promise.race([exited, sleep(3000).then(() => null)])
  if (graceful) return graceful
  child.kill('SIGKILL')
  return Promise.race([exited, sleep(3000).then(() => ({ code: child.exitCode, signal: child.signalCode ?? 'SIGKILL' }))])
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null) return { code: child.exitCode, signal: child.signalCode }
  return Promise.race([
    new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))),
    sleep(timeoutMs).then(() => null)
  ])
}

function writeReport() {
  mkdirSync(runDir, { recursive: true })
  const json = `${JSON.stringify(report, null, 2)}\n`
  writeFileSync(reportPath, json)
  writeFileSync(report.mode === 'diagnostic' ? latestDiagnosticPath : latestPath, json)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
