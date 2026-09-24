import type { ExternalBrowserActionResult, ExternalBrowserConnection, ExternalBrowserVendor } from './external-browser-types'
export interface BrowserExtensionPairing {
  connection: ExternalBrowserConnection
  pairingCode: string
  expiresAt: number
}
export interface BrowserExtensionApi {
  openBrowserExtensionDirectory(): Promise<{ path: string; version: string }>
  beginBrowserExtensionPairing(input: { sessionId: string; vendor: ExternalBrowserVendor; extensionId: string }): Promise<ExternalBrowserActionResult<BrowserExtensionPairing>>
}
export type BrowserExtensionOperation = 'read' | 'capture' | 'navigate' | 'click' | 'type' | 'screenshot' | 'wait'
export interface BrowserExtensionPage {
  tabId: string
  url: string
  title: string
  revision: number
  loading: boolean
}
export const BROWSER_EXTENSION_PROTOCOL = 1
export const BROWSER_EXTENSION_OPERATIONS: BrowserExtensionOperation[] = ['read', 'capture', 'navigate', 'click', 'type', 'screenshot', 'wait']
