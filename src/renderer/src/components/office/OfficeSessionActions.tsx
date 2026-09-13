import { useState } from 'react'
import { useStore, type SessionState } from '../../store'
import PermissionBar from '../PermissionBar'
import { publishOfficeActionFeedback } from './OfficeActionFeedback'
import { officeSessionCanContinue, officeSessionCanStop, officeSessionNeedsRecovery } from './office-session-action-policy'
import { submitOfficeSessionInstruction } from './office-session-commands'

export default function OfficeSessionActions({ session, onOpenResults }: {
  session: SessionState; onOpenResults?: () => void
}): React.JSX.Element {
  const zh = useStore((state) => state.settings.language) === 'zh'
  const [busy, setBusy] = useState(false)
  const id = session.meta.id
  const receipt = (text: string, error = false): void => publishOfficeActionFeedback({ sessionId: id, title: session.meta.title, text, error })
  const operate = async (action: 'stop' | 'continue'): Promise<void> => {
    setBusy(true)
    try {
      if (action === 'stop') {
        await useStore.getState().interrupt(id)
        const state = useStore.getState()
        const pending = officeSessionNeedsRecovery(id, state.taskSnapshots, state.modelAttemptReconciliations)
        const stillActive = state.sessions[id] && officeSessionCanStop(state.sessions[id])
        receipt(stopReceipt(zh, Boolean(stillActive), pending))
      } else {
        await submitOfficeSessionInstruction(id, zh ? '继续当前任务，保留已有目标、业务线与验收要求。' : 'Continue the current task, preserving its goal, business line, and acceptance requirements.', zh)
        receipt(zh ? '继续请求已提交；执行结果将随任务更新。' : 'Continue request submitted. The task will report its outcome.')
      }
    } catch (error) {
      receipt(error instanceof Error ? error.message : String(error), true)
    } finally { setBusy(false) }
  }
  return <div className="office-session-actions" data-office-session-actions={id}>
    <PermissionBar sessionId={id} requests={session.pendingPermissions} />
    <div className="office-operation-actions">
      {onOpenResults && <button className="btn btn-ghost btn-sm" data-office-session-results onClick={onOpenResults}>{zh ? '查看成果' : 'View results'}</button>}
      {officeSessionCanContinue(session) && <button className="btn btn-ghost btn-sm" data-office-session-continue disabled={busy} onClick={() => void operate('continue')}>{zh ? '继续任务' : 'Continue task'}</button>}
      {officeSessionCanStop(session) && <button className="btn btn-ghost btn-sm" data-office-session-stop disabled={busy} onClick={() => void operate('stop')}>{zh ? '停止此会话' : 'Stop this session'}</button>}
    </div>
  </div>
}

function stopReceipt(zh: boolean, active: boolean, pending: boolean): string {
  if (active) return zh ? '停止请求已受理，执行尚未确认停止。' : 'Stop requested; execution has not yet confirmed it stopped.'
  if (pending) return zh ? '此会话执行已停止，仍有结果待审批或对账；请查看工作区。' : 'This session stopped, with approval or reconciliation still pending. Open its workspace.'
  return zh ? '此会话当前已不在执行；其他会话和子任务保留各自状态。' : 'This session is no longer executing. Other sessions and child tasks retain their own state.'
}
