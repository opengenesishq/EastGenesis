import type { SessionMeta } from '../../shared/types'
import type { BrowserTabTarget } from '../../shared/browser-tab-types'
import type { EffectTarget } from '../../shared/effect-types'
import { browserViewManager } from '../browserView'
import { externalBrowserRegistry } from '../external-browser-registry'
import { getSettings } from '../settings'
import { browserDebugController, type BrowserDebugBinding } from './controller'

let metaFor: (id: string) => SessionMeta | undefined = () => undefined
export function configureBrowserDebugRuntime(getSessionMeta: typeof metaFor): void {
  metaFor = getSessionMeta
  browserDebugController.configure(browserDebugEnabled)
}
export function browserDebugEnabled(): boolean {
  return getSettings().browserDebug?.enabled === true && !process.env.CAOGEN_TEMPORARY_PROFILE_ID
}
function taskIdentity(id: string): string {
  const meta = metaFor(id)
  if (!meta || meta.status === 'closed' || id.startsWith('workspace-browser:')) throw new Error('高级调试必须绑定一个有效任务。')
  if (externalBrowserRegistry.taskStatus(id)) throw new Error('高级调试当前仅支持内置浏览器；外部 CDP 和浏览器扩展暂不支持。')
  return JSON.stringify([meta.id, meta.createdAt, meta.cwd, meta.sourceCwd, meta.workspaceId, meta.projectId, meta.goalId, meta.workItemId])
}
export function browserDebugBinding(target: BrowserTabTarget, ownerId: number): BrowserDebugBinding {
  const identity = taskIdentity(target.contextId)
  const record = browserViewManager.assertTarget(target, true, true)
  const contents = record.view.webContents
  const url = contents.getURL()
  if (!/^https?:\/\//i.test(url)) throw new Error('高级调试只支持已加载的 HTTP/HTTPS 页面。')
  const assertCurrent = (): void => {
    if (taskIdentity(target.contextId) !== identity || browserViewManager.assertTarget(target, true, true) !== record ||
      record.owner.isDestroyed() || record.owner.webContents.id !== ownerId || contents.isDestroyed() ||
      !browserViewManager.isContextVisible(target.contextId) || contents.isLoadingMainFrame() || contents.getURL() !== url) throw new Error('任务、窗口、标签或页面已变化，调试授权失效。')
  }
  assertCurrent()
  return { target, ownerId, url, transport: contents.debugger, assertCurrent }
}
export async function prepareBrowserDebugEvaluation(sessionId: string, expression: unknown): Promise<EffectTarget> {
  taskIdentity(sessionId)
  const binding = browserDebugController.evaluationBinding(sessionId, expression)
  const page = await browserViewManager.captureMutationPage(sessionId, 'browser_evaluate')
  const current = browserDebugController.evaluationBinding(sessionId, expression)
  if (JSON.stringify(binding) !== JSON.stringify(current)) throw new Error('读取调试审批目标期间授权发生变化。')
  return { kind: 'unsupported', toolName: 'browser_debug_evaluate', browserPage: page, browserDebug: binding }
}
export async function executeBrowserDebugEvaluation(sessionId: string, expression: unknown, target?: EffectTarget): Promise<unknown> {
  taskIdentity(sessionId)
  if (target?.kind !== 'unsupported' || target.toolName !== 'browser_debug_evaluate' || !target.browserDebug || !target.browserPage?.embedded || target.browserPage.external) throw new Error('高级调试缺少已审批的脚本和固定页面版本。')
  const page = target.browserPage
  return browserDebugController.evaluate(sessionId, expression, target.browserDebug,
    () => browserViewManager.validateApprovedPage(sessionId, page))
}
