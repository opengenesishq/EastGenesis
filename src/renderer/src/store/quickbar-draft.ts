import type { QuickbarDispatchOptions, SendMessagePayload } from '../../../shared/types'
import type { AppStore } from '../store'
import { appendComposerDraft } from './composer-draft-inbox'

/** The destination is resolved once, before clipboard/file/capture preparation. */
export async function ensureQuickbarSession(
  getState: () => AppStore,
  options: QuickbarDispatchOptions
): Promise<{ sessionId: string; cwd: string }> {
  const state = getState()
  if (options.target === 'current') {
    const currentId = options.sessionId
    const current = currentId ? state.sessions[currentId] : undefined
    if (!currentId || !current || current.meta.status === 'closed') throw new Error('所选任务已关闭，请重新选择目标。')
    return { sessionId: currentId, cwd: current.meta.cwd }
  }
  const cwd = options.cwd?.trim()
  if (!cwd) throw new Error('请选择新任务的工作目录。')
  const sessionId = await state.createSession({ cwd, title: options.note?.trim().slice(0, 60) || '快捷输入' })
  const created = getState().sessions[sessionId]
  if (!created || created.meta.status === 'closed') throw new Error('新任务已关闭，请重新选择目标。')
  return { sessionId, cwd: created.meta.cwd }
}

export function stageQuickbarPayload(
  getState: () => AppStore,
  sessionId: string,
  payload: SendMessagePayload,
  imagePreviews?: Record<string, string>
): void {
  const session = getState().sessions[sessionId]
  if (!session || session.meta.status === 'closed') throw new Error('所选任务已关闭，内容未发送。')
  appendComposerDraft(sessionId, { payload, imagePreviews })
  getState().selectSession(sessionId)
  getState().setView('list')
}
