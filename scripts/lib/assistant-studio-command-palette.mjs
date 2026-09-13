export async function openCommandPalette(page) {
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.keyboard.down(modifier)
  await page.keyboard.press('k')
  await page.keyboard.up(modifier)
  await page.waitForSelector('.command-palette-backdrop', { visible: true, timeout: 5_000 })
  await page.waitForFunction(
    () => document.activeElement?.classList.contains('command-palette-input'),
    { timeout: 5_000 }
  )
}
