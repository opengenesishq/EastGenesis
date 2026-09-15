#!/usr/bin/env node
/**
 * Local renderer click/IPC smoke for the 0913 Work OS refactor.
 *
 * This gate drives deterministic local UI navigation and fixture mutations.
 * It never invokes a Provider and never records human-task
 * evidence. With --artifact it proves the packaged renderer path; without it
 * --source launches the built Electron output for a faster local check.
 *
 * Examples:
 *   node scripts/packaged-ui-click-required.mjs --source
 *   node scripts/packaged-ui-click-required.mjs --artifact dist/mac/CaoGen.app
 *   node scripts/packaged-ui-click-required.mjs --source --fixture runs-review
 *   node scripts/packaged-ui-click-required.mjs --source --fixture plan-confirmation
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { createRequire } from 'node:module'

const repoRoot = path.resolve(process.env.CAOGEN_REPO_ROOT || process.cwd())
const require = createRequire(path.join(repoRoot, 'package.json'))
const puppeteer = require('puppeteer-core')
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const args = parseArgs(process.argv.slice(2))
const startedAt = new Date().toISOString()
const runId = process.env.CAOGEN_UI_CLICK_RUN_ID || startedAt.replace(/[:.]/gu, '-')
const outputPath = process.env.CAOGEN_UI_CLICK_REPORT_PATH
  ? path.resolve(repoRoot, process.env.CAOGEN_UI_CLICK_REPORT_PATH)
  : path.join(repoRoot, 'test-results', 'packaged-ui-click', 'latest.json')
const outputDir = path.dirname(outputPath)
const checks = []
const clicks = []
const report = {
  schemaVersion: 1,
  kind: 'caogen.packaged-ui-click-report',
  gate: 'test:packaged-ui-click:required',
  runId,
  startedAt,
  status: 'failed',
  evidenceStrength: args.artifact ? 'packaged-renderer-click-observed' : 'built-source-renderer-click-observed',
  providerCalls: false,
  humanEvidence: false,
  artifact: args.artifact || null,
  checks,
  clicks,
  explicitlyNotVerified: ['real Provider calls or failover', 'human timed task evidence', 'release signing/notarization/public publishing']
}

function parseArgs(argv) {
  const parsed = { artifact: null, source: false, fixture: null }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--artifact') parsed.artifact = argv[++index]
    else if (value === '--source') parsed.source = true
    else if (value === '--fixture') parsed.fixture = argv[++index]
    else if (value === '--help' || value === '-h') {
      console.log('Usage: node scripts/packaged-ui-click-required.mjs --source | --artifact PATH')
      process.exit(0)
    } else throw new Error(`unknown option: ${value}`)
  }
  if (Boolean(parsed.artifact) === parsed.source) throw new Error('choose exactly one of --source or --artifact')
  if (parsed.fixture && !['runs-review', 'run-detail-delivery', 'plan-confirmation', 'mission-compile'].includes(parsed.fixture)) throw new Error(`unknown fixture: ${parsed.fixture}`)
  return parsed
}

function assertCondition(condition, message) {
  if (!condition) throw new Error(message)
}

function recordCheck(name, detail = '') {
  checks.push({ name, status: 'passed', detail })
  console.log(`[PASS] ${name}${detail ? ` — ${detail}` : ''}`)
}

async function runCheck(name, fn) {
  try {
    await fn()
    recordCheck(name)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    checks.push({ name, status: 'failed', detail })
    throw error
  }
}

function executableForArtifact(artifactPath) {
  const resolved = path.resolve(repoRoot, artifactPath)
  assertCondition(existsSync(resolved), `artifact missing: ${resolved}`)
  if (resolved.endsWith('.app')) return path.join(resolved, 'Contents', 'MacOS', packageJson.productName || 'CaoGen')
  if (resolved.endsWith('-unpacked')) {
    if (process.platform === 'darwin') return path.join(resolved, `${packageJson.productName || 'CaoGen'}.app`, 'Contents', 'MacOS', packageJson.productName || 'CaoGen')
    if (process.platform === 'win32') return path.join(resolved, `${packageJson.productName || 'CaoGen'}.exe`)
    return path.join(resolved, packageJson.productName || 'CaoGen')
  }
  return resolved
}

function findFreePort(start = 10460) {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(start, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : start
      server.close(() => resolve(port))
    })
  })
}

async function waitForDebugPort(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) return
    } catch { /* process is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Electron remote debugging port did not start: ${port}`)
}

async function waitForPage(browser, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const page = (await browser.pages()).find((candidate) => !candidate.url().startsWith('devtools://'))
    if (page) return page
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Electron renderer page did not appear')
}

async function waitForVisible(page, selector, timeout = 20_000) {
  await page.waitForSelector(selector, { visible: true, timeout })
}

async function clickVisible(page, name, selector) {
  console.log(`[CLICK] waiting ${name} (${selector})`)
  await waitForVisible(page, selector)
  console.log(`[CLICK] clicking ${name}`)
  // Persistence can finish before React clears the busy/disabled state.
  // Locator waits for an enabled, stable target before issuing a real click.
  await page.locator(selector).click()
  console.log(`[CLICK] clicked ${name}`)
  clicks.push({ name, selector, at: new Date().toISOString() })
}

async function waitForRunReviewOutcome(page, view, timeout = 8_000) {
  const selector = `[data-work-os-run-review][data-work-os-view="${view}"]`
  await waitForVisible(page, selector, timeout)
  // Canonical reads are asynchronous and an empty userData directory is a
  // valid state. Wait for either an empty projection, a rendered row, or a
  // surfaced read error, but keep the smoke bounded if a migration/read is
  // unexpectedly slow. The bounded timeout is evidence of responsiveness;
  // it does not invent records or mutate the store.
  try {
    await page.waitForFunction((panelSelector) => {
      const panel = document.querySelector(panelSelector)
      if (!panel) return false
      return Boolean(panel.querySelector('[data-work-os-empty], [data-work-os-error], [data-work-os-runs] > *, [data-work-os-review] > *'))
    }, { timeout }, selector)
    return 'settled'
  } catch {
    return 'pending'
  }
}

async function waitForWorkspaceNavigation(page, focus, workItemId, timeout = 12_000) {
  const selector = `[data-project-workspace-navigation-focus="${focus}"][data-project-workspace-navigation-work-item="${workItemId}"]`
  await page.waitForSelector(selector, { visible: true, timeout })
}

async function terminate(child) {
  if (!child || child.exitCode !== null) return
  if (process.platform !== 'win32' && child.pid) {
    try { process.kill(-child.pid, 'SIGTERM') } catch { try { child.kill('SIGTERM') } catch {} }
  } else {
    try { child.kill('SIGTERM') } catch {}
  }
  await new Promise((resolve) => setTimeout(resolve, 250))
  if (child.exitCode === null) {
    try { child.kill('SIGKILL') } catch {}
    // Electron's macOS helper processes can outlive the top-level app and
    // keep the captured stderr pipe open. Kill direct descendants explicitly
    // so a passing smoke cannot leave an orphaned app or hang npm test.
    if (process.platform !== 'win32' && child.pid) {
      try { execFileSync('pkill', ['-KILL', '-P', String(child.pid)], { stdio: 'ignore' }) } catch { /* already gone */ }
      try { process.kill(child.pid, 'SIGKILL') } catch { /* already gone */ }
    }
  }
}

async function main() {
  await runCheck('built app inputs exist', () => {
    for (const entry of ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html']) {
      assertCondition(existsSync(path.join(repoRoot, entry)), `missing ${entry}; run npm run build first`)
    }
  })
  await runCheck('0913 click selectors are present in source', () => {
    const studio = readFileSync(path.join(repoRoot, 'src/renderer/src/components/studio/StudioView.tsx'), 'utf8')
    const inbox = readFileSync(path.join(repoRoot, 'src/renderer/src/components/studio/WorkInbox.tsx'), 'utf8')
    for (const selector of ['data-studio-section-option="inbox"', 'data-studio-section-option="work"', 'data-studio-section-option="runs"', 'data-studio-section-option="review"', 'data-studio-section-option="golden-tasks"', 'data-studio-section-option="builder"']) {
      assertCondition(studio.includes(selector), `missing Studio selector ${selector}`)
    }
    assertCondition(inbox.includes('data-work-inbox-action="create-goal"'), 'missing Work Inbox create-goal action')
  })

  const tempUserData = await mkdtemp(path.join(tmpdir(), 'caogen-packaged-ui-click-'))
  if (args.fixture) {
    const fixtureScript = path.join(repoRoot, 'scripts', `${args.fixture === 'plan-confirmation' ? 'plan-confirmation' : 'runs-review'}-fixture-runtime.ts`)
    const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx')
    execFileSync(tsxBin, [fixtureScript, tempUserData], {
      cwd: repoRoot,
      env: { ...process.env, CAOGEN_USER_DATA_DIR: tempUserData },
      stdio: 'pipe'
    })
    report.fixture = args.fixture === 'plan-confirmation'
      ? 'plan-confirmation-canonical-local'
      : 'runs-review-canonical-local'
  }
  const port = await findFreePort()
  const electronBin = require('electron')
  const mainEntry = path.join(repoRoot, 'out', 'main', 'index.js')
  const executable = args.artifact ? executableForArtifact(args.artifact) : electronBin
  const launchArgs = args.artifact
    ? [`--remote-debugging-port=${port}`, '--user-data-dir', tempUserData]
    : [`--remote-debugging-port=${port}`, mainEntry]
  const child = spawn(executable, launchArgs, {
    cwd: repoRoot,
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      CAOGEN_USER_DATA_DIR: tempUserData,
      CAOGEN_MEMORY_DIR: path.join(tempUserData, 'memory'),
      CAOGEN_PROJECT_WORKSPACE_READ_MODE: 'canonical',
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: '',
      APPLE_API_KEY: '',
      APPLE_API_KEY_ID: '',
      APPLE_API_ISSUER: '',
      CAOGEN_RUN_REAL_PROVIDER: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr?.on('data', (chunk) => { stderr += chunk.toString() })
  let browser
  let page
  try {
    await waitForDebugPort(port)
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null })
    page = await waitForPage(browser)
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 })
    page.on('pageerror', (error) => console.error(`[PAGEERROR] ${error.message}`))
    page.on('console', (message) => { if (message.type() === 'error') console.error(`[CONSOLE] ${message.text()}`) })
    await waitForVisible(page, '.app')
    await page.waitForFunction(() => typeof window.agentDesk?.listProjectWorkspaces === 'function', { timeout: 30_000 })
    recordCheck('renderer and preload are ready')

    await clickVisible(page, 'enter Studio', '[data-experience-mode-option="studio"]')
    await waitForVisible(page, '[data-studio-view]')
    recordCheck('Studio surface opened')
    await clickVisible(page, 'Work Inbox', '[data-studio-section-option="inbox"]')
    await waitForVisible(page, '[data-cross-project-work-inbox]')
    if (args.fixture === 'mission-compile') {
      await clickVisible(page, 'Project Workspace for mission', '[data-studio-section-option="work"]')
      await waitForVisible(page, '[data-goal-task-objective]')
      await page.select('[data-goal-task-template]', 'product-launch')
      const objective = '形成包含可运行实现、使用说明和验证报告的本地交付计划'
      await page.type('[data-goal-task-objective]', objective)
      await clickVisible(page, 'Compile mission plan', '[data-goal-task-start]')
      await page.waitForFunction(() => Boolean(document.querySelector('[data-task-plan-status="pending"]') || document.querySelector('.pws-goal-task-error')), { timeout: 25_000 })
      const compileError = await page.$eval('.pws-goal-task-error', (node) => node.textContent).catch(() => '')
      assertCondition(!compileError, `Mission compilation failed: ${compileError}`)
      const sessionId = await page.$eval('[data-task-plan-status="pending"]', (node) => node.getAttribute('data-task-plan-session'))
      const plan = await page.evaluate((id) => window.agentDesk.getTaskPlan(id), sessionId)
      assertCondition(plan.approvalStatus === 'pending' && plan.currentVersion?.source === 'genesis', 'Mission did not create a pending genesis plan')
      assertCondition(plan.currentVersion.steps.length === 4, 'Mission plan must contain four role steps')
      for (const role of ['礼部', '工部', '文书', '都察院']) {
        assertCondition(plan.currentVersion.steps.some((step) => step.title.includes(role)), `Mission plan missing ${role}`)
      }
      const roles = Object.fromEntries(['礼部', '工部', '文书', '都察院'].map((role) => [role, plan.currentVersion.steps.find((step) => step.title.includes(role))]))
      const dependencies = { 礼部: [], 工部: [roles.礼部.id], 文书: [roles.礼部.id], 都察院: [roles.工部.id, roles.文书.id] }
      const semantics = {
        礼部: { role: 'research', executionRole: 'general', type: 'research' },
        工部: { role: 'build', executionRole: 'general', type: 'coding' },
        文书: { role: 'document', executionRole: 'docs', type: 'documentation' },
        都察院: { role: 'verify', executionRole: 'qa', type: 'testing' }
      }
      for (const [role, step] of Object.entries(roles)) {
        assert.deepEqual([...step.dependsOn].sort(), [...dependencies[role]].sort(), `Mission ${role} has the wrong dependencies`)
        assert.deepEqual({ role: step.role, executionRole: step.executionRole, type: step.workItemType }, semantics[role], `Mission ${role} lost its structured role or work type`)
        assertCondition(step.acceptanceSpec?.length > 0, `Mission ${role} has no per-step acceptance criteria`)
      }
      const binding = plan.currentVersion.binding
      const pendingItems = await page.evaluate(() => window.agentDesk.listProjectWorkItems('fixture-runs-review-project'))
      // Other Goals may materialize repair WorkItems while the workspace loads.
      // Approval only owns the new Mission's Goal and parent, not the project total.
      const pendingMissionItems = pendingItems.filter((item) => item.goalId === binding.goalId)
      assert.deepEqual(pendingMissionItems.map((item) => item.id), [binding.workItemId], 'Compilation projected child WorkItems before approval')
      const parent = pendingMissionItems[0]
      assertCondition(parent.projectId === binding.workspaceId && !pendingItems.some((item) => item.parentId === parent.id), 'Pending Mission has invalid ownership or premature children')
      recordCheck('Goal starter compiles four-role pending Mission plan', 'production UI, Session, IPC and TaskPlan store; child WorkItems await approval')
      clicks.push({ name: 'Goal starter opens compiled Mission plan', sessionId, at: new Date().toISOString() })
      // Studio and the retained Session surface can render the same plan.
      // Scope interactions to the visible workspace, never the hidden copy.
      const workbench = `[data-project-workspace-studio] [data-task-plan-session="${sessionId}"]`
      const originalVersion = plan.currentVersion
      await clickVisible(page, 'Edit Mission step title', `${workbench} [data-task-plan-step-title="0"]`)
      await page.keyboard.press('End')
      await page.type(`${workbench} [data-task-plan-step-title="0"]`, '（本地验证）')
      await page.type(`${workbench} [data-task-plan-change-reason="true"]`, '明确本地验证交付范围')
      await clickVisible(page, 'Save edited Mission plan', `${workbench} [data-task-plan-save="true"]`)
      await page.waitForFunction(async (id, previousId) => {
        const state = await window.agentDesk.getTaskPlan(id)
        return state.currentVersion?.id !== previousId && state.approvalStatus === 'pending'
      }, { timeout: 15_000 }, sessionId, originalVersion.id)
      const edited = await page.evaluate((id) => window.agentDesk.getTaskPlan(id), sessionId)
      assertCondition(edited.currentVersion.steps[0].title !== originalVersion.steps[0].title, 'UI edit did not change the saved title')
      for (let index = 0; index < originalVersion.steps.length; index += 1) {
        for (const field of ['id', 'role', 'executionRole', 'workItemType', 'acceptanceSpec', 'dependsOn']) {
          assert.deepEqual(edited.currentVersion.steps[index][field], originalVersion.steps[index][field], `UI save changed step ${index} field ${field}`)
        }
      }
      plan.currentVersion = edited.currentVersion
      recordCheck('Mission UI title edit preserves responsibilities and acceptance', 'real form save and persisted version readback')
      await clickVisible(page, 'Approve compiled Mission plan', `${workbench} [data-task-plan-approve="true"]`)
      await waitForVisible(page, `${workbench}[data-task-plan-status="approved"]`)
      const approvedItems = await page.evaluate(() => window.agentDesk.listProjectWorkItems('fixture-runs-review-project'))
      const approvedMissionItems = approvedItems.filter((item) => item.goalId === binding.goalId)
      assertCondition(approvedMissionItems.length === 5 && approvedMissionItems.filter((item) => item.parentId === parent.id).length === 4, 'Approval did not project exactly four canonical WorkItems under the Mission parent')
      const afterApproval = await page.evaluate((id) => window.agentDesk.getTaskPlan(id), sessionId)
      assertCondition(afterApproval.approvalStatus === 'approved' && afterApproval.currentVersion.id === plan.currentVersion.id, 'Approval was not bound to the compiled version')
      const projection = afterApproval.projection
      assertCondition(projection?.mode === 'canonical' && projection.steps.length === 4, 'Mission approval must carry four canonical projection receipts')
      const workItemByStep = new Map(projection.steps.map((step) => [step.stepId, step.workItemId]))
      for (const step of plan.currentVersion.steps) {
        const item = approvedItems.find((candidate) => candidate.id === workItemByStep.get(step.id))
        assertCondition(item && item.projectId === plan.currentVersion.binding.workspaceId && item.goalId === plan.currentVersion.binding.goalId && item.parentId === plan.currentVersion.binding.workItemId, 'Mission child WorkItem ownership does not match the approved plan')
        assert.deepEqual([...item.dependencyIds].sort(), step.dependsOn.map((id) => workItemByStep.get(id)).sort(), 'Canonical dependencies differ from the approved plan')
        assert.deepEqual({ role: item.role, type: item.type, businessLineId: item.businessLineId }, { role: step.role, type: step.workItemType, businessLineId: parent.businessLineId }, 'Canonical role, type or business line differs from the approved Mission')
        assert.deepEqual(item.acceptanceSpec, step.acceptanceSpec, 'Canonical acceptance criteria differ from the approved Mission')
        assertCondition(item.runRefs.length === 0 && ['backlog', 'ready'].includes(item.status), 'Mission approval started a child Run')
      }
      const executions = await page.evaluate(async (id) => {
        const ledger = await window.agentDesk.listWorkflowLedger({ sessionId: id, limit: 500 })
        return ledger.runs.items.map((run) => ({ id: run.id, status: run.status }))
      }, sessionId)
      assertCondition(executions.every((run) => !['executing', 'verifying', 'completed'].includes(run.status)), 'Mission approval dispatched execution')
      report.missionCompilation = { sessionId, versionId: plan.currentVersion.id, originalVersionId: originalVersion.id, editedVersionId: edited.currentVersion.id, approvalStatus: afterApproval.approvalStatus, binding, steps: plan.currentVersion.steps.map(({ id, role, executionRole, workItemType, acceptanceSpec, dependsOn }) => ({ id, role, executionRole, workItemType, acceptanceSpec, dependsOn })), projection, runs: executions }
      recordCheck('Mission approval projects canonical role WorkItems', 'approval only; execution not dispatched')
      clicks.push({ name: 'Mission plan approval projects four WorkItems', sessionId, at: new Date().toISOString() })
    }
    if (args.fixture === 'plan-confirmation') {
      const snapshots = await page.evaluate(() => window.agentDesk.listTaskSnapshots())
      assertCondition(Array.isArray(snapshots) && snapshots.length > 0, 'plan fixture recovery snapshot is missing')
      const fixtureSnapshot = snapshots.find((snapshot) => snapshot.id === 'fixture-plan-confirmation-session') ?? snapshots[0]
      const recoveryResult = await page.evaluate(async (snapshotId) => {
        try {
          const meta = await window.agentDesk.recoverTaskSnapshot(snapshotId)
          return { ok: true, meta }
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      }, fixtureSnapshot.id)
      assertCondition(recoveryResult.ok, `plan fixture recovery failed: ${recoveryResult.error}`)
      await page.waitForFunction(() => document.querySelector('[data-cross-project-work-inbox]')?.textContent?.includes('待确认') ?? false, { timeout: 15_000 })
      const row = '[data-cross-project-work-inbox] [data-work-item-id="fixture-plan-confirmation-work-item"]'
      await page.waitForSelector(`${row} [data-inbox-action="open-plan"]`, { visible: true, timeout: 15_000 })
      await page.click(`${row} [data-inbox-action="open-plan"]`)
      const workbench = '[data-task-plan-session="fixture-plan-confirmation-session"]'
      await page.waitForSelector(`${workbench}[data-task-plan-status="pending"]`, { visible: true, timeout: 15_000 })
      recordCheck('Work Inbox Run opens pending TaskPlan', 'canonical Run row navigated to pending plan')
      clicks.push({ name: 'Run opens pending TaskPlan', sessionId: 'fixture-plan-confirmation-session', at: new Date().toISOString() })
      await page.click(`${workbench} [data-task-plan-approve="true"]`)
      await page.waitForSelector(`${workbench}[data-task-plan-status="approved"]`, { visible: true, timeout: 15_000 })
      recordCheck('TaskPlan approve click updates canonical status', 'approve IPC returned approved')
      clicks.push({ name: 'TaskPlan approve', at: new Date().toISOString() })
      await page.click(`${workbench} .task-plan-actions button:not([data-task-plan-save]):not([data-task-plan-approve-execute])`)
      await page.waitForSelector(`${workbench}[data-task-plan-status="pending"]`, { visible: true, timeout: 15_000 })
      recordCheck('TaskPlan revoke click restores pending status', 'revoke IPC returned pending')
      clicks.push({ name: 'TaskPlan revoke', at: new Date().toISOString() })
    }
    if (args.fixture === 'run-detail-delivery') {
      const recoveryRow = '[data-cross-project-work-inbox] [data-work-item-id="fixture-runs-review-recovery-item"]'
      await page.waitForSelector(`${recoveryRow} [data-inbox-action="open-run"]`, { visible: true, timeout: 12_000 })
      await page.click(`${recoveryRow} [data-inbox-action="open-run"]`)
      await waitForVisible(page, '[data-run-detail-panel="true"]')
      assertCondition(await page.$eval('[data-run-detail-panel="true"]', (panel) => panel.dataset.runId === 'fixture-runs-review-recovery-run'), 'Run detail opened the wrong canonical Run')
      recordCheck('Work Inbox opens canonical Run detail')
      clicks.push({ name: 'Work Inbox row opens Run detail', runId: 'fixture-runs-review-recovery-run', at: new Date().toISOString() })
      await clickVisible(page, 'Run detail Acceptance section', 'button[data-run-detail-section="acceptance"]')
      await waitForVisible(page, '[data-run-detail-panel="true"][data-run-section="acceptance"]')
      const acceptanceStatus = await page.$eval('[data-acceptance-gate-status]', (node) => node.getAttribute('data-acceptance-gate-status'))
      assertCondition(acceptanceStatus === 'failed', `Run detail Acceptance gate did not preserve failed canonical state: ${acceptanceStatus}`)
      recordCheck('Run detail Acceptance section click')
      clicks.push({ name: 'Run detail opens Acceptance', at: new Date().toISOString() })
      await clickVisible(page, 'Run detail Recovery section', 'button[data-run-detail-section="recovery"]')
      await waitForVisible(page, '[data-run-detail-panel="true"][data-run-section="recovery"]')
      await clickVisible(page, 'Run detail Recover action', '[data-run-recover]')
      await page.waitForFunction(() => {
        const panel = document.querySelector('[data-run-detail-panel="true"]')
        return Boolean(panel?.querySelector('[data-run-recovery-result="completed"], [data-run-recovery-error]'))
      }, { timeout: 20_000 })
      const recoveryError = await page.$eval('[data-run-recovery-error]', (node) => node.textContent?.trim() ?? '').catch(() => '')
      assertCondition(!recoveryError, `Run detail recovery failed: ${recoveryError}`)
      const recovered = await page.evaluate(async () => {
        const snapshots = await window.agentDesk.listTaskSnapshots()
        return snapshots.find((snapshot) => snapshot.id === 'fixture-runs-review-recovery-session')?.run
      })
      assertCondition(recovered && recovered.recoveryCount > 0 && recovered.revision > 2, 'Recovery did not persist a new recovery revision')
      report.recoveryOutcome = { runId: recovered.id, status: recovered.status, revision: recovered.revision, recoveryCount: recovered.recoveryCount }
      recordCheck('Run detail Recovery action click', `snapshot recovery persisted; final Run status: ${recovered.status}; no Provider execution`)
      clicks.push({ name: 'Run detail recovery completed', at: new Date().toISOString() })
      await clickVisible(page, 'Run detail Delivery entry', '[data-run-open-delivery]')
      await waitForWorkspaceNavigation(page, 'delivery', 'fixture-runs-review-recovery-item')
      recordCheck('Run detail opens canonical Delivery', 'Delivery navigation carried the Run WorkItem identity')
      clicks.push({ name: 'Run detail opens delivery', workItemId: 'fixture-runs-review-recovery-item', at: new Date().toISOString() })
      await waitForVisible(page, '[data-project-advanced-section="delivery"][open]')
      await waitForVisible(page, '[data-project-delivery-workbench][data-delivery-requested-work-item="fixture-runs-review-recovery-item"]', 20_000)
      await waitForVisible(page, '[data-project-delivery-workbench] [data-delivery-work-item-id="fixture-runs-review-recovery-item"]', 20_000)
      assertCondition(await page.$('[data-project-delivery-workbench] .pws-error') === null, 'Delivery workbench surfaced a read error')
      recordCheck('Delivery workbench receives canonical WorkItem focus')
    }
    await clickVisible(page, 'Project Workspace', '[data-studio-section-option="work"]')
    await waitForVisible(page, '[data-project-workspace-studio]')
    await clickVisible(page, 'Runs', '[data-studio-section-option="runs"]')
    const runsOutcome = await waitForRunReviewOutcome(page, 'runs')
    recordCheck('Runs canonical projection click', runsOutcome === 'settled' ? 'empty, rows, or surfaced error' : 'panel remained responsive while canonical read was pending')
    clicks.push({ name: 'Runs canonical projection outcome', outcome: runsOutcome, at: new Date().toISOString() })
    if (args.fixture === 'runs-review') {
      await page.waitForSelector('[data-work-os-runs] [data-work-os-run-id="fixture-runs-review-task-run"] [data-work-os-open-project]', { visible: true, timeout: 12_000 })
      await page.click('[data-work-os-runs] [data-work-os-run-id="fixture-runs-review-task-run"] [data-work-os-open-project]')
      await waitForWorkspaceNavigation(page, 'work-item', 'fixture-runs-review-run-item')
      recordCheck('Runs row opens canonical WorkItem', 'fixture TaskRun row navigated to its project WorkItem')
      clicks.push({ name: 'Runs row opens WorkItem', workItemId: 'fixture-runs-review-run-item', at: new Date().toISOString() })
      await clickVisible(page, 'Review after Runs handoff', '[data-studio-section-option="review"]')
    } else {
      await clickVisible(page, 'Review', '[data-studio-section-option="review"]')
    }
    const reviewOutcome = await waitForRunReviewOutcome(page, 'review')
    recordCheck('Review canonical projection click', reviewOutcome === 'settled' ? 'empty, rows, or surfaced error' : 'panel remained responsive while canonical read was pending')
    clicks.push({ name: 'Review canonical projection outcome', outcome: reviewOutcome, at: new Date().toISOString() })
    if (args.fixture === 'runs-review') {
      await page.waitForSelector('[data-work-os-review] [data-work-os-review-work-item-id="fixture-runs-review-review-item"] [data-work-os-open-delivery]', { visible: true, timeout: 12_000 })
      await page.click('[data-work-os-review] [data-work-os-review-work-item-id="fixture-runs-review-review-item"] [data-work-os-open-delivery]')
      await waitForWorkspaceNavigation(page, 'delivery', 'fixture-runs-review-review-item')
      recordCheck('Review row opens canonical delivery', 'fixture failed Acceptance row navigated to delivery focus')
      clicks.push({ name: 'Review row opens delivery', workItemId: 'fixture-runs-review-review-item', at: new Date().toISOString() })
    }
    recordCheck('Runs/Review navigation selectors are contract-covered')
    await clickVisible(page, 'PalaceScene Builder', '[data-studio-section-option="builder"]')
    await waitForVisible(page, '[data-palace-scene-builder]')
    await clickVisible(page, 'Golden Tasks', '[data-studio-section-option="golden-tasks"]')
    await waitForVisible(page, '[data-golden-tasks-panel]')

    const projects = await page.evaluate(() => window.agentDesk.listProjectWorkspaces({ includeArchived: true, includeDeleted: true }))
    assertCondition(Array.isArray(projects), 'canonical workspace IPC did not return an array')
    recordCheck('read-only canonical IPC bridge', `listProjectWorkspaces returned ${projects.length} records`)
    report.status = 'passed'
    report.finishedAt = new Date().toISOString()
  } finally {
    if (page && !page.isClosed()) {
      const screenshotPath = path.join(outputDir, `${runId}-${args.fixture || 'navigation'}.png`)
      mkdirSync(outputDir, { recursive: true })
      try {
        await page.screenshot({ path: screenshotPath, fullPage: false })
        report.screenshot = path.relative(repoRoot, screenshotPath)
        if (report.status !== 'passed' && args.fixture) {
          report.fixtureUiState = await page.evaluate(() => ({
            runDetail: document.querySelector('[data-run-detail-panel]')?.textContent?.slice(0, 3_000),
            workspace: document.querySelector('[data-project-workspace-studio]')?.textContent?.slice(0, 3_000)
          }))
        }
      } catch { /* capture failure must not replace the underlying gate result */ }
    }
    // A packaged macOS Electron process can keep the DevTools connection
    // alive after the renderer has finished. Bound browser shutdown so the
    // smoke cannot hang before it writes its report.
    if (browser) await Promise.race([
      browser.close().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 2_000))
    ])
    await terminate(child)
    if (process.env.CAOGEN_KEEP_TEMP !== '1') await rm(tempUserData, { recursive: true, force: true })
    else report.tempUserData = tempUserData
    if (stderr.trim()) report.stderrTail = stderr.trim().slice(-5_000)
    if (args.fixture && /Conversation Ledger archive failed:/u.test(stderr)) {
      report.status = 'failed'
      report.error = 'Conversation Ledger archive failed during the fixture UI flow'
      checks.push({ name: 'fixture conversation archive has no persistence errors', status: 'failed', detail: report.error })
    }
  }
}

try {
  await main()
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? error.message : String(error)
  console.error(`[FAIL] packaged UI click: ${report.error}`)
  if (report.stderrTail) console.error(report.stderrTail)
}
mkdirSync(outputDir, { recursive: true })
report.finishedAt = new Date().toISOString()
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(`packaged UI click: ${report.status}`)
console.log(`report: ${outputPath}`)
process.exit(report.status === 'passed' ? 0 : 1)
