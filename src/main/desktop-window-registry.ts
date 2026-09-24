import type { BrowserWindow } from 'electron'
const roles = new WeakMap<BrowserWindow, string>()
export function registerDesktopWindow(win: BrowserWindow, role: string): void { roles.set(win, role) }
export function desktopWindowRole(win: BrowserWindow): string | undefined { return roles.get(win) }
