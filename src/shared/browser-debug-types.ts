import type { BrowserTabTarget } from './browser-tab-types'

export interface BrowserDebugPreferences { enabled: boolean }
export function normalizeBrowserDebugPreferences(value: unknown): BrowserDebugPreferences {
  return { enabled: Boolean(value && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>).enabled === true) }
}
export const BROWSER_DEBUG_TTL_MS = 5 * 60_000
export const BROWSER_DEBUG_LIMITS = { console: 100, network: 100, text: 1_024, resultBytes: 16_384, expression: 16_384 } as const
export interface BrowserDebugGrant {
  id: string; target: BrowserTabTarget; ownerId: number; expiresAt: number; pageUrl: string
}
export interface BrowserDebugConsoleEntry { at: number; kind: string; text: string }
export interface BrowserDebugNetworkEntry {
  id: string; at: number; url: string; method: string; type: string; status?: number; bytes?: number; failed?: boolean
}
export interface BrowserDebugSnapshot {
  grant: BrowserDebugGrant; capturedAt: number; console: BrowserDebugConsoleEntry[]; network: BrowserDebugNetworkEntry[]
  metrics: Record<string, number>; limits: typeof BROWSER_DEBUG_LIMITS
}
export interface BrowserDebugStatus { enabled: boolean; supported: boolean; grant?: BrowserDebugGrant; reason?: string }
export interface BrowserDebugEvaluationBinding { grantId: string; expressionDigest: string; executionContextUniqueId: string }
export interface BrowserDebugApi {
  getBrowserDebugStatus(target: BrowserTabTarget): Promise<BrowserDebugStatus>
  grantBrowserDebug(target: BrowserTabTarget): Promise<BrowserDebugGrant>
  revokeBrowserDebug(input: { sessionId: string; grantId: string }): Promise<void>
  getBrowserDebugSnapshot(input: { target: BrowserTabTarget; grantId: string }): Promise<BrowserDebugSnapshot>
}
