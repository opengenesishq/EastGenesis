import assert from 'node:assert/strict'

export async function dismissRecoveryDrawer(page, required = false) {
  if (required) await page.waitForSelector('.task-recovery-drawer', { visible: true, timeout: 20000 })
  if (!await page.$('.task-recovery-drawer')) return
  await page.waitForFunction(() => !document.querySelector('.task-recovery-drawer-close')?.disabled, { timeout: 15000 })
  const close = await page.$('.task-recovery-drawer-close')
  await clickUncovered(close, 'recovery drawer close')
  await page.waitForSelector('.task-recovery-drawer', { hidden: true, timeout: 10000 })
}

/** Current Session + its unique exact tool input identify this fixture’s card; the durable requestId proves the response. */
export async function approveOriginalPermission({ page, session, until }) {
  await page.waitForSelector(`.session-card.active[data-session-id="${session.id}"]`, { visible: true, timeout: 15000 })
  await dismissRecoveryDrawer(page)
  const entries = await page.evaluate((id) => window.agentDesk.getTranscript(id), session.id)
  const resolved = new Set(entries.filter((entry) => entry.event.kind === 'permission-resolved').map((entry) => entry.event.requestId))
  const requests = entries.filter((entry) => entry.event.kind === 'permission-request' && !resolved.has(entry.event.request.requestId)).map((entry) => entry.event.request)
  assert.equal(requests.length, 1, 'Fixture must approve one identified original request in this Session')
  const request = requests[0]
  await page.waitForSelector('.permission-card', { visible: true })
  const matches = []
  for (const card of await page.$$('.permission-card')) {
    const matchesInput = await card.evaluate((node, request) => {
      if (!node.getClientRects().length || node.querySelector('.permission-title code')?.textContent !== request.toolName) return false
      try { return JSON.stringify(JSON.parse(node.querySelector('.permission-detail')?.textContent ?? '')) === JSON.stringify(request.input) } catch { return false }
    }, request)
    if (matchesInput) matches.push(card)
  }
  assert.equal(matches.length, 1, `Visible approval must match the exact original input for request ${request.requestId}`)
  const allow = await matches[0].$('.permission-actions .btn-primary')
  await clickUncovered(allow, `allow ${session.id}/${request.requestId}`)
  await until(() => page.evaluate((id) => window.agentDesk.getTranscript(id), session.id),
    (items) => items.some((entry) => entry.event.kind === 'permission-resolved' && entry.event.requestId === request.requestId && entry.event.behavior === 'allow'),
    15000, `exact permission resolved ${session.id}/${request.requestId}`)
  return { sessionId: session.id, requestId: request.requestId, toolUseId: request.toolUseId, input: request.input }
}

async function clickUncovered(button, label) {
  assert(button, `Missing real button: ${label}`)
  await button.evaluate((node) => node.scrollIntoView({ block: 'center', inline: 'center' }))
  const hit = await button.evaluate((node) => {
    const rect = node.getBoundingClientRect(), top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
    return { enabled: !node.disabled, uncovered: top === node || node.contains(top), top: top?.outerHTML.slice(0, 400) }
  })
  assert(hit.enabled && hit.uncovered, `Button is disabled or covered (${label}): ${JSON.stringify(hit)}`)
  await button.click()
}
