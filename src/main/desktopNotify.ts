import { app, ipcMain, Notification, type BrowserWindow, type WebContents } from 'electron'

interface DesktopNotificationHost {
  getMainWindow(): BrowserWindow | null
  showMainWindow(): BrowserWindow
}

let host: DesktopNotificationHost | undefined
let pendingSessionId: string | undefined
let readyContents: WebContents | undefined
const observedContents = new WeakSet<WebContents>()

/** The renderer subscribes only after its existing task list has hydrated. */
export function configureDesktopNotifications(input: DesktopNotificationHost): void {
  host = input
  ipcMain.removeAllListeners('desktop-notification:ready')
  ipcMain.on('desktop-notification:ready', (event) => {
    const win = host?.getMainWindow()
    if (!win || win.isDestroyed() || win.webContents !== event.sender) return
    readyContents = event.sender
    if (!observedContents.has(event.sender)) {
      const contents = event.sender
      observedContents.add(contents)
      const reset = (): void => { if (readyContents === contents) readyContents = undefined }
      contents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) reset()
      })
      contents.on('did-finish-load', deliverPendingNotification)
      contents.once('destroyed', reset)
    }
    deliverPendingNotification()
  })
}

function deliverPendingNotification(): void {
  const win = host?.getMainWindow()
  if (!pendingSessionId || !win || win.isDestroyed() || win.webContents !== readyContents ||
      win.webContents.isDestroyed() || win.webContents.isLoadingMainFrame()) return
  win.webContents.send('desktop-notification:activate', pendingSessionId)
  pendingSessionId = undefined
}

function truncate(text: string, max = 180): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

function activateNotification(sessionId: string): void {
  // Keep only the latest explicit click while the main window is being rebuilt.
  pendingSessionId = sessionId
  host?.showMainWindow()
  deliverPendingNotification()
  if (process.platform === 'darwin') {
    app.focus({ steal: true })
  } else {
    app.focus()
  }
}

export function showDesktopNotification(input: {
  title: string
  body: string
  sessionId: string
}): void {
  console.info('[caogen] desktop notification requested:', JSON.stringify({
    sessionId: input.sessionId,
    title: input.title
  }))
  if (!Notification.isSupported()) return
  const notification = new Notification({
    title: input.title,
    body: truncate(input.body),
    silent: false
  })
  notification.once('click', () => {
    activateNotification(input.sessionId)
  })
  notification.show()
}
