import type { RemoteHostTasks, RemoteHostCommandReceipt, RemoteHostCommandKind, RemoteHostApproval, RemoteHostApprovalCandidate } from '../../shared/remote-host-types'
import type { RemoteDeviceCapability, RemoteResultProjection, RemoteCommandStatus } from '../../shared/remote-types'
import type { StoredRemoteHost } from './store'
import type { RemoteCreatedTaskProjection } from '../../shared/remote-created-task-types'
import { goalTaskIds } from '../project-workspace/goal-task-service'

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('远端响应格式无效。')
  return value as Record<string, unknown>
}
export function text(value: unknown, max = 512): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0\r]/.test(value)) throw new Error('远端字段无效。')
  return value.trim()
}
export function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('远端版本无效。')
  return Number(value)
}
export function capabilities(value: unknown): RemoteDeviceCapability[] {
  const allowed = ['view_results', 'resume_work_item', 'create_task', 'control_work_item', 'approve_effect', 'trigger_routine', 'remote_runner', 'workspace_read', 'task_handoff']
  if (!Array.isArray(value) || value.some(item => !allowed.includes(item))) throw new Error('远端权限声明无效。')
  return [...new Set(value)] as RemoteDeviceCapability[]
}
export function tasks(value: unknown, host: StoredRemoteHost): RemoteHostTasks {
  const data = object(value)
  if (data.deviceId !== host.deviceId || data.projectId !== host.projectId || !Array.isArray(data.workItems) || data.workItems.length > 2000) throw new Error('远端设备或项目身份不匹配。')
  const projection = object(data.projection)
  if (projection.projectId !== host.projectId) throw new Error('远端成果不属于配对项目。')
  return { hostId: host.id, projectId: host.projectId!, projectName: text(data.projectName), projectRevision: revision(data.projectRevision), capabilities: capabilities(data.capabilities),
    workItems: data.workItems.map(value => { const item = object(value); return {
      id: text(item.id), title: text(item.title, 2000), status: text(item.status, 80), revision: revision(item.revision),
      canResume: item.canResume === true, canAppend: item.canAppend === true, canPause: item.canPause === true, canCancel: item.canCancel === true,
      ...(typeof item.resumeReason === 'string' ? { resumeReason: item.resumeReason.slice(0, 1000) } : {})
    } }), projection: projection as unknown as RemoteResultProjection,
    routines: boundedArray(data.routines, 1000).map(value => { const row = object(value); return { id: text(row.id), name: text(row.name), nextRunAt: row.nextRunAt === null ? null : revision(row.nextRunAt) } }),
    approvals: boundedArray(data.approvals, 100).map(approval),
    approvalCandidates: boundedArray(data.approvalCandidates, 100).map(approvalCandidate) }
}
export function receipt(value: unknown, host: StoredRemoteHost, command: RemoteHostCommandReceipt): Partial<RemoteHostCommandReceipt> {
  const data = object(value)
  if (data.protocolVersion !== 1 || data.deviceId !== host.deviceId || data.projectId !== host.projectId) throw new Error('远端命令回执身份不匹配。')
  if (data.command === null) return { state: 'not_received', status: undefined, execution: undefined, error: '服务器未找到此命令。请刷新任务状态后再操作。' }
  const item = object(data.command)
  if (item.commandId !== command.commandId || item.kind !== command.kind || item.workItemId !== command.workItemId || item.routineId !== command.routineId ||
    !['pending', 'offline', 'expired', 'rejected', 'accepted'].includes(String(item.status))) throw new Error('远端命令回执不匹配。')
  const execution = item.execution === undefined ? undefined : object(item.execution)
  if (execution && !['running', 'succeeded', 'failed'].includes(String(execution.status))) throw new Error('远端执行回执无效。')
  return { state: 'received', status: item.status as RemoteCommandStatus,
    ...createdTaskProjection(item, command, host),
    execution: execution ? { status: execution.status as 'running' | 'succeeded' | 'failed' } : undefined,
    ...(item.approval ? { approval: approval(item.approval) } : {}),
    error: typeof item.error === 'string' ? item.error.slice(0, 1000) : undefined }
}
function createdTaskProjection(item: Record<string, unknown>, command: RemoteHostCommandReceipt, host: StoredRemoteHost): Partial<RemoteCreatedTaskProjection> {
  if (item.createdTask === undefined && item.createPhase === undefined) return {}
  if (command.kind !== 'create_task' || !['preparing', 'plan_ready', 'input_queued', 'input_received', 'needs_reconciliation'].includes(String(item.createPhase))) throw new Error('远端新任务状态无效。')
  const phase = item.createPhase as RemoteCreatedTaskProjection['createPhase']
  if (item.createdTask === undefined) {
    if (!['preparing', 'needs_reconciliation'].includes(phase)) throw new Error('远端缺少原任务身份。')
    return { createPhase: phase }
  }
  const value = object(item.createdTask)
  if (Object.keys(value).some(key => !['projectId', 'goalId', 'workItemId', 'sessionId'].includes(key)) || value.projectId !== host.projectId) throw new Error('新任务不属于原远端项目。')
  const createdTask = { projectId: text(value.projectId), goalId: text(value.goalId), workItemId: text(value.workItemId), sessionId: text(value.sessionId) }
  const expected = goalTaskIds(host.projectId!, `remote-${command.commandId}`)
  if (createdTask.goalId !== expected.goalId || createdTask.workItemId !== expected.workItemId) throw new Error('新任务不属于原创建命令。')
  if (command.createdTask && Object.keys(createdTask).some(key => createdTask[key as keyof typeof createdTask] !== command.createdTask![key as keyof typeof createdTask])) throw new Error('原远端任务身份已变化。')
  return { createdTask, createPhase: phase }
}
export function commandKind(value: unknown): RemoteHostCommandKind {
  if (!['resume_work_item', 'append_task', 'pause_work_item', 'cancel_work_item', 'create_task', 'trigger_routine', 'approve_effect'].includes(String(value))) throw new Error('不支持此远端任务操作。')
  return value as RemoteHostCommandKind
}

function boundedArray(value: unknown, max: number): unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > max) throw new Error('远端列表无效。')
  return value
}
export function approval(value: unknown): RemoteHostApproval {
  const row = object(value)
  if (!['pending', 'approved', 'rejected', 'expired'].includes(String(row.status)) || !['pending', 'applying', 'applied', 'failed'].includes(String(row.applicationStatus))) throw new Error('远端审批状态无效。')
  return { id: text(row.id), commandId: text(row.commandId), action: text(row.action), targetDigest: text(row.targetDigest), approvalDigest: text(row.approvalDigest),
    recordRevision: revision(row.recordRevision), expiresAt: revision(row.expiresAt), status: row.status as RemoteHostApproval['status'], applicationStatus: row.applicationStatus as RemoteHostApproval['applicationStatus'],
    ...(typeof row.summary === 'string' ? { summary: row.summary.slice(0, 4000) } : {}) }
}
export function approvalCandidate(value: unknown): RemoteHostApprovalCandidate {
  const row = object(value)
  return { sessionId: text(row.sessionId), workItemId: text(row.workItemId), permissionRequestId: text(row.permissionRequestId), action: text(row.action),
    targetDigest: text(row.targetDigest), dataScope: text(row.dataScope), revision: revision(row.revision), summary: text(row.summary, 4000) }
}
