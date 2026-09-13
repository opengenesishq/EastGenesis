export async function setControlledInputWhenStable(page, selector, value) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.waitForFunction((candidate) => {
      const root = document.querySelector('[data-project-workspace-studio]')
      return root?.getAttribute('aria-busy') === 'false' && document.querySelector(candidate) !== null
    }, { timeout: 20_000 }, selector)
    try {
      await page.$eval(selector, (input, nextValue) => {
        const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
        if (!setter) throw new Error('controlled input value setter is unavailable')
        setter.call(input, nextValue)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }, value)
      await page.waitForFunction(({ candidate, expected }) => {
        const root = document.querySelector('[data-project-workspace-studio]')
        const input = document.querySelector(candidate)
        return root?.getAttribute('aria-busy') === 'false' && input?.value === expected
      }, { timeout: 2_000 }, { candidate: selector, expected: value })
      return
    } catch (error) {
      if (attempt === 3) throw error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
}

export async function clickProjectResourceAdd(page) {
  await openProjectDetails(page)
  const selector = '[data-project-action="add-resource"], [data-project-action="add-resource-inline"]'
  await page.waitForFunction(
    (candidate) => Array.from(document.querySelectorAll(candidate)).some((element) =>
      element instanceof HTMLButtonElement && !element.disabled && element.getClientRects().length > 0
    ),
    { timeout: 10_000 },
    selector
  )
  await page.$eval(selector, (element) => {
    const button = element instanceof HTMLButtonElement ? element : null
    if (!button || button.disabled || button.getClientRects().length === 0) {
      throw new Error('no visible enabled Project resource add button')
    }
    button.click()
  })
}

export async function openProjectDetails(page) {
  const details = await page.$('[data-project-secondary-details]')
  if (!details) return
  const state = await page.$eval('[data-project-secondary-details]', (element) => ({
    open: element.hasAttribute('open'),
    mounted: Boolean(element.querySelector('[data-project-lifecycle]'))
  }))
  if (!state.open || !state.mounted) {
    if (state.open) {
      await page.click('[data-project-secondary-details] > summary')
      await page.waitForFunction(
        () => document.querySelector('[data-project-secondary-details]')?.hasAttribute('open') !== true,
        { timeout: 5_000 }
      )
    }
    await page.click('[data-project-secondary-details] > summary')
  }
  await page.waitForSelector('[data-project-lifecycle]', { visible: true, timeout: 10_000 })
}

export async function clickStudioActionWithRetry(page, action, resultSelector) {
  await page.waitForFunction((actionName) => {
    const button = document.querySelector(`[data-studio-action="${actionName}"]`)
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false
    const rect = button.getBoundingClientRect()
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    return rect.width > 0 && rect.height > 0 && (hit === button || (hit !== null && button.contains(hit)))
  }, { timeout: 5_000 }, action)
  await page.click(`[data-studio-action="${action}"]`)
  if (await page.$(resultSelector)) return
  // A renderer layout commit can replace the button between mouse down/up; retry once after a fresh hit check.
  await page.waitForFunction((actionName) => {
    const button = document.querySelector(`[data-studio-action="${actionName}"]`)
    return button instanceof HTMLButtonElement && !button.disabled
  }, { timeout: 2_000 }, action)
  await page.click(`[data-studio-action="${action}"]`)
}
