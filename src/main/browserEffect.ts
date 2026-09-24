import { createHash } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import type { EffectRecord } from '../shared/effect-types'
import type { BrowserStateActionResult, BrowserViewState } from '../shared/browser-operation-types'
import type { BrowserTabTarget } from '../shared/browser-tab-types'
import { DEFAULT_BROWSER_URL, normalizeBrowserNavigationUrl } from './browserNavigation'
import {
  executeInteractiveOperationEffect,
  type InteractiveOperationEffectOutcome
} from './task/operation-effect-gateway'
import { stableValueDigest } from './task/tool-idempotency'

type OperationGateway = typeof executeInteractiveOperationEffect
type BrowserAction = 'open' | 'navigate' | 'back' | 'forward' | 'reload'

export interface BrowserEffectContext {
  browserTarget?: BrowserTabTarget
  /** Main-process lifecycle and window ownership guard. */
  assertActive?: () => void
  sourceKind?: 'task' | 'workspace_human'
  sourceSessionId: string
  projectId?: string
  cwd: string
}

export interface BrowserEffectManager {
  boundTarget?: BrowserTabTarget
  bind?(sessionId: string, target?: BrowserTabTarget): BrowserEffectManager
  assertWindowOwner(sessionId: string, owner: BrowserWindow): void
  getState(sessionId: string): BrowserViewState | undefined
  open(owner: BrowserWindow, sessionId: string, url?: string): Promise<BrowserViewState>
  navigate(sessionId: string, url: string): Promise<BrowserViewState>
  goBack(sessionId: string): Promise<BrowserViewState>
  goForward(sessionId: string): Promise<BrowserViewState>
  reload(sessionId: string): Promise<BrowserViewState>
}

const BROWSER_TOOL_NAMES: Record<BrowserAction, string> = {
  open: 'browser_view_open',
  navigate: 'browser_view_navigate',
  back: 'browser_view_back',
  forward: 'browser_view_forward',
  reload: 'browser_view_reload'
}

export async function openBrowserWithEffect(
  context: BrowserEffectContext,
  manager: BrowserEffectManager,
  owner: BrowserWindow,
  rawUrl?: string,
  runOperation: OperationGateway = executeInteractiveOperationEffect
): Promise<BrowserStateActionResult<BrowserViewState>> {
  context.assertActive?.()
  manager.assertWindowOwner(context.sourceSessionId, owner)
  let existing = manager.getState(context.sourceSessionId)
  // Creating a blank local view establishes the target before an async Effect
  // gateway. The requested navigation cannot drift onto a subsequently selected tab.
  if (!existing && manager.bind) existing = await manager.open(owner, context.sourceSessionId, DEFAULT_BROWSER_URL)
  if (existing && manager.bind) manager = manager.bind(context.sourceSessionId)
  context = { ...context, browserTarget: manager.boundTarget }
  const url = normalizeBrowserNavigationUrl(rawUrl ?? DEFAULT_BROWSER_URL)
  if (existing && (rawUrl === undefined || url === DEFAULT_BROWSER_URL)) {
    return { ok: true, state: existing, sourceKind: context.sourceKind ?? 'task' }
  }
  return executeBrowserNavigation(
    context,
    'open',
    url,
    () => manager.open(owner, context.sourceSessionId, url),
    runOperation
  )
}

export async function navigateBrowserWithEffect(
  context: BrowserEffectContext,
  manager: BrowserEffectManager,
  rawUrl: string,
  runOperation: OperationGateway = executeInteractiveOperationEffect
): Promise<BrowserStateActionResult<BrowserViewState>> {
  if (manager.bind) manager = manager.bind(context.sourceSessionId)
  context = { ...context, browserTarget: manager.boundTarget }
  const missing = requireBrowserState(context, manager)
  if ('error' in missing) return missing
  const url = normalizeBrowserNavigationUrl(rawUrl)
  return executeBrowserNavigation(
    context,
    'navigate',
    url,
    () => manager.navigate(context.sourceSessionId, url),
    runOperation
  )
}

export async function browserGoBackWithEffect(
  context: BrowserEffectContext,
  manager: BrowserEffectManager,
  runOperation: OperationGateway = executeInteractiveOperationEffect
): Promise<BrowserStateActionResult<BrowserViewState>> {
  if (manager.bind) manager = manager.bind(context.sourceSessionId)
  context = { ...context, browserTarget: manager.boundTarget }
  const current = requireBrowserState(context, manager)
  if ('error' in current) return current
  if (!current.state.canGoBack) return current
  return executeBrowserNavigation(
    context,
    'back',
    undefined,
    () => manager.goBack(context.sourceSessionId),
    runOperation
  )
}

export async function browserGoForwardWithEffect(
  context: BrowserEffectContext,
  manager: BrowserEffectManager,
  runOperation: OperationGateway = executeInteractiveOperationEffect
): Promise<BrowserStateActionResult<BrowserViewState>> {
  if (manager.bind) manager = manager.bind(context.sourceSessionId)
  context = { ...context, browserTarget: manager.boundTarget }
  const current = requireBrowserState(context, manager)
  if ('error' in current) return current
  if (!current.state.canGoForward) return current
  return executeBrowserNavigation(
    context,
    'forward',
    undefined,
    () => manager.goForward(context.sourceSessionId),
    runOperation
  )
}

export async function reloadBrowserWithEffect(
  context: BrowserEffectContext,
  manager: BrowserEffectManager,
  runOperation: OperationGateway = executeInteractiveOperationEffect
): Promise<BrowserStateActionResult<BrowserViewState>> {
  if (manager.bind) manager = manager.bind(context.sourceSessionId)
  context = { ...context, browserTarget: manager.boundTarget }
  const current = requireBrowserState(context, manager)
  if ('error' in current) return current
  return executeBrowserNavigation(
    context,
    'reload',
    undefined,
    () => manager.reload(context.sourceSessionId),
    runOperation
  )
}

async function executeBrowserNavigation(
  context: BrowserEffectContext,
  action: BrowserAction,
  url: string | undefined,
  execute: () => Promise<BrowserViewState>,
  runOperation: OperationGateway
): Promise<BrowserStateActionResult<BrowserViewState>> {
  const toolName = BROWSER_TOOL_NAMES[action]
  const outcome = await runOperation({
    kind: 'browser_navigation',
    title: browserActionTitle(action),
    sourceSessionId: context.sourceSessionId,
    projectId: context.projectId,
    cwd: context.cwd,
    toolName,
    toolInput: {
      action,
      ...(context.browserTarget ? { browserTab: context.browserTarget } : {}),
      sourceKind: context.sourceKind ?? 'task',
      sessionIdDigest: stableValueDigest(context.sourceSessionId),
      ...(url ? browserUrlEvidence(url) : {})
    },
    execute: async (effect) => {
      assertOpaqueBrowserEffect(effect, toolName)
      context.assertActive?.()
      let state: BrowserViewState
      try {
        state = await execute()
      } catch {
        throw new Error(`浏览器${browserActionLabel(action)}执行失败`)
      }
      context.assertActive?.()
      return state
    },
    isSuccess: (state) => isBrowserViewState(state, context.sourceSessionId),
    resultSummary: summarizeBrowserState
  })
  return { ...browserStateOutcome(outcome, browserActionLabel(action)), sourceKind: context.sourceKind ?? 'task' }
}

function requireBrowserState(
  context: BrowserEffectContext,
  manager: BrowserEffectManager
): BrowserStateActionResult<BrowserViewState> {
  context.assertActive?.()
  const state = manager.getState(context.sourceSessionId)
  const sourceKind = context.sourceKind ?? 'task'
  return state ? { ok: true, state, sourceKind } : { ok: false, error: '浏览器面板尚未打开', sourceKind }
}

function browserUrlEvidence(url: string): Record<string, unknown> {
  const parsed = new URL(url)
  return {
    protocol: parsed.protocol,
    hostDigest: parsed.host ? sha256(parsed.host) : undefined,
    targetDigest: sha256(url),
    hasQuery: parsed.search.length > 0,
    hasFragment: parsed.hash.length > 0
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function assertOpaqueBrowserEffect(effect: EffectRecord, toolName: string): void {
  if (effect.target.kind !== 'unsupported' || effect.target.toolName !== toolName) {
    throw new Error('浏览器导航必须保持 opaque 并与工具名绑定')
  }
}

function isBrowserViewState(value: BrowserViewState, sessionId: string): boolean {
  return Boolean(
    value && value.sessionId === sessionId && typeof value.url === 'string' &&
    typeof value.loading === 'boolean'
  )
}

function summarizeBrowserState(state: BrowserViewState): string {
  return JSON.stringify({
    sessionIdDigest: stableValueDigest(state.sessionId),
    urlDigest: sha256(state.url),
    tabId: state.tabId, contextEpoch: state.contextEpoch, selectionRevision: state.selectionRevision, navigationRevision: state.navigationRevision,
    loading: state.loading,
    canGoBack: state.canGoBack,
    canGoForward: state.canGoForward
  })
}

function browserStateOutcome(
  outcome: InteractiveOperationEffectOutcome<BrowserViewState>,
  label: string
): BrowserStateActionResult<BrowserViewState> {
  if (outcome.status === 'completed' && outcome.value) {
    return {
      ok: true,
      state: outcome.value,
      effectStatus: outcome.effectStatus,
      operationId: outcome.operationId
    }
  }
  if (outcome.status === 'waiting_reconciliation') {
    return {
      ok: false,
      error: `${label}结果未知，请在恢复面板完成对账`,
      effectStatus: outcome.effectStatus,
      operationId: outcome.operationId,
      snapshotId: outcome.snapshotId
    }
  }
  return {
    ok: false,
    error: outcome.status === 'failed' ? outcome.error : `${label}效果已确认，但执行结果缺失`,
    effectStatus: outcome.effectStatus,
    operationId: outcome.operationId
  }
}

function browserActionTitle(action: BrowserAction): string {
  return `浏览器${browserActionLabel(action)}`
}

function browserActionLabel(action: BrowserAction): string {
  if (action === 'open') return '打开页面'
  if (action === 'navigate') return '导航'
  if (action === 'back') return '后退'
  if (action === 'forward') return '前进'
  return '刷新'
}
