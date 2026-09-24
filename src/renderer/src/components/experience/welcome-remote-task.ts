import type { RemoteHostCommandReceipt } from '../../../../shared/remote-host-types'
import { useStore } from '../../store'
import type { WelcomeDraftState } from '../../store/welcome-draft'
import { persistWelcomeDraftStrict } from '../../store/welcome-draft-persistence'
import { taskWindowSessionId } from '../../task-window-context'
import { remoteConnection, sameRemoteConnection, sameRemoteTarget, type RemoteIntakeReference, type WelcomeRemoteTarget } from './welcome-remote-target'

let sending = false
export async function remoteIntentDigest(target: WelcomeRemoteTarget, objective: string): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify({ hostId: target.hostId, connection: remoteConnection(target), objective: objective.trim() }))
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('')
}
function remember(reference: RemoteIntakeReference): void {
  const state = useStore.getState(), current = state.welcomeDraft.remoteIntakes ?? []
  const index = current.findIndex(item => item.requestId === reference.requestId)
  if (index >= 0 && JSON.stringify(current[index]) === JSON.stringify(reference)) return
  const next = [...current]
  if (index < 0) next.push(reference); else next[index] = reference
  state.updateWelcomeDraft({ remoteIntakes: next })
}
export function clearConfirmedRemoteDraft(reference: RemoteIntakeReference, receipt: RemoteHostCommandReceipt): void {
  const state = useStore.getState(), draft = state.welcomeDraft
  if (receipt.createdTask && receipt.createdTask.projectId === reference.target.projectId &&
    draft.draftVersion === reference.draftVersion && draft.executionTarget?.kind === 'remote' &&
    sameRemoteConnection(remoteConnection(draft.executionTarget), remoteConnection(reference.target)) && draft.executionTarget.hostId === reference.target.hostId) {
    state.updateWelcomeDraft({ text: '' })
  }
}
export async function releaseUnrecordedRemoteIntake(reference: RemoteIntakeReference): Promise<void> {
  const found = await window.agentDesk.findRemoteHostCommandByRequestId(reference.target.hostId, reference.requestId)
  if (found) throw new Error('本机已有原命令记录，请核对原提交。')
  const state = useStore.getState()
  const remoteIntakes = (state.welcomeDraft.remoteIntakes ?? []).filter(item => item.requestId !== reference.requestId)
  persistWelcomeDraftStrict({ ...state.welcomeDraft, remoteIntakes })
  state.updateWelcomeDraft({ remoteIntakes })
}
export async function recoverRemoteIntake(reference: RemoteIntakeReference, online: boolean): Promise<RemoteHostCommandReceipt | null> {
  const api = window.agentDesk
  let receipt = await api.findRemoteHostCommandByRequestId(reference.target.hostId, reference.requestId)
  if (receipt && (receipt.kind !== 'create_task' || receipt.requestId !== reference.requestId || receipt.source !== 'welcome')) throw new Error('原提交记录不匹配，已停止打开任务。')
  if (receipt && online) receipt = await api.reconcileRemoteHostCommand(reference.target.hostId, receipt.commandId)
  if (receipt) {
    remember({ ...reference, commandId: receipt.commandId })
    clearConfirmedRemoteDraft(reference, receipt)
  }
  return receipt
}
export async function submitWelcomeRemote(draft: WelcomeDraftState, promptInput: string): Promise<void> {
  if (sending) return
  if (taskWindowSessionId()) throw new Error('请将草稿交给主工作台，在主窗口开始远端任务。')
  const target = draft.executionTarget, objective = promptInput.trim()
  if (target?.kind !== 'remote') throw new Error('请选择远端主机与配对项目。')
  if (draft.forkFromSdkSessionId) throw new Error('分叉草稿不能改成远端新任务，请先另起草稿。')
  if (!objective || objective.length > 20_000) throw new Error('远端新任务支持 1–20,000 字符，请保留草稿并缩短正文。')
  sending = true
  try {
    const intentDigest = await remoteIntentDigest(target, objective)
    const original = (draft.remoteIntakes ?? []).find(item => item.intentDigest === intentDigest)
    if (original) { await recoverRemoteIntake(original, false); throw new Error('这份目标已有原提交记录。请核对并打开原任务，不能重复发送。') }
    const { hosts } = await window.agentDesk.listRemoteHosts(), host = hosts.find(item => item.id === target.hostId)
    if (!host || !sameRemoteTarget(target, host)) throw new Error('原主机或项目身份已变化，请在连接设置核对。草稿仍保留。')
    if (host.status !== 'paired' || host.renewal || (host.expiresAt ?? 0) <= Date.now()) throw new Error('请先续期或核对原连接，再发送任务。')
    const tasks = await window.agentDesk.readRemoteHostTasks(host.id)
    if (tasks.projectId !== target.projectId || !tasks.capabilities.includes('create_task')) throw new Error('远端项目不匹配或新建任务权限已撤销。')
    const current = useStore.getState().welcomeDraft
    if (current.draftVersion !== draft.draftVersion || current.text.trim() !== objective || JSON.stringify(current.executionTarget) !== JSON.stringify(target)) throw new Error('草稿已经修改，请发送当前版本。')
    const reference: RemoteIntakeReference = { target, requestId: crypto.randomUUID(), createdAt: Date.now(), draftVersion: draft.draftVersion ?? 0, intentDigest }
    remember(reference)
    persistWelcomeDraftStrict(useStore.getState().welcomeDraft)
    // Persist request identity before IPC. No retry path calls this mutation.
    try {
      const receipt = await window.agentDesk.sendRemoteHostCommand({ hostId: target.hostId, kind: 'create_task',
        text: objective, requestId: reference.requestId, expectedRevision: tasks.projectRevision,
        source: 'welcome', expectedConnection: remoteConnection(target) })
      remember({ ...reference, commandId: receipt.commandId })
      clearConfirmedRemoteDraft(reference, receipt)
    } catch {
      await recoverRemoteIntake(reference, false).catch(() => undefined)
      throw new Error('提交结果待核对。原请求已保留，请在下方核对原提交，不要重复创建。')
    }
  } finally { sending = false }
}
export function remoteCreateLabel(receipt: RemoteHostCommandReceipt | null | undefined, zh: boolean): string {
  if (!receipt) return zh ? '原请求待核对' : 'Original request awaiting confirmation'
  const phases = {
    preparing: zh ? '远端正在准备任务' : 'Preparing task on host',
    plan_ready: zh ? '计划已建立，等待远端计划审批' : 'Plan created; awaiting host approval',
    input_queued: zh ? '任务已建立，首轮要求已排队' : 'Task created; first input queued',
    input_received: zh ? '任务已建立，远端已接收要求' : 'Task created; host received the input',
    needs_reconciliation: zh ? '创建记录不完整，需要核对原任务' : 'Creation needs reconciliation'
  }
  if (receipt.createPhase) return phases[receipt.createPhase]
  if (receipt.execution?.status === 'succeeded') return zh ? '远端已处理，任务身份待核对' : 'Host processed request; task identity unconfirmed'
  if (receipt.execution?.status === 'failed') return zh ? '创建命令失败，请查看原原因' : 'Creation command failed; inspect its receipt'
  return ({ unknown: zh ? '发送结果未知' : 'Send outcome unknown', sending: zh ? '正在发送' : 'Sending',
    not_received: zh ? '远端暂未找到原命令，继续核对' : 'Command not found yet; check original receipt',
    received: zh ? `远端命令：${receipt.status ?? '已接收'}` : `Host command: ${receipt.status ?? 'received'}` })[receipt.state]
}
