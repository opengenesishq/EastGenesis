export async function dismissRecoveryCenter(page) {
  const drawerPresent = await page.$('.task-recovery-drawer-close')
  if (!drawerPresent) {
    const drawerMounted = await page.$('.task-recovery-drawer')
    // Recovery state may exist in the ledger before the renderer mounts its
    // drawer. There is no visible surface to dismiss in that state; the next
    // navigation owns whether the drawer is projected.
    if (!drawerMounted) return
    const hasWorkflowAttention = await page.evaluate(async () => {
      const [workItems, supervisorRuns] = await Promise.all([
        window.agentDesk.listProjectWorkItems(undefined, { includeArchived: true }),
        window.agentDesk.listSupervisorRuns()
      ])
      const attentionStatuses = new Set(['running', 'waiting_approval', 'blocked', 'verifying', 'failed'])
      return workItems.some((item) => attentionStatuses.has(item.status) || item.acceptance?.status === 'failed') ||
        supervisorRuns.some((run) => ['waiting_approval', 'waiting_reconciliation', 'blocked', 'failed'].includes(run.status))
    })
    if (!hasWorkflowAttention) return
  }
  try {
    await page.waitForSelector('.task-recovery-drawer-close', { visible: true, timeout: 15_000 })
    await page.waitForFunction(() => !document.querySelector('.task-recovery-drawer-close')?.disabled, { timeout: 15_000 })
    await page.$eval('.task-recovery-drawer-close', (button) => button.click())
    await page.waitForFunction(() => !document.querySelector('.task-recovery-drawer'), { timeout: 5_000 })
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      drawerPresent: Boolean(document.querySelector('.task-recovery-drawer')),
      drawerVisible: Boolean(document.querySelector('.task-recovery-drawer')?.getClientRects().length),
      closeDisabled: document.querySelector('.task-recovery-drawer-close')?.disabled ?? null,
      loading: Array.from(document.querySelectorAll('.task-recovery-meta')).map((node) => node.textContent?.trim()),
      attention: document.querySelector('.task-recovery-attention')?.textContent?.trim() || ''
    }))
    throw new Error(`dismissRecoveryCenter failed: ${JSON.stringify(diagnostics)}`, { cause: error })
  }
}
