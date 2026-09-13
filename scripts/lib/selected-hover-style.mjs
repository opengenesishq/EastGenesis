export async function assertSelectedHoverStyle(page, selector) {
  const originalTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
  try {
    for (const theme of ['dark', 'light']) {
      await page.mouse.move(0, 0)
      await page.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme)
      await waitForColorTransition()
      const before = await readButtonColors(page, selector)
      await page.hover(selector)
      await waitForColorTransition()
      const after = await readButtonColors(page, selector)
      if (before.color !== after.color || before.backgroundColor !== after.backgroundColor) {
        throw new Error(`${selector} ${theme} selected hover changed colors: ${JSON.stringify({ before, after })}`)
      }
      if (after.contrast < 4.5) {
        throw new Error(`${selector} ${theme} selected hover contrast is ${after.contrast.toFixed(2)}:1`)
      }
    }
  } finally {
    await page.mouse.move(0, 0)
    await page.evaluate((value) => {
      if (value === null) document.documentElement.removeAttribute('data-theme')
      else document.documentElement.setAttribute('data-theme', value)
    }, originalTheme)
  }
}

function waitForColorTransition() {
  return new Promise((resolve) => setTimeout(resolve, 180))
}

async function readButtonColors(page, selector) {
  return page.$eval(selector, (button) => {
    const style = getComputedStyle(button)
    const luminance = (value) => {
      const channels = (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
      if (channels.length !== 3) throw new Error(`cannot parse CSS color ${value}`)
      return channels
        .map((channel) => channel / 255)
        .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
        .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0)
    }
    const foreground = luminance(style.color)
    const background = luminance(style.backgroundColor)
    return {
      color: style.color,
      backgroundColor: style.backgroundColor,
      contrast: (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
    }
  })
}
