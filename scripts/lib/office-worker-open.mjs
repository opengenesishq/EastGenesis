const OPEN_TARGET_KINDS = new Set(['approval', 'failure', 'task', 'session'])

export async function readVisibleOfficeWorkerMapping(page) {
  const target = await page.evaluate(() => {
    const wrap = document.querySelector('.office-canvas-wrap')
    const panel = document.querySelector('.office-selection-panel')
    return {
      visible: JSON.parse(wrap?.getAttribute('data-office-visible-session-ids') || '[]'),
      workstations: JSON.parse(wrap?.getAttribute('data-office-workstation-hit-targets') || '[]'),
      selected: wrap?.getAttribute('data-office-selected-session') ?? '',
      targetKind: panel?.getAttribute('data-office-open-target-kind') ?? '',
      currentTask: panel?.getAttribute('data-office-current-task-id') ?? '',
      openButton: Boolean(panel?.querySelector('[data-office-open-session]'))
    }
  })
  assert(target.visible.length > 0, `expected visible Office workers: ${JSON.stringify(target)}`)
  assert(target.visible.length === target.workstations.length, `worker/workstation count mismatch: ${JSON.stringify(target)}`)
  assert(target.visible.every((id) => target.workstations.some((item) => item.id === id)), `orphan workstation target: ${JSON.stringify(target)}`)
  assert(target.selected && target.visible.includes(target.selected), `selected worker is not visible: ${JSON.stringify(target)}`)
  assert(OPEN_TARGET_KINDS.has(target.targetKind), `invalid Office open target kind: ${JSON.stringify(target)}`)
  assert(target.openButton, `selected worker has no open-session action: ${JSON.stringify(target)}`)
  return target
}

export async function waitForOfficeSceneReady(page, waitForRenderLoop) {
  await page.waitForFunction(
    () => document.querySelector('.office-canvas-wrap')?.getAttribute('data-office-scene-assets-ready') === '1',
    { timeout: 20_000 }
  )
  await waitForRenderLoop(page, 15_000)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
