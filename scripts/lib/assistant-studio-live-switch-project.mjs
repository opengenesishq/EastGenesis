export function seedProjectOwnedSession(page, {
  cwd,
  baseUrl,
  projectId,
  goalId,
  workItemId
}) {
  return page.evaluate(async ({ cwd: cwdValue, baseUrl: baseUrlValue, projectId: projectIdValue, goalId: goalIdValue, workItemId: workItemIdValue }) => {
    const project = await window.agentDesk.createProjectWorkspace({
      id: projectIdValue,
      name: 'EXP-003 live switch project',
      kind: 'software'
    })
    const goal = await window.agentDesk.createProjectGoal({
      id: goalIdValue,
      projectId: project.id,
      title: 'Preserve one running session across projections',
      objective: 'Assistant and Studio must keep one runtime identity',
      status: 'planned'
    })
    const workItem = await window.agentDesk.createProjectWorkItem({
      id: workItemIdValue,
      projectId: project.id,
      goalId: goal.id,
      title: 'Run the live projection continuity check',
      type: 'testing',
      status: 'ready'
    })
    const provider = await window.agentDesk.createProvider({
      name: 'Live Switch Mock',
      baseUrl: baseUrlValue,
      token: 'test-only',
      models: ['live-model-primary', 'live-model-backup'],
      openaiProtocol: 'responses'
    })
    return window.agentDesk.createSession({
      cwd: cwdValue,
      workspaceId: project.id,
      goalId: goal.id,
      workItemId: workItem.id,
      engine: 'openai',
      providerId: provider.id,
      model: 'live-model-primary',
      routingScope: 'fixed',
      permissionMode: 'default',
      isolated: false,
      title: 'Live switch session'
    })
  }, { cwd, baseUrl, projectId, goalId, workItemId })
}

export async function clickStudioSurface(page, surface) {
  await page.waitForSelector(`[data-studio-projection-tab="${surface}"]`, { visible: true, timeout: 10_000 })
  await page.click(`[data-studio-projection-tab="${surface}"]`)
  await page.waitForSelector(`#studio-projection-panel-${surface}:not([hidden])`, { visible: true, timeout: 10_000 })
}

export async function waitForApp(page, expectSession) {
  await page.waitForSelector('.app', { timeout: 20_000 })
  await page.waitForFunction(() => typeof window.agentDesk?.createProvider === 'function', { timeout: 15_000 })
  await page.waitForSelector('[data-experience-mode-switcher]', { visible: true, timeout: 15_000 })
  await page.waitForSelector(expectSession ? '.composer-input' : '.welcome-composer-input', { visible: true, timeout: 15_000 })
}
