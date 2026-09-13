import assert from 'node:assert/strict'
import { clickStudioActionWithRetry, setControlledInputWhenStable } from './project-workspace-lifecycle-actions.mjs'
import { waitForValue } from './assistant-studio-ui-e2e-runtime.mjs'

const trigger = '[data-project-workspace-select-trigger]'
const menu = '[data-project-workspace-select-menu]'
const staticProject = '[data-project-workspace-select-static]'

/** Owns the alternate-project fixture and the picker's complete UI contract. */
export async function verifyProjectWorkspacePicker(page) {
  await assertStaticPicker(page)
  const alternative = await createAlternativeProject(page)
  try {
    await waitForAlternativePicker(page, alternative.id)
    for (const viewport of [{ width: 1280, height: 800 }, { width: 960, height: 640 }]) {
      await page.setViewport({ ...viewport, deviceScaleFactor: 1 })
      await page.click(trigger)
      await page.waitForSelector(menu, { visible: true, timeout: 5_000 })
      await assertMenuBounds(page, viewport.width)
      await assertLongNameBounds(page, alternative.id, viewport.width)
      await assertPickerKeyboard(page, viewport.width)
    }
  } finally {
    await page.setViewport({ width: 1320, height: 860, deviceScaleFactor: 1 })
    await page.evaluate(async (projectId) => {
      await window.agentDesk.deleteProjectWorkspace(projectId)
      await window.agentDesk.purgeProjectWorkspace(projectId)
    }, alternative.id)
    await page.click('[data-studio-action="refresh"]')
    await page.waitForSelector(staticProject, { visible: true, timeout: 5_000 })
  }
}

async function assertStaticPicker(page) {
  await page.waitForSelector(staticProject, { visible: true, timeout: 5_000 })
  assert(await page.$(trigger) === null, 'single Project exposed a meaningless picker trigger')
  const singleProjectState = await page.$eval('[data-project-workspace-select]', (select) => ({
    disabled: select.disabled,
    optionCount: select.options.length
  }))
  assert(singleProjectState.disabled && singleProjectState.optionCount === 1,
    `single Project automation bridge is not static: ${JSON.stringify(singleProjectState)}`)
}

async function createAlternativeProject(page) {
  const longProjectName = 'Project picker long name '.repeat(8) + '终点'
  await clickStudioActionWithRetry(page, 'create-project', '[data-studio-form="project"]')
  await setControlledInputWhenStable(page, '[data-studio-form="project"] [name="projectName"]', longProjectName)
  await page.select('[data-studio-form="project"] [name="projectKind"]', 'research')
  await page.click('[data-studio-form="project"] button[type="submit"]')
  const projects = await waitForValue(
    () => page.evaluate(() => window.agentDesk.listProjectWorkspaces({ includeArchived: true, includeDeleted: true })),
    (candidates) => Array.isArray(candidates) && candidates.some((candidate) => candidate.name === longProjectName),
    15_000,
    'waiting for ProjectWorkspace list mutation'
  )
  return projects.find((candidate) => candidate.name === longProjectName)
}

async function waitForAlternativePicker(page, projectId) {
  await page.waitForFunction((id) => {
    const select = document.querySelector('[data-project-workspace-select]')
    return document.querySelector('[data-project-workspace-studio]')?.getAttribute('aria-busy') === 'false' &&
      select instanceof HTMLSelectElement &&
      Array.from(select.options).some((option) => option.value === id)
  }, { timeout: 10_000 }, projectId)
  await page.waitForSelector(trigger, { visible: true, timeout: 5_000 })
  await page.waitForFunction(
    (selector) => document.querySelector('[data-project-workspace-studio]')?.getAttribute('aria-busy') === 'false' &&
      document.querySelector(selector)?.disabled === false,
    { timeout: 10_000 },
    trigger
  )
}

async function assertMenuBounds(page, viewportWidth) {
  const bounds = await page.$eval(menu, (element) => {
    const rect = element.getBoundingClientRect()
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight }
  })
  assert(bounds.left >= 0 && bounds.right <= bounds.viewportWidth,
    `Project picker overflowed horizontally at ${viewportWidth}: ${JSON.stringify(bounds)}`)
  assert(bounds.top >= 0 && bounds.bottom <= bounds.viewportHeight,
    `Project picker overflowed vertically at ${viewportWidth}: ${JSON.stringify(bounds)}`)
}

async function assertLongNameBounds(page, projectId, viewportWidth) {
  const optionLayout = await page.$eval(`${menu} [data-project-workspace-option="${projectId}"]`, (element) => {
    const option = element.getBoundingClientRect()
    const label = element.querySelector('span')?.getBoundingClientRect()
    return { optionRight: option.right, menuRight: element.parentElement?.getBoundingClientRect().right ?? 0, labelRight: label?.right ?? 0, optionScrollWidth: element.scrollWidth, optionClientWidth: element.clientWidth }
  })
  assert(optionLayout.optionRight <= optionLayout.menuRight + 1 &&
    optionLayout.labelRight <= optionLayout.optionRight + 1 &&
    optionLayout.optionScrollWidth <= optionLayout.optionClientWidth + 1,
  `Long project name escaped bounded picker at ${viewportWidth}: ${JSON.stringify(optionLayout)}`)
}

async function assertPickerKeyboard(page, viewportWidth) {
  await page.keyboard.press('End')
  await page.keyboard.press('Home')
  assert(await page.evaluate(() => Boolean(document.activeElement?.getAttribute('data-project-workspace-option'))),
    `Project picker did not move focus to an option at ${viewportWidth}`)
  await page.keyboard.press('Escape')
  await page.waitForSelector(menu, { hidden: true, timeout: 5_000 })
  assert(await page.evaluate(() => document.activeElement?.hasAttribute('data-project-workspace-select-trigger') === true),
    `Project picker did not restore trigger focus at ${viewportWidth}`)
}
