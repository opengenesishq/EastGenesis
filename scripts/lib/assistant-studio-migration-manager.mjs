import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

export async function verifyMigrationManager(context) {
  const preview = await scanMigrationPreview(context)
  verifyMigrationPreview(context, preview)
  await verifyMigrationResponsiveLayout(context)
  await applySelectedMigration(context)
  await rollbackSelectedMigration(context)
  await verifyMigrationOperationsSettled(context)
  await closeMigrationManager(context)
}

async function scanMigrationPreview({ assert, secretCanary, setFieldValue, targetPage, targetProject, sleep }) {
  await targetPage.click('[data-sidebar-action="settings"]')
  await targetPage.waitForSelector('[data-settings-tab="migrate"]', { visible: true, timeout: 10_000 })
  await targetPage.click('[data-settings-tab="migrate"]')
  await targetPage.waitForSelector('[data-migration-manager]', { visible: true, timeout: 5_000 })
  await sleep(100)
  await setFieldValue(targetPage, '[data-migration-manager] input', '')
  await targetPage.click('[data-migration-scan]')
  await targetPage.waitForSelector('[data-migration-mode="conversation"]', { visible: true, timeout: 10_000 })
  const conversation = await targetPage.evaluate(readConversationMigrationState)
  assert(conversation.directory === '', `conversation migration required a project path: ${JSON.stringify(conversation)}`)
  assert(conversation.rows > 0, `conversation migration found no user assets: ${JSON.stringify(conversation)}`)
  assert(conversation.selected === 0, `user-scoped assets were selected by default: ${JSON.stringify(conversation)}`)
  await setFieldValue(targetPage, '[data-migration-manager] input', targetProject)
  await targetPage.click('[data-migration-scan]')
  await targetPage.waitForSelector('[data-migration-mode="project"]', { visible: true, timeout: 10_000 })
  await targetPage.waitForSelector('[data-migration-asset]', { visible: true, timeout: 10_000 })
  return targetPage.evaluate(readProjectMigrationState, secretCanary)
}

function readConversationMigrationState() {
  return {
    directory: document.querySelector('[data-migration-manager] input')?.value,
    rows: document.querySelectorAll('[data-migration-asset]').length,
    selected: [...document.querySelectorAll('[data-migration-asset] input')].filter((input) => input.checked).length
  }
}

function readProjectMigrationState(canary) {
  const rows = [...document.querySelectorAll('[data-migration-asset]')].map((row) => ({
    kind: row.getAttribute('data-migration-kind'),
    risk: row.getAttribute('data-migration-risk'),
    checked: row.querySelector('input')?.checked,
    disabled: row.querySelector('input')?.disabled
  }))
  return {
    rows,
    leaked: document.querySelector('[data-migration-manager]')?.textContent?.includes(canary) === true
  }
}

function verifyMigrationPreview({ assert }, state) {
  assert(!state.leaked, 'migration preview exposed the credential canary')
  assert(state.rows.some((row) => row.kind === 'rules' && row.risk === 'low' && row.checked),
    `safe rule was not selected by default: ${JSON.stringify(state.rows)}`)
  assert(state.rows.some((row) => row.kind === 'mcp' && row.risk === 'review' && !row.checked),
    `credential-bearing MCP was selected by default: ${JSON.stringify(state.rows)}`)
}

async function verifyMigrationResponsiveLayout({ assert, captureScreenshot, sleep, targetPage }) {
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 960, height: 640 }
  ]) {
    await targetPage.setViewport({ ...viewport, deviceScaleFactor: 1 })
    await sleep(150)
    const layout = await readMigrationLayout(targetPage)
    assert(layout.documentOverflow <= 1, `migration ${viewport.width}: document overflow ${layout.documentOverflow}px`)
    assert(layout.managerInsideViewport, `migration ${viewport.width}: manager outside viewport ${JSON.stringify(layout)}`)
    assert(layout.visibleOffenders.length === 0, `migration ${viewport.width}: ${JSON.stringify(layout.visibleOffenders)}`)
    await captureScreenshot(targetPage, `migration-manager-${viewport.width}x${viewport.height}`)
  }
  await targetPage.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 })
}

async function applySelectedMigration({ assert, targetPage, targetProject }) {
  await targetPage.click('[data-migration-apply]')
  await targetPage.waitForSelector('[data-migration-rollback]', { visible: true, timeout: 30_000 })
  await targetPage.waitForFunction(() => {
    const button = document.querySelector('[data-migration-rollback]')
    return button instanceof HTMLButtonElement && !button.disabled
  }, { timeout: 30_000 })
  assert(existsSync(path.join(targetProject, 'caogen.md')), 'selected project rule was not imported')
  assert(!existsSync(path.join(targetProject, '.caogen', 'mcp', 'mcp.json')), 'unselected MCP was imported')
}

async function rollbackSelectedMigration({ targetPage, targetProject, waitForValue }) {
  await targetPage.click('[data-migration-rollback]')
  await targetPage.waitForSelector('[data-migration-rollback-confirm]', { visible: true, timeout: 30_000 })
  await targetPage.click('[data-migration-rollback-confirm]')
  try {
    await targetPage.waitForSelector('[data-migration-rollback]', { hidden: true, timeout: 30_000 })
  } catch (error) {
    const state = await targetPage.evaluate(async () => ({
      buttonDisabled: document.querySelector('[data-migration-rollback]')?.disabled,
      message: document.querySelector('[data-migration-result]')?.textContent?.trim() ?? '',
      operations: (await window.agentDesk.listTaskSnapshots())
        .filter((snapshot) => snapshot.run?.operation)
        .map((snapshot) => ({
          id: snapshot.id,
          status: snapshot.run?.status,
          kind: snapshot.run?.operation?.kind,
          effects: snapshot.run?.effects?.map((effect) => ({
            status: effect.status,
            targetKind: effect.target.kind
          })) ?? []
        }))
    }))
    throw new Error(`migration rollback did not settle: ${JSON.stringify(state)}; ${error instanceof Error ? error.message : String(error)}`)
  }
  await waitForValue(
    async () => !existsSync(path.join(targetProject, 'caogen.md')),
    Boolean,
    30_000,
    'waiting for migration rollback'
  )
}

async function verifyMigrationOperationsSettled({ assert, targetPage, userDataDir, waitForValue }) {
  const operationSnapshots = await waitForValue(
    () => targetPage.evaluate(() => window.agentDesk.listTaskSnapshots()
      .then((snapshots) => snapshots.filter((snapshot) => snapshot.run?.operation))),
    (snapshots) => snapshots.length === 0,
    10_000,
    'waiting for migration operation snapshots to settle'
  )
  assert(operationSnapshots.length === 0, 'migration left operation recovery snapshots')
  const settledSystemOperations = await targetPage.evaluate(async () => ({
    goals: await window.agentDesk.listProjectGoals('caogen-managed-personal-workspace', { includeArchived: true }),
    workItems: await window.agentDesk.listProjectWorkItems('caogen-managed-personal-workspace', { includeArchived: true })
  }))
  const migrationGoals = settledSystemOperations.goals.filter((goal) => goal.objective.includes('外部 Agent'))
  const migrationWorkItems = settledSystemOperations.workItems.filter((workItem) => workItem.description.includes('外部 Agent'))
  assert(migrationGoals.length === 2 && migrationGoals.every((goal) => goal.status === 'completed'),
    `migration Goals did not settle: ${JSON.stringify(migrationGoals)}`)
  assert(migrationWorkItems.length === 2 && migrationWorkItems.every((workItem) => workItem.status === 'done'),
    `migration WorkItems did not settle: ${JSON.stringify(migrationWorkItems)}`)
  verifyCanonicalOperationWriteBudget(assert, userDataDir, migrationGoals, migrationWorkItems)
}

function verifyCanonicalOperationWriteBudget(assert, userDataDir, goals, workItems) {
  const journalRoot = path.join(
    userDataDir,
    'project-workspace-ledger-shadow',
    'canonical-journals'
  )
  const journals = readdirSync(journalRoot)
    .filter((name) => name.endsWith('.json') && !name.endsWith('.state.json'))
    .map((name) => JSON.parse(readFileSync(path.join(journalRoot, name), 'utf8')))
  for (const goal of goals) {
    const workItem = workItems.find((candidate) => candidate.goalId === goal.id)
    assert(workItem, `migration Goal has no owned WorkItem: ${goal.id}`)
    const writes = journals
      .filter((journal) => journal.mutation?.entityId === goal.id || journal.mutation?.entityId === workItem.id)
      .sort((left, right) => left.createdAt - right.createdAt)
    assert(writes.length === 12,
      `migration system operation exceeded canonical write budget: ${goal.id}:${writes.length}`)
    assert(writes[0]?.mutation?.command === 'goal.create' && writes[1]?.mutation?.command === 'work_item.create',
      `migration system operation creation order changed: ${JSON.stringify(writes.map((item) => item.mutation?.command))}`)
    assert(writes[2]?.mutation?.command === 'work_item.lease.acquire',
      `migration WorkItem owner was not persisted at creation: ${JSON.stringify(writes.map((item) => item.mutation?.command))}`)
  }
}

async function closeMigrationManager({ assert, targetPage }) {
  await targetPage.click('.settings-page-back')
  await targetPage.waitForSelector('.composer-input', { visible: true, timeout: 10_000 })
  const recoveryDrawer = await targetPage.$('.task-recovery-drawer')
  if (!recoveryDrawer) return
  const recoveryText = await targetPage.$eval('.task-recovery-drawer', (element) => element.textContent ?? '')
  assert(!recoveryText.includes('外部 Agent 迁移'), `migration remained in recovery: ${recoveryText}`)
  await targetPage.waitForFunction(() => !document.querySelector('.task-recovery-drawer-close')?.disabled, { timeout: 15_000 })
  await targetPage.$eval('.task-recovery-drawer-close', (button) => button.click())
  await targetPage.waitForFunction(() => !document.querySelector('.task-recovery-drawer'), { timeout: 5_000 })
}

async function readMigrationLayout(targetPage) {
  return targetPage.evaluate(() => {
    const manager = document.querySelector('[data-migration-manager]')
    const managerRect = manager?.getBoundingClientRect()
    const visibleOffenders = [...(manager?.querySelectorAll('*') ?? [])].flatMap((element) => {
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      if (style.display === 'none' || style.visibility === 'hidden' || rect.width === 0 || rect.height === 0) return []
      const overflow = Math.max(0, rect.right - innerWidth, -rect.left)
      return overflow > 1 ? [{ tag: element.tagName, className: element.className, overflow }] : []
    }).slice(0, 10)
    return {
      documentOverflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
      managerInsideViewport: Boolean(managerRect && managerRect.left >= -1 && managerRect.right <= innerWidth + 1),
      visibleOffenders
    }
  })
}
