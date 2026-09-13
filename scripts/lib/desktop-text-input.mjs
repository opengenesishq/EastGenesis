import assert from 'node:assert/strict'

/** Insert one text payload without synthesizing Enter keys that can submit a composer. */
export async function insertDesktopText(page, selector, text) {
  await page.focus(selector)
  await page.$eval(selector, (node) => node.select())
  await page.keyboard.press('Backspace')
  await page.keyboard.sendCharacter(text)
  assert.equal(await page.$eval(selector, (node) => node.value), text, `Text input differs from the full supplied payload: ${selector}`)
}
