import { createHash, randomUUID } from 'node:crypto'
import { BROWSER_DEBUG_LIMITS, BROWSER_DEBUG_TTL_MS, type BrowserDebugGrant, type BrowserDebugSnapshot, type BrowserDebugEvaluationBinding } from '../../shared/browser-debug-types'
import type { BrowserTabTarget } from '../../shared/browser-tab-types'
import { debugEvaluationResult, debugRemoteValue, debugText, debugUrl } from './output'

export interface DebuggerTransport {
  isAttached(): boolean
  attach(version?: string): void
  detach(): void
  sendCommand(method: string, params?: Record<string, unknown>): Promise<any>
  on(event: 'message' | 'detach', listener: (...args: any[]) => void): unknown
  removeListener(event: 'message' | 'detach', listener: (...args: any[]) => void): unknown
}
export interface BrowserDebugBinding {
  target: BrowserTabTarget; ownerId: number; url: string; transport: DebuggerTransport
  assertCurrent(): void
}
interface Entry {
  binding: BrowserDebugBinding; grant: BrowserDebugGrant; frameId?: string; context?: { id: number; uniqueId: string }
  console: BrowserDebugSnapshot['console']; network: Map<string, BrowserDebugSnapshot['network'][number]>
  message: (...args: any[]) => void; detach: (...args: any[]) => void; timer?: ReturnType<typeof setTimeout>; attached: boolean
  startedAt: number
  ready: boolean
}
const METRICS = new Set(['Timestamp', 'Documents', 'Frames', 'JSEventListeners', 'Nodes', 'LayoutCount', 'RecalcStyleCount', 'LayoutDuration', 'RecalcStyleDuration', 'ScriptDuration', 'TaskDuration', 'JSHeapUsedSize', 'JSHeapTotalSize'])

export class BrowserDebugController {
  private entries = new Map<string, Entry>()
  constructor(private enabled: () => boolean = () => false, private readonly now: () => number = Date.now) {}
  configure(enabled: () => boolean): void { this.enabled = enabled }
  status(sessionId: string): BrowserDebugGrant | undefined {
    const entry = this.entries.get(sessionId)
    if (!entry) return undefined
    try { this.assert(entry); return entry.ready ? structuredClone(entry.grant) : undefined } catch { return undefined }
  }
  async grant(binding: BrowserDebugBinding): Promise<BrowserDebugGrant> {
    if (!this.enabled()) throw new Error('高级浏览器调试默认关闭，请先在浏览器设置中开启。')
    binding.assertCurrent()
    this.revokeSession(binding.target.contextId)
    if (binding.transport.isAttached()) throw new Error('此标签已被其他调试器占用；请关闭其调试连接后再授权。')
    const grant: BrowserDebugGrant = { id: randomUUID(), target: structuredClone(binding.target), ownerId: binding.ownerId,
      expiresAt: this.now() + BROWSER_DEBUG_TTL_MS, pageUrl: debugUrl(binding.url) }
    const entry: Entry = { binding, grant, console: [], network: new Map(), attached: false, startedAt: this.now(), ready: false,
      message: (_event, method, params) => this.event(entry, method, params), detach: () => this.revokeSession(binding.target.contextId, grant.id) }
    this.entries.set(binding.target.contextId, entry)
    try {
      binding.transport.on('message', entry.message); binding.transport.on('detach', entry.detach)
      binding.transport.attach('1.3'); entry.attached = true
      this.assert(entry)
      const tree = await this.command(entry, 'Page.getFrameTree')
      entry.frameId = tree?.frameTree?.frame?.id
      if (!entry.frameId) throw new Error('无法绑定浏览器主框架。')
      await this.command(entry, 'Runtime.enable')
      if (!entry.context) throw new Error('无法绑定当前文档的主框架执行环境。')
      await this.command(entry, 'Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0, maxPostDataSize: 0 })
      await this.command(entry, 'Performance.enable')
      this.assert(entry)
      entry.ready = true
      entry.timer = setTimeout(() => this.revokeSession(binding.target.contextId, grant.id), BROWSER_DEBUG_TTL_MS)
      entry.timer.unref?.()
      return structuredClone(grant)
    } catch (error) { this.revokeSession(binding.target.contextId, grant.id); throw error }
  }
  revokeSession(sessionId: string, grantId?: string): void {
    const entry = this.entries.get(sessionId)
    if (!entry || grantId && entry.grant.id !== grantId) return
    this.entries.delete(sessionId)
    if (entry.timer) clearTimeout(entry.timer)
    entry.binding.transport.removeListener('message', entry.message)
    entry.binding.transport.removeListener('detach', entry.detach)
    entry.console.length = 0; entry.network.clear(); entry.context = undefined
    if (entry.attached && entry.binding.transport.isAttached()) { try { entry.binding.transport.detach() } catch { /* Already detached. */ } }
  }
  invalidateTab(tabId: string): void {
    for (const [id, entry] of this.entries) if (entry.grant.target.tabId === tabId) this.revokeSession(id)
  }
  revokeAll(): void { for (const id of this.entries.keys()) this.revokeSession(id) }
  assertGrant(sessionId: string, ownerId?: number, grantId?: string): BrowserDebugGrant {
    const entry = this.require(sessionId)
    if (ownerId !== undefined && entry.grant.ownerId !== ownerId || grantId !== undefined && entry.grant.id !== grantId) throw new Error('调试授权不属于当前窗口或已被替换。')
    return structuredClone(entry.grant)
  }
  async snapshot(sessionId: string, grantId?: string): Promise<BrowserDebugSnapshot> {
    const entry = this.require(sessionId)
    if (grantId !== undefined && entry.grant.id !== grantId) throw new Error('调试授权已变化。')
    const value = await this.command(entry, 'Performance.getMetrics')
    const metrics: Record<string, number> = {}
    for (const item of Array.isArray(value?.metrics) ? value.metrics : []) if (METRICS.has(item?.name) && Number.isFinite(item?.value)) metrics[item.name] = item.value
    this.assert(entry)
    return { grant: structuredClone(entry.grant), capturedAt: this.now(), console: structuredClone(entry.console),
      network: structuredClone([...entry.network.values()]), metrics, limits: BROWSER_DEBUG_LIMITS }
  }
  evaluationBinding(sessionId: string, expression: unknown): BrowserDebugEvaluationBinding {
    const entry = this.require(sessionId)
    if (!entry.context) throw new Error('调试执行环境已失效，请重新授权。')
    return { grantId: entry.grant.id, expressionDigest: expressionDigest(expression), executionContextUniqueId: entry.context.uniqueId }
  }
  async evaluate(sessionId: string, expression: unknown, approved: BrowserDebugEvaluationBinding,
    validatePage: () => Promise<void>): Promise<unknown> {
    const entry = this.require(sessionId)
    const current = this.evaluationBinding(sessionId, expression)
    if (!approved || Object.keys(current).some(key => current[key as keyof typeof current] !== approved[key as keyof typeof current])) throw new Error('调试脚本、文档或授权已变化，原审批失效。')
    await validatePage()
    this.assert(entry)
    if (entry.context?.uniqueId !== approved.executionContextUniqueId) throw new Error('页面执行环境已变化，原审批失效。')
    // Exactly one request. A lost reply may follow a completed mutation; never retry or switch contexts.
    let result: any
    try {
      result = await this.command(entry, 'Runtime.evaluate', { expression, uniqueContextId: approved.executionContextUniqueId,
        includeCommandLineAPI: false, returnByValue: true, awaitPromise: true, userGesture: false, timeout: 5_000,
        objectGroup: `caogen-debug-${entry.grant.id}` })
    } catch { throw new Error('调试脚本执行结果未知；没有自动重试。请核对原页面及操作记录后再决定。') }
    if (result?.exceptionDetails) throw new Error('调试脚本抛出异常，可能已产生部分副作用。请核对原页面；未重试。')
    if (result?.result?.objectId) throw new Error('调试结果无法安全序列化；脚本可能已执行，未重试。')
    return debugEvaluationResult(result?.result?.value ?? null)
  }
  private require(id: string): Entry {
    const entry = this.entries.get(id)
    if (!entry) throw new Error('当前任务没有有效的高级浏览器调试授权。')
    this.assert(entry)
    if (!entry.ready) throw new Error('调试授权仍在初始化，请稍后重试。')
    return entry
  }
  private assert(entry: Entry): void {
    try {
      if (!this.enabled() || this.entries.get(entry.grant.target.contextId) !== entry || this.now() >= entry.grant.expiresAt) throw new Error('调试授权已关闭、撤销或过期。')
      entry.binding.assertCurrent()
      if (entry.attached && !entry.binding.transport.isAttached()) throw new Error('调试连接已断开。')
    } catch (error) { this.revokeSession(entry.grant.target.contextId, entry.grant.id); throw error }
  }
  private async command(entry: Entry, method: string, params?: Record<string, unknown>): Promise<any> {
    this.assert(entry)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        entry.binding.transport.sendCommand(method, params),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('浏览器调试请求超时。')), 8_000) })
      ])
      this.assert(entry)
      return result
    } catch (error) {
      this.revokeSession(entry.grant.target.contextId, entry.grant.id)
      throw error
    } finally { if (timer) clearTimeout(timer) }
  }
  private event(entry: Entry, method: string, params: any): void {
    try {
      this.assert(entry)
      if (method === 'Runtime.executionContextCreated') {
        const context = params?.context
        if (context?.auxData?.frameId === entry.frameId && context.auxData.isDefault === true && typeof context.uniqueId === 'string' && Number.isInteger(context.id)) {
          if (entry.context && entry.context.uniqueId !== context.uniqueId) { this.revokeSession(entry.grant.target.contextId); return }
          entry.context = { id: context.id, uniqueId: context.uniqueId }
        }
      } else if (method === 'Runtime.executionContextsCleared' || method === 'Runtime.executionContextDestroyed' && params?.executionContextId === entry.context?.id) {
        this.revokeSession(entry.grant.target.contextId)
      } else if (method === 'Runtime.consoleAPICalled' && params?.executionContextId === entry.context?.id) {
        if (typeof params.timestamp !== 'number' || params.timestamp < entry.startedAt) return
        entry.console.push({ at: this.now(), kind: debugText(params.type), text: (Array.isArray(params.args) ? params.args.slice(0, 8).map(debugRemoteValue).join(' ') : '').slice(0, BROWSER_DEBUG_LIMITS.text) })
      } else if (method === 'Runtime.exceptionThrown' && params?.exceptionDetails?.executionContextId === entry.context?.id) {
        if (typeof params.timestamp !== 'number' || params.timestamp < entry.startedAt) return
        entry.console.push({ at: this.now(), kind: 'exception', text: debugText(params.exceptionDetails.exception?.description ?? params.exceptionDetails.text) })
      } else if (method === 'Network.requestWillBeSent' && params?.frameId === entry.frameId && typeof params.requestId === 'string' && params.requestId.length <= 100) {
        entry.network.delete(params.requestId)
        entry.network.set(params.requestId, { id: params.requestId.slice(0, 100), at: this.now(), url: debugUrl(params.request?.url),
          method: debugText(params.request?.method).slice(0, 16), type: debugText(params.type).slice(0, 40) })
      } else if (['Network.responseReceived', 'Network.loadingFinished', 'Network.loadingFailed'].includes(method)) {
        const record = entry.network.get(params?.requestId)
        if (record) {
          if (method === 'Network.responseReceived' && Number.isFinite(params.response?.status)) record.status = params.response.status
          if (method === 'Network.loadingFinished' && Number.isFinite(params.encodedDataLength)) record.bytes = params.encodedDataLength
          if (method === 'Network.loadingFailed') record.failed = true
        }
      }
      if (entry.console.length > BROWSER_DEBUG_LIMITS.console) entry.console.splice(0, entry.console.length - BROWSER_DEBUG_LIMITS.console)
      while (entry.network.size > BROWSER_DEBUG_LIMITS.network) entry.network.delete(entry.network.keys().next().value!)
    } catch { /* Revoked or stale protocol events are not exposed. */ }
  }
}
export function expressionDigest(expression: unknown): string {
  if (typeof expression !== 'string' || !expression.trim() || Buffer.byteLength(expression) > BROWSER_DEBUG_LIMITS.expression) throw new Error('调试脚本必须为非空文本，且不超过 16 KiB。')
  return createHash('sha256').update(expression, 'utf8').digest('hex')
}
export const browserDebugController = new BrowserDebugController()
