import { useStore } from '../../store'
import { officeSessionCanContinue, officeSessionNeedsRecovery } from './office-session-action-policy'

/** The selected task uses the same current-state, permission and recovery gates as Continue. */
export async function submitOfficeSessionInstruction(id: string, text: string, zh: boolean): Promise<void> {
  if (!text.trim()) throw new Error(zh ? '请输入任务要求。' : 'Enter an instruction.')
  const exists = await useStore.getState().syncSession(id)
  await useStore.getState().hydrateTaskRecoveryCandidates()
  const state = useStore.getState()
  if (state.taskSnapshotsError) throw new Error(state.taskSnapshotsError)
  if (!exists || !officeSessionCanContinue(state.sessions[id])) {
    throw new Error(zh ? '任务仍在执行或等待处理；请先使用右侧控制。' : 'The task is running or awaiting action. Use its controls first.')
  }
  if (officeSessionNeedsRecovery(id, state.taskSnapshots, state.modelAttemptReconciliations)) {
    throw new Error(zh ? '任务仍有待审批、待对账或恢复中的操作，请在任务中完成处理。' : 'Resolve this task’s approval, reconciliation or recovery before continuing.')
  }
  await state.sendMessage(text, id)
}
