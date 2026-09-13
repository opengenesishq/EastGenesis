export async function openControlRoomCommandPalette(page, timeout = 10_000) {
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.keyboard.down(modifier)
  await page.keyboard.press('k')
  await page.keyboard.up(modifier)
  await page.waitForSelector('[data-command-id="app:control-room"]', { visible: true, timeout })
}

export async function openControlRoom(page, timeout = 20_000) {
  await openControlRoomCommandPalette(page, Math.min(timeout, 10_000))
  await page.click('[data-command-id="app:control-room"]')
  await page.waitForSelector('.office', { visible: true, timeout })
}
