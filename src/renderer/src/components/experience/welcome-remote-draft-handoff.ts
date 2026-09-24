import type { WelcomeDraftState } from '../../store/welcome-draft'
import { taskWindowSessionId } from '../../task-window-context'
import { remoteConnection } from './welcome-remote-target'
import { remoteIntentDigest } from './welcome-remote-task'

let handoffBusy = false
export async function handoffWelcomeRemoteDraft(draft: WelcomeDraftState, text: string): Promise<void> {
  const target = draft.executionTarget, sessionId = taskWindowSessionId()
  if (!sessionId || target?.kind !== 'remote' || draft.forkFromSdkSessionId) throw new Error('此草稿不能交给主窗口。')
  if (!text.trim() || text.trim().length > 20_000) throw new Error('远端草稿支持 1–20,000 字符，当前文字仍保留。')
  if (handoffBusy) return
  handoffBusy = true
  try {
    const digest = await remoteIntentDigest(target, text)
    const key = `caogen.remote-welcome-handoff.${sessionId}.${digest}`
    let requestId = window.localStorage.getItem(key)
    if (!requestId || !/^[a-zA-Z0-9_-]{1,160}$/.test(requestId)) { requestId = crypto.randomUUID(); window.localStorage.setItem(key, requestId) }
    const result = await window.agentDesk.sendRemoteWelcomeDraftToMain({ requestId, text: text.trim(), hostId: target.hostId, expectedConnection: remoteConnection(target) })
    if (result.requestId !== requestId) throw new Error('草稿交接尚未确认，请保留当前内容。')
  } finally { handoffBusy = false }
}
