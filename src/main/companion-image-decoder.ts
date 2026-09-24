import { BrowserWindow, nativeImage } from 'electron'
import { randomUUID } from 'node:crypto'

export async function decodeCompanionImage(bytes: Buffer): Promise<boolean> {
  if (bytes[0] !== 71) return !nativeImage.createFromBuffer(bytes).isEmpty()
  const decoder = new BrowserWindow({ show: false, webPreferences: {
    sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true,
    partition: `companion-image-${randomUUID()}`
  } })
  decoder.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  decoder.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*','https://*/*','file://*/*'] }, (_details, callback) => callback({ cancel: true }))
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      (async () => {
        await decoder.loadURL('about:blank')
        return decoder.webContents.executeJavaScriptInIsolatedWorld(991, [{ code:
          `new Promise(resolve => { const image = new Image(); image.onload = () => resolve(image.naturalWidth > 0 && image.naturalHeight > 0); image.onerror = () => resolve(false); image.src = ${JSON.stringify(`data:image/gif;base64,${bytes.toString('base64')}`)}; })` }]) as Promise<boolean>
      })(),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 4000) })
    ])
  } catch { return false }
  finally { if (timer) clearTimeout(timer); if (!decoder.isDestroyed()) decoder.destroy() }
}
