const { app, nativeImage, Tray } = require('electron')
const path = require('node:path')

void app.whenReady().then(() => {
  const iconPath = path.join(process.cwd(), 'resources', 'trayTemplate.png')
  const image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) throw new Error(`macOS tray icon did not load: ${iconPath}`)
  const size = image.getSize()
  if (size.width !== 18 || size.height !== 18) {
    throw new Error(`unexpected tray icon size: ${size.width}x${size.height}`)
  }
  const scaleFactors = image.getScaleFactors()
  if (!scaleFactors.includes(1) || !scaleFactors.includes(2)) {
    throw new Error(`missing macOS tray scale factors: ${JSON.stringify(scaleFactors)}`)
  }
  image.setTemplateImage(true)
  if (typeof image.isTemplateImage === 'function' && !image.isTemplateImage()) {
    throw new Error('macOS tray icon did not retain template-image mode')
  }
  const tray = new Tray(image)
  tray.setToolTip('EastGenesis tray icon smoke')
  setTimeout(() => {
    const bounds = tray.getBounds()
    if (bounds.height <= 0 || bounds.height > 30) {
      throw new Error(`unexpected macOS tray bounds: ${JSON.stringify(bounds)}`)
    }
    console.log(JSON.stringify({ ok: true, size, scaleFactors, bounds, template: true }))
    tray.destroy()
    app.quit()
  }, 200)
})
