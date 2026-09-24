import type { EffectStatus } from './effect-types'

/** External Chrome/Edge integration is opt-in and remains separate from the embedded BrowserView. */
export type ExternalBrowserVendor = 'chrome' | 'edge'
export type ExternalBrowserTransport = 'cdp' | 'extension'
export type ExternalBrowserConnectionStatus = 'pairing' | 'connected' | 'revoked' | 'disconnected' | 'error'
export type ExternalBrowserCapability = 'read' | 'navigate' | 'click' | 'type' | 'screenshot'

export interface ExternalBrowserConnection {
  id: string
  sessionId: string
  ownerWebContentsId: number
  vendor: ExternalBrowserVendor
  transport: ExternalBrowserTransport
  status: ExternalBrowserConnectionStatus
  /** CDP port or extension id only; never a URL containing a token or profile path. */
  endpointLabel: string
  connectedAt?: number
  revokedAt?: number
  selectedTabId?: string
  selectionRevision: number
  capabilities: ExternalBrowserCapability[]
}

export interface ExternalBrowserTab {
  tabId: string
  title: string
  url: string
  active: boolean
  windowId?: number
  vendor: ExternalBrowserVendor
  connectionId: string
  /** Monotonic page revision used to invalidate approvals after navigation. */
  pageRevision?: number
}

export interface ExternalBrowserConnectInput {
  sessionId: string
  vendor: ExternalBrowserVendor
  transport: ExternalBrowserTransport
  /** CDP loopback port explicitly supplied by the user; extension pairing omits this. */
  port?: number
  extensionId?: string
}

export type ExternalBrowserActionResult<T> = {
  ok: true
  value: T
  effectStatus?: EffectStatus
  operationId?: string
} | { ok: false; error: string; operationId?: string }

export interface ExternalBrowserConnectResult {
  connection: ExternalBrowserConnection
  tabs: ExternalBrowserTab[]
}

export interface ExternalBrowserBridgeApi {
  listExternalBrowserConnections(): Promise<ExternalBrowserConnection[]>
  connectExternalBrowser(input: ExternalBrowserConnectInput): Promise<ExternalBrowserActionResult<ExternalBrowserConnectResult>>
  reconnectExternalBrowser(connectionId: string): Promise<ExternalBrowserActionResult<ExternalBrowserConnectResult>>
  listExternalBrowserTabs(connectionId: string): Promise<ExternalBrowserActionResult<ExternalBrowserTab[]>>
  selectExternalBrowserTab(connectionId: string, tabId: string): Promise<ExternalBrowserActionResult<ExternalBrowserTab>>
  revokeExternalBrowser(connectionId: string): Promise<ExternalBrowserActionResult<{ revoked: true }>>
}

/** Approval binding for a page in an external browser. Kept separate from the
 * embedded BrowserView identity so a tab can never be confused with a local
 * WebContentsView. */
export interface ExternalBrowserPageBinding {
  connectionId: string
  tabId: string
  pageRevision: number
  urlDigest: string
  documentToken: string
  actionTarget?: {
    kind: 'browser_click' | 'browser_type' | 'browser_evaluate'
    nodeToken: string
    version: number
    stateDigest: string
  }
}

export function normalizeExternalBrowserInput(value: unknown): ExternalBrowserConnectInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('外部浏览器连接参数无效。')
  const input = value as Record<string, unknown>
  for (const key of Object.keys(input)) if (!['sessionId', 'vendor', 'transport', 'port', 'extensionId'].includes(key)) throw new Error(`不允许的外部浏览器参数：${key}`)
  const sessionId = requiredId(input.sessionId, '任务')
  if (input.vendor !== 'chrome' && input.vendor !== 'edge') throw new Error('只支持 Chrome 或 Edge。')
  if (input.transport !== 'cdp' && input.transport !== 'extension') throw new Error('外部浏览器连接方式无效。')
  if (input.transport === 'cdp') {
    const port = input.port
    if (!Number.isInteger(port) || Number(port) < 1024 || Number(port) > 65535) throw new Error('CDP 端口必须是 1024-65535。')
    return { sessionId, vendor: input.vendor, transport: 'cdp', port: Number(port) }
  }
  const extensionId = requiredId(input.extensionId, '浏览器扩展')
  if (!/^[a-p]{32}$/.test(extensionId)) throw new Error('浏览器扩展 ID 无效。')
  return { sessionId, vendor: input.vendor, transport: 'extension', extensionId }
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  return normalized === 'localhost' || normalized === '::1' || normalized === '127.0.0.1' || normalized.startsWith('127.')
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9:_-]{1,180}$/.test(value)) throw new Error(`${label}标识无效。`)
  return value
}
