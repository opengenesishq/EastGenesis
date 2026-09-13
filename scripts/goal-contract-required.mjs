#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const repoRoot = process.cwd()
const require = createRequire(path.join(repoRoot, 'package.json'))
const puppeteer = require('puppeteer-core')
const packageJson = require(path.join(repoRoot, 'package.json'))
const electronPackage = require('electron/package.json')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const outputRoot = path.join(repoRoot, 'test-results', 'goal-contract')
const runDir = path.join(outputRoot, runId)
const reportPath = path.join(runDir, 'report.json')
const latestPath = path.join(outputRoot, 'latest.json')
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-goal-contract-'))
const userDataDir = path.join(tempRoot, 'electron-user-data')
const sourceOutDir = path.join(repoRoot, 'out')
const isolatedOutDir = path.join(runDir, 'app', 'out')
const mainEntry = path.join(isolatedOutDir, 'main', 'index.js')
const electronBin = process.platform === 'win32'
  ? path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(repoRoot, 'node_modules', '.bin', 'electron')

const PROJECT_NAME = `GOAL-001 Contract ${runId}`
const CREATED_DRAFT = {
  title: 'Canonical Goal Contract',
  objective: 'Deliver a complete canonical Goal contract',
  background: 'Created through the production Studio form',
  constraints: ['Preserve canonical identity', 'Fail closed on stale revisions'],
  successCriteria: ['Contract survives restart', 'Archive and restore preserve every field'],
  acceptance: ['Studio writes through preload and main', 'Canonical readback matches the form'],
  forbiddenActions: ['Do not bypass revision checks', 'Do not mutate user data'],
  riskLevel: 'critical',
  dueDate: '2030-07-26',
  budgetAmount: '1250.5',
  budgetCurrency: 'CNY',
  budgetRuns: '7',
  budgetTokens: '64000'
}
const EDITED_DRAFT = {
  title: 'Canonical Goal Contract Edited',
  objective: 'Deliver and verify the edited canonical Goal contract',
  background: 'Edited through the production Studio form with revision CAS',
  constraints: ['Preserve canonical identity', 'Reject stale revisions'],
  successCriteria: ['Edited contract survives restart', 'Archived restore retains every field'],
  acceptance: ['Studio update uses optimistic concurrency', 'Canonical get returns the edited contract'],
  forbiddenActions: ['Never overwrite a concurrent writer', 'Never mutate real user data'],
  riskLevel: 'high',
  dueDate: '2031-08-15',
  budgetAmount: '2048.75',
  budgetCurrency: 'USD',
  budgetRuns: '11',
  budgetTokens: '128000'
}

const state = {
  projectId: '',
  baselineGoalCount: 0,
  goalId: '',
  originalAcceptanceIds: [],
  editedContract: null,
  archivedRevision: 0
}
const report = {
  schemaVersion: 1,
  status: 'running',
  requirement: 'GOAL-001',
  gate: 'test:goal-contract:required',
  runId,
  runDir,
  packageVersion: packageJson.version,
  git: gitState(),
  environment: {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    electronVersion: electronPackage.version
  },
  checks: [],
  phases: [],
  screenshots: [],
  warnings: [],
  coverage: {
    verified: [
      'required HTML validation prevents an invalid Studio Goal form from reaching persistence',
      'negative Goal budget amount, zero maxRuns, and zero maxTokens are rejected by production preload and main IPC',
      'complete Goal contract creation and editing through the production Studio renderer',
      'revision increment plus stale-revision rejection for a concurrent Studio edit',
      'non-terminal archive rejection and draft-to-cancelled-to-archived lifecycle',
      'archived Goal and complete contract persistence across a full Electron restart',
      'restore to the pre-archive terminal status with revision and contract preservation',
      'canonical get and list readback under CAOGEN_PROJECT_WORKSPACE_READ_MODE=canonical'
    ],
    explicitlyNotVerified: [
      'clean release commit binding',
      'remote multi-user concurrency',
      'provider calls, signing, notarization, and release packaging'
    ]
  }
}

let activeRuntime
mkdirSync(runDir, { recursive: true })
mkdirSync(userDataDir, { recursive: true })

try {
  assertBuildInputs()
  copyBuiltApp()

  await runElectronPhase('studio-create-edit-archive', async (page) => {
    await check('Studio creates an isolated ProjectWorkspace for Goal contract acceptance', async () => {
      await waitForValue(async () => page.evaluate(() => {
        const button = document.querySelector('[data-studio-action="create-project-empty"], [data-studio-action="create-project"]')
        if (!(button instanceof HTMLButtonElement) || button.disabled) return false
        button.click()
        return true
      }), Boolean, 30_000, 'waiting for an available Studio create-project action')
      await page.waitForSelector('[data-studio-form="project"]', { visible: true, timeout: 10_000 })
      await replaceValue(page, '[data-studio-form="project"] [name="projectName"]', PROJECT_NAME)
      await page.select('[data-studio-form="project"] [name="projectKind"]', 'software')
      await page.click('[data-studio-form="project"] button[type="submit"]')
      const project = await waitForValue(
        async () => (await canonicalProjects(page)).find((candidate) => candidate.name === PROJECT_NAME),
        Boolean,
        20_000,
        'waiting for Studio-created ProjectWorkspace'
      )
      state.projectId = project.id
      assert(project.status === 'active', `Studio-created project status mismatch: ${project.status}`)
      const templateGoals = await canonicalGoals(page, state.projectId, true)
      assert(templateGoals.length === 1, `software Project template Goal baseline mismatch: ${templateGoals.length}`)
      state.baselineGoalCount = templateGoals.length
      await page.waitForSelector('[data-goal-action="create"]', { visible: true, timeout: 15_000 })
    })

    await check('native HTML required validation blocks an invalid Goal without any canonical write', async () => {
      const before = await canonicalGoals(page, state.projectId, true)
      assert(before.length === state.baselineGoalCount, `template Goal baseline drifted to ${before.length}`)
      await page.click('[data-goal-action="create"]')
      const form = '[data-studio-form="goal"]'
      await page.waitForSelector(form, { visible: true, timeout: 10_000 })
      await replaceValue(page, `${form} [data-goal-field="title"]`, 'Must Not Persist')
      await page.click(`${form} button[type="submit"]`)
      await sleep(300)
      const validity = await page.$eval(form, (element) => {
        const objective = element.querySelector('[data-goal-field="objective"]')
        return {
          formValid: element.checkValidity(),
          objectiveValid: objective?.checkValidity(),
          formVisible: element.getClientRects().length > 0
        }
      })
      assert(validity.formValid === false, 'invalid Goal form unexpectedly reports valid')
      assert(validity.objectiveValid === false, 'required objective did not participate in native validation')
      assert(validity.formVisible === true, 'invalid Goal form closed as if submission succeeded')
      const after = await canonicalGoals(page, state.projectId, true)
      assert(after.length === before.length, `HTML-invalid submission wrote ${after.length - before.length} Goal records`)
      await page.keyboard.press('Escape')
      await page.waitForSelector(form, { hidden: true, timeout: 10_000 })
    })

    await check('main rejects negative budget and zero budget limits without partial records', async () => {
      const negativeId = `goal-negative-budget-${runId}`
      const zeroRunsId = `goal-zero-runs-${runId}`
      const zeroTokensId = `goal-zero-tokens-${runId}`
      const negative = await invokeGoalCreate(page, {
        id: negativeId,
        projectId: state.projectId,
        title: 'Negative budget must fail',
        contract: { objective: 'Reject negative budget', budget: { amount: -0.01, currency: 'CNY', maxRuns: 1 } }
      })
      assert(negative.rejected, 'negative Goal budget unexpectedly succeeded')
      assert(/goal budget amount must be non-negative/.test(negative.message), `negative budget rejection mismatch: ${negative.message}`)

      const zeroRuns = await invokeGoalCreate(page, {
        id: zeroRunsId,
        projectId: state.projectId,
        title: 'Zero runs must fail',
        contract: { objective: 'Reject zero maxRuns', budget: { amount: 1, currency: 'CNY', maxRuns: 0 } }
      })
      assert(zeroRuns.rejected, 'zero maxRuns unexpectedly succeeded')
      assert(/goal budget maxRuns must be greater than zero/.test(zeroRuns.message), `zero maxRuns rejection mismatch: ${zeroRuns.message}`)

      const zeroTokens = await invokeGoalCreate(page, {
        id: zeroTokensId,
        projectId: state.projectId,
        title: 'Zero tokens must fail',
        contract: { objective: 'Reject zero maxTokens', budget: { amount: 1, currency: 'CNY', maxRuns: 1, maxTokens: 0 } }
      })
      assert(zeroTokens.rejected, 'zero maxTokens unexpectedly succeeded')
      assert(/goal budget maxTokens must be greater than zero/.test(zeroTokens.message), `zero maxTokens rejection mismatch: ${zeroTokens.message}`)

      const missing = await page.evaluate(async ({ negativeId, zeroRunsId, zeroTokensId }) => ({
        negative: await window.agentDesk.getProjectGoal(negativeId),
        zeroRuns: await window.agentDesk.getProjectGoal(zeroRunsId),
        zeroTokens: await window.agentDesk.getProjectGoal(zeroTokensId)
      }), { negativeId, zeroRunsId, zeroTokensId })
      assert(!missing.negative && !missing.zeroRuns && !missing.zeroTokens, 'rejected Goal input left a canonical record')
      assert((await canonicalGoals(page, state.projectId, true)).length === state.baselineGoalCount, 'rejected Goal input changed canonical Goal count')
    })

    await check('Studio persists the complete Goal contract through preload and main', async () => {
      await page.click('[data-goal-action="create"]')
      const form = '[data-studio-form="goal"]'
      await page.waitForSelector(form, { visible: true, timeout: 10_000 })
      await fillGoalForm(page, form, CREATED_DRAFT)
      const dueAt = await rendererDueAt(page, CREATED_DRAFT.dueDate)
      await page.click(`${form} button[type="submit"]`)
      const goal = await waitForValue(
        async () => (await canonicalGoals(page, state.projectId, true)).find((candidate) => candidate.title === CREATED_DRAFT.title),
        Boolean,
        20_000,
        'waiting for Studio-created Goal'
      )
      state.goalId = goal.id
      state.originalAcceptanceIds = goal.acceptance.map((item) => item.id)
      assert(goal.revision === 1, `new Goal revision mismatch: ${goal.revision}`)
      assertGoalContract(goal, contractExpectation(CREATED_DRAFT, dueAt), 'created Goal')
      assert(state.originalAcceptanceIds.length === CREATED_DRAFT.acceptance.length, 'created Goal acceptance IDs are missing')
      assert(state.originalAcceptanceIds.every((id) => typeof id === 'string' && id.length > 0), 'created Goal acceptance ID is invalid')
      await page.waitForSelector(form, { hidden: true, timeout: 10_000 })
      await waitForGoalRow(page, state.goalId, 'draft', 1)
    })
  })

  await runElectronPhase('studio-edit-archive', async (page) => {
    await check('Studio edit increments revision and preserves Acceptance identities', async () => {
      await openGoalAction(page, state.goalId, 'edit')
      const form = '[data-studio-form="goal-edit"]'
      await page.waitForSelector(form, { visible: true, timeout: 10_000 })
      await fillGoalForm(page, form, EDITED_DRAFT)
      const dueAt = await rendererDueAt(page, EDITED_DRAFT.dueDate)
      await page.click(`${form} button[type="submit"]`)
      const goal = await waitForGoal(page, state.goalId, (candidate) => candidate.revision === 2, 'waiting for revision 2 after Studio edit')
      state.editedContract = contractExpectation(EDITED_DRAFT, dueAt, state.originalAcceptanceIds)
      assert(goal.title === EDITED_DRAFT.title, `edited Goal title mismatch: ${goal.title}`)
      assertGoalContract(goal, state.editedContract, 'edited Goal')
      assertDeepEqual(goal.acceptance.map((item) => item.id), state.originalAcceptanceIds, 'Studio edit replaced Acceptance identities')
      await page.waitForSelector(form, { hidden: true, timeout: 10_000 })
      await waitForGoalRow(page, state.goalId, 'draft', 2)
      await screenshot(page, '01-edited-goal-contract')
    })

    await check('stale Studio edit fails CAS and cannot overwrite a concurrent canonical update', async () => {
      await openGoalAction(page, state.goalId, 'edit')
      const form = '[data-studio-form="goal-edit"]'
      await page.waitForSelector(form, { visible: true, timeout: 10_000 })
      await replaceValue(page, `${form} [data-goal-field="title"]`, 'Stale Studio overwrite must fail')
      const concurrent = await page.evaluate(async ({ id }) => {
        const current = await window.agentDesk.getProjectGoal(id)
        return window.agentDesk.updateProjectGoal(id, { createdBy: 'goal-contract-concurrent-writer' }, { expectedRevision: current.revision })
      }, { id: state.goalId })
      assert(concurrent.revision === 3, `concurrent Goal update revision mismatch: ${concurrent.revision}`)

      await page.click(`${form} button[type="submit"]`)
      await page.waitForFunction(
        (id) => document.querySelector(`[data-goal-id="${id}"] [data-goal-control-error]`)?.textContent?.includes('stale_revision'),
        { timeout: 15_000 },
        state.goalId
      )
      const errorText = await page.$eval(`[data-goal-id="${state.goalId}"] [data-goal-control-error]`, (element) => element.textContent || '')
      assert(/stale_revision/.test(errorText), `stale revision error is not visible: ${errorText}`)
      const canonical = await canonicalGoal(page, state.goalId)
      assert(canonical.revision === 3, `failed stale edit changed revision: ${canonical.revision}`)
      assert(canonical.title === EDITED_DRAFT.title, `failed stale edit overwrote title: ${canonical.title}`)
      assert(canonical.createdBy === 'goal-contract-concurrent-writer', 'concurrent canonical update was lost')
      assertGoalContract(canonical, state.editedContract, 'Goal after stale edit rejection')
      await screenshot(page, '02-stale-revision-visible')
    })

    await check('non-terminal Goal archive is rejected without status or revision mutation', async () => {
      const rejected = await page.evaluate(async ({ id }) => {
        const current = await window.agentDesk.getProjectGoal(id)
        try {
          await window.agentDesk.archiveProjectGoal(id, { expectedRevision: current.revision })
          return { rejected: false, message: '' }
        } catch (error) {
          return { rejected: true, message: error instanceof Error ? error.message : String(error) }
        }
      }, { id: state.goalId })
      assert(rejected.rejected, 'draft Goal archive unexpectedly succeeded')
      assert(/invalid_transition/.test(rejected.message), `non-terminal archive rejection mismatch: ${rejected.message}`)
      const canonical = await canonicalGoal(page, state.goalId)
      assert(canonical.status === 'draft', `rejected archive changed Goal status: ${canonical.status}`)
      assert(canonical.revision === 3, `rejected archive changed Goal revision: ${canonical.revision}`)

      await page.click('[data-studio-form="goal-edit"] .pws-form-actions button[type="button"]')
      await page.waitForSelector('[data-studio-form="goal-edit"]', { hidden: true, timeout: 10_000 })
      await page.click('[data-studio-action="refresh"]')
      await waitForGoalRow(page, state.goalId, 'draft', 3)
    })

    await check('Studio performs draft to cancelled to archived with canonical revision checks', async () => {
      await openGoalTransition(page, state.goalId, 'cancelled')
      const cancelled = await waitForGoal(page, state.goalId, (candidate) => candidate.status === 'cancelled' && candidate.revision === 4, 'waiting for cancelled Goal')
      assertGoalContract(cancelled, state.editedContract, 'cancelled Goal')
      await waitForGoalRow(page, state.goalId, 'cancelled', 4)

      await openGoalAction(page, state.goalId, 'archive')
      const archived = await waitForGoal(page, state.goalId, (candidate) => candidate.status === 'archived' && candidate.revision === 5, 'waiting for archived Goal')
      assert(archived.archivedFromStatus === 'cancelled', `archivedFromStatus mismatch: ${archived.archivedFromStatus}`)
      assert(Number.isFinite(archived.archivedAt), 'archived Goal is missing archivedAt')
      assertGoalContract(archived, state.editedContract, 'archived Goal')
      state.archivedRevision = archived.revision
      await waitForGoalRow(page, state.goalId, 'archived', state.archivedRevision)

      const defaultList = await canonicalGoals(page, state.projectId, false)
      const inclusiveList = await canonicalGoals(page, state.projectId, true)
      assert(!defaultList.some((goal) => goal.id === state.goalId), 'default canonical Goal list exposed an archived Goal')
      assert(inclusiveList.some((goal) => goal.id === state.goalId), 'includeArchived canonical Goal list omitted the archived Goal')
      await screenshot(page, '03-archived-goal')
    })
  })

  await runElectronPhase('restart-read-restore', async (page) => {
    await check('archived Goal and complete contract survive a full Electron restart', async () => {
      await waitForGoalRow(page, state.goalId, 'archived', state.archivedRevision)
      const canonical = await canonicalGoal(page, state.goalId)
      assert(canonical.status === 'archived', `restart Goal status mismatch: ${canonical.status}`)
      assert(canonical.revision === state.archivedRevision, `restart Goal revision mismatch: ${canonical.revision}`)
      assert(canonical.archivedFromStatus === 'cancelled', `restart archivedFromStatus mismatch: ${canonical.archivedFromStatus}`)
      assertGoalContract(canonical, state.editedContract, 'restarted archived Goal')
      const inclusive = await canonicalGoals(page, state.projectId, true)
      assert(inclusive.some((goal) => goal.id === state.goalId), 'canonical includeArchived list lost Goal after restart')
      assertPersistedGoal(canonical)
      await screenshot(page, '04-archived-after-restart')
    })

    await check('archived Studio row exposes restore only and restores the complete canonical Goal', async () => {
      await expandGoal(page, state.goalId)
      const controls = await page.$eval(`[data-goal-id="${state.goalId}"]`, (row) => ({
        edit: Boolean(row.querySelector('[data-goal-action="edit"]')),
        archive: Boolean(row.querySelector('[data-goal-action="archive"]')),
        restore: Boolean(row.querySelector('[data-goal-action="restore"]')),
        transitions: row.querySelectorAll('[data-goal-transition]').length
      }))
      assert(!controls.edit && !controls.archive && controls.transitions === 0, `archived Goal exposes mutation controls: ${JSON.stringify(controls)}`)
      assert(controls.restore, 'archived Goal does not expose restore')

      await page.click(`[data-goal-id="${state.goalId}"] [data-goal-action="restore"]`)
      const restoredRevision = state.archivedRevision + 1
      const restored = await waitForGoal(page, state.goalId, (candidate) => candidate.status === 'cancelled' && candidate.revision === restoredRevision, 'waiting for restored Goal')
      assert(restored.archivedAt === undefined, 'restored Goal retained archivedAt')
      assert(restored.archivedFromStatus === undefined, 'restored Goal retained archivedFromStatus')
      assertGoalContract(restored, state.editedContract, 'restored Goal')
      await waitForGoalRow(page, state.goalId, 'cancelled', restoredRevision)

      const canonicalDefault = await canonicalGoals(page, state.projectId, false)
      assert(canonicalDefault.some((goal) => goal.id === state.goalId && goal.revision === restoredRevision), 'restored Goal is missing from canonical default list')
      assertPersistedGoal(restored)
      report.finalGoal = {
        id: restored.id,
        status: restored.status,
        revision: restored.revision,
        acceptanceIds: restored.acceptance.map((item) => item.id)
      }
      await screenshot(page, '05-restored-goal')
    })
  })

  report.status = 'pass'
  report.conclusion = 'GOAL-001 required gate passed through production Studio, preload, main IPC, canonical persistence, restart, and restore.'
} catch (error) {
  report.status = 'fail'
  report.error = safeError(error)
  report.conclusion = 'GOAL-001 required gate failed closed.'
} finally {
  if (activeRuntime) await stopRuntime(activeRuntime).catch(() => undefined)
  report.releaseBinding = {
    requirement: report.requirement,
    gate: report.gate,
    packageVersion: report.packageVersion,
    git: gitState(),
    environment: report.environment
  }
  writeReport()
  rmSync(tempRoot, { recursive: true, force: true })
}

if (report.status === 'pass') {
  console.log(`goal contract required ok: ${reportPath}`)
  console.log(`${report.checks.length}/${report.checks.length} checks passed across ${report.phases.length} Electron launches`)
} else {
  console.error(`goal contract required failed: ${report.error || 'unknown failure'}`)
  console.error(`report: ${reportPath}`)
}
process.exit(report.status === 'pass' ? 0 : 1)

async function runElectronPhase(name, execute) {
  const startedAt = Date.now()
  activeRuntime = await launchRuntime(name)
  try {
    await enterStudio(activeRuntime.page)
    await execute(activeRuntime.page)
    report.phases.push({ name, status: 'pass', durationMs: Date.now() - startedAt })
  } catch (error) {
    await screenshot(activeRuntime.page, `failure-${name}`).catch(() => undefined)
    report.phases.push({ name, status: 'fail', durationMs: Date.now() - startedAt, error: safeError(error) })
    throw error
  } finally {
    await stopRuntime(activeRuntime)
    activeRuntime = null
  }
}

async function launchRuntime(phase) {
  const port = await findFreePort(10160)
  const child = spawn(electronBin, [`--remote-debugging-port=${port}`, mainEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CAOGEN_USER_DATA_DIR: userDataDir,
      CAOGEN_MEMORY_DIR: path.join(tempRoot, 'memory'),
      CAOGEN_PROJECT_WORKSPACE_READ_MODE: 'canonical',
      CAOGEN_CHINA_TOOL_CALL_PARITY: '',
      CAOGEN_CHINA_TOOL_CALL_PARITY_REQUIRED: '',
      CAOGEN_CHINA_PARITY_PROVIDERS: '',
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: '',
      APPLE_API_KEY: '',
      APPLE_API_KEY_ID: '',
      APPLE_API_ISSUER: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const output = { stdout: '', stderr: '' }
  child.stdout.on('data', (chunk) => { output.stdout += chunk.toString() })
  child.stderr.on('data', (chunk) => { output.stderr += chunk.toString() })
  try {
    await waitForDebugPort(port, 30_000)
    const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null })
    const page = await waitForValue(
      async () => (await browser.pages()).find((candidate) => !candidate.url().startsWith('devtools://')),
      Boolean,
      30_000,
      'waiting for Electron renderer page'
    )
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') report.warnings.push(`${phase} console ${message.type()}: ${message.text()}`)
    })
    page.on('pageerror', (error) => report.warnings.push(`${phase} pageerror: ${error.message}`))
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 })
    return { browser, child, output, page, phase }
  } catch (error) {
    await terminate(child)
    throw error
  }
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
}

async function enterStudio(page) {
  await page.waitForSelector('.app', { timeout: 30_000 })
  await page.waitForFunction(() => typeof window.agentDesk?.getProjectGoal === 'function', { timeout: 30_000 })
  await page.click('[data-experience-mode-option="studio"]')
  await page.waitForSelector('[data-project-workspace-studio]', { visible: true, timeout: 30_000 })
  await page.waitForFunction(
    () => document.querySelector('[data-project-workspace-studio]')?.getAttribute('aria-busy') === 'false',
    { timeout: 90_000 }
  )
}

async function check(name, execute) {
  const startedAt = Date.now()
  try {
    await execute()
    report.checks.push({ name, status: 'pass', durationMs: Date.now() - startedAt })
  } catch (error) {
    report.checks.push({ name, status: 'fail', durationMs: Date.now() - startedAt, error: safeError(error) })
    throw error
  }
}

async function canonicalProjects(page) {
  return page.evaluate(() => window.agentDesk.listProjectWorkspaces({ includeArchived: true, includeDeleted: true }))
}

async function canonicalGoals(page, projectId, includeArchived) {
  return page.evaluate(
    ({ projectId, includeArchived }) => window.agentDesk.listProjectGoals(projectId, { includeArchived }),
    { projectId, includeArchived }
  )
}

async function canonicalGoal(page, id) {
  return page.evaluate((goalId) => window.agentDesk.getProjectGoal(goalId), id)
}

async function waitForGoal(page, id, predicate, label) {
  return waitForValue(
    () => canonicalGoal(page, id),
    (goal) => Boolean(goal && predicate(goal)),
    20_000,
    label
  )
}

async function waitForGoalRow(page, id, status, revision) {
  await page.waitForFunction(
    ({ id, status, revision }) => {
      const row = document.querySelector(`[data-goal-id="${id}"]`)
      return row?.getAttribute('data-status') === status && Number(row.getAttribute('data-goal-revision')) === revision
    },
    { timeout: 20_000 },
    { id, status, revision }
  )
}

async function expandGoal(page, id) {
  const selector = `[data-goal-id="${id}"]`
  await page.waitForSelector(selector, { visible: true, timeout: 15_000 })
  const open = await page.$eval(selector, (element) => element instanceof HTMLDetailsElement && element.open)
  if (!open) await page.click(`${selector} > summary`)
  await page.waitForFunction((id) => document.querySelector(`[data-goal-id="${id}"]`)?.open === true, { timeout: 5000 }, id)
}

async function openGoalAction(page, id, action) {
  await expandGoal(page, id)
  const selector = `[data-goal-id="${id}"] [data-goal-action="${action}"]`
  await waitForEnabled(page, selector)
  await page.click(selector)
}

async function openGoalTransition(page, id, status) {
  await expandGoal(page, id)
  const selector = `[data-goal-id="${id}"] [data-goal-transition="${status}"]`
  await waitForEnabled(page, selector)
  await page.click(selector)
}

async function waitForEnabled(page, selector) {
  await page.waitForFunction(
    (selector) => {
      const element = document.querySelector(selector)
      return element instanceof HTMLButtonElement && !element.disabled && element.getClientRects().length > 0
    },
    { timeout: 15_000 },
    selector
  )
}

async function fillGoalForm(page, form, draft) {
  await replaceValue(page, `${form} [data-goal-field="title"]`, draft.title)
  await replaceValue(page, `${form} [data-goal-field="objective"]`, draft.objective)
  await replaceValue(page, `${form} [data-goal-field="background"]`, draft.background)
  await replaceValue(page, `${form} [data-goal-field="constraints"]`, draft.constraints.join('\n'))
  await replaceValue(page, `${form} [data-goal-field="success"]`, draft.successCriteria.join('\n'))
  await replaceValue(page, `${form} [data-goal-field="acceptance"]`, draft.acceptance.join('\n'))
  await replaceValue(page, `${form} [data-goal-field="forbidden"]`, draft.forbiddenActions.join('\n'))
  await page.select(`${form} [data-goal-field="risk"]`, draft.riskLevel)
  await replaceValue(page, `${form} [data-goal-field="due"]`, draft.dueDate)
  await replaceValue(page, `${form} [data-goal-field="budget-amount"]`, draft.budgetAmount)
  await replaceValue(page, `${form} [data-goal-field="budget-currency"]`, draft.budgetCurrency)
  await replaceValue(page, `${form} [data-goal-field="budget-runs"]`, draft.budgetRuns)
  await replaceValue(page, `${form} [data-goal-field="budget-tokens"]`, draft.budgetTokens)
}

async function replaceValue(page, selector, value) {
  await page.$eval(selector, (element, nextValue) => {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
    if (setter) setter.call(element, nextValue)
    else element.value = nextValue
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  }, value)
}

async function rendererDueAt(page, date) {
  return page.evaluate((value) => new Date(`${value}T23:59:59`).getTime(), date)
}

async function invokeGoalCreate(page, input) {
  return page.evaluate(async (input) => {
    try {
      const goal = await window.agentDesk.createProjectGoal(input)
      return { rejected: false, message: '', goal }
    } catch (error) {
      return { rejected: true, message: error instanceof Error ? error.message : String(error) }
    }
  }, input)
}

function contractExpectation(draft, dueAt, acceptanceIds = []) {
  return {
    objective: draft.objective,
    background: draft.background,
    constraints: [...draft.constraints],
    successCriteria: [...draft.successCriteria],
    budget: {
      amount: Number(draft.budgetAmount),
      currency: draft.budgetCurrency,
      maxTokens: Number(draft.budgetTokens),
      maxRuns: Number(draft.budgetRuns)
    },
    dueAt,
    riskLevel: draft.riskLevel,
    forbiddenActions: [...draft.forbiddenActions],
    acceptance: draft.acceptance.map((criterion, index) => ({
      id: acceptanceIds[index],
      criterion,
      required: true
    }))
  }
}

function assertGoalContract(goal, expected, label) {
  assert(goal, `${label} is missing`)
  const acceptanceIds = goal.acceptance.map((item) => item.id)
  const expectedWithIds = {
    ...expected,
    acceptance: expected.acceptance.map((item, index) => ({
      id: item.id ?? acceptanceIds[index],
      criterion: item.criterion,
      required: item.required
    }))
  }
  assertDeepEqual(goal.contract, expectedWithIds, `${label} canonical contract mismatch`)
  assertDeepEqual({
    objective: goal.objective,
    background: goal.background,
    constraints: goal.constraints,
    successCriteria: goal.successCriteria,
    budget: goal.budget,
    dueAt: goal.dueAt,
    riskLevel: goal.riskLevel,
    forbiddenActions: goal.forbiddenActions,
    acceptance: goal.acceptance
  }, expectedWithIds, `${label} flattened contract projection mismatch`)
}

function assertPersistedGoal(canonical) {
  const persisted = JSON.parse(readFileSync(path.join(userDataDir, 'project-workspace.json'), 'utf8'))
  const durable = persisted.goals.find((goal) => goal.id === state.goalId)
  assert(durable, 'durable ProjectWorkspace source omitted Goal')
  assert(durable.status === canonical.status, `durable Goal status mismatch: ${durable.status}`)
  assert(durable.revision === canonical.revision, `durable Goal revision mismatch: ${durable.revision}`)
  assertDeepEqual(durable.contract, canonical.contract, 'durable and canonical Goal contracts differ')
}

function assertBuildInputs() {
  assert(existsSync(electronBin), 'Electron binary not found. Run npm install first.')
  for (const entry of ['main/index.js', 'preload/index.js', 'renderer/index.html']) {
    assert(existsSync(path.join(sourceOutDir, entry)), `Built app entry missing: out/${entry}. Run npm run build first.`)
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
  writeFileSync(latestPath, json)
}

function gitState() {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
    const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repoRoot, encoding: 'utf8' }).trim()
    return { commit, worktreeClean: status.length === 0, statusEntryCount: status ? status.split(/\r?\n/).length : 0 }
  } catch {
    return { commit: null, worktreeClean: null }
  }
}

function safeError(error) {
  return error instanceof Error ? error.stack ?? error.message : String(error)
}

function assertDeepEqual(actual, expected, message) {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
